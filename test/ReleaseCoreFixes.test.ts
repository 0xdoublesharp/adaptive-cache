import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AdaptiveCache } from '../src/AdaptiveCache'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { Logger } from '../src/lib/logger'
import type { AdaptiveCacheEvent } from '../src/types'

const caches: AdaptiveCache[] = []
const create = () => {
  const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: randomUUID() }, new Logger('silent'))
  const cache = new AdaptiveCache({ backend, logLevel: 'silent' })
  caches.push(cache)
  return { backend, cache }
}
const gate = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(caches.splice(0).map((cache) => cache.close()))
})

describe('release core fixes', () => {
  it('validates public lock expirations and keeps lease capabilities out of logs', async () => {
    const { cache } = create()
    const info = vi.spyOn(cache.logger, 'info')
    expect(() => AdaptiveCache.setDefaultLockExpirationSeconds(0)).toThrow(RangeError)
    expect(() => AdaptiveCache.setDefaultLockExpirationSeconds(Number.NaN)).toThrow(RangeError)
    await expect(cache.shouldRefresh('invalid-lock', 0, false, 0)).rejects.toThrow(RangeError)
    await cache.shouldRefresh('valid-lock', 0, false, 1)
    expect(info).not.toHaveBeenCalled()
  })

  it('does not record refresh success after the public lease is already absent', async () => {
    const { backend } = create()
    expect(await backend.releaseLock('missing-lock', 100, 'owner')).toEqual(['LOCK_MISMATCH', ''])
  })

  it.each(['getMany', 'setMany', 'clearMany'] as const)('rejects empty %s after shutdown', async (method) => {
    const { cache } = create()
    await cache.close()
    await expect(cache[method]([])).rejects.toThrow('closed')
  })

  it('rejects fractional metadata TTL before creating a backend', () => {
    // A Redis EXPIRE failure occurs after Lua has already written metadata.
    expect(() => new AdaptiveCache({ backend: 'clustered-lru', metaTTL: 0.5, logLevel: 'silent' })).toThrow(
      /metaTTL.*integer/,
    )
  })

  it('preserves the loader error when lock cleanup also fails', async () => {
    const { backend, cache } = create()
    const original = new Error('upstream loader failed')
    const cleanup = new Error('lock release unavailable')
    const events: AdaptiveCacheEvent[] = []
    cache.onEvent((event) => {
      events.push(event)
    })
    vi.spyOn(backend, 'releaseLock').mockRejectedValue(cleanup)
    await expect(
      cache.getOrSet('failure', async () => {
        throw original
      }),
    ).rejects.toBe(original)
    expect(events.filter((event) => event.type === 'error')).toEqual([
      expect.objectContaining({ reason: 'refresh', error: original }),
      expect.objectContaining({ reason: 'lock-release', error: cleanup }),
    ])
    expect(await cache.get('failure')).toBeNull()
  })

  it('returns and stores a successful result despite lock cleanup failure', async () => {
    const { backend, cache } = create()
    const cleanup = new Error('lock release unavailable')
    const events: AdaptiveCacheEvent[] = []
    cache.onEvent((event) => {
      events.push(event)
    })
    vi.spyOn(backend, 'releaseLock').mockRejectedValue(cleanup)
    await expect(cache.getOrSet('success', async () => ({ value: 17 }))).resolves.toEqual({ value: 17 })
    expect((await cache.get('success'))?.data).toEqual({ value: 17 })
    expect(events.filter((event) => event.type === 'error')).toEqual([
      expect.objectContaining({ reason: 'lock-release', error: cleanup }),
    ])
  })

  it('rejects public lock operations after shutdown', async () => {
    const { backend, cache } = create()
    const acquire = vi.spyOn(backend, 'shouldRefresh')
    const release = vi.spyOn(backend, 'releaseLock')
    await cache.close()
    await expect(cache.shouldRefresh('closed', 0)).rejects.toThrow('closed')
    await expect(cache.releaseLock('closed', 'owner')).rejects.toThrow('closed')
    expect(acquire).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })

  it.each(['acquire', 'release'] as const)(
    'drains an accepted public lock %s before closing its backend',
    async (operation) => {
      const { backend, cache } = create()
      const started = gate(),
        finish = gate()
      const order: string[] = []
      const quit = backend.quit.bind(backend)
      vi.spyOn(backend, 'quit').mockImplementation(async () => {
        order.push('quit')
        await quit()
      })
      vi.spyOn(backend, 'shouldRefresh').mockImplementation(async () => {
        started.resolve()
        await finish.promise
        order.push('acquire')
        return ['UPDATE', 'owner']
      })
      vi.spyOn(backend, 'releaseLock').mockImplementation(async () => {
        started.resolve()
        await finish.promise
        order.push('release')
        return ['UPDATED']
      })
      const pending =
        operation === 'acquire' ? cache.shouldRefresh('working', 0) : cache.releaseLock('working', 'owner')
      await started.promise
      const closing = cache.close()
      try {
        await Promise.resolve()
        await Promise.resolve()
        expect(order).toEqual([])
      } finally {
        finish.resolve()
        await pending
        await closing
      }
      expect(order).toEqual([operation, 'quit'])
    },
  )

  it('allows accepted loaders to acquire and release internal locks during shutdown', async () => {
    const { backend, cache } = create()
    const started = gate(),
      finish = gate()
    const fetch = backend.fetch.bind(backend)
    vi.spyOn(backend, 'fetch').mockImplementationOnce(async (input) => {
      started.resolve()
      await finish.promise
      return fetch(input)
    })
    const order: string[] = []
    const releaseLock = backend.releaseLock.bind(backend)
    vi.spyOn(backend, 'releaseLock').mockImplementation(async (...args) => {
      order.push('release')
      return releaseLock(...args)
    })
    const loading = cache.getOrSet('accepted', async () => {
      order.push('loader')
      return 42
    })
    await started.promise
    const closing = cache.close().then(() => {
      order.push('closed')
    })
    finish.resolve()
    await expect(loading).resolves.toBe(42)
    await closing
    expect(order).toEqual(['loader', 'release', 'closed'])
  })
})
