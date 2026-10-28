import { FOREGROUND_FORCED_REFRESH_MIN_MS } from './foreground-output-budgets'

export type ForegroundRenderRefreshDecision = { refresh: boolean; inPlaceRewrite: boolean }

/** Rate-limits a forced foreground repaint: sustained output already repaints its own dirty rows. */
export function resolveForegroundForcedRefresh(
  decision: ForegroundRenderRefreshDecision,
  lastForcedAt: number,
  now: number
): { decision: ForegroundRenderRefreshDecision; lastForcedAt: number } {
  if (!decision.refresh) {
    return { decision, lastForcedAt }
  }
  if (now - lastForcedAt < FOREGROUND_FORCED_REFRESH_MIN_MS) {
    return { decision: { refresh: false, inPlaceRewrite: decision.inPlaceRewrite }, lastForcedAt }
  }
  return { decision, lastForcedAt: now }
}
