import { describe, expect, it } from 'vitest'
import { FOREGROUND_FORCED_REFRESH_MIN_MS } from './foreground-output-budgets'
import { resolveForegroundForcedRefresh } from './foreground-forced-refresh'

const REFRESH = { refresh: true, inPlaceRewrite: false }

describe('resolveForegroundForcedRefresh', () => {
  it('passes through decisions that do not ask for a repaint', () => {
    const decision = { refresh: false, inPlaceRewrite: true }
    const result = resolveForegroundForcedRefresh(decision, 0, 1_000)
    expect(result.decision).toEqual(decision)
    expect(result.lastForcedAt).toBe(0)
  })

  it('allows the first forced repaint', () => {
    const result = resolveForegroundForcedRefresh(REFRESH, Number.NEGATIVE_INFINITY, 1_000)
    expect(result.decision.refresh).toBe(true)
    expect(result.lastForcedAt).toBe(1_000)
  })

  it('suppresses a forced repaint inside the window but keeps the repair hint', () => {
    const decision = { refresh: true, inPlaceRewrite: true }
    const result = resolveForegroundForcedRefresh(decision, 1_000, 1_000 + FOREGROUND_FORCED_REFRESH_MIN_MS - 1)
    expect(result.decision).toEqual({ refresh: false, inPlaceRewrite: true })
    expect(result.lastForcedAt).toBe(1_000)
  })

  it('allows a forced repaint once the window has elapsed', () => {
    const now = 1_000 + FOREGROUND_FORCED_REFRESH_MIN_MS
    const result = resolveForegroundForcedRefresh(REFRESH, 1_000, now)
    expect(result.decision.refresh).toBe(true)
    expect(result.lastForcedAt).toBe(now)
  })
})
