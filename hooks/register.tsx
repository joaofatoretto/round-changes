import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallInput, ToolCallResult } from 'claude-code'

import type { Change, FileTouch, Live, Round, View } from '../types'
import {
  clock,
  diffScreenRows,
  diffSource,
  displayPath,
  duration,
  fileRowLabel,
  fileStats,
  fitFor,
  fromToolRecord,
  makeChange,
  parseGitDiff,
  keepStart,
  promptLine,
  recordChange,
  roundForDuration,
  countShell,
  roundStats,
  roundsFromTranscript,
  shortDir,
  shownFile,
  shownRound,
  sizeBar,
  splitPath,
  stepFile,
  stepRound,
  shellWarning,
  viewKey,
  wantedRows,
  wrapLines,
} from './model'

const PANE = 'round-changes'
const TITLE = 'Changes'
const EDITOR = 'code'
/** The docked viewer's width: room for a diff, most of the row left to the chat. */
const DOCK_COLUMNS = 52

const rounds = atom({ plugin: 'round-changes', key: 'rounds' } as const, [])
const live = atom({ plugin: 'round-changes', key: 'live' } as const, null)
const turns = atom({ plugin: 'round-changes', key: 'turns' } as const, 0)
const view = atom({ plugin: 'round-changes', key: 'view' } as const, { roundId: null, file: null, screen: 'round' })
const cwd = atom({ plugin: 'round-changes', key: 'cwd' } as const, '')
const home = atom({ plugin: 'round-changes', key: 'home' } as const, '')
const scroll = atom({ plugin: 'round-changes', key: 'scroll' } as const, null)

/** Git's colors for added and removed lines, as GitHub draws them. */
const ADDED = '#3fb950'
const REMOVED = '#f85149'

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

// ── Recording ─────────────────────────────────────────────────────────

/** The round a change lands in: the running turn, else background work after the last one. */
async function currentRound($: EngineInterface): Promise<Live> {
  const running = await read($, live)
  if (running) return running
  const turn = await read($, turns)
  return {
    id: `after-${turn}`,
    turn,
    prompt: `(background work after turn ${turn})`,
    startedAt: await $.clock.now(),
    shellCommands: 0,
  }
}

async function record($: EngineInterface, path: string, kind: FileTouch['kind'], change: Change) {
  const into = await currentRound($)
  await update($, rounds, list => recordChange(list, into, path, kind, change))
}

/** With nothing recorded yet (a fresh load mid-session), rebuilds the rounds from the transcript. */
async function backfill($: EngineInterface) {
  if ((await read($, rounds)).length > 0) return
  const found = roundsFromTranscript(await $.session.messages())
  if (found.rounds.length === 0) return
  await update($, rounds, list => (list.length > 0 ? list : found.rounds))
  await update($, turns, n => Math.max(n, found.turns))
}

async function recordFileTool<E extends ToolCallInput, R extends ToolCallResult>(
  $: EngineInterface,
  e: E,
  next: (e: E) => Promise<R>,
): Promise<R> {
  const ran = await next(e)
  if (ran.deny !== undefined || ran.isError) return ran
  const found = fromToolRecord(e.tool, e.tool_use_id, ran.result, e.agentId)
  if (found) await record($, found.path, found.kind, found.change)
  return ran
}

// ── Shell commands, through git ─────────────────────────────────────

/**
 * Snapshots of a git work tree, to see what a shell command changed: the tree
 * before and after, each written with `git add -A` into a private index inside
 * `.git` (never the person's staging area), then diffed.
 */
type Repo = { top: string; index: string }

const QUICK = { timeoutMs: 10_000 }

/** The repo the session works in, or null outside one. */
async function findRepo($: EngineInterface, cwd: string): Promise<Repo | null> {
  const found = await $.process.run(['git', 'rev-parse', '--show-toplevel', '--absolute-git-dir'], { cwd, ...QUICK })
  if (found.exitCode !== 0) return null
  const [top, gitDir] = found.stdout.trim().split('\n')
  if (!top || !gitDir) return null
  const index = `${gitDir}/round-changes.index`
  // Seeded from the real index, so its stat cache is warm and the first snapshot is quick.
  await $.process.run(['sh', '-c', '[ -f "$1" ] || cp "$2/index" "$1" 2>/dev/null || true', 'sh', index, gitDir], QUICK)
  return { top, index }
}

/** The work tree as a tree id, untracked files included, ignored ones not. */
async function snapshot($: EngineInterface, repo: Repo): Promise<string | undefined> {
  const ran = await $.process.run(['sh', '-c', 'git add -A . >/dev/null 2>&1; git write-tree'], {
    cwd: repo.top,
    env: { GIT_INDEX_FILE: repo.index },
    ...QUICK,
  })
  const tree = ran.stdout.trim()
  return ran.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(tree) ? tree : undefined
}

/** The unified diff between two snapshots. */
async function diffTrees($: EngineInterface, repo: Repo, before: string, after: string): Promise<string> {
  const ran = await $.process.run(
    ['git', '-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '--no-renames', '-U3', before, after],
    { cwd: repo.top, ...QUICK },
  )
  return ran.exitCode === 0 ? ran.stdout : ''
}

// Repos found, by the folder the session ran in. A miss is not kept, so a `git init`
// or a move into a repo mid-session is seen at the next command; snapshots run one at
// a time, as they share an index.
const repos = new Map<string, Repo>()
let queue: Promise<unknown> = Promise.resolve()

async function repoFor($: EngineInterface): Promise<Repo | null> {
  try {
    const dir = await $.session.cwd()
    const known = repos.get(dir)
    if (known) return known
    const found = await findRepo($, dir)
    if (found) repos.set(dir, found)
    return found
  } catch {
    return null
  }
}

/** Drops a repo whose snapshot failed (moved, renamed, removed), so the next command looks again. */
function forgetRepo(repo: Repo) {
  for (const [dir, known] of repos) if (known === repo) repos.delete(dir)
}

function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)
  return run
}

/** Records what a shell command changed in the repo, file by file. */
async function recordShell($: EngineInterface, repo: Repo, before: string, e: { tool_use_id: string; agentId?: string; command: string }) {
  const after = await oneAtATime(() => snapshot($, repo))
  if (!after || after === before) return
  const files = parseGitDiff(await diffTrees($, repo, before, after))
  for (const f of files) {
    const note = f.isBinary ? 'Binary file: no text diff to show.' : f.hunks.length === 0 ? 'Mode or empty-file change.' : undefined
    const change = makeChange(
      { toolUseId: e.tool_use_id, tool: 'Bash', agentId: e.agentId, command: e.command.slice(0, 300), note },
      f.hunks,
    )
    await record($, `${repo.top}/${f.path}`, f.kind, change)
  }
}

/** The tool.call hooks only watch: if one fails, the call's own result stands. */
function passThrough<E, R>($: unknown, e: E, next: (e: E) => R): R {
  return next(e)
}

// ── The viewer ────────────────────────────────────────────────────────

/** Opens the viewer on `next`, or moves it there, as tall as what it shows needs. */
async function show($: EngineInterface, next: View) {
  await update($, view, () => next)
  const list = await read($, rounds)
  const round = shownRound(list, next)
  const rows = Math.min(40, Math.max(6, wantedRows(round, shownFile(round, next), next.screen)))
  // Docked (fullscreen, 110+ columns) it takes a slim column on the right; inline, the rows it needs.
  return $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true, rows, columns: DOCK_COLUMNS })
}

/** Opens a round: straight to the diff when it touched one file, else its overview. */
async function showRound($: EngineInterface, roundId: string | null) {
  const list = await read($, rounds)
  const round = shownRound(list, { roundId, file: null, screen: 'round' })
  const only = round?.files.length === 1 ? round.files[0] : undefined
  return show($, { roundId, file: only?.path ?? null, screen: only ? 'file' : 'round' })
}

async function move($: EngineInterface, to: (list: readonly Round[], v: View) => View) {
  const list = await read($, rounds)
  await show($, to(list, await read($, view)))
  try {
    await $.ui.scroll({ in: PANE, to: 'start' })
  } catch {}
}

async function scrollPane($: EngineInterface, to: 'start' | 'end') {
  try {
    await $.ui.scroll({ in: PANE, to })
  } catch {}
}

async function openInEditor($: EngineInterface, path: string, line: number) {
  const name = splitPath(path).name
  try {
    const ran = await $.process.run([EDITOR, '-r', '-g', `${path}:${line}`], { timeoutMs: 20_000 })
    if (ran.exitCode === 0) $.ui.toast(`Opened ${name}:${line} in VS Code`, { timeoutMs: 2500 })
    else {
      const why = (ran.stderr || ran.stdout).trim().split('\n')[0] || `exit code ${ran.exitCode}`
      $.ui.toast(`VS Code did not open ${name}: ${why}`)
    }
  } catch {
    $.ui.toast(`Could not run \`${EDITOR}\`. Is the VS Code CLI on your PATH?`)
  }
}

async function revealInChat($: EngineInterface, change: Change) {
  if (change.agentId) {
    $.ui.toast('A subagent made this change: it is in that agent’s transcript, not the main one.')
    return
  }
  try {
    const moved = await $.ui.scroll({ to: { requestId: change.toolUseId }, block: 'center' })
    if (moved.deny) $.ui.toast(`Could not scroll the chat there: ${moved.deny}`)
  } catch {
    $.ui.toast('That change is no longer in the chat.')
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'changes',
      description: 'Review what the last round changed: files, diffs, open in VS Code',
    })
    const root = await $.session.cwd()
    await update($, cwd, () => root)
    const homeDir = (await $.env.get('HOME')) ?? ''
    await update($, home, () => homeDir)
    // The first version pinned a status line; the chips replace it.
    $.ui.status(undefined)
    await backfill($)
    return result
  })

  on('command.run', { command: 'changes' }, async $ => {
    const root = await $.session.cwd()
    await update($, cwd, () => root)
    await backfill($)
    const opened = await showRound($, null)
    if (!opened.isPlaced) return { text: `The changes viewer could not open: ${opened.reason}` }
    return {}
  })

  // The window's moves, measured: the pills at its foot need the tree's true height.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    const moved = await next(e)
    if (moved.deny !== undefined) return moved
    const key = viewKey(await read($, rounds), await read($, view))
    await update($, scroll, () => ({ key, contentRows: e.contentRows }))
    return moved
  })

  // Esc on a file's diff steps back to the round; on the round it closes.
  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE || e.origin.kind !== 'person') return next(e)
    const v = await read($, view)
    if (v.screen !== 'file') return next(e)
    await show($, { ...v, screen: 'round' })
    return { value: undefined }
  })

  on('turn.start', async ($, e, next) => {
    const at = await $.clock.now()
    const n = (await read($, turns)) + 1
    await update($, turns, () => n)
    await update($, live, () => ({ id: e.turnId, turn: n, prompt: e.text.slice(0, 400), startedAt: at, shellCommands: 0 }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const at = await $.clock.now()
    const ended = await read($, live)
    if (ended)
      await update($, rounds, list =>
        list.map(r =>
          r.id === ended.id ? { ...r, endedAt: at, durationMs: e.durationMs } : r,
        ),
      )
    await update($, live, () => null)
    return next(e)
  })

  on('tool.call', { tool: 'Edit' }, recordFileTool).catch(passThrough)
  on('tool.call', { tool: 'Write' }, recordFileTool).catch(passThrough)
  on('tool.call', { tool: 'NotebookEdit' }, recordFileTool).catch(passThrough)

  // Shell commands: the work tree before and after, diffed. Outside a git repo they are only counted.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.tool !== 'Bash') return next(e)
    const repo = await repoFor($)
    const before = repo ? await oneAtATime(() => snapshot($, repo)) : undefined
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isReadOnly) return ran
    if (repo && before) {
      await recordShell($, repo, before, e)
      return ran
    }
    // No snapshot: the round still shows, with a warning that files may have changed unseen.
    if (repo) forgetRepo(repo)
    const into = await currentRound($)
    await update($, live, l => (l && l.id === into.id ? { ...l, shellCommands: l.shellCommands + 1 } : l))
    await update($, rounds, list => countShell(list, into, repo === null))
    return ran
  }).catch(passThrough)

  // ── Entry point 1: a chip on each round's "✻ Baked for 48s" line ──────
  // The line is drawn whole here, the engine's words kept, so the chip never wraps it.
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const round = roundForDuration(await read($, rounds), e.props.durationMs)
    if (!round) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const s = roundStats(round)
    const columns = e.viewport?.columns ?? 80
    const said = `✻ ${e.props.word} for ${duration(e.props.durationMs)}`
    const counts = columns >= said.length + 34
    return (
      <Box flexDirection="row" gap={2}>
        <Text key="said" dimColor>
          {said}
        </Text>
        <Box key="chip" flexDirection="row" gap={1} flexShrink={0}>
          {round.shellCommands > 0 && (
            <Text key="warn" color="yellow">
              {round.isOutsideRepo
                ? s.files === 0 && counts ? 'no git: shell changes not tracked' : 'no git'
                : s.files === 0 && counts ? 'shell changes not tracked' : 'untracked'}
            </Text>
          )}
          {counts && s.files > 0 && <Text key="files">{plural(s.files, 'file')}</Text>}
          {counts && s.added > 0 && <Text key="a" color={ADDED}>{`+${s.added}`}</Text>}
          {counts && s.removed > 0 && <Text key="r" color={REMOVED}>{`−${s.removed}`}</Text>}
          <Button key={`view:${round.id}`} onPress={() => showRound($, round.id)}>
            {counts || s.files === 0 ? 'view' : `${s.files} · view`}
          </Button>
        </Box>
      </Box>
    )
  })

  // ── Entry point 2: the newest round in the prompt footer, one click from the viewer ──
  // Drawn in the footer's mode slot at the right of the hint row: no row of its own.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const list = await read($, rounds)
    const newest = list[list.length - 1]
    if (!newest) return next(e)
    const s = roundStats(newest)
    const files = s.files > 0 ? plural(s.files, 'file') : 'shell changes'
    const counts = [s.added > 0 && `+${s.added}`, s.removed > 0 && `−${s.removed}`].filter(Boolean).join(' ')
    const noGit = newest.shellCommands > 0 ? (newest.isOutsideRepo ? 'no git ' : 'untracked ') : ''
    // The engine moves this slot to a row of its own when the hint leaves it no room, so
    // it drops the counts, then steps aside: the hint is about 52 columns, 71 while a turn runs.
    const columns = e.viewport?.columns ?? 0
    const modes = e.props.modes.length > 0 ? e.props.modes.join(' & ').length + 2 : 0
    const free = columns - ((await read($, live)) ? 71 : 52) - modes - 4
    const full = `${noGit}${files} ${counts}`.trim()
    const short = `${noGit}${files}`.trim()
    if (free < short.length) return next(e)
    const withCounts = free >= full.length && counts !== ''
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={2}>
        {e.props.modes.length > 0 && (
          <Text key="modes" dimColor>
            {e.props.modes.join(' & ')}
          </Text>
        )}
        <Box key="changes" flexDirection="row" gap={1}>
          {noGit !== '' && (
            <Text key="nogit" color="yellow">
              {noGit.trim()}
            </Text>
          )}
          {/* One Button for the whole of it, counts included: a label holds no colors, but every cell presses. */}
          <Button key="footer-changes" plain dimColor onPress={() => showRound($, newest.id)}>
            {withCounts ? `${files} ${counts}` : files}
          </Button>
        </Box>
      </Box>
    )
  })

  // ── The viewer itself ─────────────────────────────────────────────────
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const list = await read($, rounds)
    const running = await read($, live)
    const v = await read($, view)
    const root = await read($, cwd)
    const homeDir = await read($, home)
    const where = (path: string) => displayPath(path, root, homeDir)
    const width = Math.max(24, e.props.bodyColumns)
    // The body is padded by one column at each side: what is drawn fits `room`.
    const room = width - 2
    const fit = fitFor(width)
    const round = shownRound(list, v)

    /** A file's kind as a 3-cell chip: A added, M modified, D deleted. */
    const kindBadge = (kind: FileTouch['kind']) => (
      <Text key="badge" bold color="inverseText" backgroundColor={kind === 'deleted' ? 'error' : kind === 'added' ? 'success' : 'warning'}>
        {kind === 'deleted' ? ' D ' : kind === 'added' ? ' A ' : ' M '}
      </Text>
    )

    /**
     * Pills at the window's foot, as the chat's own: to the top once scrolled down, to the
     * bottom while there is more below. `estimate` stands in for the tree's height until
     * the window has moved on this screen and the engine has said it.
     */
    const measured = await read($, scroll)
    const here = viewKey(list, v)
    const known = measured?.key === here ? measured : undefined
    const treeRows = (estimate: number) => known?.contentRows ?? estimate
    const pills = (estimate: number) => {
      const { bodyRows } = e.props.scroll
      const total = treeRows(estimate)
      const { offset } = e.props.scroll
      const canTop = offset > 0
      const canBottom = offset + bodyRows < total
      if (!canTop && !canBottom) return null
      const short = fit === 'narrow'
      return (
        <Box key="pills" position="absolute" top={offset + bodyRows - 1} right={1} flexDirection="row" gap={1}>
          {canTop && (
            <Button key="top" hotkey="g" variant="primary" onPress={() => scrollPane($, 'start')}>
              {short ? '⤒' : '⤒ top'}
            </Button>
          )}
          {canBottom && (
            <Button key="bottom" hotkey="e" variant="primary" onPress={() => scrollPane($, 'end')}>
              {short ? '⤓' : '⤓ bottom'}
            </Button>
          )}
        </Box>
      )
    }
    // A tree taller than its window ends in a blank row, under the pills at its foot.
    const scrolls = (estimate: number) => treeRows(estimate) > e.props.scroll.bodyRows

    /** The key hints at the foot: key in the accent, what it does dim, wrapping instead of cutting. */
    const hints = (pairs: readonly (readonly [string, string])[]) => (
      <Box key="hints" flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1} width={room}>
        {pairs.map(([key, label]) => (
          <Box key={`hint:${key}`} flexDirection="row" gap={1}>
            <Text key="key" bold color="claude">
              {key}
            </Text>
            <Text key="label" dimColor>
              {label}
            </Text>
          </Box>
        ))}
      </Box>
    )

    if (!round) {
      return (
        <Box flexDirection="column" paddingX={1} paddingY={1} width={width}>
          <Text key="title" bold>
            No changes yet
          </Text>
          <Box key="about" marginTop={1}>
            <Text key="hint" dimColor wrap="wrap">
              When Claude edits, creates or deletes files, each round appears here with its diffs.
            </Text>
          </Box>
          {running && (
            <Box key="running" marginTop={1}>
              <Text key="live" color="claude">
                {`● Turn ${running.turn} is running`}
              </Text>
            </Box>
          )}
        </Box>
      )
    }

    const index = list.indexOf(round)
    const isLive = running?.id === round.id
    const stats = roundStats(round)
    const file = v.screen === 'file' ? shownFile(round, v) : undefined

    // ── Screen 2: one file's diff ───────────────────────────────────
    if (file) {
      const at = round.files.indexOf(file)
      const { dir, name } = splitPath(where(file.path))
      const fs = fileStats(file)
      const isNew = file.kind === 'added'
      const isGone = file.kind === 'deleted'
      const canReveal = file.changes.some(c => !c.agentId)
      const many = round.files.length > 1

      // Row 1: back at the left, the walk between the round's files at the right.
      const nav = (
        <Box key="nav" flexDirection="row" justifyContent="space-between" width={room}>
          <Button key="back" plain hotkey="b" dimColor onPress={() => move($, (_, w) => ({ ...w, screen: 'round' }))}>
            ◀ Back
          </Button>
          {many && (
            <Box key="files-nav" flexDirection="row" gap={1} flexShrink={0}>
              <Button key="prev-file" plain hotkey="p" dimColor onPress={() => move($, (l, w) => stepFile(l, w, -1))}>
                ◀
              </Button>
              <Text key="pos" dimColor>{`${at + 1}/${round.files.length}`}</Text>
              <Button key="next-file" plain hotkey="n" dimColor onPress={() => move($, (l, w) => stepFile(l, w, 1))}>
                ▶
              </Button>
            </Box>
          )}
        </Box>
      )

      // What the file is, how much changed, and where it lives.
      const title = (
        <Box key="title" flexDirection="column" marginTop={1} width={room}>
          <Box key="what" flexDirection="row" justifyContent="space-between" gap={1} width={room}>
            <Box key="who" flexDirection="row" gap={1} flexShrink={1} overflow="hidden">
              {kindBadge(file.kind)}
              <Text key="name" bold wrap="truncate-end">
                {name}
              </Text>
            </Box>
            <Box key="counts" flexDirection="row" gap={1} flexShrink={0}>
              {fs.added > 0 && <Text key="a" color={ADDED}>{`+${fs.added}`}</Text>}
              {fs.removed > 0 && <Text key="r" color={REMOVED}>{`−${fs.removed}`}</Text>}
            </Box>
          </Box>
          {dir !== '' && (
            <Box key="where" paddingLeft={4}>
              <Text key="dir" dimColor wrap="truncate-start">
                {shortDir(dir, room - 4)}
              </Text>
            </Box>
          )}
        </Box>
      )

      // The two things to do with the file.
      const openLabel = fit === 'narrow' ? 'VS Code' : 'Open in VS Code'
      const chatLabel = fit === 'narrow' ? 'chat' : 'Find in chat'
      const actions = (!isGone || canReveal) && (
        <Box key="actions" flexDirection="row" gap={2} marginTop={1} width={room}>
          {!isGone && (
            <Button key="open" hotkey="o" variant="primary" onPress={() => openInEditor($, file.path, file.changes[0]?.line ?? 1)}>
              {openLabel}
            </Button>
          )}
          {canReveal && (
            <Button
              key="reveal"
              hotkey="t"
              onPress={() => {
                const first = file.changes.find(c => !c.agentId)
                if (first) void revealInChat($, first)
              }}
            >
              {chatLabel}
            </Button>
          )}
        </Box>
      )

      const edits = file.changes.map((c, ci) => {
        const what =
          c.tool === 'Bash'
            ? 'Shell'
            : c.tool === 'Write'
              ? isNew && ci === 0
                ? 'Created'
                : 'Rewritten'
              : 'Edit'
        const several = file.changes.length > 1
        const label = several ? `${what} ${ci + 1} of ${file.changes.length}` : what
        const line = `· line ${c.line}`
        const agent = fit !== 'narrow' && c.agentId ? '· subagent' : ''
        const hasOpen = several && !isGone
        const hasChat = several && !c.agentId && fit !== 'narrow'
        const buttonsWidth = (hasOpen ? 6 : 0) + (hasChat ? 6 : 0) + (hasOpen && hasChat ? 2 : 0)
        // The rule runs from the label to the buttons (or the edge), one space between each part.
        const parts = [2, label.length, line.length, ...(agent ? [agent.length] : []), ...(buttonsWidth > 0 ? [buttonsWidth] : [])]
        // One cell spare: a rule that fills the row exactly is cut with an ellipsis.
        const fill = room - parts.reduce((n, p) => n + p, 0) - parts.length - 1
        return (
          <Box key={`edit:${ci}`} flexDirection="column" marginTop={1} width={room}>
            <Box key="head" flexDirection="row" gap={1} width={room}>
              <Text key="lead" dimColor>
                ──
              </Text>
              <Text key="label" bold>
                {label}
              </Text>
              <Text key="line" dimColor>
                {line}
              </Text>
              {agent !== '' && (
                <Text key="agent" dimColor>
                  {agent}
                </Text>
              )}
              {fill > 0 && (
                <Box key="rule" flexGrow={1} flexShrink={1} overflow="hidden">
                  <Text key="dashes" dimColor wrap="truncate-end">
                    {'─'.repeat(fill)}
                  </Text>
                </Box>
              )}
              {buttonsWidth > 0 && (
                <Box key="go" flexDirection="row" gap={2} flexShrink={0}>
                  {hasOpen && (
                    <Button key={`open:${ci}`} plain dimColor onPress={() => openInEditor($, file.path, c.line)}>
                      ↗ open
                    </Button>
                  )}
                  {hasChat && (
                    <Button key={`reveal:${ci}`} plain dimColor onPress={() => revealInChat($, c)}>
                      ⌖ chat
                    </Button>
                  )}
                </Box>
              )}
            </Box>
            {!!c.command && (
              <Text key="cmd" dimColor wrap="truncate-end">
                {`  $ ${c.command.replace(/\s+/g, ' ')}`}
              </Text>
            )}
            {c.hunks.length > 0 && (
              <Code key="diff" format="diff" source={diffSource(c.hunks)} path={file.path} language={c.language} />
            )}
            {!!c.note && (
              <Text key="note" dimColor italic>
                {c.note}
              </Text>
            )}
            {c.isTruncated && (
              <Text key="cut" dimColor italic>
                … longer than shown: press o to see it all in VS Code
              </Text>
            )}
          </Box>
        )
      })

      const estimate = diffScreenRows(file, width, dir !== '')

      return (
        <Box flexDirection="column" paddingX={1} paddingBottom={scrolls(estimate) ? 1 : 0} width={width}>
          {nav}
          {title}
          {actions}
          {edits}
          {hints([
            ...(!isGone ? [['o', 'open'] as const] : []),
            ...(canReveal ? [['t', 'chat'] as const] : []),
            ...(many ? [['p/n', 'file'] as const] : []),
            ...(scrolls(estimate) ? [['g/e', 'top/end'] as const] : []),
            ['esc', 'back'],
          ])}
          {pills(estimate)}
        </Box>
      )
    }

    // ── Screen 1: the round's overview ──────────────────────────────
    // Row 1: older ◀ which round ▶ newer.
    const isLatest = index === list.length - 1
    const nav = (
      <Box key="nav" flexDirection="row" justifyContent="space-between" width={room}>
        {index > 0 ? (
          <Button key="older" plain hotkey="p" onPress={() => move($, (l, w) => stepRound(l, w, -1))}>
            ◀
          </Button>
        ) : (
          <Text key="older-off" dimColor>
            {'   ◀'}
          </Text>
        )}
        <Box key="where" flexDirection="row" gap={1}>
          <Text key="round" bold color="claude">
            {`Round ${index + 1} of ${list.length}`}
          </Text>
          {isLive ? (
            <Text key="tag" color="claude">
              ● working
            </Text>
          ) : (
            isLatest && (
              <Text key="tag" dimColor>
                latest
              </Text>
            )
          )}
        </Box>
        {index < list.length - 1 ? (
          <Button key="newer" plain hotkey="n" onPress={() => move($, (l, w) => stepRound(l, w, 1))}>
            ▶
          </Button>
        ) : (
          <Text key="newer-off" dimColor>
            {'▶   '}
          </Text>
        )}
      </Box>
    )

    // The prompt, up to two lines behind an accent bar; under it, which turn, how long, when.
    const meta = [
      `turn ${round.turn}`,
      round.durationMs ? duration(round.durationMs) : '',
      round.startedAt > 0 ? clock(round.startedAt) : 'earlier',
    ]
      .filter(Boolean)
      .join(' · ')
    const prompt = (
      <Box key="prompt" flexDirection="column" marginTop={1} width={room}>
        {wrapLines(promptLine(round.prompt), room - 2, 2).map((line, i) => (
          <Box key={`prompt:${i}`} flexDirection="row" gap={1}>
            <Text key="bar" color="claude">
              ▎
            </Text>
            <Text key="text" italic wrap="truncate-end">
              {line}
            </Text>
          </Box>
        ))}
        {fit !== 'narrow' && (
          <Box key="meta" paddingLeft={2}>
            <Text key="text" dimColor>
              {meta}
            </Text>
          </Box>
        )}
      </Box>
    )

    const summary = (
      <Box key="summary" flexDirection="row" gap={1} marginTop={1} width={room}>
        <Text key="count" bold>
          {stats.files > 0 ? `${plural(stats.files, 'file')} changed` : 'No file changes recorded'}
        </Text>
        {stats.added > 0 && <Text key="a" color={ADDED}>{`+${stats.added}`}</Text>}
        {stats.removed > 0 && <Text key="r" color={REMOVED}>{`−${stats.removed}`}</Text>}
      </Box>
    )

    const shell = round.shellCommands
    const warning = shell > 0 && (
      <Box key="warning" marginTop={1} width={room}>
        <Text key="text" color="warning" wrap={fit === 'narrow' ? 'truncate-end' : 'wrap'}>
          {shellWarning(shell, round.isOutsideRepo === true, fit === 'narrow')}
        </Text>
      </Box>
    )

    // One row per file: its kind, then one Button from the number to the counts, so a
    // click anywhere on the row opens it (a label holds no colors; the badge and the
    // size bar after it keep theirs).
    const largest = Math.max(1, ...round.files.map(f => fileStats(f).added + fileStats(f).removed))
    const badgeWidth = 3
    const barWidth = fit === 'narrow' ? 0 : 5
    const labelRoom = room - badgeWidth - 1 - 3 - (barWidth > 0 ? barWidth + 1 : 0)
    const rows = round.files.map((f, i) => {
      const { dir, name } = splitPath(where(f.path))
      const s = fileStats(f)
      const bar = sizeBar(s.added, s.removed, largest, barWidth)
      const counts = s.added + s.removed === 0 ? '±0' : [s.added > 0 && `+${s.added}`, s.removed > 0 && `−${s.removed}`].filter(Boolean).join(' ')
      const hotkey = i < 9 ? String(i + 1) : undefined
      // A row past the ninth has no `n: ` before it: three spaces keep it in line.
      const label = `${hotkey ? '' : '   '}${fileRowLabel(name, fit === 'narrow' ? '' : dir, counts, labelRoom)}`
      return (
        <Box key={`row:${i}`} flexDirection="row" gap={1} width={room}>
          {kindBadge(f.kind)}
          <Button
            key={`file:${i}`}
            plain
            hotkey={hotkey}
            onPress={() => move($, (_, w) => ({ roundId: w.roundId, file: f.path, screen: 'file' }))}
          >
            {label}
          </Button>
          {barWidth > 0 && (
            <Box key="bar" width={barWidth} flexShrink={0}>
              <Text key="p" color={ADDED}>
                {'■'.repeat(bar.plus)}
              </Text>
              <Text key="m" color={REMOVED}>
                {'■'.repeat(bar.minus)}
              </Text>
              <Text key="x" dimColor>
                {'·'.repeat(bar.rest)}
              </Text>
            </Box>
          )}
        </Box>
      )
    })

    const n = round.files.length
    const estimate = wantedRows(round, undefined, 'round', width)
    return (
      <Box flexDirection="column" paddingX={1} paddingBottom={scrolls(estimate) ? 1 : 0} width={width}>
        {nav}
        {prompt}
        {summary}
        {n > 0 && (
          <Box key="files" flexDirection="column" marginTop={1} width={room}>
            {rows}
          </Box>
        )}
        {warning}
        {hints([
          ...(n > 0 ? [[n === 1 ? '1' : `1-${Math.min(9, n)}`, 'open'] as const] : []),
          ['p/n', 'round'],
          ...(scrolls(estimate) ? [['g/e', 'top/end'] as const] : []),
          ['esc', 'close'],
        ])}
        {pills(estimate)}
      </Box>
    )
  })
}
