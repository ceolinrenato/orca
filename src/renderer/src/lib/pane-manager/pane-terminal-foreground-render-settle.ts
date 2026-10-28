import { forceRepaintThroughRenderPause } from './terminal-render-pause-release'
import {
  armTrailingForcedRefresh,
  consumeSuppressedFollowupRefresh,
  discardForcedRefreshWindow,
  noteSuppressedParseLanded,
  noteSuppressedRepair,
  takeForcedRefreshSlot
} from './terminal-forced-refresh-window'
import {
  disposeParsedDirtyRows,
  readParsedDirtyRowSpan,
  resetParsedDirtyRows,
  type ParsedDirtyRowSpan
} from './terminal-parsed-dirty-rows'
import { runGuardedWriteCompletionStep } from './xterm-write-callback-guard'

export { FORCED_REFRESH_MIN_MS } from './terminal-forced-refresh-window'

export type ForegroundTerminalOutputTarget = {
  buffer?: {
    active?: {
      type?: string
      cursorY?: number
      baseY?: number
      viewportY?: number
    }
  }
  rows?: number
  _core?: {
    refresh?(start: number, end: number, sync?: boolean): void
  }
  refresh?(start: number, end: number): void
  write(data: string, callback?: () => void): void
}

type ForegroundTerminalWriteOptions = {
  forceViewportRefresh?: boolean
  // Why opt-in: replay/snapshot repairs must not be throttled; only the live output writers pass this.
  throttleForcedRefresh?: boolean
  followupViewportRefresh?: boolean
  shouldRefreshViewportSynchronously?: () => boolean
  shouldReleaseRenderPause?: () => boolean
  onParsed?: () => void
  onWriteFailure?: () => void
}

const pendingViewportSettleRefreshByTerminal = new WeakMap<
  ForegroundTerminalOutputTarget,
  { kind: 'raf'; id: number } | { kind: 'timeout'; id: ReturnType<typeof setTimeout> }
>()

type ViewportSnapshot = {
  type: string | null
  cursorY: number | null
  baseY: number | null
  viewportY: number | null
}

function refreshVisibleRows(
  terminal: ForegroundTerminalOutputTarget,
  synchronously: boolean,
  shouldReleaseRenderPause?: () => boolean,
  span?: ParsedDirtyRowSpan | null
): void {
  if (typeof terminal.rows !== 'number' || terminal.rows < 1) {
    return
  }

  try {
    // Only reveal-owned replay may override paused rendering; ordinary/newly-hidden output must preserve it.
    if (shouldReleaseRenderPause?.() === true && forceRepaintThroughRenderPause(terminal)) {
      return
    }
    const lastRow = Math.max(0, terminal.rows - 1)
    // xterm unions dirty ranges; use this parse’s span to avoid a full-grid walk on every frame, retaining null as full repaint.
    const start = span ? Math.min(Math.max(span.start, 0), lastRow) : 0
    const end = span ? Math.min(Math.max(span.end, start), lastRow) : lastRow
    // Windows DOM rewrites need immediate repair; WebGL merges into its queued frame.
    if (synchronously && typeof terminal._core?.refresh === 'function') {
      terminal._core.refresh(start, end, true)
      return
    }
    if (typeof terminal.refresh === 'function') {
      terminal.refresh(start, end)
      return
    }
    terminal._core?.refresh?.(start, end, false)
  } catch {
    // Ignore disposed terminals; PTY output can race pane teardown.
  }
}

function captureViewportSnapshot(terminal: ForegroundTerminalOutputTarget): ViewportSnapshot {
  const active = terminal.buffer?.active
  return {
    type: typeof active?.type === 'string' ? active.type : null,
    cursorY: typeof active?.cursorY === 'number' ? active.cursorY : null,
    baseY: typeof active?.baseY === 'number' ? active.baseY : null,
    viewportY: typeof active?.viewportY === 'number' ? active.viewportY : null
  }
}

function viewportChangedDuringWrite(
  beforeWrite: ViewportSnapshot,
  afterWrite: ViewportSnapshot
): boolean {
  return (
    afterWrite.baseY !== null &&
    afterWrite.viewportY !== null &&
    (afterWrite.baseY !== beforeWrite.baseY || afterWrite.viewportY !== beforeWrite.viewportY)
  )
}

/** Repair parse-dirty rows plus cursor rows before/after writing; WebGL drops the cursor if omitted. Unknown span, viewport scroll or buffer flip requires full repaint (null) because prior row coordinates no longer apply. */
function repairRowSpan(
  terminal: ForegroundTerminalOutputTarget,
  beforeWrite: ViewportSnapshot,
  afterWrite: ViewportSnapshot
): ParsedDirtyRowSpan | null {
  if (beforeWrite.type !== afterWrite.type || viewportChangedDuringWrite(beforeWrite, afterWrite)) {
    return null
  }
  const parsed = readParsedDirtyRowSpan(terminal)
  if (!parsed) {
    return null
  }
  let { start, end } = parsed
  for (const cursorY of [beforeWrite.cursorY, afterWrite.cursorY]) {
    if (cursorY === null) {
      return null
    }
    start = Math.min(start, cursorY)
    end = Math.max(end, cursorY)
  }
  return { start, end }
}

function cancelScheduledViewportSettleRefresh(terminal: ForegroundTerminalOutputTarget): void {
  const pending = pendingViewportSettleRefreshByTerminal.get(terminal)
  if (!pending) {
    return
  }
  pendingViewportSettleRefreshByTerminal.delete(terminal)
  if (pending.kind === 'raf') {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(pending.id)
    }
    return
  }
  clearTimeout(pending.id)
}

function scheduleViewportSettleRefresh(
  terminal: ForegroundTerminalOutputTarget,
  shouldRefreshSynchronously?: () => boolean,
  shouldReleaseRenderPause?: () => boolean
): void {
  cancelScheduledViewportSettleRefresh(terminal)
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => {
      pendingViewportSettleRefreshByTerminal.delete(terminal)
      refreshVisibleRows(terminal, shouldRefreshSynchronously?.() ?? true, shouldReleaseRenderPause)
    })
    pendingViewportSettleRefreshByTerminal.set(terminal, { kind: 'raf', id })
    return
  }

  const id = setTimeout(() => {
    pendingViewportSettleRefreshByTerminal.delete(terminal)
    refreshVisibleRows(terminal, shouldRefreshSynchronously?.() ?? true, shouldReleaseRenderPause)
  }, 16)
  pendingViewportSettleRefreshByTerminal.set(terminal, { kind: 'timeout', id })
}

/** Repair every row a suppressed batch dirtied, then honour the next-frame repaint it asked for. */
function repairSuppressedForegroundRows(
  terminal: ForegroundTerminalOutputTarget,
  options: ForegroundTerminalWriteOptions
): void {
  refreshVisibleRows(
    terminal,
    options.shouldRefreshViewportSynchronously?.() ?? true,
    options.shouldReleaseRenderPause,
    null
  )
  // A full-span repair owns every dirty row, so the next throttled repair starts a fresh window.
  resetParsedDirtyRows(terminal)
  if (consumeSuppressedFollowupRefresh(terminal)) {
    scheduleViewportSettleRefresh(
      terminal,
      options.shouldRefreshViewportSynchronously,
      options.shouldReleaseRenderPause
    )
  }
}

/** Repair the rows this parse dirtied plus cursor rows, and schedule the next-frame repaint when one is owed. */
function settleForegroundRender(
  terminal: ForegroundTerminalOutputTarget,
  beforeWriteViewport: ViewportSnapshot,
  options: ForegroundTerminalWriteOptions,
  spanSinceLastRepair: boolean,
  followupViewportRefresh: boolean
): void {
  const afterWriteViewport = captureViewportSnapshot(terminal)
  const span = repairRowSpan(terminal, beforeWriteViewport, afterWriteViewport)
  if (spanSinceLastRepair) {
    // Why: a throttled repair owns every row dirtied since the previous one, so its window restarts after the read.
    resetParsedDirtyRows(terminal)
  }
  refreshVisibleRows(
    terminal,
    options.shouldRefreshViewportSynchronously?.() ?? true,
    options.shouldReleaseRenderPause,
    span
  )
  // Chromium can paint scrolled top rows after parsing completes; repaint next frame to avoid stale rows until window movement.
  if (
    followupViewportRefresh ||
    viewportChangedDuringWrite(beforeWriteViewport, afterWriteViewport)
  ) {
    scheduleViewportSettleRefresh(
      terminal,
      options.shouldRefreshViewportSynchronously,
      options.shouldReleaseRenderPause
    )
  }
}

/** Write a foreground chunk and run its repair; throttled writers opt into the bounded repair window. */
export function writeForegroundTerminalChunk(
  terminal: ForegroundTerminalOutputTarget,
  data: string,
  options: ForegroundTerminalWriteOptions = {}
): boolean {
  const throttled = options.throttleForcedRefresh === true
  let forcedRefresh = options.forceViewportRefresh === true
  let followupViewportRefresh = options.followupViewportRefresh === true
  let suppressedForcedRefresh = false
  if (forcedRefresh && throttled) {
    forcedRefresh = takeForcedRefreshSlot(terminal)
    if (forcedRefresh) {
      // Why: this repair stands in for every suppressed batch, including the next-frame repaint they asked for.
      followupViewportRefresh =
        consumeSuppressedFollowupRefresh(terminal) || followupViewportRefresh
    } else {
      suppressedForcedRefresh = true
      noteSuppressedRepair(terminal, options)
    }
  }
  const beforeWriteViewport = forcedRefresh ? captureViewportSnapshot(terminal) : null
  if (beforeWriteViewport && !throttled) {
    // Capture here: xterm emits dirty rows between write submission and callback; span must cover only this parse.
    resetParsedDirtyRows(terminal)
  }
  // Arm from the parse callback: a repair taken mid-parse misses rows that parse has not reached yet.
  const armSuppressedRepairWhenParsed = (): void => {
    if (noteSuppressedParseLanded(terminal)) {
      armTrailingForcedRefresh(terminal, () => repairSuppressedForegroundRows(terminal, options))
    }
  }
  // WriteBuffer callbacks must never throw (xterm-write-callback-guard.ts); guard settle/onParsed independently so renderer failure cannot strand replay guards.
  const runParsedSteps = (): void => {
    if (beforeWriteViewport) {
      runGuardedWriteCompletionStep('foreground-render-settle', () =>
        settleForegroundRender(
          terminal,
          beforeWriteViewport,
          options,
          throttled,
          followupViewportRefresh
        )
      )
    }
    if (suppressedForcedRefresh) {
      runGuardedWriteCompletionStep(
        'foreground-suppressed-parse-settled',
        armSuppressedRepairWhenParsed
      )
    }
    if (options.onParsed) {
      runGuardedWriteCompletionStep('foreground-on-parsed', options.onParsed)
    }
  }
  try {
    terminal.write(data, runParsedSteps)
    return true
  } catch {
    // A synchronous failure ends this batch without a callback, so its owed repair must not wait on one.
    if (suppressedForcedRefresh) {
      runGuardedWriteCompletionStep(
        'foreground-suppressed-parse-settled',
        armSuppressedRepairWhenParsed
      )
    }
    // Synchronous failure requires recovery but proves no parser liveness; keep it distinct from parse completion.
    if (options.onWriteFailure) {
      runGuardedWriteCompletionStep('foreground-on-write-failure', options.onWriteFailure)
    }
    return false
  }
}

export function discardForegroundRenderSettle(terminal: ForegroundTerminalOutputTarget): void {
  cancelScheduledViewportSettleRefresh(terminal)
  discardForcedRefreshWindow(terminal)
  disposeParsedDirtyRows(terminal)
}
