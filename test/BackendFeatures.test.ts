import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GenericContainer, StartedTestContainer } from 'testcontainers'
import Redis from 'ioredis'
import { RedisAdaptiveCacheBackend } from '../src/backends/RedisAdaptiveCacheBackend'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { L1RedisAdaptiveCacheBackend } from '../src/backends/L1RedisAdaptiveCacheBackend'
import { FakeRedis } from './helpers/FakeRedis'
import { Logger } from '../src/lib/logger'
import { AdaptiveCache } from '../src/AdaptiveCache'
import type { AdaptiveCacheBackend, AdaptiveCacheBackendUpdateInput } from '../src/types'

const logger = new Logger('silent')
const input = (key = 'a:k:', prefix = 'a:'): AdaptiveCacheBackendUpdateInput => ({
  key,
  dataKey: key + 'data',
  metaKey: key + 'meta',
  redisPrefix: prefix,
  encodedData: 'old',
  responseHash: 'h',
  initialTTL: 1,
  maxTTL: 10,
  ttlScaling: 2,
  metaTTL: 60,
  tags: ['red'],
  staleTTL: 2,
})
const fetchInput = (value = input(), allowStale = false) => ({ ...value, includeDebugHeaders: true, allowStale })

describe('Backend feature guarantees', () => {
  let container: StartedTestContainer
  let client: Redis
  let redis: RedisAdaptiveCacheBackend
  beforeAll(async () => {
    container = await new GenericContainer('redis:alpine').withExposedPorts(6379).start()
    client = new Redis({ host: container.getHost(), port: container.getMappedPort(6379) })
    redis = new RedisAdaptiveCacheBackend(client, logger)
  })
  beforeEach(async () => {
    await client.flushall()
  })
  afterAll(async () => {
    await client?.quit()
    await container?.stop()
  })

  it.each(['clear', 'tags', 'namespace'])('rejects Redis writes captured before %s invalidation', async (kind) => {
    const writeToken = await redis.captureWriteToken('a:')
    if (kind === 'clear') await redis.clear('a:k:', 'a:k:data', 'a:k:meta')
    if (kind === 'tags') await redis.invalidateTags(['red'], 'a:')
    if (kind === 'namespace') await redis.invalidateNamespace('a:')
    expect(await redis.update({ ...input(), writeToken })).toEqual(['INVALIDATED', 0])
    expect(await redis.fetch(fetchInput())).toBeNull()
  })

  it('releases distinct loader locks without leaving permanent refresh markers', async () => {
    for (let index = 0; index < 8; index++) {
      const lastUpdateKey = 'a:loader:' + index
      expect((await redis.shouldRefresh(lastUpdateKey, 0, 100, false, 60, 'owner'))[0]).toBe('UPDATE')
      expect(await redis.releaseLock(lastUpdateKey, 100, 'owner', false)).toEqual(['UPDATED'])
    }
    expect(await client.keys('a:loader:*')).toEqual([])
    await client.set('a:loader:owned-lock', 'successor')
    expect(await redis.releaseLock('a:loader:owned', 100, 'old-owner', false)).toEqual(['LOCK_MISMATCH', 'successor'])
    expect(await client.get('a:loader:owned-lock')).toBe('successor')
    expect(await client.exists('a:loader:owned')).toBe(0)
  })

  it('cleans up successful and failed getOrSet coordination keys', async () => {
    const cache = new AdaptiveCache({ keyPrefix: 'a:', logLevel: 'silent' }, client)
    try {
      for (let index = 0; index < 8; index++)
        expect(await cache.getOrSet('a:item:' + index, async () => index)).toBe(index)
      await expect(
        cache.getOrSet('a:failed', async () => {
          throw new Error('loader failed')
        }),
      ).rejects.toThrow('loader failed')
      expect(await client.keys('a:loader:*')).toEqual([])
    } finally {
      await cache.close()
    }
  })

  it('rejects a loader whose lease has been replaced without clearing its successor', async () => {
    const writeToken = await redis.captureWriteToken('a:')
    await client.set('a:lease-lock', 'successor')
    await redis.update({ ...input(), encodedData: 'new' })
    expect(await redis.update({ ...input(), writeToken, lockKey: 'a:lease-lock', lockValue: 'old' })).toEqual([
      'INVALIDATED',
      0,
    ])
    expect((await redis.fetch(fetchInput()))?.encodedData).toBe('new')
  })

  it('retags atomically and clears obsolete memberships without touching disjoint entries', async () => {
    await redis.update(input())
    await redis.update({ ...input(), tags: ['blue'] })
    await redis.update({ ...input('a:other:'), tags: ['red'] })
    await redis.invalidateTags(['red'], 'a:')
    expect((await redis.fetch(fetchInput()))?.encodedData).toBe('old')
    expect(await redis.fetch(fetchInput(input('a:other:')))).toBeNull()
    await redis.clear('a:k:', 'a:k:data', 'a:k:meta')
    expect(await client.zrange('a:__adaptive:tag-index:blue', 0, -1)).toEqual([])
  })

  it('fails closed when Redis evicts namespace, barrier, state, or tag-index keys independently', async () => {
    const original = await redis.captureWriteToken('a:')
    await redis.update({ ...input(), writeToken: original })
    await client.del('a:__adaptive:namespace')
    expect(await redis.fetch(fetchInput())).toBeNull()
    const replacement = await redis.captureWriteToken('a:')
    expect(replacement).not.toBe(original)
    expect(await redis.update({ ...input(), writeToken: original })).toEqual(['INVALIDATED', 0])
    await redis.update({ ...input(), writeToken: replacement })
    await client.del('a:k:data:state', 'a:__adaptive:tag-index:red')
    await redis.invalidateTags(['red'], 'a:')
    expect(await redis.fetch(fetchInput())).toBeNull()
    const beforeEviction = await redis.captureWriteToken('a:')
    await client.del('a:__adaptive:barrier', '__adaptive:legacy-barrier')
    expect(await redis.captureWriteToken('a:')).not.toBe(beforeEviction)
    expect(await redis.update({ ...input(), writeToken: beforeEviction })).toEqual(['INVALIDATED', 0])
  })

  it('cleans obsolete tags after the separate tag-state hash was evicted', async () => {
    await redis.update(input())
    await client.del(input().dataKey + ':state')
    await redis.update({ ...input(), tags: ['blue'] })
    expect(await client.zrange('a:__adaptive:tag-index:red', 0, -1)).toEqual([])
    await redis.invalidateTags(['red'], 'a:')
    expect(await redis.fetch(fetchInput())).not.toBeNull()
    await client.del(input().dataKey + ':state')
    await redis.clear(input().key, input().dataKey, input().metaKey, 'a:')
    expect(await client.zrange('a:__adaptive:tag-index:blue', 0, -1)).toEqual([])
  })

  it('bounds tag-epoch retention and does not create epochs for unknown invalidated tags', async () => {
    await redis.update({ ...input(), metaTTL: 4 })
    const epochKey = 'a:__adaptive:tag-epoch:red'
    expect(await client.pttl(epochKey)).toBeGreaterThan(0)
    expect(await client.pttl(epochKey)).toBeLessThanOrEqual(4000)
    await redis.update({ ...input('a:other:'), metaTTL: 1, staleTTL: 0 })
    expect(await client.pttl(epochKey)).toBeGreaterThan(3000)
    await redis.invalidateTags(['unknown'], 'a:')
    expect(await client.exists('a:__adaptive:tag-epoch:unknown')).toBe(0)
  })

  it('shortens physical freshness with jitter while retaining the adaptive TTL', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    try {
      const result = await redis.update({ ...input(), initialTTL: 10, staleTTL: 0, ttlJitter: 0.4 })
      expect(result[1]).toBe(10)
      expect(await client.pttl(input().dataKey)).toBeLessThanOrEqual(8000)
      expect(await client.pttl(input().dataKey)).toBeGreaterThan(7500)
    } finally {
      random.mockRestore()
    }
  })

  it('invalidates only existing entries in the requested namespace', async () => {
    await redis.update(input())
    await redis.update(input('b:k:', 'b:'))
    await redis.invalidateNamespace('a:')
    expect(await redis.fetch(fetchInput())).toBeNull()
    expect((await redis.fetch(fetchInput(input('b:k:', 'b:'))))?.layer).toBe('redis')
    await redis.update({ ...input(), writeToken: await redis.captureWriteToken('a:') })
    expect(await redis.fetch(fetchInput())).not.toBeNull()
  })

  it('keeps Redis stale values only within retention and filters ordinary reads', async () => {
    await redis.update(input())
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(await redis.fetch(fetchInput())).toBeNull()
    const stale = await redis.fetch(fetchInput(input(), true))
    expect(stale).toMatchObject({ encodedData: 'old', ttl: 0, stale: true, layer: 'redis' })
    expect(stale?.staleAge).toBeGreaterThanOrEqual(0)
    await new Promise((resolve) => setTimeout(resolve, 2000))
    expect(await redis.fetch(fetchInput(input(), true))).toBeNull()
  })

  it('completes L1 loader invalidation and a subsequent reload', async () => {
    const cache = new AdaptiveCache(
      {
        backend: 'l1-redis',
        keyPrefix: 'loader-case:',
        lru: { namespace: 'loader-case:' + Math.random() },
        logLevel: 'silent',
      },
      client,
    )
    let begin!: () => void
    let finish!: () => void
    const started = new Promise<void>((resolve) => {
      begin = resolve
    })
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const bounded = async <T>(work: Promise<T>, stage: string) => {
      let timer: ReturnType<typeof setTimeout>
      try {
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(stage)), 2000)
          }),
        ])
      } finally {
        clearTimeout(timer!)
      }
    }
    try {
      const load = cache.getOrSet('item', async () => {
        begin()
        await gate
        return 'old'
      })
      await bounded(started, 'initial loader start')
      await redis.clear('item', 'itemdata', 'itemmeta', 'loader-case:')
      finish()
      expect(await bounded(load, 'initial loader result')).toBe('old')
      await bounded(cache.flush(), 'cache flush')
      expect(await bounded(cache.get('item'), 'cleared read')).toBeNull()
      expect(
        await bounded(
          cache.getOrSet('item', async () => 'new'),
          'subsequent loader',
        ),
      ).toBe('new')
    } finally {
      finish()
      await bounded(cache.close(), 'close')
    }
  })

  it('does not hydrate a write invalidated after Redis accepted it', async () => {
    const lru = new ClusteredLruAdaptiveCacheBackend({ namespace: 'ack-race-' + Math.random() }, logger)
    const l1 = new L1RedisAdaptiveCacheBackend(redis, lru, 'a:', logger, 'await-redis')
    const update = redis.update.bind(redis)
    const spy = vi.spyOn(redis, 'update').mockImplementationOnce(async (value) => {
      const result = await update(value)
      await redis.invalidateNamespace('a:')
      return result
    })
    try {
      expect(await l1.update({ ...input(), writeToken: await l1.captureWriteToken('a:') })).toEqual(['INVALIDATED', 0])
      expect(await l1.fetch(fetchInput())).toBeNull()
    } finally {
      spy.mockRestore()
      await l1.quit()
    }
  })

  it('keeps subsecond Redis freshness authoritative and invalidates via the L1 wrapper', async () => {
    const lru = new ClusteredLruAdaptiveCacheBackend({ namespace: 'short-life-' + Math.random() }, logger)
    const l1 = new L1RedisAdaptiveCacheBackend(redis, lru, 'a:', logger, 'await-redis')
    try {
      await l1.update({ ...input(), ttlJitter: 0.5, writeToken: await l1.captureWriteToken('a:') })
      const hit = await l1.fetch(fetchInput())
      expect(hit?.layer).toBe('l1')
      expect(hit?.encodedData).toBe('old')
      await l1.invalidateNamespace('a:')
      expect(await l1.fetch(fetchInput())).toBeNull()
    } finally {
      await l1.quit()
    }
  })

  it('checks Redis invalidation even when an L1 subscriber misses the message', async () => {
    const lru = new ClusteredLruAdaptiveCacheBackend({ namespace: 'backend-features-' + Math.random() }, logger)
    const l1 = new L1RedisAdaptiveCacheBackend(redis, lru, 'a:', logger, 'await-redis')
    try {
      await l1.update({ ...input(), initialTTL: 10 })
      expect((await l1.fetch(fetchInput()))?.layer).toBe('l1')
      await redis.invalidateNamespace('a:')
      expect(await l1.fetch(fetchInput())).toBeNull()
      const writeToken = await l1.captureWriteToken('a:')
      await redis.invalidateTags(['red'], 'a:')
      expect(await l1.update({ ...input(), writeToken })).toEqual(['INVALIDATED', 0])
      expect(await l1.fetch(fetchInput())).toBeNull()
    } finally {
      await l1.quit()
    }
  })
})

describe('Redis barrier initialization failures', () => {
  it('fails explicitly when control keys repeatedly disappear during initialization', async () => {
    const client = new FakeRedis()
    const backend = new RedisAdaptiveCacheBackend(client as any, logger)
    const evicted = vi.spyOn(client, 'setnx').mockResolvedValue(0)
    try {
      await expect(backend.captureWriteToken('missing:')).rejects.toThrow('cannot retain invalidation barriers')
    } finally {
      evicted.mockRestore()
    }
  })
})

describe('Clustered LRU feature guarantees', () => {
  it.each(['clear', 'tags', 'namespace'])(
    'does not expose an LRU store that crosses a concurrent %s invalidation',
    async (kind) => {
      const writer = new ClusteredLruAdaptiveCacheBackend({ namespace: 'race-' + Math.random() }, logger)
      // Separate serialization domains model distinct workers sharing the primary cache.
      const invalidator = new ClusteredLruAdaptiveCacheBackend({ namespace: 'other-worker-' + Math.random() }, logger)
      const primary = await (writer as any).getCache()
      ;(invalidator as any).cachePromise = Promise.resolve(primary)
      const set = primary.set.bind(primary)
      let started!: () => void
      let release!: () => void
      const entered = new Promise<void>((resolve) => {
        started = resolve
      })
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      const spy = vi.spyOn(primary, 'set').mockImplementation(async (key: string, ...args: unknown[]) => {
        if (key === input().dataKey) {
          started()
          await barrier
        }
        return set(key, ...args)
      })
      try {
        const updating = writer.update({ ...input(), writeToken: await writer.captureWriteToken('a:') })
        await entered
        if (kind === 'clear') await invalidator.clear('a:k:', 'a:k:data', 'a:k:meta', 'a:')
        if (kind === 'tags') await invalidator.invalidateTags(['red'], 'a:')
        if (kind === 'namespace') await invalidator.invalidateNamespace('a:')
        release()
        await updating
        expect(await writer.fetch(fetchInput())).toBeNull()
      } finally {
        release()
        spy.mockRestore()
        await writer.quit()
      }
    },
  )

  it('reports actual dependency evictions and isolates observer errors', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: 'evictions-' + Math.random(), maxSizeBytes: 12000, maxEntrySizeBytes: 4000 },
      logger,
    )
    let evictions = 0
    const unsubscribe = backend.onEvent((event) => {
      evictions += event.count || 0
      throw new Error('observer')
    })
    try {
      for (let index = 0; index < 12; index++)
        await backend.update({ ...input('a:evict:' + index + ':'), encodedData: 'x'.repeat(1200) })
      const primary = await (backend as any).getCache()
      expect(evictions).toBeGreaterThan(0)
      expect(evictions).toBe((await primary.stats()).evictions)
    } finally {
      unsubscribe()
      await backend.quit()
    }
  })

  it('rejects entries when an epoch is evicted and preserves disjoint retagged entries', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: 'epoch-retag-' + Math.random() }, logger)
    try {
      await backend.update(input())
      await backend.update({ ...input(), tags: ['blue'] })
      await backend.update({ ...input('a:other:'), tags: ['red'] })
      await backend.invalidateTags(['red'], 'a:')
      expect(await backend.fetch(fetchInput())).not.toBeNull()
      expect(await backend.fetch(fetchInput(input('a:other:')))).toBeNull()
      const primary = await (backend as any).getCache()
      await primary.delete(input().dataKey + ':epoch')
      expect(await backend.fetch(fetchInput())).toBeNull()
    } finally {
      await backend.quit()
    }
  })

  it('recovers its mutation queue after a failed write and retains shared tag members', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend(undefined, logger)
    const primary = await (backend as any).getCache()
    const set = primary.set.bind(primary)
    const spy = vi.spyOn(primary, 'set').mockImplementationOnce(async () => {
      throw new Error('storage unavailable')
    })
    try {
      const failed = backend.update(input())
      const succeeding = backend.update(input('a:other:'))
      await expect(failed).rejects.toThrow('storage unavailable')
      await succeeding
      spy.mockRestore()
      await backend.update(input())
      await backend.clear('a:k:', 'a:k:data', 'a:k:meta', 'a:')
      expect(await backend.fetch(fetchInput(input('a:other:')))).not.toBeNull()
      expect(Object.keys(await primary.get('a:tag:red'))).toEqual(['a:other:'])
      await primary.delete('a:tag:red')
      await backend.clear('a:other:', 'a:other:data', 'a:other:meta', 'a:')
      expect(await backend.fetch(fetchInput(input('a:other:')))).toBeNull()
    } finally {
      spy.mockRestore()
      primary.set = set
      await backend.quit()
    }
  })

  it('fails explicitly if the configured LRU cannot retain write barriers', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: 'tiny-barrier-' + Math.random(), maxSizeBytes: 512, maxEntrySizeBytes: 32 },
      logger,
    )
    try {
      await expect(backend.captureWriteToken('a:')).rejects.toThrow('cannot retain invalidation barrier')
    } finally {
      await backend.quit()
    }
  })

  it('ignores rejected hydration and invalidates conservative envelopes', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: 'hydration-' + Math.random() }, logger)
    try {
      await backend.hydrateFromUpdate(input(), ['INVALIDATED', 0])
      expect(await backend.fetch(fetchInput())).toBeNull()
      await backend.hydrateFromUpdate(input(), ['CACHED', 3, 1, 1, 'accepted', 1])
      expect((await backend.fetch(fetchInput()))?.metadata?.hash).toBe('accepted')
      await backend.invalidateNamespace('a:')
      expect(await backend.fetch(fetchInput())).toBeNull()
    } finally {
      await backend.quit()
    }
  })

  it('releases LRU loader locks without markers and preserves regular refresh timestamps', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: 'loader-cleanup-' + Math.random() }, logger)
    try {
      const primary = await (backend as any).getCache()
      await backend.shouldRefresh('loader:key', 0, 100, false, 60, 'owner')
      expect(await backend.releaseLock('loader:key', 100, 'owner', false)).toEqual(['UPDATED'])
      expect(await primary.get('loader:key')).toBeUndefined()
      expect(await primary.get('loader:key-lock')).toBeUndefined()
      await backend.shouldRefresh('regular:key', 0, 100, false, 60, 'owner')
      await backend.releaseLock('regular:key', 100, 'owner')
      expect(await primary.get('regular:key')).toBe(100)
    } finally {
      await backend.quit()
    }
  })

  it('fences earlier work, scopes namespace invalidation, and filters stale reads', async () => {
    const backend: AdaptiveCacheBackend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: 'features-' + Math.random() },
      logger,
    )
    try {
      const token = await backend.captureWriteToken!('a:')
      await backend.clear('a:k:', 'a:k:data', 'a:k:meta')
      expect(await backend.update({ ...input(), writeToken: token })).toEqual(['INVALIDATED', 0])
      await backend.update(input())
      await backend.update(input('b:k:', 'b:'))
      await backend.invalidateNamespace!('a:')
      expect(await backend.fetch(fetchInput())).toBeNull()
      expect((await backend.fetch(fetchInput(input('b:k:', 'b:'))))?.layer).toBe('lru')
      await new Promise((resolve) => setTimeout(resolve, 1100))
      expect(await backend.fetch(fetchInput(input('b:k:', 'b:')))).toBeNull()
      expect(await backend.fetch(fetchInput(input('b:k:', 'b:'), true))).toMatchObject({ stale: true, ttl: 0 })
    } finally {
      await backend.quit?.()
    }
  })
})
