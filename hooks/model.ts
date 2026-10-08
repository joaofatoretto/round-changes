import type { Change, FileTouch, Hunk, Live, Round, View } from '../types'

/** Diff lines kept per change; past this the diff is cut and says so. */
export const MAX_LINES = 400
/** Rounds kept; the oldest go first. */
export const MAX_ROUNDS = 60

const isChanged = (line: string) => line.startsWith('+') || line.startsWith('-')

export const countLines = (hunks: readonly Hunk[]) => {
  let added = 0
  let removed = 0
  for (const hunk of hunks)
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  return { added, removed }
}

/** The first changed line, numbered in the file as it is after the change. */
export const firstChangedLine = (hunks: readonly Hunk[]): number => {
  const hunk = hunks[0]
  if (!hunk) return 1
  let line = hunk.newStart
  for (const text of hunk.lines) {
    if (isChanged(text)) return Math.max(1, line)
    if (!text.startsWith('\\')) line++
  }
  return Math.max(1, hunk.newStart)
}

/** Keeps the first `max` diff lines, recounting a cut hunk so it still parses. */
export const capHunks = (hunks: readonly Hunk[], max = MAX_LINES): { hunks: Hunk[]; isTruncated: boolean } => {
  const kept: Hunk[] = []
  let room = max
  for (const hunk of hunks) {
    if (room <= 0) return { hunks: kept, isTruncated: true }
    if (hunk.lines.length <= room) {
      kept.push({ ...hunk, lines: [...hunk.lines] })
      room -= hunk.lines.length
      continue
    }
    const lines = hunk.lines.slice(0, room)
    const oldLines = lines.filter(l => l.startsWith(' ') || l.startsWith('-')).length
    const newLines = lines.filter(l => l.startsWith(' ') || l.startsWith('+')).length
    kept.push({ ...hunk, oldLines, newLines, lines })
    return { hunks: kept, isTruncated: true }
  }
  return { hunks: kept, isTruncated: false }
}

/** Every line of `text` as an added hunk: a new file. */
export const addedHunk = (text: string): Hunk[] => {
  if (text === '') return []
  const lines = text.replace(/\n$/, '').split('\n')
  return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map(l => `+${l}`) }]
}

/** `before` replaced by `after` as one hunk: a notebook cell. */
export const replacedHunk = (before: string, after: string): Hunk[] => {
  const old = before === '' ? [] : before.split('\n')
  const now = after === '' ? [] : after.split('\n')
  if (old.length === 0 && now.length === 0) return []
  return [
    {
      oldStart: old.length ? 1 : 0,
      oldLines: old.length,
      newStart: now.length ? 1 : 0,
      newLines: now.length,
      lines: [...old.map(l => `-${l}`), ...now.map(l => `+${l}`)],
    },
  ]
}

/** A Change from the hunks a tool reported, capped and counted. */
export const makeChange = (
  base: Pick<Change, 'toolUseId' | 'tool' | 'agentId' | 'note' | 'language' | 'command'>,
  hunks: readonly Hunk[],
): Change => {
  const { added, removed } = countLines(hunks)
  const capped = capHunks(hunks)
  return {
    ...base,
    hunks: capped.hunks,
    isTruncated: capped.isTruncated,
    added,
    removed,
    line: firstChangedLine(hunks),
  }
}

/** The diff text `Code format="diff"` draws for a change. */
export const diffSource = (hunks: readonly Hunk[]): string =>
  hunks
    .map(h => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join('\n'))
    .join('\n')

/** What a file is after a second change in one round: created then deleted reads deleted, and so on. */
export const mergeKind = (was: FileTouch['kind'], now: FileTouch['kind']): FileTouch['kind'] =>
  now === 'deleted' ? 'deleted' : was === 'deleted' ? 'modified' : was

/** Adds `change` to the round `live` names, opening that round on its first change. */
export const recordChange = (
  rounds: readonly Round[],
  live: Live,
  path: string,
  kind: FileTouch['kind'],
  change: Change,
): Round[] => {
  const existing = rounds.find(r => r.id === live.id)
  const round: Round = existing ?? {
    id: live.id,
    turn: live.turn,
    prompt: live.prompt,
    startedAt: live.startedAt,
    files: [],
    shellCommands: 0,
  }
  const touched = round.files.find(f => f.path === path)
  const files = touched
    ? round.files.map(f => (f === touched ? { ...f, kind: mergeKind(f.kind, kind), changes: [...f.changes, change] } : f))
    : [...round.files, { path, kind, changes: [change] }]
  const next = { ...round, files }
  return existing
    ? rounds.map(r => (r === existing ? next : r))
    : [...rounds, next].slice(-MAX_ROUNDS)
}

/**
 * Counts one shell command whose changes could not be captured, opening the round
 * if it has none yet; `outsideRepo` when the folder was in no git repo at the time.
 */
export const countShell = (rounds: readonly Round[], live: Live, outsideRepo = false): Round[] => {
  const existing = rounds.find(r => r.id === live.id)
  const mark = outsideRepo ? { isOutsideRepo: true } : {}
  if (existing) return rounds.map(r => (r === existing ? { ...r, ...mark, shellCommands: r.shellCommands + 1 } : r))
  const round: Round = {
    id: live.id,
    turn: live.turn,
    prompt: live.prompt,
    startedAt: live.startedAt,
    files: [],
    shellCommands: 1,
    ...mark,
  }
  return [...rounds, round].slice(-MAX_ROUNDS)
}

export const fileStats = (file: FileTouch) => ({
  added: file.changes.reduce((n, c) => n + c.added, 0),
  removed: file.changes.reduce((n, c) => n + c.removed, 0),
})

export const roundStats = (round: Round) => {
  let added = 0
  let removed = 0
  for (const file of round.files) {
    const s = fileStats(file)
    added += s.added
    removed += s.removed
  }
  return { added, removed, files: round.files.length }
}

/** The round the view shows: the one it names, else the newest. */
export const shownRound = (rounds: readonly Round[], view: View): Round | undefined =>
  (view.roundId !== null && rounds.find(r => r.id === view.roundId)) || rounds[rounds.length - 1]

/** The file the view shows in `round`: the one it names, else the first. */
export const shownFile = (round: Round | undefined, view: View): FileTouch | undefined =>
  round && ((view.file !== null && round.files.find(f => f.path === view.file)) || round.files[0])

/** Names what the viewer shows (round, screen, file), so a measure of one screen is not read on another. */
export const viewKey = (rounds: readonly Round[], view: View): string => {
  const round = shownRound(rounds, view)
  const file = view.screen === 'file' ? shownFile(round, view) : undefined
  return `${round?.id ?? ''}:${view.screen}:${file?.path ?? ''}`
}

/** The view one round older (-1) or newer (+1), on its overview; the newest is followed again. */
export const stepRound = (rounds: readonly Round[], view: View, by: number): View => {
  const at = shownRound(rounds, view)
  if (!at) return view
  const index = Math.min(rounds.length - 1, Math.max(0, rounds.indexOf(at) + by))
  const target = rounds[index]
  if (!target || target === at) return view
  return { roundId: index === rounds.length - 1 ? null : target.id, file: null, screen: 'round' }
}

/** The view on the next (+1) or previous (-1) file of the shown round, wrapping. */
export const stepFile = (rounds: readonly Round[], view: View, by: number): View => {
  const round = shownRound(rounds, view)
  const file = shownFile(round, view)
  if (!round || !file) return view
  const n = round.files.length
  const index = (((round.files.indexOf(file) + by) % n) + n) % n
  return { ...view, file: round.files[index]?.path ?? null }
}

/** How much a row can hold at a width: everything, no folder, or name and counts alone. */
export type Fit = 'wide' | 'medium' | 'narrow'
export const fitFor = (columns: number): Fit => (columns >= 72 ? 'wide' : columns >= 46 ? 'medium' : 'narrow')

/**
 * A GitHub-style size bar of `cells` blocks: the share of added and removed
 * lines, scaled to the round's largest file so sizes compare at a glance.
 */
export const sizeBar = (added: number, removed: number, largest: number, cells = 5) => {
  const total = added + removed
  if (total === 0 || largest === 0) return { plus: 0, minus: 0, rest: cells }
  const filled = Math.max(1, Math.round((total / largest) * cells))
  let plus = Math.round((added / total) * filled)
  if (added > 0 && plus === 0) plus = 1
  if (removed > 0 && plus === filled) plus = filled - 1
  const minus = filled - plus
  return { plus, minus: Math.max(0, minus), rest: cells - filled }
}

/** Cuts `text` to `width` cells, keeping its end: for paths, whose end says the most. */
export const keepEnd = (text: string, width: number): string =>
  width <= 0 ? '' : text.length <= width ? text : `…${text.slice(text.length - width + 1)}`

/** Cuts `text` to `width` cells, keeping its start. */
export const keepStart = (text: string, width: number): string =>
  width <= 0 ? '' : text.length <= width ? text : `${text.slice(0, width - 1)}…`

/**
 * The prompt as at most `maxLines` rows of `width` cells, cut at spaces, the last
 * row ending in … when more was left.
 */
export const wrapLines = (text: string, width: number, maxLines: number): string[] => {
  const room = Math.max(1, width)
  const lines: string[] = []
  let rest = text.trim()
  while (rest !== '' && lines.length < maxLines) {
    if (rest.length <= room) {
      lines.push(rest)
      break
    }
    if (lines.length === maxLines - 1) {
      lines.push(keepStart(rest, room))
      break
    }
    let cut = rest.lastIndexOf(' ', room)
    if (cut <= 0) cut = room
    lines.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  return lines.length > 0 ? lines : ['']
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** The warning for shell commands whose changes could not be shown; short when `narrow`. */
export const shellWarning = (shell: number, isOutsideRepo: boolean, narrow: boolean): string => {
  const commands = plural(shell, 'shell command')
  if (narrow) return `⚠ ${isOutsideRepo ? 'No git' : 'Untracked'}: ${commands} not shown`
  const its = shell === 1 ? 'its' : 'their'
  return isOutsideRepo
    ? `⚠ ${commands} ran outside a git repo, so ${its} changes can't be shown. Run git init to track them.`
    : `⚠ ${commands} couldn't be snapshotted, so ${its} changes aren't shown.`
}

/** The room the viewer's body has at a pane `width`: its sides are padded by one. */
const bodyRoom = (width: number) => Math.max(22, width - 2)

/**
 * The rows the viewer wants for what it shows, so it opens no taller than it needs;
 * `width` is the pane's body, about the docked column.
 */
export const wantedRows = (
  round: Round | undefined,
  file: FileTouch | undefined,
  screen: View['screen'],
  width = 50,
): number => {
  if (!round) return 6
  if (screen !== 'round' && file) return diffScreenRows(file, width)
  const room = bodyRoom(width)
  const narrow = fitFor(width) === 'narrow'
  const prompt = wrapLines(promptLine(round.prompt), room - 2, 2).length
  const warning =
    round.shellCommands > 0
      ? 1 + (narrow ? 1 : Math.ceil(shellWarning(round.shellCommands, round.isOutsideRepo === true, false).length / room))
      : 0
  const hints = room >= 34 ? 1 : 2
  // nav, blank, prompt, meta, blank, summary, [blank, files], [blank, warning], blank, hints
  return 2 + prompt + (narrow ? 0 : 1) + 2 + (round.files.length > 0 ? 1 + round.files.length : 0) + warning + 1 + hints
}

/** The finished round whose length matches a "Baked for" line, within a moment's drift. */
export const roundForDuration = (rounds: readonly Round[], durationMs: number): Round | undefined => {
  let best: Round | undefined
  let gap = 1500
  for (const round of rounds) {
    if (round.durationMs === undefined) continue
    const d = Math.abs(round.durationMs - durationMs)
    if (d <= gap) {
      gap = d
      best = round
    }
  }
  return best
}

/** `path` relative to `root` when inside it, `~/…` under home, else as is. */
export const displayPath = (path: string, root: string, home?: string): string => {
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1)
  if (home && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`
  return path
}

/** Splits a path into the directory part and the file name. */
export const splitPath = (path: string): { dir: string; name: string } => {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? { dir: '', name: path } : { dir: path.slice(0, cut), name: path.slice(cut + 1) }
}

/** The prompt as one short line. */
export const promptLine = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line === '' ? '(continued without a new prompt)' : line
}

export const clock = (at: number): string => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const duration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

type PatchRecord = { filePath?: string; structuredPatch?: Hunk[]; staged?: boolean }
type WriteRecord = PatchRecord & { type?: 'create' | 'update'; content?: string; originalFile?: string | null }
type NotebookRecord = {
  notebook_path?: string
  new_source?: string
  old_source?: string
  cell_id?: string
  cell_type?: string
  language?: string
  edit_mode?: string
  error?: string
}

/**
 * The file and change a file tool's stored record describes, or undefined when
 * it changed nothing (an error, a staged write, a tool that edits no file).
 */
export const fromToolRecord = (
  tool: string,
  toolUseId: string,
  record: unknown,
  agentId?: string,
): { path: string; kind: FileTouch['kind']; change: Change } | undefined => {
  if (record === null || typeof record !== 'object') return undefined
  if (tool === 'Edit') {
    const r = record as PatchRecord
    if (!r.filePath || r.staged) return undefined
    const change = makeChange({ toolUseId, tool: 'Edit', agentId }, r.structuredPatch ?? [])
    return { path: r.filePath, kind: 'modified', change }
  }
  if (tool === 'Write') {
    const r = record as WriteRecord
    if (!r.filePath || r.staged) return undefined
    const isNew = r.type === 'create'
    const patch = r.structuredPatch ?? []
    const hunks = patch.length > 0 ? patch : isNew ? addedHunk(r.content ?? '') : []
    const note =
      hunks.length > 0
        ? undefined
        : r.originalFile === null
          ? 'Rewritten whole; the previous version was too large to diff.'
          : 'Written with the same content: nothing changed.'
    const change = makeChange({ toolUseId, tool: 'Write', agentId, note }, hunks)
    return { path: r.filePath, kind: isNew ? 'added' : 'modified', change }
  }
  if (tool === 'NotebookEdit') {
    const r = record as NotebookRecord
    if (!r.notebook_path || r.error) return undefined
    const change = makeChange(
      {
        toolUseId,
        tool: 'NotebookEdit',
        agentId,
        language: r.cell_type === 'markdown' ? 'markdown' : r.language,
        note: `Cell ${r.cell_id ?? '?'} (${r.edit_mode ?? 'edit'})`,
      },
      replacedHunk(r.old_source ?? '', r.edit_mode === 'delete' ? '' : (r.new_source ?? '')),
    )
    return { path: r.notebook_path, kind: 'modified', change }
  }
  return undefined
}

/** The minimum of a transcript row the rebuild reads. */
export type TranscriptRow = {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly { tool_use_id: string; tool: string; result?: unknown; isError?: true }[]
  toolResults?: readonly unknown[]
}

/**
 * Rounds rebuilt from a transcript: each prompt the person typed opens a round,
 * and the file changes its tool calls stored land in it. Times are unknown (0).
 */
export const roundsFromTranscript = (rows: readonly TranscriptRow[]): { rounds: Round[]; turns: number } => {
  let rounds: Round[] = []
  let turns = 0
  let at: Live = { id: 'before-0', turn: 0, prompt: '(before the first prompt)', startedAt: 0, shellCommands: 0 }
  for (const row of rows) {
    if (row.role === 'user') {
      if (row.text.trim() === '' || (row.toolResults && row.toolResults.length > 0)) continue
      turns++
      at = { id: `history-${turns}`, turn: turns, prompt: row.text.slice(0, 400), startedAt: 0, shellCommands: 0 }
      continue
    }
    for (const use of row.toolUses) {
      if (use.isError) continue
      const found = fromToolRecord(use.tool, use.tool_use_id, use.result)
      if (found) rounds = recordChange(rounds, at, found.path, found.kind, found.change)
    }
  }
  return { rounds, turns }
}

/**
 * A folder cut to `width` by whole segments from its end (`…/round-changes/hooks`),
 * the nearest folders saying the most; the last segment alone when even one will not fit.
 */
export const shortDir = (dir: string, width: number): string => {
  if (width <= 0) return ''
  if (dir.length <= width) return dir
  const parts = dir.split('/')
  let kept = ''
  for (let i = parts.length - 1; i >= 0; i--) {
    const next = kept === '' ? (parts[i] ?? '') : `${parts[i]}/${kept}`
    if (next.length + 2 > width) break
    kept = next
  }
  return kept === '' ? keepEnd(dir, width) : `…/${kept}`
}

/**
 * A file row as one line of `width` cells: the name, its folder when there is room,
 * and the counts at the right end. The name gives way last.
 */
export const fileRowLabel = (name: string, dir: string, counts: string, width: number): string => {
  const nameRoom = Math.max(4, width - counts.length - 2)
  const shown = keepStart(name, nameRoom)
  const dirRoom = width - shown.length - counts.length - 4
  const folder = dir !== '' && dirRoom > 3 ? `  ${shortDir(dir, dirRoom)}` : ''
  const left = `${shown}${folder}`
  return `${left}${' '.repeat(Math.max(1, width - left.length - counts.length))}${counts}`
}

/** One file of a `git diff` between two snapshots. */
export type DiffFile = { path: string; kind: FileTouch['kind']; hunks: Hunk[]; isBinary: boolean }

const unquote = (path: string) =>
  path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1).replace(/\\(["\\])/g, '$1') : path

/** The files of a `git diff --no-renames` and their hunks, paths relative to the repo's top. */
export const parseGitDiff = (text: string): DiffFile[] => {
  const files: DiffFile[] = []
  let file: DiffFile | undefined
  let hunk: Hunk | undefined
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const b = line.lastIndexOf(' b/')
      file = { path: unquote(line.slice(b + 3)), kind: 'modified', hunks: [], isBinary: false }
      hunk = undefined
      files.push(file)
      continue
    }
    if (!file) continue
    if (!hunk) {
      if (line.startsWith('new file mode')) file.kind = 'added'
      else if (line.startsWith('deleted file mode')) file.kind = 'deleted'
      else if (line.startsWith('Binary files')) file.isBinary = true
      else if (line.startsWith('+++ b/')) file.path = unquote(line.slice(6))
    }
    const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (head) {
      hunk = {
        oldStart: Number(head[1]),
        oldLines: head[2] === undefined ? 1 : Number(head[2]),
        newStart: Number(head[3]),
        newLines: head[4] === undefined ? 1 : Number(head[4]),
        lines: [],
      }
      file.hunks.push(hunk)
      continue
    }
    if (hunk && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line.startsWith('\\')))
      hunk.lines.push(line)
  }
  return files
}

/**
 * About how many rows a file's diff screen draws at `width`, wrapped lines counted:
 * the nav, title, folder and actions, each change under its rule, the key hints.
 */
export const diffScreenRows = (file: FileTouch, width: number, hasDir = true): number => {
  const room = bodyRoom(width)
  const code = Math.max(10, width - 9)
  const hasActions = file.kind !== 'deleted' || file.changes.some(c => !c.agentId)
  // nav, blank, title, [folder], [blank, actions], blank, hints
  let rows = 3 + (hasDir ? 1 : 0) + (hasActions ? 2 : 0) + 1 + (room >= 48 ? 1 : 2)
  for (const c of file.changes) {
    // blank, rule, [command], [note], [cut note], the diff
    rows += 2 + (c.command ? 1 : 0) + (c.note ? 1 : 0) + (c.isTruncated ? 1 : 0)
    for (const h of c.hunks) for (const l of h.lines) rows += Math.max(1, Math.ceil(l.length / code))
  }
  return rows
}
