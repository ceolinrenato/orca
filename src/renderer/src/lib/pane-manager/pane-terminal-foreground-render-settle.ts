import { forceRepaintThroughRenderPause } from './terminal-render-pause-release'
import {
  disposeParsedDirtyRows,
  readParsedDirtyRowSpan,
  resetParsedDirtyRows,
  type ParsedDirtyRowSpan
} from './terminal-parsed-dirty-rows'
import { runGuardedWriteCompletionStep } from './xterm-write-callback-guard'

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

// Why here: the forced repaint is bounded where it actually runs, so queued batches drained back-to-back cannot each issue one.
export const FORCED_REFRESH_MIN_MS = 100

const lastForcedRefreshAtByTerminal = new WeakMap<ForegroundTerminalOutputTarget, number>()
const trailingForcedRefreshByTerminal = new WeakMap<
  ForegroundTerminalOutputTarget,
  ReturnType<typeof setTimeout>
>()
// Why: a suppressed repair still owes its next-frame repaint, so the repair that lands has to honor it.
const suppressedFollowupRefreshByTerminal = new WeakMap<ForegroundTerminalOutputTarget, boolean>()

function noteSuppressedFollowupRefresh(
  terminal: ForegroundTerminalOutputTarget,
  options: ForegroundTerminalWriteOptions
): void {
  if (options.followupViewportRefresh === true) {
    suppressedFollowupRefreshByTerminal.set(terminal, true)
  }
}

function consumeSuppressedFollowupRefresh(terminal: ForegroundTerminalOutputTarget): boolean {
  const pending = suppressedFollowupRefreshByTerminal.get(terminal) === true
  suppressedFollowupRefreshByTerminal.delete(terminal)
  return pending
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function cancelTrailingForcedRefresh(terminal: ForegroundTerminalOutputTarget): void {
  const timer = trailingForcedRefreshByTerminal.get(terminal)
  if (timer === undefined) {
    return
  }
  clearTimeout(timer)
  trailingForcedRefreshByTerminal.delete(terminal)
}

/** A suppressed repair must still land: repair every row dirtied since the last one, not just the last write's span. */
function scheduleTrailingForcedRefresh(
  terminal: ForegroundTerminalOutputTarget,
  options: ForegroundTerminalWriteOptions
): void {
  if (trailingForcedRefreshByTerminal.has(terminal)) {
    return
  }
  const timer = setTimeout(() => {
    trailingForcedRefreshByTerminal.delete(terminal)
    lastForcedRefreshAtByTerminal.set(terminal, now())
    refreshVisibleRows(
      terminal,
      options.shouldRefreshViewportSynchronously?.() ?? true,
      options.shouldReleaseRenderPause,
      null
    )
    // A full-span repair owns every dirty row, so the next throttled repair starts a fresh window.
    resetParsedDirtyRows(terminal)
    if (consumeSuppressedFollowupRefresh(terminal)) {
      // Why: batches suppressed since the last repair asked for a next-frame repaint; this is the repair that owes it.
      scheduleViewportSettleRefresh(
        terminal,
        options.shouldRefreshViewportSynchronously,
        options.shouldReleaseRenderPause
      )
    }
  }, FORCED_REFRESH_MIN_MS)
  timer.unref?.()
  trailingForcedRefreshByTerminal.set(terminal, timer)
}

function takeForcedRefreshSlot(
  terminal: ForegroundTerminalOutputTarget,
  options: ForegroundTerminalWriteOptions
): boolean {
  const last = lastForcedRefreshAtByTerminal.get(terminal) ?? Number.NEGATIVE_INFINITY
  if (now() - last >= FORCED_REFRESH_MIN_MS) {
    lastForcedRefreshAtByTerminal.set(terminal, now())
    cancelTrailingForcedRefresh(terminal)
    return true
  }
  scheduleTrailingForcedRefresh(terminal, options)
  return false
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

export function writeForegroundTerminalChunk(
  terminal: ForegroundTerminalOutputTarget,
  data: string,
  options: ForegroundTerminalWriteOptions = {}
): boolean {
  const throttled = options.throttleForcedRefresh === true
  let forcedRefresh = options.forceViewportRefresh === true
  let followupViewportRefresh = options.followupViewportRefresh === true
  if (forcedRefresh && throttled) {
    forcedRefresh = takeForcedRefreshSlot(terminal, options)
    if (forcedRefresh) {
      // Why: this repair stands in for every suppressed batch, including the next-frame repaint they asked for.
      followupViewportRefresh =
        consumeSuppressedFollowupRefresh(terminal) || followupViewportRefresh
    } else {
      noteSuppressedFollowupRefresh(terminal, options)
    }
  }
  const beforeWriteViewport = forcedRefresh ? captureViewportSnapshot(terminal) : null
  if (beforeWriteViewport && !throttled) {
    // Capture here: xterm emits dirty rows between write submission and callback; span must cover only this parse.
    resetParsedDirtyRows(terminal)
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
    if (options.onParsed) {
      runGuardedWriteCompletionStep('foreground-on-parsed', options.onParsed)
    }
  }
  try {
    terminal.write(data, runParsedSteps)
    return true
  } catch {
    // Synchronous failure requires recovery but proves no parser liveness; keep it distinct from parse completion.
    if (options.onWriteFailure) {
      runGuardedWriteCompletionStep('foreground-on-write-failure', options.onWriteFailure)
    }
    return false
  }
}

export function discardForegroundRenderSettle(terminal: ForegroundTerminalOutputTarget): void {
  cancelScheduledViewportSettleRefresh(terminal)
  cancelTrailingForcedRefresh(terminal)
  suppressedFollowupRefreshByTerminal.delete(terminal)
  disposeParsedDirtyRows(terminal)
}
