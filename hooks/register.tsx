import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallInput, ToolCallResult } from 'claude-code'

import type { Change, FileTouch, Live, Round, View } from '../types'
import {
  diffScreenRows,
  diffSource,
  displayPath,
  duration,
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
  wantedRows,
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
const noRepo = atom({ plugin: 'round-changes', key: 'noRepo' } as const, false)

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

// The repo is looked up once per load; snapshots run one at a time, as they share an index.
let repoLookup: Promise<Repo | null> | undefined
let queue: Promise<unknown> = Promise.resolve()

function repoFor($: EngineInterface): Promise<Repo | null> {
  repoLookup ??= $.session.cwd().then(dir => findRepo($, dir)).catch(() => null)
  return repoLookup
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
    await update($, noRepo, () => repo === null)
    const into = await currentRound($)
    await update($, live, l => (l && l.id === into.id ? { ...l, shellCommands: l.shellCommands + 1 } : l))
    await update($, rounds, list => countShell(list, into))
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
              {s.files === 0 && counts ? 'no git: shell changes not tracked' : 'no git'}
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
    const noGit = newest.shellCommands > 0 ? 'no git ' : ''
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
          {noGit && (
            <Text key="nogit" color="yellow">
              no git
            </Text>
          )}
          <Button key="footer-changes" plain dimColor onPress={() => showRound($, newest.id)}>
            {files}
          </Button>
          {withCounts && s.added > 0 && <Text key="a" color={ADDED}>{`+${s.added}`}</Text>}
          {withCounts && s.removed > 0 && <Text key="r" color={REMOVED}>{`−${s.removed}`}</Text>}
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
    const fit = fitFor(width)
    const round = shownRound(list, v)

    const keyHelp = (text: string) => (
      <Text key="help" dimColor wrap="truncate-end">
        {text}
      </Text>
    )

    if (!round) {
      return (
        <Box flexDirection="column" paddingX={1} width={width}>
          <Text key="title" bold>
            Nothing changed yet
          </Text>
          <Text key="hint" dimColor>
            When Claude edits or creates files, each round shows up here with its diffs.
          </Text>
          {running && (
            <Text key="live" color="claude">
              {`● Turn ${running.turn} is running`}
            </Text>
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

      const nav = many && (
        <Box key="files-nav" flexDirection="row" gap={1} flexShrink={0}>
          <Button key="prev-file" plain hotkey="p" dimColor onPress={() => move($, (l, w) => stepFile(l, w, -1))}>
            ◀
          </Button>
          <Text key="pos" dimColor>{`${at + 1}/${round.files.length}`}</Text>
          <Button key="next-file" plain hotkey="n" dimColor onPress={() => move($, (l, w) => stepFile(l, w, 1))}>
            ▶
          </Button>
        </Box>
      )

      // Row 1: back, what the file is, how much changed; the file walk at the right.
      const titleRow = (
        <Box key="title" flexDirection="row" justifyContent="space-between" width={width}>
          <Box key="left" flexDirection="row" gap={1} flexShrink={1} overflow="hidden">
            <Button key="back" plain hotkey="b" dimColor onPress={() => move($, (_, w) => ({ ...w, screen: 'round' }))}>
              ◀
            </Button>
            <Text key="badge" bold color="inverseText" backgroundColor={isGone ? 'error' : isNew ? 'success' : 'warning'}>
              {isGone ? ' DEL ' : isNew ? ' NEW ' : ' EDIT '}
            </Text>
            <Text key="name" bold wrap="truncate-end">
              {name}
            </Text>
            {fs.added > 0 && <Text key="a" color={ADDED}>{`+${fs.added}`}</Text>}
            {fs.removed > 0 && <Text key="r" color={REMOVED}>{`−${fs.removed}`}</Text>}
          </Box>
          {nav}
        </Box>
      )

      // Row 2: the folder, and the two things to do with the file.
      const openLabel = isGone ? '' : fit === 'narrow' ? 'VS Code' : 'Open in VS Code'
      const chatLabel = fit === 'narrow' ? 'chat' : 'Find in chat'
      const actionsWidth = (isGone ? 0 : openLabel.length + 6) + (canReveal ? chatLabel.length + 7 : 0)
      const actionRow = (
        <Box key="actions" flexDirection="row" justifyContent="space-between" width={width}>
          <Text key="dir" dimColor>
            {shortDir(dir, width - actionsWidth - 2)}
          </Text>
          <Box key="do" flexDirection="row" gap={1} flexShrink={0}>
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
        const label = file.changes.length > 1 ? `${what} ${ci + 1}/${file.changes.length}` : what
        return (
          <Box key={`edit:${ci}`} flexDirection="column" width={width}>
            <Box key="head" flexDirection="row" justifyContent="space-between" width={width}>
              <Box key="what" flexDirection="row" gap={1}>
                <Text key="bar" color="claude">
                  ▍
                </Text>
                <Text key="label" bold>
                  {label}
                </Text>
                <Text key="line" dimColor>{`· line ${c.line}`}</Text>
                {fit !== 'narrow' && c.agentId && (
                  <Text key="agent" dimColor>
                    · subagent
                  </Text>
                )}
              </Box>
              {file.changes.length > 1 && (
                <Box key="go" flexDirection="row" gap={2}>
                  {!isGone && (
                    <Button key={`open:${ci}`} plain dimColor onPress={() => openInEditor($, file.path, c.line)}>
                      ↗ open
                    </Button>
                  )}
                  {!c.agentId && fit !== 'narrow' && (
                    <Button key={`reveal:${ci}`} plain dimColor onPress={() => revealInChat($, c)}>
                      ⌖ chat
                    </Button>
                  )}
                </Box>
              )}
            </Box>
            {c.command && (
              <Text key="cmd" dimColor wrap="truncate-end">
                {`  $ ${c.command.replace(/\s+/g, ' ')}`}
              </Text>
            )}
            {c.hunks.length > 0 && (
              <Code key="diff" format="diff" source={diffSource(c.hunks)} path={file.path} language={c.language} />
            )}
            {c.note && (
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

      // Like the chat's own: a pill at the window's foot while there is more below.
      const { offset, bodyRows } = e.props.scroll
      const moreBelow = diffScreenRows(file, width) - (offset + bodyRows)
      const jump = moreBelow > 0 && (
        <Box key="jump" position="absolute" top={offset + bodyRows - 1} right={1}>
          <Button key="bottom" hotkey="e" variant="primary" onPress={() => scrollPane($, 'end')}>
            {fit === 'narrow' ? '⤓' : '⤓ jump to bottom'}
          </Button>
        </Box>
      )

      return (
        <Box flexDirection="column" width={width}>
          {titleRow}
          {actionRow}
          {edits}
          {keyHelp(
            fit === 'narrow'
              ? 'o code · t chat · esc back'
              : `o VS Code · t find in chat · ${many ? 'p/n file · ' : ''}↑↓ scroll · e bottom · esc back`,
          )}
          {jump}
        </Box>
      )
    }

    // ── Screen 1: the round's overview ──────────────────────────────
    // Row 1: older ◀ ROUND ▶ newer, the totals, and when.
    const header = (
      <Box key="nav" flexDirection="row" justifyContent="space-between" width={width}>
        <Box key="steps" flexDirection="row" gap={1}>
          {index > 0 ? (
            <Button key="older" plain hotkey="p" onPress={() => move($, (l, w) => stepRound(l, w, -1))}>
              ◀
            </Button>
          ) : (
            <Text key="older-off" dimColor>
              {'   ◀'}
            </Text>
          )}
          <Text key="where" bold color="inverseText" backgroundColor="claude">
            {` ROUND ${index + 1}/${list.length} `}
          </Text>
          {index < list.length - 1 ? (
            <Button key="newer" plain hotkey="n" onPress={() => move($, (l, w) => stepRound(l, w, 1))}>
              ▶
            </Button>
          ) : (
            <Text key="newer-off" dimColor>
              {'▶   '}
            </Text>
          )}
          <Text key="files" bold>
            {stats.files > 0 ? ` ${plural(stats.files, 'file')}` : ' no tracked files'}
          </Text>
          {stats.added > 0 && <Text key="a" color={ADDED}>{`+${stats.added}`}</Text>}
          {stats.removed > 0 && <Text key="r" color={REMOVED}>{`−${stats.removed}`}</Text>}
        </Box>
        {isLive ? (
          <Text key="when" color="claude">
            ● working
          </Text>
        ) : (
          fit === 'wide' && (
            <Text key="when" dimColor>
              {`turn ${round.turn}` +
                (round.durationMs ? ` · ${duration(round.durationMs)}` : round.startedAt === 0 ? ' · earlier' : '')}
            </Text>
          )
        )}
      </Box>
    )

    const prompt = (
      <Text key="prompt" italic wrap="truncate-end">
        {`“${keepStart(promptLine(round.prompt), Math.max(10, width * 2 - 4))}”`}
      </Text>
    )

    const shell = round.shellCommands
    const isGitless = await read($, noRepo)
    const warning = shell > 0 && (
      <Text key="warning" color="warning" wrap={fit === 'narrow' ? 'truncate-end' : 'wrap'}>
        {fit === 'narrow'
          ? `⚠ ${isGitless ? 'No git' : 'Untracked'}: ${plural(shell, 'shell command')} not shown`
          : isGitless
            ? `⚠ Not a git repo: ${plural(shell, 'shell command')} may have changed files that can't be shown here. Run git init to see them.`
            : `⚠ ${plural(shell, 'shell command')} ran while the work tree could not be snapshotted: their changes are not shown.`}
      </Text>
    )

    // One row per file: number + name to click, folder, badge, counts, size bar.
    const largest = Math.max(1, ...round.files.map(f => fileStats(f).added + fileStats(f).removed))
    const statsWidth = 11
    const badgeWidth = 5
    const barWidth = fit === 'wide' ? 7 : 0
    const nameRoom = width - 4 - statsWidth - badgeWidth - barWidth
    const rows = round.files.map((f, i) => {
      const { dir, name } = splitPath(where(f.path))
      const s = fileStats(f)
      const bar = sizeBar(s.added, s.removed, largest)
      const nameText = keepStart(name, Math.max(6, fit === 'wide' ? Math.min(28, nameRoom) : nameRoom))
      const dirRoom = nameRoom - nameText.length - 1
      return (
        <Box key={`row:${i}`} flexDirection="row" width={width}>
          <Box key="pick" flexDirection="row" flexGrow={1} flexShrink={1} gap={1} overflow="hidden">
            <Button
              key={`file:${i}`}
              plain
              hotkey={i < 9 ? String(i + 1) : undefined}
              onPress={() => move($, (_, w) => ({ roundId: w.roundId, file: f.path, screen: 'file' }))}
            >
              {nameText}
            </Button>
            {fit !== 'narrow' && dirRoom > 3 && (
              <Text key="dir" dimColor wrap="truncate-start">
                {shortDir(dir, dirRoom)}
              </Text>
            )}
          </Box>
          <Box key="kind" width={badgeWidth} flexShrink={0} justifyContent="flex-end">
            <Text key="badge" color={f.kind === 'added' ? 'success' : f.kind === 'deleted' ? 'error' : 'warning'} bold>
              {f.kind === 'added' ? 'NEW' : f.kind === 'deleted' ? 'DEL' : 'M'}
            </Text>
          </Box>
          <Box key="nums" width={statsWidth} flexShrink={0} justifyContent="flex-end" gap={1}>
            {s.added > 0 && <Text key="a" color={ADDED}>{`+${s.added}`}</Text>}
            {s.removed > 0 && <Text key="r" color={REMOVED}>{`−${s.removed}`}</Text>}
            {s.added + s.removed === 0 && (
              <Text key="z" dimColor>
                ±0
              </Text>
            )}
          </Box>
          {barWidth > 0 && (
            <Box key="bar" width={barWidth} flexShrink={0} justifyContent="flex-end">
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
    const pick = n === 1 ? '1 diff' : `1-${Math.min(9, n)} diff`
    return (
      <Box flexDirection="column" width={width}>
        {header}
        {prompt}
        {warning}
        {rows}
        {keyHelp(
          n === 0
            ? 'p/n older/newer round · esc close'
            : fit === 'narrow'
              ? `${pick} · p/n round · esc`
              : `click a file or ${pick} · p/n older/newer round · esc close`,
        )}
      </Box>
    )
  })
}
