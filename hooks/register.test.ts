import { expect, mock, test } from 'claude-code/testing'

import type { Live, Round } from '../types'
import {
  addedHunk,
  capHunks,
  diffSource,
  displayPath,
  firstChangedLine,
  makeChange,
  recordChange,
  roundsFromTranscript,
  parseGitDiff,
  mergeKind,
  shortDir,
  stepFile,
  stepRound,
} from './model'

const HUNK = {
  oldStart: 40,
  oldLines: 4,
  newStart: 40,
  newLines: 5,
  lines: [' a', ' b', '-old', '+new', '+more', ' c'],
}

test('finds the first changed line in the new file', () => {
  expect(firstChangedLine([HUNK])).toBe(42)
  expect(firstChangedLine(addedHunk('x\ny\n'))).toBe(1)
  expect(firstChangedLine([])).toBe(1)
})

test('cuts a long diff and recounts the cut hunk so it still parses', () => {
  const { hunks, isTruncated } = capHunks([HUNK], 4)
  expect(isTruncated).toBe(true)
  expect(hunks[0]).toEqual({ ...HUNK, oldLines: 3, newLines: 3, lines: [' a', ' b', '-old', '+new'] })
  expect(capHunks([HUNK]).isTruncated).toBe(false)
})

test('writes hunks as a unified diff', () => {
  expect(diffSource(addedHunk('one\ntwo\n'))).toBe('@@ -0,0 +1,2 @@\n+one\n+two')
})

test('shows paths relative to the project, or under home', () => {
  expect(displayPath('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
  expect(displayPath('/home/me/x.md', '/repo', '/home/me')).toBe('~/x.md')
  expect(displayPath('/etc/hosts', '/repo')).toBe('/etc/hosts')
})

const live = (id: string, turn: number): Live => ({ id, turn, prompt: `p${turn}`, startedAt: 0, shellCommands: 0 })
const change = (id: string) => makeChange({ toolUseId: id, tool: 'Edit' }, [HUNK])

test('groups changes by round, then by file in the order touched', () => {
  let rounds: Round[] = []
  rounds = recordChange(rounds, live('t1', 1), '/r/a.ts', 'modified', change('1'))
  rounds = recordChange(rounds, live('t1', 1), '/r/b.ts', 'added', change('2'))
  rounds = recordChange(rounds, live('t1', 1), '/r/a.ts', 'modified', change('3'))
  rounds = recordChange(rounds, live('t3', 3), '/r/c.ts', 'modified', change('4'))
  expect(rounds.map(r => r.turn)).toEqual([1, 3])
  expect(rounds[0]?.files.map(f => [f.path, f.changes.length])).toEqual([
    ['/r/a.ts', 2],
    ['/r/b.ts', 1],
  ])
  expect(rounds[0]?.files[0]?.changes[0]?.added).toBe(2)
})

test('steps between rounds and follows the newest again at the end', () => {
  let rounds: Round[] = []
  for (const n of [1, 2, 3]) rounds = recordChange(rounds, live(`t${n}`, n), `/r/${n}.ts`, 'modified', change(`${n}`))
  const back = stepRound(rounds, { roundId: null, file: null, screen: 'round' }, -1)
  expect(back).toEqual({ roundId: 't2', file: null, screen: 'round' })
  expect(stepRound(rounds, back, -5)).toEqual({ roundId: 't1', file: null, screen: 'round' })
  expect(stepRound(rounds, back, 1)).toEqual({ roundId: null, file: null, screen: 'round' })
})

test('walks the files of a round, wrapping', () => {
  let rounds: Round[] = []
  for (const f of ['a', 'b']) rounds = recordChange(rounds, live('t1', 1), `/r/${f}`, 'modified', change(f))
  const v = stepFile(rounds, { roundId: null, file: null, screen: 'file' }, 1)
  expect(v.file).toBe('/r/b')
  expect(stepFile(rounds, v, 1).file).toBe('/r/a')
  expect(stepFile(rounds, v, -1).file).toBe('/r/a')
})

const PANE_PROPS = {
  title: 'Changes',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pane lists the files a round touched and opens one in VS Code on ${surface}`, async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') })
    const opened: string[][] = []
    on('process.run', ($, e) => {
      opened.push([...e.argv])
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    on('ui.status', () => ({ value: undefined }))
    mock.store(on)
    const resized: (number | undefined)[] = []
    on('ui.open', ($, e) => {
      resized.push(e.rows)
      return { value: { isPlaced: true as const } }
    })
    on('ui.toast', () => ({ value: undefined }))
    on('tool.call', ($, e) => {
      if (e.tool === 'Edit')
        return {
          result: {
            filePath: e.file_path,
            oldString: e.old_string,
            newString: e.new_string,
            originalFile: 'x',
            structuredPatch: [HUNK],
            userModified: false,
            replaceAll: false,
          },
        }
      if (e.tool === 'Write')
        return {
          result: { type: 'create' as const, filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null },
        }
      return { deny: 'not in this test' }
    })

    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/theme.ts', old_string: 'old', new_string: 'new\nmore' })
    await $.tool.call({ tool: 'Write', file_path: '/repo/src/dark.css', content: 'body {}\n' })

    const pane = await $.ui.mount({
      plugin: 'round-changes',
      surface,
      component: 'Pane',
      requestId: 'round-changes',
      props: PANE_PROPS,
    })
    // The overview: the round, its totals, one clickable row per file.
    expect(await pane.find({ text: 'Round 1 of 1' })).toBeDefined()
    expect(await pane.find({ text: '2 files changed' })).toBeDefined()
    expect(await pane.find({ key: 'file:0' })).toBeDefined()
    expect(await pane.find({ key: 'file:1' })).toBeDefined()
    expect(await pane.find({ text: ' A ' })).toBeDefined()
    // The footer hints: the key to open a file, the round walk, close.
    expect(await pane.find({ text: '1-2' })).toBeDefined()
    expect(await pane.find({ text: 'p/n' })).toBeDefined()
    expect(await pane.find({ text: 'esc' })).toBeDefined()

    // A file opens its own screen: badge, actions, the diff.
    await pane.press({ key: 'file:1' })
    expect(await pane.find({ text: ' A ' })).toBeDefined()
    expect(await pane.find({ text: 'Created' })).toBeDefined()
    expect(await pane.find({ key: 'file:0' })).toBeUndefined()

    await pane.press({ key: 'open' })
    expect(opened).toEqual([['code', '-r', '-g', '/repo/src/dark.css:1']])

    await pane.press({ key: 'prev-file' })
    expect(await pane.find({ text: '· line 42' })).toBeDefined()
    expect(await pane.find({ text: ' M ' })).toBeDefined()

    await pane.press({ key: 'back' })
    expect(await pane.find({ key: 'file:0' })).toBeDefined()
    expect(resized.length).toBe(3)

    // Narrow: no folder, no bars, still every file and its counts.
    await pane.redraw({ ...PANE_PROPS, bodyColumns: 40 })
    expect(await pane.find({ key: 'file:1' })).toBeDefined()
    expect(await pane.find({ text: 'src' })).toBeUndefined()
    await pane.unmount()
  })
}

test('rebuilds rounds from the transcript, one per typed prompt', () => {
  const edit = (id: string, path: string) => ({
    tool_use_id: id,
    tool: 'Edit',
    result: { filePath: path, structuredPatch: [HUNK] },
  })
  const { rounds, turns } = roundsFromTranscript([
    { role: 'user', text: 'first', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [edit('a', '/r/a.ts'), { tool_use_id: 'b', tool: 'Read', result: {} }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{}] },
    { role: 'assistant', text: '', toolUses: [edit('c', '/r/a.ts')] },
    { role: 'user', text: 'second, no edits', toolUses: [] },
    { role: 'user', text: 'third', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'd', tool: 'Write', result: { type: 'create', filePath: '/r/n.md', content: 'hi\n', structuredPatch: [] } }] },
  ])
  expect(turns).toBe(3)
  expect(rounds.map(r => [r.turn, r.prompt, r.files.map(f => [f.path, f.kind, f.changes.length])])).toEqual([
    [1, 'first', [['/r/a.ts', 'modified', 2]]],
    [3, 'third', [['/r/n.md', 'added', 1]]],
  ])
})

test('shortens folders by whole segments from the end', () => {
  expect(shortDir('~/.claude/dev-mods/fe9cda15-d723/round-changes/hooks', 24)).toBe('…/round-changes/hooks')
  expect(shortDir('src/settings', 20)).toBe('src/settings')
  expect(shortDir('a/averyveryverylongfoldername', 10)).toBe('…oldername')
})

const GIT_DIFF = [
  'diff --git a/src/x.txt b/src/x.txt',
  'index de98044..7be73ce 100644',
  '--- a/src/x.txt',
  '+++ b/src/x.txt',
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+B',
  ' c',
  'diff --git a/y.txt b/y.txt',
  'deleted file mode 100644',
  'index 2fa992c..0000000',
  '--- a/y.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-keep',
  'diff --git a/z.txt b/z.txt',
  'new file mode 100644',
  'index 0000000..3e75765',
  '--- /dev/null',
  '+++ b/z.txt',
  '@@ -0,0 +1 @@',
  '+new',
  'diff --git a/logo.png b/logo.png',
  'index 1111111..2222222 100644',
  'Binary files a/logo.png and b/logo.png differ',
  '',
].join('\n')

test('reads a git diff into files: modified, deleted, added, binary', () => {
  const files = parseGitDiff(GIT_DIFF)
  expect(files.map(f => [f.path, f.kind, f.hunks.length, f.isBinary])).toEqual([
    ['src/x.txt', 'modified', 1, false],
    ['y.txt', 'deleted', 1, false],
    ['z.txt', 'added', 1, false],
    ['logo.png', 'modified', 0, true],
  ])
  expect(files[1]?.hunks[0]).toEqual({ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ['-keep'] })
  expect(files[2]?.hunks[0]).toEqual({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+new'] })
})

test('a file created then deleted in one round reads deleted', () => {
  expect(mergeKind('added', 'deleted')).toBe('deleted')
  expect(mergeKind('deleted', 'added')).toBe('modified')
  expect(mergeKind('added', 'modified')).toBe('added')
})

test('a shell command that changes files shows its diffs, deletions included', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') })
  let trees = 0
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[1] === 'rev-parse') return out('/repo\n/repo/.git\n')
    if (argv[0] === 'sh' && argv[2]?.includes('write-tree')) return out(`${String(++trees).repeat(40)}\n`)
    if (argv.includes('diff')) return out(GIT_DIFF)
    return out('')
  })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'Bash', command: "sed -i 's/b/B/' src/x.txt && rm y.txt && echo new > z.txt" })

  const pane = await $.ui.mount({ plugin: 'round-changes', surface: 'terminal', component: 'Pane', requestId: 'round-changes', props: PANE_PROPS })
  expect(await pane.find({ text: '4 files changed' })).toBeDefined()
  expect(await pane.find({ text: ' D ' })).toBeDefined()
  expect(await pane.find({ text: ' A ' })).toBeDefined()
  await pane.unmount()
})

test('outside a git repo, shell commands still show their round, with a warning', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') })
  on('session.cwd', () => ({ value: '/plain' }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'Bash', command: 'mv a.json b.json' })

  const pane = await $.ui.mount({ plugin: 'round-changes', surface: 'terminal', component: 'Pane', requestId: 'round-changes', props: PANE_PROPS })
  expect(await pane.find({ text: /^⚠ 1 shell command ran outside a git repo, so its changes can't be shown\. Run git init to track them\.$/ })).toBeDefined()
  await pane.unmount()
})

test('a repo made mid-session (git init) is found at the next shell command', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') })
  let isRepo = false
  let trees = 0
  on('session.cwd', () => ({ value: '/later' }))
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    const out = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (argv[1] === 'rev-parse') return isRepo ? out('/later\n/later/.git\n') : out('', 128)
    if (argv[0] === 'sh' && argv[2]?.includes('write-tree')) return out(`${String(++trees).repeat(40)}\n`)
    if (argv.includes('diff')) return out(GIT_DIFF)
    return out('')
  })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  isRepo = true
  await $.tool.call({ tool: 'Bash', command: "sed -i 's/b/B/' src/x.txt && rm y.txt && echo new > z.txt" })

  const pane = await $.ui.mount({ plugin: 'round-changes', surface: 'terminal', component: 'Pane', requestId: 'round-changes', props: PANE_PROPS })
  expect(await pane.find({ text: '4 files changed' })).toBeDefined()
  await pane.unmount()
})

test('a scrolled viewer offers the top once scrolled down and the bottom only while more is below', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-07T12:00:00Z') })
  on('tool.call', ($, e) =>
    e.tool === 'Edit'
      ? { result: { filePath: e.file_path, oldString: '', newString: '', originalFile: 'x', structuredPatch: [HUNK], userModified: false, replaceAll: false } }
      : { deny: 'not in this test' },
  )
  for (const f of ['a', 'b', 'c', 'd']) await $.tool.call({ tool: 'Edit', file_path: `/repo/${f}.ts`, old_string: 'old', new_string: 'new' })

  const short = { ...PANE_PROPS, scroll: { offset: 0, bodyRows: 5 } }
  const pane = await $.ui.mount({ plugin: 'round-changes', surface: 'terminal', component: 'Pane', requestId: 'round-changes', props: short })
  expect(await pane.find({ key: 'bottom' })).toBeDefined()
  expect(await pane.find({ key: 'top' })).toBeUndefined()

  // At the end: back to the top, nothing more below.
  await pane.redraw({ ...short, scroll: { offset: 100, bodyRows: 5 } })
  expect(await pane.find({ key: 'top' })).toBeDefined()
  expect(await pane.find({ key: 'bottom' })).toBeUndefined()

  // A tree that fits shows neither.
  await pane.redraw({ ...short, scroll: { offset: 0, bodyRows: 40 } })
  expect(await pane.find({ key: 'top' })).toBeUndefined()
  expect(await pane.find({ key: 'bottom' })).toBeUndefined()
  await pane.unmount()
})
