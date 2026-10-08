/** One unified-diff hunk, as Edit and Write report it. */
export type Hunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

/** One tool call that changed a file. */
export type Change = {
  toolUseId: string
  tool: 'Edit' | 'Write' | 'NotebookEdit' | 'Bash'
  /** The shell command that made the change, for a Bash change. */
  command?: string
  /** Set when a subagent made the change: its row is not in the main transcript. */
  agentId?: string
  hunks: Hunk[]
  added: number
  removed: number
  /** The first changed line in the file after the change, 1-based. */
  line: number
  /** Lines were dropped to keep the stored diff small. */
  isTruncated: boolean
  /** Why there is no diff to show, when there is none. */
  note?: string
  language?: string
}

export type FileTouch = {
  path: string
  kind: 'added' | 'modified' | 'deleted'
  changes: Change[]
}

export type Round = {
  id: string
  /** The turn's ordinal in the session. */
  turn: number
  prompt: string
  startedAt: number
  endedAt?: number
  files: FileTouch[]
  /** The turn's length as turn.complete reported it: what finds its "Baked for" line. */
  durationMs?: number
  /** Shell commands run this round whose changes could not be captured. */
  shellCommands: number
  /** Some of them ran outside any git repo (the rest, if any, failed to snapshot). */
  isOutsideRepo?: boolean
}

/** The turn running now, before or after its first change. */
export type Live = {
  id: string
  turn: number
  prompt: string
  startedAt: number
  shellCommands: number
}

/**
 * What the viewer shows: a round (null follows the newest), and either its
 * overview or one file's diff.
 */
export type View = { roundId: string | null; file: string | null; screen: 'round' | 'file' }

declare module 'claude-code' {
  interface PluginState {
    'round-changes': {
      rounds: Round[]
      live: Live | null
      turns: number
      view: View
      cwd: string
      home: string
      /** The viewer's tree height as the engine measured it at the last scroll, and on which screen (`viewKey`). */
      scroll: { key: string; contentRows: number } | null
    }
  }
}
