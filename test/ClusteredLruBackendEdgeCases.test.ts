import { describe, expect, it, vi } from 'vitest'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { Logger } from '../src/lib/logger'

const namespace = (name: string) => `adaptive-cache-backend-${name}-${Date.now()}-${Math.random()}`

const logger = () => new Logger('silent')

describe('ClusteredLruAdaptiveCacheBackend edge cases', () => {
  it.each([
    { maxSizeBytes: 0 },
    { maxSizeBytes: Number.POSITIVE_INFINITY },
    { maxEntrySizeBytes: -1 },
    { maxSizeBytes: 100, maxEntrySizeBytes: 101 },
  ])('rejects invalid clustered-LRU byte limits %o', (options) => {
    expect(() => new ClusteredLruAdaptiveCacheBackend(options, logger())).toThrow(RangeError)
  })

  it('should use safe defaults and pass through v2.1 local L1 options', async () => {
    const originalLoader = ClusteredLruAdaptiveCacheBackend.loadModule
    const constructorOptions: any[] = []
    const instances: any[] = []

    class FakeClusteredCache {
      static bootstrap = vi.fn()

      constructor(options: any) {
        constructorOptions.push(options)
        instances.push(this)
      }

      async healthCheck() {
        return undefined
      }

      async get() {
        return undefined
      }

      async set() {
        return true
      }

      async delete() {
        return true
      }

      async destroy() {
        return true
      }
    }

    ClusteredLruAdaptiveCacheBackend.loadModule = () => ({ LRUCacheForClustersAsPromised: FakeClusteredCache })

    const defaultBackend = new ClusteredLruAdaptiveCacheBackend(undefined, logger())
    await defaultBackend.fetch({
      key: 'default-key',
      dataKey: 'default-keydata',
      metaKey: 'default-keymeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    })

    const localL1 = { enabled: true, maxSize: 1024, invalidation: 'broadcast' as const }
    const localBackend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: 'v21-local', maxSizeBytes: 2048, maxEntrySizeBytes: 512, failsafe: 'resolve', localL1 },
      logger(),
    )
    await (localBackend as any).getCache()

    expect(constructorOptions[0]).toMatchObject({
      namespace: 'adaptive-cache',
      maxSize: 64 * 1024 * 1024,
      maxEntrySize: Math.floor(64 * 1024 * 1024 * 0.1),
      failsafe: 'reject',
    })
    expect(constructorOptions[0]).not.toHaveProperty('localL1')
    expect(constructorOptions[1]).toMatchObject({
      namespace: 'v21-local',
      maxSize: 2048,
      maxEntrySize: 512,
      failsafe: 'resolve',
      localL1,
    })
    expect(FakeClusteredCache.bootstrap).toHaveBeenCalled()

    await defaultBackend.quit()
    expect(instances[0].destroy).toBeDefined()

    ClusteredLruAdaptiveCacheBackend.loadModule = originalLoader
  })

  it('should coordinate refresh locks in standalone mode', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('locks'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )

    const update = await backend.shouldRefresh('lru-last-update', 10, 100, false, 1, 'lock-a')
    expect(update[0]).toBe('UPDATE')

    const updating = await backend.shouldRefresh('lru-last-update', 10, 100, false, 1, 'lock-b')
    expect(updating).toEqual(['UPDATING', 'lock-a'])

    expect(await backend.releaseLock('lru-last-update', 100, 'lock-a')).toEqual(['UPDATED'])
    expect((await backend.shouldRefresh('lru-last-update', 10, 101, false, 1, 'lock-c'))[0]).toBe('EXISTS')
    expect((await backend.shouldRefresh('lru-last-update', 10, 101, true, 1, 'lock-d'))[0]).toBe('UPDATE')
    expect(await backend.releaseLock('lru-last-update', 101, 'wrong-lock')).toEqual(['LOCK_MISMATCH', 'lock-d'])
  })

  it.each([false, true])('fails boundedly when force=%s cannot retain an oversized refresh lock', async (force) => {
    const backend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('oversized-lock'), maxSizeBytes: 1024, maxEntrySizeBytes: 128 },
      logger(),
    )

    await expect(backend.shouldRefresh('x'.repeat(512), 0, 100, force, 1, 'owner')).rejects.toThrow(
      'cannot retain refresh lock',
    )
    await backend.quit()
  })

  it.each([false, true])('preserves a successor acquired during release with recordRefresh=%s', async (recordRefresh) => {
    const backend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('release-successor'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const cache = await (backend as any).getCache()
    const primary = cache.getCache()
    const key = 'release-successor'
    const lockKey = key + '-lock'
    await backend.shouldRefresh(key, 0, 100, false, 60, 'owner')
    const get = primary.get.bind(primary)
    const spy = vi.spyOn(primary, 'get').mockImplementation((requested: string) => {
      const value = get(requested)
      if (requested === lockKey) {
        // A new primary operation may run as soon as release yields. It must
        // observe the entire release, never just its ownership read.
        globalThis.queueMicrotask(() => primary.set(lockKey, 'successor', { ttl: 60_000, size: 128 }))
      }
      return value
    })
    try {
      expect(await backend.releaseLock(key, 100, 'owner', recordRefresh)).toEqual(['UPDATED'])
      spy.mockRestore()
      expect(primary.get(lockKey)).toBe('successor')
      expect(primary.get(key)).toBe(recordRefresh ? 100 : undefined)
      expect(await backend.releaseLock(key, 101, 'owner', recordRefresh)).toEqual(['LOCK_MISMATCH', 'successor'])
      expect(primary.get(lockKey)).toBe('successor')
    } finally {
      spy.mockRestore()
      await backend.quit()
    }
  })

  it('does not claim a refresh lock whose readback belongs to a successor', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('lock-readback'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const primary = await (backend as any).getCache()
    await primary.set('readback-lock', 'successor', { ttl: 1000, size: 64 })
    const claim = vi.spyOn(primary, 'setIfAbsent').mockResolvedValueOnce(true)
    expect(await backend.shouldRefresh('readback', 0, 100, false, 1, 'owner')).toEqual(['UPDATING', 'successor'])
    claim.mockRestore()

    const force = vi.spyOn(primary, 'set').mockResolvedValueOnce(true)
    await expect(backend.shouldRefresh('readback', 0, 100, true, 1, 'owner')).rejects.toThrow(
      'cannot retain refresh lock',
    )
    force.mockRestore()
    await backend.quit()
  })

  it('rejects invalidation state that cannot fit in the configured entry budget', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('oversized-state'), maxSizeBytes: 1024, maxEntrySizeBytes: 128 },
      logger(),
    )
    const long = 'x'.repeat(512)

    await expect(backend.invalidateNamespace(long)).rejects.toThrow('cannot retain invalidation state')
    await expect(backend.clear(long, long + 'data', long + 'meta', 'a:')).rejects.toThrow(
      'cannot retain invalidation state',
    )
    await expect(backend.clear('key', 'keydata', 'keymeta', long)).rejects.toThrow(
      'cannot retain invalidation state',
    )
    await expect(backend.invalidateTags([long], 'a:')).rejects.toThrow('cannot retain invalidation state')
    await backend.quit()
  })

  it.each(['rejected', 'lost'])('rejects invalidation state when its write is %s', async (mode) => {
    const backend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('unretained-state'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const primary = await (backend as any).getCache()
    vi.spyOn(primary, 'set').mockResolvedValueOnce(mode === 'lost')

    await expect(backend.invalidateNamespace('a:')).rejects.toThrow('cannot retain invalidation state')
    await backend.quit()
  })

  it('should cap TTL at maxTTL', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('ttl-cap'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const input = {
      key: 'cap-key',
      dataKey: 'cap-keydata',
      metaKey: 'cap-keymeta',
      redisPrefix: 'adaptive:',
      encodedData: JSON.stringify({ ok: true }),
      responseHash: 'hash-cap',
      initialTTL: 2,
      maxTTL: 2,
      ttlScaling: 2,
      metaTTL: 100,
      tags: [],
    }

    await backend.update(input)
    const second = await backend.update(input)

    expect(second[1]).toBe(2)
  })

  it('should hydrate without metadata, fall back to update hashes, and handle missing tag sets', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('hydrate-fallbacks'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const fetchInput = {
      key: 'hydrate-key',
      dataKey: 'hydrate-keydata',
      metaKey: 'hydrate-keymeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    }
    const updateInput = {
      ...fetchInput,
      encodedData: JSON.stringify({ ok: true }),
      responseHash: 'fallback-hash',
      initialTTL: 3,
      maxTTL: 60,
      ttlScaling: 2,
      metaTTL: 100,
      tags: [],
    }

    await backend.hydrateFromFetch(fetchInput, {
      encodedData: JSON.stringify({ ok: true }),
      ttl: 0,
    })
    expect(await backend.fetch(fetchInput)).toBeNull()
    await backend.hydrateFromFetch(fetchInput, { encodedData: 'hydrated', ttl: 1 })
    expect((await backend.fetch(fetchInput))?.metadata?.hash).toBe('')

    await backend.hydrateFromUpdate(updateInput, ['CACHED', false, false, false, false] as any)
    expect((await backend.fetch(fetchInput))?.metadata?.hash).toBe('fallback-hash')
    expect(await backend.invalidateTags(['missing-tag'], 'adaptive:')).toEqual([])
  })

  it('does not index oversized conservative or reconciled entries', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('oversized-hydration'), maxSizeBytes: 1024 * 1024, maxEntrySizeBytes: 1024 },
      logger(),
    )
    const makeInput = (key: string) => ({
      key,
      dataKey: key + 'data',
      metaKey: key + 'meta',
      redisPrefix: 'adaptive:',
      encodedData: 'x'.repeat(2048),
      responseHash: 'oversized',
      initialTTL: 3,
      maxTTL: 60,
      ttlScaling: 2,
      metaTTL: 100,
      tags: ['red'],
    })

    await backend.storeConservative(makeInput('conservative'))
    await backend.hydrateFromUpdate(makeInput('reconciled'), ['CACHED', 3, 1, 1, 'oversized', 1])

    expect(await backend.fetch({ ...makeInput('conservative'), includeDebugHeaders: true })).toBeNull()
    expect(await backend.fetch({ ...makeInput('reconciled'), includeDebugHeaders: true })).toBeNull()
    const primary = await (backend as any).getCache()
    expect(await primary.get('adaptive:tag:red', { bypassL1: true })).toBeUndefined()
    await backend.quit()
  })

  it('should no-op quit before clustered LRU initialization', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: namespace('quit-before-init') }, logger())

    await expect(backend.quit()).resolves.toBeUndefined()
  })

  it('should throw a useful error when the optional LRU package cannot be loaded or has no export', async () => {
    const originalLoader = ClusteredLruAdaptiveCacheBackend.loadModule
    ClusteredLruAdaptiveCacheBackend.loadModule = () => {
      throw new Error('missing package')
    }
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: namespace('missing') }, logger())

    await expect((backend as any).getCache()).rejects.toThrow('@0xdoublesharp/lru-cache-clustered')

    ClusteredLruAdaptiveCacheBackend.loadModule = () => ({})
    const backendWithoutExport = new ClusteredLruAdaptiveCacheBackend({ namespace: namespace('bad-export') }, logger())
    await expect((backendWithoutExport as any).getCache()).rejects.toThrow('Could not find LRUCacheClustered')

    ClusteredLruAdaptiveCacheBackend.loadModule = originalLoader
  })
})
