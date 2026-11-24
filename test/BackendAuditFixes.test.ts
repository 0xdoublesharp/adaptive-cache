import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import Redis from 'ioredis'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { RedisAdaptiveCacheBackend } from '../src/backends/RedisAdaptiveCacheBackend'
import { estimateEnvelopeSize, type LruEnvelope } from '../src/backends/lruEnvelope'
import { Logger } from '../src/lib/logger'

const logger = new Logger('silent')
const input = (key = 'audit:item:') => ({
  key,
  dataKey: key + 'data',
  metaKey: key + 'meta',
  redisPrefix: 'audit:',
  includeDebugHeaders: false,
  encodedData: 'value',
  responseHash: 'hash',
  initialTTL: 30,
  maxTTL: 60,
  ttlScaling: 2,
  metaTTL: 100,
  tags: ['original'],
})

describe('Redis audit regressions', () => {
  let container: StartedTestContainer
  let client: Redis
  let backend: RedisAdaptiveCacheBackend

  beforeAll(async () => {
    container = await new GenericContainer('redis:alpine').withExposedPorts(6379).start()
    client = new Redis({ host: container.getHost(), port: container.getMappedPort(6379), stringNumbers: true })
    backend = new RedisAdaptiveCacheBackend(client, logger)
  })

  afterAll(async () => {
    await client?.quit()
    await container?.stop()
  })

  it('normalizes Lua integer replies without losing empty payloads or subsecond freshness', async () => {
    const entry = { ...input(), encodedData: '', staleTTL: 60 }
    const result = await backend.update(entry)
    expect(result).toEqual(['CACHED', 30, expect.any(Number), 1, 'hash', 1])
    const hit = await backend.fetch(entry)
    expect(hit).toMatchObject({ encodedData: '', ttl: expect.any(Number), stale: false, staleAge: 0 })
    expect(hit!.freshUntil - Date.now()).toBeGreaterThan(29_000)
    const token = await backend.captureWriteToken(entry.redisPrefix)
    expect(await backend.validateRevision(entry.dataKey, entry.redisPrefix, token, hit!.revision)).toBe(true)

    const marker = '@ac-redis:1:'
    const envelope = JSON.parse((await client.get(entry.dataKey))!.slice(marker.length))
    const [seconds, micros] = await client.time()
    envelope.freshUntil = Number(seconds) * 1000 + Math.floor(Number(micros) / 1000) - 250
    await client.set(entry.dataKey, marker + JSON.stringify(envelope), 'KEEPTTL')
    expect(await backend.fetch(entry)).toBeNull()
    const stale = await backend.fetch({ ...entry, allowStale: true })
    expect(stale).toMatchObject({
      encodedData: '',
      ttl: 0,
      stale: true,
      staleAge: expect.any(Number),
    })
    expect(stale!.staleAge).toBeGreaterThanOrEqual(0.25)
  })

  it('keeps legacy empty bulk strings readable', async () => {
    const entry = input('audit:legacy:')
    await client.set(entry.dataKey, '', 'PX', 1500)
    expect(await backend.fetch(entry)).toMatchObject({ encodedData: '', ttl: expect.any(Number) })
  })

  it('rounds fractional leases up and returns numeric refresh TTLs', async () => {
    const key = 'audit:fractional-refresh'
    await client.set(key, '100')
    expect(await backend.shouldRefresh(key, 20, 105, false, 1, 'owner')).toEqual(['EXISTS', 15])
    const refresh = vi.spyOn(client, 'shouldRefreshCache')
    try {
      expect((await backend.shouldRefresh(key, 20, 125, false, 1.0005, 'owner')).slice(0, 2)).toEqual([
        'UPDATE',
        'owner',
      ])
      expect(refresh).toHaveBeenCalledWith(key, key + '-lock', 125, 20, 1001, 'owner', 0)
    } finally {
      refresh.mockRestore()
    }
    const pttl = Number(await client.pttl(key + '-lock'))
    expect(pttl).toBeGreaterThan(800)
    expect(pttl).toBeLessThanOrEqual(1001)
  })

  it.each([0, -1, Infinity, NaN, Number.MAX_SAFE_INTEGER])('rejects invalid lease duration %s', async (lease) => {
    await expect(backend.shouldRefresh('audit:bad-lease', 10, 100, true, lease, 'owner')).rejects.toThrow(RangeError)
    expect(Number(await client.exists('audit:bad-lease-lock'))).toBe(0)
  })

  it('treats a nonnumeric timestamp as unrecorded and skips timestamp reads when forced', async () => {
    const key = 'audit:refresh'
    await client.set(key, '{"payload":true}')
    expect((await backend.shouldRefresh(key, 100, 1, false, 2, 'first')).slice(0, 2)).toEqual(['UPDATE', 'first'])
    expect(await backend.shouldRefresh(key, 100, 1, false, 2, 'second')).toEqual(['UPDATING', 'first'])
    await client.del(key)
    await client.hset(key, 'payload', 'wrong type for GET')
    expect((await backend.shouldRefresh(key, 100, 1, true, 2, 'second')).slice(0, 2)).toEqual(['UPDATE', 'second'])
    expect(await client.get(key + '-lock')).toBe('second')
  })

  it.each([
    ['broken JSON', '{', '30', '100', '0'],
    ['JSON object', '{"red":"blue"}', '30', '100', '0'],
    ['empty object', '{}', '30', '100', '0'],
    ['nonnumeric expiry', '[]', '30', 'nan', '0'],
    ['nonfinite data expiry', '[]', 'nan', '100', '0'],
    ['invalid tag after a valid tag', '["valid",false]', '30', '100', '0'],
    ['empty tag after a valid tag', '["valid",""]', '30', '100', '0'],
    ['huge data expiry', '[]', '2147483648', '100', '0'],
    ['huge metadata expiry', '[]', '30', '2147483648', '0'],
    ['huge stale retention', '[]', '30', '100', '1e100'],
    ['zero metadata expiry', '[]', '30', '0', '0'],
  ])('rejects %s before mutating Redis', async (_name, tags, ttl, metaTtl, staleTtl) => {
    const entry = input('audit:atomic:')
    await backend.update(entry)
    await client.sadd('audit:tag:original', entry.key)
    const keys = [
      entry.dataKey,
      entry.metaKey,
      entry.dataKey + ':state',
      entry.dataKey + ':revision',
      'audit:__adaptive:namespace',
      'audit:tag:original',
      'audit:__adaptive:tag-index:original',
      'audit:__adaptive:tag-epoch:original',
      'audit:__adaptive:tag-index:valid',
      'audit:__adaptive:tag-epoch:valid',
    ]
    const snapshot = () =>
      Promise.all(keys.map((key) => Promise.all([client.dumpBuffer(key), client.pexpiretime(key)])))
    const before = await snapshot()
    await expect(
      (client.adaptiveCacheUpdate as (...args: string[]) => Promise<unknown>)(
        entry.dataKey,
        entry.metaKey,
        'new',
        'new',
        ttl,
        ttl,
        '2',
        metaTtl,
        '',
        'audit:',
        entry.key,
        tags,
        staleTtl,
      ),
    ).rejects.toThrow()
    expect(await snapshot()).toEqual(before)

    const coldPrefix = 'audit:cold:'
    await expect(
      (client.adaptiveCacheUpdate as (...args: string[]) => Promise<unknown>)(
        coldPrefix + 'data',
        coldPrefix + 'meta',
        'new',
        'new',
        ttl,
        ttl,
        '2',
        metaTtl,
        '',
        coldPrefix,
        coldPrefix,
        tags,
        staleTtl,
      ),
    ).rejects.toThrow()
    expect(await client.keys(coldPrefix + '*')).toEqual([])
  })

  it.each(['audit:', ''])(
    'preserves write barriers on empty backend and Lua invalidations for prefix %j',
    async (prefix) => {
      const entry = { ...input(prefix + 'empty-invalidation:'), redisPrefix: prefix }
      const token = await backend.captureWriteToken(prefix)
      const commands = client as Redis & { adaptiveCacheInvalidate: (...args: string[]) => Promise<string[]> }
      const invalidate = vi.spyOn(commands, 'adaptiveCacheInvalidate')
      try {
        expect(await backend.invalidateTags([], prefix)).toEqual([])
        expect(invalidate).not.toHaveBeenCalled()
        expect(
          await commands.adaptiveCacheInvalidate(
            '__adaptive:legacy-barrier',
            'tags',
            prefix,
            '',
            '[]',
            'new-barrier',
            'new-namespace',
          ),
        ).toEqual([])
        expect(await backend.captureWriteToken(prefix)).toBe(token)
        expect((await backend.update({ ...entry, writeToken: token }))[0]).toBe('CACHED')
      } finally {
        invalidate.mockRestore()
      }
    },
  )

  it('stores entries at the inclusive Redis expiry bound', async () => {
    const entry = { ...input('audit:expiry-bound:'), initialTTL: 2147483647, maxTTL: 2147483647, metaTTL: 2147483647 }
    expect((await backend.update(entry)).slice(0, 2)).toEqual(['CACHED', 2147483647])
    for (const key of [entry.dataKey, entry.metaKey, entry.dataKey + ':state']) {
      const pttl = Number(await client.pttl(key))
      expect(pttl).toBeLessThanOrEqual(2147483647000)
      expect(pttl).toBeGreaterThan(2147483640000)
    }
  })
})

describe('backend command and key boundaries', () => {
  it('replaces untracked and changed scripts, skipping registration only for present commands with matching digests', async () => {
    const client = new Redis({ lazyConnect: true })
    const preexisting = vi.fn()
    client.adaptiveCacheFetch = preexisting
    const define = vi.spyOn(client, 'defineCommand')
    try {
      new RedisAdaptiveCacheBackend(client, logger)
      expect(define).toHaveBeenCalledTimes(7)
      expect(client.adaptiveCacheFetch).not.toBe(preexisting)
      const spy = vi.spyOn(client, 'adaptiveCacheFetch')
      new RedisAdaptiveCacheBackend(client, logger)
      expect(define).toHaveBeenCalledTimes(7)
      expect(client.adaptiveCacheFetch).toBe(spy)
      spy.mockRestore()

      const readOriginal = fs.readFileSync
      const read = vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
        const body = readOriginal(file, options)
        return String(file).endsWith('adaptiveCacheFetch.lua') ? body + '\n-- changed script' : body
      })
      try {
        new RedisAdaptiveCacheBackend(client, logger)
        expect(define).toHaveBeenCalledTimes(8)
        expect(define.mock.lastCall?.[0]).toBe('adaptiveCacheFetch')
        Reflect.deleteProperty(client, 'adaptiveCacheFetch')
        new RedisAdaptiveCacheBackend(client, logger)
        expect(define).toHaveBeenCalledTimes(9)
      } finally {
        read.mockRestore()
      }
    } finally {
      client.disconnect()
    }
  })

  it.each([null, false, undefined])('handles a mock returning %s for a miss', async (payload) => {
    const adaptiveCacheFetch = vi.fn().mockResolvedValue([payload, 0])
    const mock = { adaptiveCacheFetch }
    const backend = new RedisAdaptiveCacheBackend(mock as unknown as Redis, logger)
    expect(await backend.fetch(input())).toBeNull()
    expect(mock.adaptiveCacheFetch).toBe(adaptiveCacheFetch)
  })

  it('preserves optional update fields from an older command implementation', async () => {
    const client = { adaptiveCacheUpdate: vi.fn().mockResolvedValue(['CACHED', '2.5', undefined, false, 'hash', '0']) }
    const backend = new RedisAdaptiveCacheBackend(client as unknown as Redis, logger)
    expect(await backend.update(input())).toEqual(['CACHED', 2.5, undefined, false, 'hash', 0])
  })

  it.each([
    { key: 'audit:__adaptive:tag-epoch:red' },
    { dataKey: 'audit:__adaptive:namespace' },
    { metaKey: 'audit:__adaptive:barrier' },
    { dataKey: '__adaptive:legacy-barrier' },
  ])('rejects reserved user and storage keys before any backend work (%j)', async (override) => {
    const client = new Redis({ lazyConnect: true })
    const redis = new RedisAdaptiveCacheBackend(client, logger)
    const lru = new ClusteredLruAdaptiveCacheBackend({ namespace: randomUUID() }, logger)
    const entry = { ...input(), ...override }
    try {
      for (const backend of [redis, lru]) {
        await expect(backend.fetch(entry)).rejects.toThrow(RangeError)
        await expect(backend.update(entry)).rejects.toThrow(RangeError)
        await expect(backend.clear(entry.key, entry.dataKey, entry.metaKey, entry.redisPrefix)).rejects.toThrow(
          RangeError,
        )
      }
      await expect(lru.fetchMany([entry])).rejects.toThrow(RangeError)
      await expect(lru.storeConservative(entry)).rejects.toThrow(RangeError)
      await expect(lru.hydrateFromFetch(entry, { encodedData: 'data', ttl: 10 })).rejects.toThrow(RangeError)
      await expect(lru.hydrateFromUpdate(entry, ['CACHED', 10])).rejects.toThrow(RangeError)
    } finally {
      client.disconnect()
      await lru.quit()
    }
  })
})

describe('clustered LRU audit regressions', () => {
  it('requires the current lease owner and resets history when returning to the default TTL policy', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: randomUUID() }, logger)
    const entry = input()
    const key = 'audit:refresh-lease'
    try {
      await backend.shouldRefresh(key, 10, 100, false, 30, 'owner')
      const locked = { ...entry, lockKey: key + '-lock', ttlPolicy: { type: 'aimd', increaseSeconds: 3 } as const }
      expect(await backend.update({ ...locked, lockValue: 'other' })).toEqual(['INVALIDATED', 0])
      expect((await backend.update({ ...locked, lockValue: 'owner' }))[1]).toBe(30)
      expect((await backend.update({ ...locked, lockValue: 'owner' }))[1]).toBe(33)
      expect((await backend.update(entry))[1]).toBe(30)
      expect((await backend.update(entry))[1]).toBe(60)
      await backend.invalidateNamespace(entry.redisPrefix)
      expect((await backend.update(entry))[1]).toBe(30)
    } finally {
      await backend.quit()
    }
  })

  it('preserves the captured write token on empty tag invalidations', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: randomUUID() }, logger)
    try {
      const entry = input()
      const writeToken = await backend.captureWriteToken(entry.redisPrefix)
      expect(await backend.invalidateTags([], entry.redisPrefix)).toEqual([])
      expect(await backend.captureWriteToken(entry.redisPrefix)).toBe(writeToken)
      expect((await backend.update({ ...entry, writeToken }))[0]).toBe('CACHED')
    } finally {
      await backend.quit()
    }
  })

  it.each([
    ['prefix', { prefix: '雪'.repeat(400) }],
    ['hash', { hash: '雪'.repeat(400) }],
    ['revision', { revision: '雪'.repeat(400) }],
    ['write token', { writeToken: '雪'.repeat(400) }],
    ['namespace generation', { namespaceGeneration: '雪'.repeat(400) }],
    [
      'TTL policy state',
      { ttlPolicyState: { signature: '雪'.repeat(400), observedAt: 1, observedHash: 'hash', changeRate: 0.5 } },
    ],
  ] satisfies Array<[string, Partial<LruEnvelope>]>)(
    'includes variable %s bytes in the entry estimate',
    (_name, fields) => {
      const envelope = {
        encodedData: 'raw',
        prefix: '',
        hash: '',
        tags: [],
        dataTTL: 1,
        changeCount: 1,
        lastChanged: 1,
        createdAt: 1,
        updatedAt: 1,
        expiresAt: 2,
      }
      expect(estimateEnvelopeSize({ ...envelope, ...fields }) - estimateEnvelopeSize(envelope)).toBeGreaterThanOrEqual(
        1200,
      )
    },
  )

  it('rejects oversized envelopes with multi-byte keys or metadata', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: randomUUID(), maxSizeBytes: 4096, maxEntrySizeBytes: 1024 },
      logger,
    )
    try {
      const small = input()
      const largeKey = input('audit:' + '雪'.repeat(200))
      await backend.hydrateFromFetch(small, { encodedData: 'a', ttl: 10 })
      expect(await backend.fetch(small)).toMatchObject({ encodedData: 'a' })
      await backend.hydrateFromFetch(largeKey, { encodedData: 'b', ttl: 10 })
      expect(await backend.fetch(largeKey)).toBeNull()
      await backend.hydrateFromFetch(small, { encodedData: 'c', ttl: 10, revision: '雪'.repeat(400) })
      expect(await backend.fetch(small)).toBeNull()
    } finally {
      await backend.quit()
    }
  })

  it('charges variable envelope bytes against the total cache capacity', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: randomUUID(), maxSizeBytes: 2200, maxEntrySizeBytes: 1600 },
      logger,
    )
    const first = input('audit:first:')
    const second = input('audit:second:')
    const result = { encodedData: 'small', ttl: 10, metadata: { hash: '雪'.repeat(250) } }
    try {
      await backend.hydrateFromFetch(first, result)
      expect(await backend.fetch(first)).toMatchObject({ encodedData: 'small' })
      await backend.hydrateFromFetch(second, result)
      expect(await backend.fetch(first)).toBeNull()
      expect(await backend.fetch(second)).toMatchObject({ encodedData: 'small' })
    } finally {
      await backend.quit()
    }
  })

  it('bounds local invalidation subscribers across repeated preserving quits and keeps primary entries', async () => {
    const namespace = randomUUID()
    const options = { namespace, localL1: { enabled: true, experimental: true } }
    const entry = input()
    const writer = new ClusteredLruAdaptiveCacheBackend(options, logger)
    const subscriberCount = () => {
      const registry = Reflect.get(globalThis, Symbol.for('lru-cache-clustered.invalidations')) as Map<
        string,
        Set<unknown>
      >
      return registry.get(namespace)?.size ?? 0
    }
    try {
      await writer.update(entry)
      expect(subscriberCount()).toBe(1)
      for (let index = 0; index < 3; index++) {
        const reader = new ClusteredLruAdaptiveCacheBackend(options, logger)
        try {
          expect(await reader.fetch(entry)).toMatchObject({ encodedData: 'value' })
        } finally {
          await reader.quit(true)
        }
        await reader.quit(true)
        expect(subscriberCount()).toBe(1)
      }

      const destroyer = new ClusteredLruAdaptiveCacheBackend(options, logger)
      try {
        expect(await destroyer.fetch(entry)).toMatchObject({ encodedData: 'value' })
      } finally {
        await destroyer.quit()
      }
      expect(await writer.fetch(entry)).toBeNull()
      await writer.update(entry)

      await writer.quit(true)
      const reader = new ClusteredLruAdaptiveCacheBackend(options, logger)
      try {
        expect(await reader.fetch(entry)).toMatchObject({ encodedData: 'value' })
        expect(subscriberCount()).toBe(1)
      } finally {
        await reader.quit()
      }
      expect(subscriberCount()).toBe(0)
    } finally {
      await writer.quit()
    }
  })
})
