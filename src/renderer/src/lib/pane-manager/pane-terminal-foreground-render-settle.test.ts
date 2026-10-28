import { describe, expect, it, vi } from 'vitest'
import {
  FORCED_REFRESH_MIN_MS,
  writeForegroundTerminalChunk
} from './pane-terminal-foreground-render-settle'

type RefreshFn = (start: number, end: number, sync?: boolean) => void

type RenderServiceStub = {
  _isPaused: boolean
  _needsFullRefresh: boolean
  refreshRows: ReturnType<typeof vi.fn<RefreshFn>>
}

function createTerminal(paused: boolean): {
  terminal: {
    rows: number
    buffer: { active: { cursorY: number; baseY: number; viewportY: number } }
    _core: { refresh: ReturnType<typeof vi.fn<RefreshFn>>; _renderService: RenderServiceStub }
    refresh: ReturnType<typeof vi.fn<(start: number, end: number) => void>>
    write: (data: string, callback?: () => void) => void
  }
  renderService: RenderServiceStub
} {
  const renderService: RenderServiceStub = {
    _isPaused: paused,
    _needsFullRefresh: paused,
    refreshRows: vi.fn<RefreshFn>()
  }
  const terminal = {
    rows: 24,
    buffer: { active: { cursorY: 0, baseY: 0, viewportY: 0 } },
    _core: { refresh: vi.fn<RefreshFn>(), _renderService: renderService },
    refresh: vi.fn<(start: number, end: number) => void>(),
    write: (_data: string, callback?: () => void) => callback?.()
  }
  return { terminal, renderService }
}

describe('writeForegroundTerminalChunk render-pause ownership', () => {
  it('drives a paused render only for a currently visible reveal replay', () => {
    const { terminal, renderService } = createTerminal(true)

    writeForegroundTerminalChunk(terminal, 'replayed snapshot bytes', {
      forceViewportRefresh: true,
      shouldReleaseRenderPause: () => true
    })

    expect(renderService.refreshRows).toHaveBeenCalledWith(0, 23, true)
    expect(renderService._isPaused).toBe(false)
    expect(renderService._needsFullRefresh).toBe(false)
  })

  it('leaves a newly-hidden terminal paused when replay parsing finishes', () => {
    const { terminal, renderService } = createTerminal(true)
    let parsed: (() => void) | undefined
    let visible = true
    terminal.write = (_data: string, callback?: () => void) => {
      parsed = callback
    }

    writeForegroundTerminalChunk(terminal, 'late replay bytes', {
      forceViewportRefresh: true,
      shouldReleaseRenderPause: () => visible
    })
    visible = false
    parsed?.()

    expect(renderService.refreshRows).not.toHaveBeenCalled()
    expect(renderService._isPaused).toBe(true)
    expect(renderService._needsFullRefresh).toBe(true)
  })
})

describe('writeForegroundTerminalChunk forced refresh throttle', () => {
  const throttled = { forceViewportRefresh: true, throttleForcedRefresh: true }

  it('issues one repair inside the window and a trailing repair for the suppressed batches', () => {
    vi.useFakeTimers()
    try {
      const { terminal } = createTerminal(false)

      writeForegroundTerminalChunk(terminal, 'first batch', throttled)
      writeForegroundTerminalChunk(terminal, 'second batch', throttled)
      expect(terminal._core.refresh).toHaveBeenCalledTimes(1)

      vi.runOnlyPendingTimers()
      expect(terminal._core.refresh).toHaveBeenCalledTimes(2)
      // The trailing repair must cover every row dirtied since, not just the last write's span.
      expect(terminal._core.refresh).toHaveBeenLastCalledWith(0, terminal.rows - 1, true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('issues one trailing repair however many batches were suppressed', () => {
    vi.useFakeTimers()
    try {
      const { terminal } = createTerminal(false)

      for (let index = 0; index < 5; index += 1) {
        writeForegroundTerminalChunk(terminal, `batch ${index}`, throttled)
      }
      expect(terminal._core.refresh).toHaveBeenCalledTimes(1)

      vi.runOnlyPendingTimers()
      expect(terminal._core.refresh).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves replay repairs unthrottled when the writer does not opt in', () => {
    vi.useFakeTimers()
    try {
      const { terminal } = createTerminal(false)

      writeForegroundTerminalChunk(terminal, 'a', { forceViewportRefresh: true })
      writeForegroundTerminalChunk(terminal, 'b', { forceViewportRefresh: true })
      expect(terminal._core.refresh).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('covers the rows a suppressed batch dirtied before the window reopens', () => {
    vi.useFakeTimers()
    try {
      const { terminal } = createTerminal(false)
      const spans: Record<string, { start: number; end: number }> = {
        prime: { start: 0, end: 1 },
        a: { start: 1, end: 2 },
        b: { start: 21, end: 22 },
        c: { start: 3, end: 4 }
      }
      let emit: ((span: { start: number; end: number } | undefined) => void) | null = null
      ;(terminal._core as unknown as { _inputHandler?: unknown })._inputHandler = {
        onRequestRefreshRows: (
          listener: (event: { start: number; end: number } | undefined) => void
        ) => {
          emit = listener
          return { dispose: () => {} }
        }
      }
      terminal.write = (data: string, callback?: () => void) => {
        emit?.(spans[data])
        callback?.()
      }

      // Prime the parse-span tracker through a non-throttled repair so later spans are observable.
      writeForegroundTerminalChunk(terminal, 'prime', { forceViewportRefresh: true })
      writeForegroundTerminalChunk(terminal, 'a', throttled)
      vi.advanceTimersByTime(FORCED_REFRESH_MIN_MS - 10)
      writeForegroundTerminalChunk(terminal, 'b', throttled)
      vi.advanceTimersByTime(15)
      writeForegroundTerminalChunk(terminal, 'c', throttled)
      vi.runOnlyPendingTimers()

      // Either the reopened window absorbed b's rows or the still-pending trailing repair covered them.
      const lastCall = terminal._core.refresh.mock.calls.at(-1)
      expect(lastCall).toBeDefined()
      expect(lastCall?.[1]).toBeGreaterThanOrEqual(22)
    } finally {
      vi.useRealTimers()
    }
  })

  it('carries a suppressed batch next-frame follow-up into the repair that lands', () => {
    vi.useFakeTimers()
    // Deterministic: take scheduleViewportSettleRefresh's timeout path instead of a real rAF.
    vi.stubGlobal('requestAnimationFrame', undefined)
    try {
      const { terminal } = createTerminal(false)

      writeForegroundTerminalChunk(terminal, 'a', throttled)
      vi.advanceTimersByTime(FORCED_REFRESH_MIN_MS - 10)
      writeForegroundTerminalChunk(terminal, 'b', {
        ...throttled,
        followupViewportRefresh: true
      })
      vi.advanceTimersByTime(15)
      writeForegroundTerminalChunk(terminal, 'c', throttled)
      expect(terminal._core.refresh).toHaveBeenCalledTimes(2)

      vi.advanceTimersByTime(20)
      expect(terminal._core.refresh).toHaveBeenCalledTimes(3)
      expect(terminal._core.refresh).toHaveBeenLastCalledWith(0, terminal.rows - 1, true)
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('holds the trailing repair until the suppressed parses land instead of mid-parse', () => {
    vi.useFakeTimers()
    try {
      const { terminal } = createTerminal(false)
      const pending: (() => void)[] = []
      terminal.write = (_data: string, callback?: () => void) => {
        if (callback) {
          pending.push(callback)
        }
      }

      writeForegroundTerminalChunk(terminal, 'a', throttled)
      writeForegroundTerminalChunk(terminal, 'b', throttled)
      vi.advanceTimersByTime(FORCED_REFRESH_MIN_MS * 3)
      // A repair taken here would miss every row the backlog has not reached yet.
      expect(terminal._core.refresh).not.toHaveBeenCalled()

      for (const run of pending) {
        run()
      }
      vi.advanceTimersByTime(FORCED_REFRESH_MIN_MS + 1)
      expect(terminal._core.refresh).toHaveBeenCalledTimes(2)
      expect(terminal._core.refresh).toHaveBeenLastCalledWith(0, terminal.rows - 1, true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a trailing repair a later repair already covers', () => {
    vi.useFakeTimers()
    try {
      const { terminal } = createTerminal(false)
      const pending: (() => void)[] = []
      terminal.write = (_data: string, callback?: () => void) => {
        if (callback) {
          pending.push(callback)
        }
      }

      writeForegroundTerminalChunk(terminal, 'prime', throttled)
      vi.advanceTimersByTime(10)
      writeForegroundTerminalChunk(terminal, 'suppressed', throttled)
      vi.advanceTimersByTime(FORCED_REFRESH_MIN_MS)
      // Claims the slot and, once its parse lands, repairs every row the suppressed batch dirtied.
      writeForegroundTerminalChunk(terminal, 'later', throttled)

      // Land the parses so the suppressed batch arms a trailing timer after the slot was claimed.
      for (const run of pending) {
        run()
      }
      vi.advanceTimersByTime(FORCED_REFRESH_MIN_MS * 2)

      // prime + later only; the trailing repair would be a redundant full-span repaint.
      expect(terminal._core.refresh).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a suppressed repair owed after a slot claim cancels its timer, so replay cannot drop its rows', () => {
    vi.useFakeTimers()
    try {
      const { terminal } = createTerminal(false)
      const spans: Record<string, { start: number; end: number }> = {
        prime: { start: 0, end: 1 },
        a: { start: 1, end: 2 },
        b: { start: 21, end: 22 },
        c: { start: 5, end: 6 },
        replay: { start: 3, end: 4 }
      }
      let emit: ((span: { start: number; end: number } | undefined) => void) | null = null
      ;(terminal._core as unknown as { _inputHandler?: unknown })._inputHandler = {
        onRequestRefreshRows: (
          listener: (event: { start: number; end: number } | undefined) => void
        ) => {
          emit = listener
          return { dispose: () => {} }
        }
      }
      const deferred = new Set(['c'])
      const pending: (() => void)[] = []
      terminal.write = (data: string, callback?: () => void) => {
        emit?.(spans[data])
        if (deferred.has(data)) {
          if (callback) {
            pending.push(callback)
          }
          return
        }
        callback?.()
      }

      writeForegroundTerminalChunk(terminal, 'prime', { forceViewportRefresh: true })
      writeForegroundTerminalChunk(terminal, 'a', throttled)
      vi.advanceTimersByTime(FORCED_REFRESH_MIN_MS - 10)
      writeForegroundTerminalChunk(terminal, 'b', throttled)
      vi.advanceTimersByTime(15)
      // 'c' claims the slot and cancels b's trailing timer before its own parse callback runs.
      writeForegroundTerminalChunk(terminal, 'c', throttled)

      // A replay write must not reset the tracker away while b's rows are still owed a repair.
      writeForegroundTerminalChunk(terminal, 'replay', {
        forceViewportRefresh: true,
        followupViewportRefresh: true
      })
      const lastCall = terminal._core.refresh.mock.calls.at(-1)
      expect(lastCall).toBeDefined()
      expect(lastCall?.[1]).toBeGreaterThanOrEqual(22)
    } finally {
      vi.useRealTimers()
    }
  })
})
