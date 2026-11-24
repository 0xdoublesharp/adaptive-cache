import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import Redis from 'ioredis'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { RedisAdaptiveCacheBackend } from '../src/backends/RedisAdaptiveCacheBackend'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { L1RedisAdaptiveCacheBackend } from '../src/backends/L1RedisAdaptiveCacheBackend'
import { Logger } from '../src/lib/logger'
import type { AdaptiveCacheBackend, AdaptiveCacheBackendUpdateInput, AdaptiveCacheTtlPolicy } from '../src/types'

const logger = new Logger('silent')
const policies: Array<{ name: string; policy?: AdaptiveCacheTtlPolicy }> = [
  { name: 'default adaptive' },
  { name: 'explicit adaptive', policy: { type: 'adaptive' } },
  { name: 'aimd', policy: { type: 'aimd' } },
  { name: 'ewma', policy: { type: 'ewma', halfLifeSeconds: 10 } },
]
const input = (ttlPolicy?: AdaptiveCacheTtlPolicy): AdaptiveCacheBackendUpdateInput => ({
  key: 'policy:item:',
  dataKey: 'policy:item:data',
  metaKey: 'policy:item:meta',
  redisPrefix: 'policy:',
  responseHash: 'a',
  encodedData: 'value',
  initialTTL: 5,
  maxTTL: 100,
  ttlScaling: 2,
  metaTTL: 3600,
  tags: [],
  ttlPolicy,
})

describe('TTL policy backend parity', () => {
  let container: StartedTestContainer
  let client: Redis
  let redis: RedisAdaptiveCacheBackend
  let lru: ClusteredLruAdaptiveCacheBackend
  let now: number
  const clock = async (value: number) => {
    now = value
    await client.hset('test:clock', 'seconds', Math.floor(now / 1000), 'micros', (now % 1000) * 1000)
  }
  beforeAll(async () => {
    container = await new GenericContainer('redis:alpine').withExposedPorts(6379).start()
    client = new Redis({ host: container.getHost(), port: container.getMappedPort(6379) })
    redis = new RedisAdaptiveCacheBackend(client, logger)
    // Run the production Lua atomically in real Redis, replacing only its clock with an explicit fixture.
    for (const [name, numberOfKeys] of [
      ['adaptiveCacheUpdate', 2],
      ['adaptiveCacheFetch', 1],
    ] as const) {
      const lua = fs.readFileSync(path.resolve('src/redis-lua', `${name}.lua`), 'utf8')
      client.defineCommand(name, {
        numberOfKeys,
        lua: lua.replaceAll("redis.call('TIME')", "redis.call('HMGET', 'test:clock', 'seconds', 'micros')"),
      })
    }
  })
  beforeEach(async () => {
    await client.flushall()
    now = 1800000000000
    await clock(now)
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    lru = new ClusteredLruAdaptiveCacheBackend({ namespace: randomUUID() }, logger)
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await lru.quit()
  })
  afterAll(async () => {
    await client?.quit()
    await container?.stop()
  })

  it.each([
    [{ type: 'adaptive' }, [5, 10, 20, 5]],
    [{ type: 'aimd', increaseSeconds: 3, decreaseFactor: 0.5 }, [5, 8, 11, 6]],
    [{ type: 'ewma', halfLifeSeconds: 10, targetChangeProbability: 0.1 }, [5, 10, 20, 5]],
  ] as const)('matches deterministic changed and unchanged trajectories for %j', async (policy, expected) => {
    const actual: number[] = []
    for (const hash of ['a', 'a', 'a', 'b']) {
      const value = { ...input(policy), responseHash: hash }
      const left = await redis.update(value)
      const right = await lru.update(value)
      expect(left).toEqual(right)
      actual.push(left[1])
      if (policy.type !== 'adaptive') {
        const state = JSON.parse((await client.hget(value.metaKey, 'ttlPolicyState'))!)
        const fetched = await lru.fetch({ ...value, includeDebugHeaders: true })
        expect(fetched?.metadata?.ttlPolicyState?.signature).toBe(state.signature)
        expect(fetched?.metadata?.ttlPolicyState?.changeRate).toBeCloseTo(state.changeRate, 12)
        expect(fetched?.metadata?.ttlPolicyState?.observedAt).toBe(state.observedAt)
      }
      await clock(now + 10000)
    }
    expect(actual).toEqual(expected)
  })

  it('retains EWMA state on zero/backward time and clamps TTLs', async () => {
    const value = input({ type: 'ewma', halfLifeSeconds: 10, targetChangeProbability: 0.1 })
    await redis.update(value)
    await lru.update(value)
    await clock(now + 10000)
    expect((await redis.update(value))[1]).toBe(10)
    expect((await lru.update(value))[1]).toBe(10)
    const saved = await client.hget(value.metaKey, 'ttlPolicyState')
    for (const offset of [0, -1000]) {
      await clock(now + offset)
      const changed = { ...value, responseHash: 'changed', maxTTL: 7.5 }
      expect((await redis.update(changed))[1]).toBe(7.5)
      expect(Number(await client.hget(value.metaKey, 'dataTTL'))).toBe(7.5)
      expect((await lru.update(changed))[1]).toBe(7.5)
      expect(JSON.parse((await client.hget(value.metaKey, 'ttlPolicyState'))!)).toEqual(JSON.parse(saved!))
    }
  })

  it.each(['clear', 'namespace', 'metadata'] as const)('resets policy history after %s invalidation', async (kind) => {
    const value = input({ type: 'aimd' })
    const backends: AdaptiveCacheBackend[] = [redis, lru]
    for (const backend of backends) {
      await backend.update(value)
      expect((await backend.update(value))[1]).toBe(10)
      if (kind === 'clear') await backend.clear(value.key, value.dataKey, value.metaKey, value.redisPrefix)
      if (kind === 'namespace') await backend.invalidateNamespace!(value.redisPrefix)
    }
    if (kind === 'metadata') {
      await client.del(value.metaKey)
      await (lru as any).getCache().then((cache: any) => cache.delete(value.metaKey))
    }
    for (const backend of backends) expect((await backend.update(value))[1]).toBe(5)
  })

  it('resets on parameter changes and when returning to the legacy adaptive policy', async () => {
    for (const backend of [redis, lru]) {
      const value = input({ type: 'aimd' })
      await backend.update(value)
      await backend.update(value)
      expect((await backend.update({ ...value, ttlPolicy: { type: 'aimd', increaseSeconds: 2 } }))[1]).toBe(5)
      expect((await backend.update({ ...value, ttlPolicy: { type: 'adaptive' } }))[1]).toBe(5)
      expect((await backend.update({ ...value, ttlPolicy: undefined }))[1]).toBe(10)
    }
  })

  it('keeps fractional TTL caps and write fencing authoritative for every policy', async () => {
    for (const backend of [redis, lru])
      for (const { policy } of policies) {
        const value = { ...input(policy), initialTTL: 0.5, maxTTL: 0.5 }
        const token = await backend.captureWriteToken(value.redisPrefix)
        await backend.clear(value.key, value.dataKey, value.metaKey, value.redisPrefix)
        expect(await backend.update({ ...value, writeToken: token })).toEqual(['INVALIDATED', 0])
        expect((await backend.update(value))[1]).toBe(0.5)
        const hit = await backend.fetch({ ...value, includeDebugHeaders: true })
        expect(Number(hit?.metadata?.dataTTL)).toBe(0.5)
      }
  })

  it('keeps tiny probabilities finite and includes same-clock changes in the next timed sample', async () => {
    const value = input({ type: 'ewma', halfLifeSeconds: 10, targetChangeProbability: 1e-20 })
    for (const backend of [redis, lru]) {
      expect((await backend.update(value))[1]).toBe(5)
      expect((await backend.update({ ...value, responseHash: 'b' }))[1]).toBe(5)
    }
    const original = JSON.parse((await client.hget(value.metaKey, 'ttlPolicyState'))!)
    expect(original.observedHash).toBe('a')
    expect(original.changeRate).toBeGreaterThan(0)
    await clock(now + 10000)
    for (const backend of [redis, lru]) expect((await backend.update({ ...value, responseHash: 'b' }))[1]).toBe(5)
    const observed = JSON.parse((await client.hget(value.metaKey, 'ttlPolicyState'))!)
    expect(observed.observedHash).toBe('b')
    expect(observed.changeRate).toBeCloseTo(0.05, 12)
    const local = await lru.fetch({ ...value, includeDebugHeaders: true })
    expect(local?.metadata?.ttlPolicyState?.changeRate).toBeCloseTo(observed.changeRate, 12)
  })

  it('matches the documented long-interval EWMA trajectory and explicit defaults', async () => {
    const value = { ...input({ type: 'ewma' }), initialTTL: 10 }
    const results: number[] = []
    for (const hash of ['a', 'a', 'b']) {
      const left = await redis.update({ ...value, responseHash: hash })
      const right = await lru.update({
        ...value,
        responseHash: hash,
        ttlPolicy: { type: 'ewma', halfLifeSeconds: 300, targetChangeProbability: 0.1 },
      })
      expect(left).toEqual(right)
      results.push(left[1])
      await clock(now + 300000)
    }
    expect(results).toEqual([10, 20, 25])
  })

  it.each(policies.flatMap((entry) => [false, true].map((expired) => ({ ...entry, expired }))))(
    'resets $name namespace history with expired payload = $expired',
    async ({ policy, expired }) => {
      const value = input(policy)
      for (const backend of [redis, lru]) expect((await backend.update(value))[1]).toBe(5)
      await clock(now + 10000)
      for (const backend of [redis, lru]) expect((await backend.update(value))[1]).toBe(10)
      if (expired) {
        // Expire the actual payload while leaving its longer-lived metadata intact.
        await client.pexpire(value.dataKey, 1)
        await new Promise((resolve) => setTimeout(resolve, 10))
        await clock(now + 10001)
        expect(await client.get(value.dataKey)).toBeNull()
        expect(await lru.fetch({ ...value, includeDebugHeaders: true })).toBeNull()
      }
      for (const backend of [redis, lru]) {
        await backend.invalidateNamespace(value.redisPrefix)
        const result = await backend.update(value)
        expect(result[1]).toBe(5)
        expect(result[3]).toBe(1)
      }
    },
  )

  it('preserves small AIMD increases when Redis returns its policy TTL', async () => {
    const value = input({ type: 'aimd', increaseSeconds: 1e-12 })
    for (const backend of [redis, lru]) {
      expect((await backend.update(value))[1]).toBe(5)
      expect((await backend.update(value))[1]).toBe(6)
    }
  })

  it('uses Redis policy state as the authority through L1 hydration', async () => {
    const combined = new L1RedisAdaptiveCacheBackend(redis, lru, 'policy:', logger, 'await-redis')
    try {
      const value = input({ type: 'aimd', increaseSeconds: 3 })
      expect(combined.supportsTtlPolicies).toBe(true)
      expect(redis.supportsTtlPolicies).toBe(true)
      expect(lru.supportsTtlPolicies).toBe(true)
      expect((await combined.update(value))[1]).toBe(5)
      expect((await combined.update(value))[1]).toBe(8)
      expect((await combined.update({ ...value, responseHash: 'b' }))[1]).toBe(5)
      const fetched = await combined.fetch({ ...value, includeDebugHeaders: true })
      expect(Number(fetched?.metadata?.dataTTL)).toBe(5)
      expect(Number(await client.hget(value.metaKey, 'dataTTL'))).toBe(5)
    } finally {
      await combined.quit(true)
    }
  })
})
