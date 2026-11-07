import { describe, expect, it, vi } from 'vitest'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { L1RedisAdaptiveCacheBackend } from '../src/backends/L1RedisAdaptiveCacheBackend'
import { RedisAdaptiveCacheBackend } from '../src/backends/RedisAdaptiveCacheBackend'
import { Logger } from '../src/lib/logger'
import { FakeRedis } from './helpers/FakeRedis'

const namespace = (name: string) => `adaptive-cache-backend-${name}-${Date.now()}-${Math.random()}`

const logger = () => new Logger('silent')

describe('L1RedisAdaptiveCacheBackend', () => {
  it('rejects invalid tags before an optimistic L1 write', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend({ namespace: namespace('invalid-tag') }, logger())
    const store = vi.spyOn(lru, 'storeConservative')
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())

    await expect(
      backend.update({
        key: 'invalid-tag',
        dataKey: 'invalid-tagdata',
        metaKey: 'invalid-tagmeta',
        redisPrefix: 'adaptive:',
        encodedData: 'value',
        responseHash: 'hash',
        initialTTL: 5,
        maxTTL: 60,
        ttlScaling: 2,
        metaTTL: 100,
        tags: [''],
      }),
    ).rejects.toThrow('non-empty')
    expect(store).not.toHaveBeenCalled()
    await backend.quit()
  })

  it.each(['flush', 'subscriber', 'redis', 'all'])('finishes all cleanup after %s shutdown failure', async (stage) => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger(), true)
    const lru = new ClusteredLruAdaptiveCacheBackend({ namespace: namespace('shutdown') }, logger())
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())
    const subscriber = (backend as any).subscriber as FakeRedis
    const failure = new Error(stage + ' unavailable')
    if (stage === 'flush' || stage === 'all') vi.spyOn(backend, 'flush').mockRejectedValue(failure)
    const subscriberQuit = vi.spyOn(subscriber, 'quit')
    const redisQuit = vi.spyOn(redis, 'quit')
    const lruQuit = vi.spyOn(lru, 'quit')
    if (stage === 'subscriber' || stage === 'all') subscriberQuit.mockRejectedValue(failure)
    if (stage === 'redis' || stage === 'all') redisQuit.mockRejectedValue(failure)
    if (stage === 'all') lruQuit.mockRejectedValue(new Error('LRU cleanup failed'))

    try {
      await expect(backend.quit(true)).rejects.toBe(failure)
      expect(subscriber.disconnectCalls).toBe(1)
      expect(subscriberQuit).toHaveBeenCalledTimes(1)
      expect(redisQuit).toHaveBeenCalledTimes(1)
      expect(redis.disconnectCalls).toBe(1)
      expect(lruQuit).toHaveBeenCalledWith(true)
      expect((backend as any).subscriber).toBeUndefined()
    } finally {
      vi.restoreAllMocks()
      await backend.quit(false, true)
    }
  })

  it('forces a subscriber disconnect while its graceful quit is still pending', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend({ namespace: namespace('forced-shutdown') }, logger())
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())
    const subscriber = (backend as any).subscriber as FakeRedis
    let finishQuit!: () => void
    vi.spyOn(subscriber, 'quit').mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finishQuit = () => resolve('OK')
        }),
    )
    const closing = backend.quit()
    await vi.waitFor(() => expect(finishQuit).toBeTypeOf('function'))
    await backend.quit(false, true)
    expect(subscriber.disconnectCalls).toBe(1)
    expect(redis.disconnectCalls).toBe(0)
    finishQuit()
    await closing
  })

  it('should read through Redis, hydrate L1, write conservatively, reconcile asynchronously, and invalidate', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('l1'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())

    await redisBackend.update({
      key: 'l1-key',
      dataKey: 'l1-keydata',
      metaKey: 'l1-keymeta',
      redisPrefix: 'adaptive:',
      encodedData: JSON.stringify({ from: 'redis' }),
      responseHash: 'hash-redis',
      initialTTL: 5,
      maxTTL: 60,
      ttlScaling: 2,
      metaTTL: 100,
      tags: [],
    })

    const first = await backend.fetch({
      key: 'l1-key',
      dataKey: 'l1-keydata',
      metaKey: 'l1-keymeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    })
    expect(first?.metadata?.hash).toBe('hash-redis')

    redis.failFetch = true
    const second = await backend.fetch({
      key: 'l1-key',
      dataKey: 'l1-keydata',
      metaKey: 'l1-keymeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    })
    expect(second?.encodedData).toBe(JSON.stringify({ from: 'redis' }))
    redis.failFetch = false

    const updateInput = {
      key: 'l1-key',
      dataKey: 'l1-keydata',
      metaKey: 'l1-keymeta',
      redisPrefix: 'adaptive:',
      encodedData: JSON.stringify({ from: 'l1' }),
      responseHash: 'hash-l1',
      initialTTL: 3,
      maxTTL: 60,
      ttlScaling: 2,
      metaTTL: 100,
      tags: ['l1-tag'],
    }
    expect((await backend.update(updateInput))[1]).toBe(3)

    await vi.waitFor(async () => {
      expect((await redis.hgetall('l1-keymeta')).hash).toBe('hash-l1')
    })

    expect(await backend.invalidateTags(['l1-tag'], 'adaptive:')).toEqual(['l1-key'])
    expect(redis.published.length).toBeGreaterThan(0)

    await backend.clear('l1-key', 'l1-keydata', 'l1-keymeta')
    await backend.quit()
  })

  it('should fall through unconfirmed L1 data when Redis async update fails', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('l1-fail'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())
    redis.failUpdate = true

    await backend.update({
      key: 'fail-key',
      dataKey: 'fail-keydata',
      metaKey: 'fail-keymeta',
      redisPrefix: 'adaptive:',
      encodedData: JSON.stringify({ ok: true }),
      responseHash: 'hash-fail',
      initialTTL: 3,
      maxTTL: 60,
      ttlScaling: 2,
      metaTTL: 100,
      tags: [],
    })

    const hit = await backend.fetch({
      key: 'fail-key',
      dataKey: 'fail-keydata',
      metaKey: 'fail-keymeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    })
    expect(hit).toBeNull()

    await backend.quit()
  })

  it('should support awaiting Redis writes and flushing async writes', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('l1-await'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const awaitBackend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger(), 'await-redis')
    const input = {
      key: 'await-key',
      dataKey: 'await-keydata',
      metaKey: 'await-keymeta',
      redisPrefix: 'adaptive:',
      encodedData: JSON.stringify({ ok: true }),
      responseHash: 'await-hash',
      initialTTL: 3,
      maxTTL: 60,
      ttlScaling: 2,
      metaTTL: 100,
      tags: [],
    }

    expect((await awaitBackend.update(input))[4]).toBe('await-hash')
    expect((await redis.hgetall('await-keymeta')).hash).toBe('await-hash')
    await awaitBackend.flush()
    await awaitBackend.quit()
  })

  it('should reject awaited Redis writes when Redis update fails', async () => {
    const redis = new FakeRedis()
    redis.failUpdate = true
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('l1-await-fail'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger(), 'await-redis')

    await expect(
      backend.update({
        key: 'await-fail-key',
        dataKey: 'await-fail-keydata',
        metaKey: 'await-fail-keymeta',
        redisPrefix: 'adaptive:',
        encodedData: JSON.stringify({ ok: true }),
        responseHash: 'await-fail-hash',
        initialTTL: 3,
        maxTTL: 60,
        ttlScaling: 2,
        metaTTL: 100,
        tags: [],
      }),
    ).rejects.toThrow('update failed')

    await backend.quit()
  })

  it('should tolerate subscriber and publish failures', async () => {
    const redis = new FakeRedis()
    redis.failSubscribe = true
    redis.failPublish = true
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('l1-pub-fail'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())

    await (backend as any).publishInvalidation([])
    await backend.clear('key', 'keydata', 'keymeta')
    await vi.waitFor(() => expect((backend as any).subscriber.subscribedChannels).toEqual([]))
    await backend.quit()

    redis.failDuplicate = true
    const backendWithDuplicateFailure = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())
    await backendWithDuplicateFailure.quit()
  })

  it('should skip publish when Redis reports unchanged data and when tags resolve to no keys', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('l1-unchanged'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())
    const input = {
      key: 'stable-key',
      dataKey: 'stable-keydata',
      metaKey: 'stable-keymeta',
      redisPrefix: 'adaptive:',
      encodedData: JSON.stringify({ stable: true }),
      responseHash: 'stable-hash',
      initialTTL: 3,
      maxTTL: 60,
      ttlScaling: 2,
      metaTTL: 100,
      tags: [],
    }

    await redisBackend.update(input)
    redis.published = []
    await backend.update(input)
    await vi.waitFor(async () => {
      expect((await redis.hgetall('stable-keymeta')).dataTTL).toBe('6')
    })

    expect(redis.published).toEqual([])
    expect(await backend.invalidateTags(['missing-tag'], 'adaptive:')).toEqual([])

    await backend.quit()
  })

  it('should tolerate Redis hit hydration failures and delegate locks to Redis', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('l1-hydrate-fail'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())

    await redisBackend.update({
      key: 'hydrate-fail-key',
      dataKey: 'hydrate-fail-keydata',
      metaKey: 'hydrate-fail-keymeta',
      redisPrefix: 'adaptive:',
      encodedData: JSON.stringify({ ok: true }),
      responseHash: 'hash-hydrate-fail',
      initialTTL: 5,
      maxTTL: 60,
      ttlScaling: 2,
      metaTTL: 100,
      tags: [],
    })
    ;(backend as any).lru.hydrateFromFetch = vi.fn(async () => {
      throw new Error('hydrate failed')
    })

    const hit = await backend.fetch({
      key: 'hydrate-fail-key',
      dataKey: 'hydrate-fail-keydata',
      metaKey: 'hydrate-fail-keymeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    })
    expect(hit?.metadata?.hash).toBe('hash-hydrate-fail')

    const refresh = await backend.shouldRefresh('l1-lock-key', 10, 100, false, 1, 'lock-a')
    expect(refresh[0]).toBe('UPDATE')
    expect(await backend.releaseLock('l1-lock-key', 100, refresh[1] as string)).toEqual(['UPDATED'])

    await backend.quit()
  })

  it('should apply external invalidation messages and ignore invalid/self messages', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('l1-message'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())

    await lru.storeConservative({
      key: 'message-key',
      dataKey: 'message-keydata',
      metaKey: 'message-keymeta',
      redisPrefix: 'adaptive:',
      encodedData: JSON.stringify({ ok: true }),
      responseHash: 'hash-message',
      writeToken: await redisBackend.captureWriteToken('adaptive:'),
      initialTTL: 5,
      maxTTL: 60,
      ttlScaling: 2,
      metaTTL: 100,
      tags: [],
    })

    await redisBackend.update({
      key: 'message-key',
      dataKey: 'message-keydata',
      metaKey: 'message-keymeta',
      redisPrefix: 'adaptive:',
      encodedData: 'confirmed',
      responseHash: 'hash-message',
      initialTTL: 5,
      maxTTL: 60,
      ttlScaling: 2,
      metaTTL: 100,
      tags: [],
    })
    expect(
      await backend.fetch({
        key: 'message-key',
        dataKey: 'message-keydata',
        metaKey: 'message-keymeta',
        redisPrefix: 'adaptive:',
        includeDebugHeaders: true,
      }),
    ).not.toBeNull()
    await redis.del('message-keydata')
    ;(backend as any).handleInvalidation('not-json')
    ;(backend as any).handleInvalidation(JSON.stringify({ source: (backend as any).sourceId, keys: ['message-key'] }))
    ;(backend as any).handleInvalidation(JSON.stringify({ source: 'external', keys: ['message-key'] }))

    await vi.waitFor(async () => {
      expect(
        await backend.fetch({
          key: 'message-key',
          dataKey: 'message-keydata',
          metaKey: 'message-keymeta',
          redisPrefix: 'adaptive:',
          includeDebugHeaders: true,
        }),
      ).toBeNull()
    })

    await backend.quit()
  })

  it('should handle subscriber events and failed invalidation handlers', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('l1-subscriber-events'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())
    const subscriber = (backend as any).subscriber as FakeRedis

    subscriber.emit('error', new Error('subscriber error'))
    subscriber.emit('message', 'adaptive:l1:invalidate', JSON.stringify({ source: 'external', keys: [] }))
    const remove = vi.spyOn((backend as any).lru, 'deleteKeys').mockRejectedValue(new Error('delete failed'))
    ;(backend as any).handleInvalidation(JSON.stringify({ source: 'external', keys: ['key'] }))

    await vi.waitFor(() => {
      expect((backend as any).lru.deleteKeys).toHaveBeenCalledWith(['key'])
    })

    remove.mockResolvedValue(undefined)
    await backend.flush()
    await backend.quit()
  })

  it('bounds, deduplicates, and drains subscriber invalidation work', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend(
      { namespace: namespace('bounded-invalidation'), maxSizeBytes: 1024 * 1024 },
      logger(),
    )
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const remove = vi.spyOn(lru, 'deleteKeys').mockImplementation(async () => {
      await barrier
    })
    const generation = (backend as any).state.generation

    ;(backend as any).handleInvalidation(JSON.stringify({ source: 'external', keys: [] }))
    ;(backend as any).handleInvalidation(JSON.stringify({ source: 'external', keys: ['x'.repeat(5000)] }))
    expect((backend as any).state.generation).toBe(generation)
    expect(remove).not.toHaveBeenCalled()

    ;(backend as any).handleInvalidation(JSON.stringify({ source: 'external', keys: ['a', 'a', 'b'] }))
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(['a', 'b']))
    const firstGeneration = (backend as any).state.generation
    ;(backend as any).handleInvalidation(JSON.stringify({ source: 'external', keys: ['a', 'b'] }))
    expect((backend as any).state.generation).toBe(firstGeneration)
    ;(backend as any).handleInvalidation(JSON.stringify({ source: 'external', keys: ['c'] }))
    expect((backend as any).state.generation).toBe(firstGeneration + 1)
    let flushed = false
    const flushing = backend.flush().then(() => {
      flushed = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(flushed).toBe(false)
    release()
    await flushing
    expect(remove).toHaveBeenCalledWith(['c'])
    await backend.quit()
  })

  it('rejects malformed and oversized subscriber messages before scheduling work', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend({ namespace: namespace('invalid-messages') }, logger())
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())
    const remove = vi.spyOn(lru, 'deleteKeys')
    const generation = (backend as any).state.generation
    const invalid = [
      'x'.repeat(256 * 1024 + 1),
      JSON.stringify(null),
      JSON.stringify('message'),
      JSON.stringify({ source: 1, keys: ['key'] }),
      JSON.stringify({ source: 'external', keys: 'key' }),
      JSON.stringify({ source: 'external', keys: Array.from({ length: 1025 }, () => 'key') }),
      JSON.stringify({ source: 'external', keys: [1] }),
      JSON.stringify({ source: 'external', keys: [''] }),
    ]

    for (const payload of invalid) (backend as any).handleInvalidation(payload)
    const subscriber = (backend as any).subscriber as FakeRedis
    subscriber.emit('message', 'another-channel', JSON.stringify({ source: 'external', keys: ['key'] }))

    expect((backend as any).state.generation).toBe(generation)
    expect(remove).not.toHaveBeenCalled()
    await backend.quit()
  })

  it('caps pending invalidations and deletes accepted work in bounded batches', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend({ namespace: namespace('pending-cap') }, logger())
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())
    const pending = (backend as any).pendingInvalidationKeys as Set<string>
    for (let index = 0; index < 4096; index++) pending.add(`pending-${index}`)
    const generation = (backend as any).state.generation
    ;(backend as any).handleInvalidation(JSON.stringify({ source: 'external', keys: ['overflow'] }))
    expect((backend as any).state.generation).toBe(generation)
    pending.clear()

    const remove = vi.spyOn(lru, 'deleteKeys')
    const keys = Array.from({ length: 130 }, (_, index) => `batch-${index}`)
    ;(backend as any).handleInvalidation(JSON.stringify({ source: 'external', keys }))
    await backend.flush()

    expect(remove).toHaveBeenNthCalledWith(1, keys.slice(0, 128))
    expect(remove).toHaveBeenNthCalledWith(2, keys.slice(128))
    await backend.quit()
  })

  it('chunks published invalidations to the subscriber limits', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend({ namespace: namespace('chunked-invalidation') }, logger())
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())
    const keys = Array.from({ length: 2050 }, (_, index) => `key-${index}`)

    await (backend as any).publishInvalidation(keys)

    expect(redis.published).toHaveLength(3)
    expect(redis.published.flatMap(({ payload }) => JSON.parse(payload).keys)).toEqual(keys)
    expect(redis.published.every(({ payload }) => Buffer.byteLength(payload, 'utf8') <= 256 * 1024)).toBe(true)
    expect(redis.published.every(({ payload }) => JSON.parse(payload).keys.length <= 1024)).toBe(true)

    redis.published = []
    await (backend as any).publishInvalidation(['', 1, 'x'.repeat(5000)])
    expect(redis.published).toEqual([])
    const largeKeys = Array.from({ length: 100 }, (_, index) => `${index}:` + 'x'.repeat(3000))
    await (backend as any).publishInvalidation(largeKeys)
    expect(redis.published.length).toBeGreaterThan(1)
    expect(redis.published.flatMap(({ payload }) => JSON.parse(payload).keys)).toEqual(largeKeys)
    expect(redis.published.every(({ payload }) => Buffer.byteLength(payload, 'utf8') <= 256 * 1024)).toBe(true)
    await backend.quit()
  })

  it('retries a failed subscriber invalidation batch before flush completes', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend({ namespace: namespace('retry-invalidation') }, logger())
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())
    const remove = vi.spyOn(lru, 'deleteKeys').mockRejectedValueOnce(new Error('temporary L1 failure'))

    ;(backend as any).handleInvalidation(JSON.stringify({ source: 'external', keys: ['retry'] }))
    await backend.flush()

    expect(remove).toHaveBeenCalledTimes(2)
    await backend.quit()
  })

  it('reports a persistent subscriber invalidation failure after one retry', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const lru = new ClusteredLruAdaptiveCacheBackend({ namespace: namespace('failed-invalidation') }, logger())
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'adaptive:', logger())
    const remove = vi.spyOn(lru, 'deleteKeys').mockRejectedValue(new Error('persistent L1 failure'))

    ;(backend as any).handleInvalidation(JSON.stringify({ source: 'external', keys: ['retry'] }))
    await expect(backend.flush()).rejects.toThrow('persistent L1 failure')
    expect(remove).toHaveBeenCalledTimes(2)
    remove.mockResolvedValue(undefined)
    await backend.flush()
    await backend.quit()
  })

  it('releases shared per-prefix state after the last backend closes', async () => {
    const redis = new FakeRedis()
    const redisBackend = new RedisAdaptiveCacheBackend(redis as any, logger())
    const first = new L1RedisAdaptiveCacheBackend(
      redisBackend,
      new ClusteredLruAdaptiveCacheBackend({ namespace: namespace('state-first') }, logger()),
      'state:',
      logger(),
    )
    const second = new L1RedisAdaptiveCacheBackend(
      redisBackend,
      new ClusteredLruAdaptiveCacheBackend({ namespace: namespace('state-second') }, logger()),
      'state:',
      logger(),
    )
    const originalState = (first as any).state
    expect((second as any).state).toBe(originalState)
    await first.quit()
    await second.quit()

    const third = new L1RedisAdaptiveCacheBackend(
      redisBackend,
      new ClusteredLruAdaptiveCacheBackend({ namespace: namespace('state-third') }, logger()),
      'state:',
      logger(),
    )
    expect((third as any).state).not.toBe(originalState)
    await third.quit()
  })
})
