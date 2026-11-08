import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { AdaptiveCache } from '../src/AdaptiveCache'
import { RedisAdaptiveCacheBackend } from '../src/backends/RedisAdaptiveCacheBackend'
import { Logger } from '../src/lib/logger'
import { FakeRedis } from './helpers/FakeRedis'

const logger = () => new Logger('silent')

describe('RedisAdaptiveCacheBackend', () => {
  it.each([0, 1.5, Number.POSITIVE_INFINITY])('rejects invalid direct cleanup limit %s', (limit) => {
    expect(() => new RedisAdaptiveCacheBackend(new FakeRedis() as any, logger(), false, limit)).toThrow(RangeError)
  })

  it('passes the configured cleanup limit through AdaptiveCache', async () => {
    const redis = new FakeRedis()
    const cache = new AdaptiveCache({ logLevel: 'silent', redis: { maxTagCleanupKeys: 1 } }, redis as any)
    redis.stores.sortedSets.set(
      'adaptive:__adaptive:tag-index:red',
      new Map(['one', 'two'].map((key) => [key, Date.now() + 60_000])),
    )

    try {
      await expect(cache.invalidateTags(['red'])).rejects.toThrow('cleanup limit')
    } finally {
      await cache.close()
    }
  })

  it('rejects tag invalidation above its aggregate cleanup limit', async () => {
    const redis = new FakeRedis()
    const backend = new (RedisAdaptiveCacheBackend as any)(redis, logger(), false, 2) as RedisAdaptiveCacheBackend
    const index = 'adaptive:__adaptive:tag-index:red'
    redis.stores.sortedSets.set(index, new Map(['one', 'two', 'three'].map((key) => [key, Date.now() + 60_000])))

    await expect(backend.invalidateTags(['red'], 'adaptive:')).rejects.toThrow('cleanup limit')
  })

  it('counts repeated key memberships across tag snapshots toward the cleanup limit', async () => {
    const redis = new FakeRedis()
    const backend = new RedisAdaptiveCacheBackend(redis as any, logger(), false, 3)
    for (const tag of ['red', 'blue']) {
      const index = `adaptive:__adaptive:tag-index:${tag}`
      redis.stores.sortedSets.set(index, new Map(['one', 'two'].map((key) => [key, Date.now() + 60_000])))
    }

    await expect(backend.invalidateTags(['red', 'blue'], 'adaptive:')).rejects.toThrow('cleanup limit')
  })

  it('rejects excessive tag input before invoking invalidation Lua', async () => {
    const redis = new FakeRedis()
    const invalidate = vi.spyOn(redis, 'adaptiveCacheInvalidate')
    const backend = new RedisAdaptiveCacheBackend(redis as any, logger())

    await expect(
      backend.invalidateTags(
        Array.from({ length: 1025 }, () => 'tag'),
        'adaptive:',
      ),
    ).rejects.toThrow('at most 1024')
    expect(invalidate).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'non-array', tags: 'tag', message: 'array' },
    { name: 'non-string', tags: [1], message: 'strings' },
    { name: 'empty', tags: [''], message: 'non-empty' },
    { name: 'overlong', tags: ['x'.repeat(4097)], message: '4096 bytes' },
    {
      name: 'oversized payload',
      tags: Array.from({ length: 100 }, (_, index) => `${index}:` + 'x'.repeat(3000)),
      message: 'payload exceeds',
    },
  ])('rejects $name tag input before invoking invalidation Lua', async ({ tags, message }) => {
    const redis = new FakeRedis()
    const invalidate = vi.spyOn(redis, 'adaptiveCacheInvalidate')
    const backend = new RedisAdaptiveCacheBackend(redis as any, logger())

    await expect((backend.invalidateTags as any)(tags, 'adaptive:')).rejects.toThrow(message)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('deduplicates tags consistently and rejects invalid tags before writes', async () => {
    const redis = new FakeRedis()
    const invalidate = vi.spyOn(redis, 'adaptiveCacheInvalidate')
    const update = vi.spyOn(redis, 'adaptiveCacheUpdate')
    const backend = new RedisAdaptiveCacheBackend(redis as any, logger())

    await backend.invalidateTags(['missing', 'missing'], 'adaptive:')
    expect(invalidate.mock.calls[0][4]).toBe('["missing"]')
    await backend.update({
      key: 'valid-tag',
      dataKey: 'valid-tagdata',
      metaKey: 'valid-tagmeta',
      redisPrefix: 'adaptive:',
      encodedData: 'value',
      responseHash: 'hash',
      initialTTL: 5,
      maxTTL: 60,
      ttlScaling: 2,
      metaTTL: 100,
      tags: ['tag', 'tag'],
    })
    expect(update.mock.calls[0][11]).toBe('["tag"]')
    update.mockClear()
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
    expect(update).not.toHaveBeenCalled()
  })

  it('does not record refresh success after the Redis lease is absent', async () => {
    const redis = new FakeRedis()
    const backend = new RedisAdaptiveCacheBackend(redis as any, logger())
    expect(await backend.releaseLock('missing-lock', 100, 'owner')).toEqual(['LOCK_MISMATCH', ''])
    expect(await redis.get('missing-lock')).toBeNull()
  })

  it('should fetch, update, tag, clear, invalidate, and coordinate locks through Redis commands', async () => {
    const redis = new FakeRedis()
    const backend = new RedisAdaptiveCacheBackend(redis as any, logger())

    const update = await backend.update({
      key: 'redis-key',
      dataKey: 'redis-keydata',
      metaKey: 'redis-keymeta',
      redisPrefix: 'adaptive:',
      encodedData: JSON.stringify({ ok: true }),
      responseHash: 'hash-a',
      initialTTL: 5,
      maxTTL: 60,
      ttlScaling: 2,
      metaTTL: 100,
      tags: ['tag-a'],
    })

    expect(update[0]).toBe('CACHED')
    expect(update[4]).toBe('hash-a')
    expect(await redis.zrange('adaptive:__adaptive:tag-index:tag-a', 0, -1)).toEqual(['redis-key'])

    const hit = await backend.fetch({
      key: 'redis-key',
      dataKey: 'redis-keydata',
      metaKey: 'redis-keymeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    })
    expect(hit?.encodedData).toBe(JSON.stringify({ ok: true }))
    expect(hit?.metadata?.hash).toBe('hash-a')

    const miss = await backend.fetch({
      key: 'missing',
      dataKey: 'missingdata',
      metaKey: 'missingmeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    })
    expect(miss).toBeNull()

    const refresh = await backend.shouldRefresh('last-update', 10, 100, false, 1, 'lock-a')
    expect(refresh[0]).toBe('UPDATE')
    const updating = await backend.shouldRefresh('last-update', 10, 100, false, 1, 'lock-b')
    expect(updating[0]).toBe('UPDATING')
    expect(await backend.releaseLock('last-update', 100, 'lock-a')).toEqual(['UPDATED'])
    expect((await backend.shouldRefresh('last-update', 10, 101, false, 1, 'lock-c'))[0]).toBe('EXISTS')
    expect((await backend.shouldRefresh('last-update', 10, 101, true, 1, 'lock-d'))[0]).toBe('UPDATE')

    const invalidated = await backend.invalidateTags(['tag-a'], 'adaptive:')
    expect(invalidated).toEqual(['redis-key'])
    expect(await redis.hgetall('redis-keymeta')).toEqual({})
    expect(await redis.exists('adaptive:tag:tag-a')).toBe(0)
    expect(await backend.invalidateTags(['missing-tag'], 'adaptive:')).toEqual([])
    expect(
      await backend.fetch({
        key: 'redis-key',
        dataKey: 'redis-keydata',
        metaKey: 'redis-keymeta',
        redisPrefix: 'adaptive:',
        includeDebugHeaders: true,
      }),
    ).toBeNull()

    await redis.adaptiveCacheUpdate(
      'redis-keydata',
      'redis-keymeta',
      'hash-b',
      JSON.stringify({ ok: false }),
      '5',
      '60',
      '2',
      '100',
    )
    await backend.clear('redis-key', 'redis-keydata', 'redis-keymeta')
    expect(await redis.get('redis-keydata')).toBeNull()
    expect(await redis.hgetall('redis-keymeta')).toEqual({})
    await backend.quit()
    expect(redis.quitCalls).toBe(0)
  })

  it('should define Lua commands when they are missing on the client', () => {
    const client = {
      defineCommand: vi.fn(),
    }

    new RedisAdaptiveCacheBackend(client as any, logger())

    expect(client.defineCommand.mock.calls.map(([name]) => name)).toEqual([
      'adaptiveCacheFetch',
      'adaptiveCacheUpdate',
      'shouldRefreshCache',
      'releaseCacheRefreshLock',
      'adaptiveCacheInvalidate',
      'adaptiveCacheValidate',
      'adaptiveCacheCleanup',
    ])
  })

  it('should fall back to the first Lua path candidate when no Lua path exists', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    const readSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue('-- mocked lua')
    const client = {
      defineCommand: vi.fn(),
    }

    try {
      new RedisAdaptiveCacheBackend(client as any, logger())
      expect(readSpy.mock.calls.map(([file]) => String(file).split('/').at(-1))).toEqual([
        'adaptiveCacheFetch.lua',
        'adaptiveCacheUpdate.lua',
        'shouldRefreshCache.lua',
        'releaseCacheRefreshLock.lua',
        'adaptiveCacheInvalidate.lua',
        'adaptiveCacheValidate.lua',
        'adaptiveCacheCleanup.lua',
      ])
      expect(client.defineCommand).toHaveBeenCalledWith('adaptiveCacheInvalidate', {
        numberOfKeys: 1,
        lua: '-- mocked lua',
      })
    } finally {
      readSpy.mockRestore()
      existsSpy.mockRestore()
    }
  })

  it('should fall back to hgetall metadata when fetch tuple has only old fields', async () => {
    const redis = new FakeRedis()
    await redis.set('old-keydata', 'raw', 'EX', 30)
    redis.stores.hashes.set('old-keymeta', {
      hash: 'old-hash',
      dataTTL: '30',
      lastChanged: '123',
      changeCount: '2',
    })
    redis.adaptiveCacheFetch = vi.fn(async () => ['raw', 30]) as any
    const backend = new RedisAdaptiveCacheBackend(redis as any, logger())

    const hit = await backend.fetch({
      key: 'old-key',
      dataKey: 'old-keydata',
      metaKey: 'old-keymeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    })

    expect(hit?.metadata).toEqual({
      hash: 'old-hash',
      dataTTL: '30',
      lastChanged: '123',
      changeCount: '2',
    })
  })

  it('should leave metadata empty when old fetch tuples have no metadata hash', async () => {
    const redis = new FakeRedis()
    await redis.set('old-empty-keydata', 'raw', 'EX', 30)
    redis.adaptiveCacheFetch = vi.fn(async () => ['raw', 30, null, null, null, null]) as any
    const backend = new RedisAdaptiveCacheBackend(redis as any, logger())

    const hit = await backend.fetch({
      key: 'old-empty-key',
      dataKey: 'old-empty-keydata',
      metaKey: 'old-empty-keymeta',
      redisPrefix: 'adaptive:',
      includeDebugHeaders: true,
    })

    expect(hit?.metadata).toBeUndefined()
  })

  it('should quit owned Redis clients', async () => {
    const redis = new FakeRedis()
    const backend = new RedisAdaptiveCacheBackend(redis as any, logger(), true)

    await backend.quit()

    expect(redis.quitCalls).toBe(1)
  })

  it('disconnects an owned client when graceful quit rejects', async () => {
    const redis = new FakeRedis()
    const failure = new Error('Redis unavailable')
    vi.spyOn(redis, 'quit').mockRejectedValue(failure)
    const backend = new RedisAdaptiveCacheBackend(redis as any, logger(), true)

    await expect(backend.quit()).rejects.toBe(failure)
    expect(redis.disconnectCalls).toBe(1)
  })

  it('never disconnects or quits a caller-owned client, including forced shutdown', async () => {
    const redis = new FakeRedis()
    const backend = new RedisAdaptiveCacheBackend(redis as any, logger())

    await backend.quit()
    await backend.quit(false, true)
    expect(redis.quitCalls).toBe(0)
    expect(redis.disconnectCalls).toBe(0)
  })
})
