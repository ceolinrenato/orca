type Entry<T> = { promise: Promise<T | null>; settledAt: number | null; value?: T }

/** One request per key at a time; answers stay fresh for `freshMs`, and empty answers retry on the next open. */
export function createHoverPreviewCache<T>({
  freshMs,
  maxEntries
}: {
  freshMs: number
  maxEntries: number
}): {
  read: (key: string) => T | null
  load: (key: string, fetch: () => Promise<T | null>) => Promise<T | null>
} {
  const entries = new Map<string, Entry<T>>()
  return {
    read: (key) => entries.get(key)?.value ?? null,
    load: (key, fetch) => {
      const cached = entries.get(key)
      if (cached && (cached.settledAt === null || Date.now() - cached.settledAt < freshMs)) {
        return cached.promise
      }
      const entry: Entry<T> = { promise: Promise.resolve(null), settledAt: null }
      const forget = (): void => {
        if (entries.get(key) === entry) {
          entries.delete(key)
        }
      }
      entry.promise = fetch().then(
        (value) => {
          if (value) {
            entry.settledAt = Date.now()
            entry.value = value
          } else {
            forget()
          }
          return value
        },
        (error: unknown) => {
          forget()
          throw error
        }
      )
      entries.delete(key)
      entries.set(key, entry)
      if (entries.size > maxEntries) {
        const oldest = entries.keys().next().value
        if (oldest !== undefined) {
          entries.delete(oldest)
        }
      }
      return entry.promise
    }
  }
}
