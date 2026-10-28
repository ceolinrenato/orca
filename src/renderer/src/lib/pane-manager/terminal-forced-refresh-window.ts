/** Bounds how often a throttled foreground repair runs: sustained output repaints its own dirty rows in between. */
export const FORCED_REFRESH_MIN_MS = 100

export type ForcedRefreshTarget = {
  rows?: number
  _core?: { refresh?(start: number, end: number, sync?: boolean): void }
  refresh?(start: number, end: number): void
}

type ForcedRefreshState = {
  lastRepairAt: number
  trailingTimer: ReturnType<typeof setTimeout> | null
  suppressedParsesInFlight: number
  suppressedFollowupRefresh: boolean
}

const stateByTerminal = new WeakMap<ForcedRefreshTarget, ForcedRefreshState>()

function stateFor(terminal: ForcedRefreshTarget): ForcedRefreshState {
  let state = stateByTerminal.get(terminal)
  if (!state) {
    state = {
      lastRepairAt: Number.NEGATIVE_INFINITY,
      trailingTimer: null,
      suppressedParsesInFlight: 0,
      suppressedFollowupRefresh: false
    }
    stateByTerminal.set(terminal, state)
  }
  return state
}

/** One time base, so every window comparison measures the same clock. */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** Claim the throttled repair slot, or report that the repair belongs to the trailing path. */
export function takeForcedRefreshSlot(terminal: ForcedRefreshTarget): boolean {
  const state = stateFor(terminal)
  if (now() - state.lastRepairAt < FORCED_REFRESH_MIN_MS) {
    return false
  }
  state.lastRepairAt = now()
  cancelTrailingForcedRefresh(terminal)
  return true
}

/** Remember a suppressed repair: its pending next-frame repaint and the parse it still owes. */
export function noteSuppressedRepair(
  terminal: ForcedRefreshTarget,
  options: { followupViewportRefresh?: boolean }
): void {
  const state = stateFor(terminal)
  state.suppressedParsesInFlight += 1
  if (options.followupViewportRefresh) {
    state.suppressedFollowupRefresh = true
  }
}

/** Take the follow-up a suppressed repair asked for; the repair that lands owns it. */
export function consumeSuppressedFollowupRefresh(terminal: ForcedRefreshTarget): boolean {
  const state = stateFor(terminal)
  const pending = state.suppressedFollowupRefresh
  state.suppressedFollowupRefresh = false
  return pending
}

/** Returns true once the last suppressed parse has landed, so a repair can no longer run mid-backlog. */
export function noteSuppressedParseLanded(terminal: ForcedRefreshTarget): boolean {
  const state = stateFor(terminal)
  state.suppressedParsesInFlight = Math.max(0, state.suppressedParsesInFlight - 1)
  return state.suppressedParsesInFlight === 0
}

/** Run `repair` once the window elapses and no suppressed parse is still in flight. */
export function armTrailingForcedRefresh(terminal: ForcedRefreshTarget, repair: () => void): void {
  const state = stateFor(terminal)
  if (state.trailingTimer !== null) {
    return
  }
  const timer = setTimeout(() => {
    state.trailingTimer = null
    if (state.suppressedParsesInFlight > 0) {
      // Why: a repair taken mid-parse cannot cover the rows that parse has not reached yet.
      armTrailingForcedRefresh(terminal, repair)
      return
    }
    state.lastRepairAt = now()
    repair()
  }, FORCED_REFRESH_MIN_MS)
  timer.unref?.()
  state.trailingTimer = timer
}

/** Drop a pending trailing repair; a live repair is about to own those rows. */
export function cancelTrailingForcedRefresh(terminal: ForcedRefreshTarget): void {
  const state = stateByTerminal.get(terminal)
  if (!state || state.trailingTimer === null) {
    return
  }
  clearTimeout(state.trailingTimer)
  state.trailingTimer = null
}

export function discardForcedRefreshWindow(terminal: ForcedRefreshTarget): void {
  cancelTrailingForcedRefresh(terminal)
  stateByTerminal.delete(terminal)
}
