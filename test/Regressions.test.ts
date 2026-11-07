import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import express from 'express'
import request from 'supertest'
import { AdaptiveCache, adaptiveExpressCache, adaptiveFastifyCache, clearAdaptiveCache } from '../src'
import { getAdaptiveCacheKey } from '../src/utils'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { L1RedisAdaptiveCacheBackend } from '../src/backends/L1RedisAdaptiveCacheBackend'
import { RedisAdaptiveCacheBackend } from '../src/backends/RedisAdaptiveCacheBackend'
import { Logger } from '../src/lib/logger'
import { FakeRedis } from './helpers/FakeRedis'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})
const options = () => ({
  backend: 'clustered-lru' as const,
  compress: false,
  logLevel: 'silent' as const,
  initialTTL: 10,
  includeDebugHeaders: true,
  lru: { namespace: `regression:${crypto.randomUUID()}`, maxSizeBytes: 1024 * 1024 },
})
const makeCache = (overrides = {}) => {
  const cache = new AdaptiveCache({ ...options(), ...overrides })
  cleanups.push(() => cache.quit())
  return cache
}

describe('cache correctness regressions', () => {
  it('keeps non-control refresh values in HTTP cache identity', () => {
    const ordinary = getAdaptiveCacheKey('/items', {}, 'test:')
    expect(getAdaptiveCacheKey('/items', { refresh: 'true' }, 'test:')).toBe(ordinary)
    expect(getAdaptiveCacheKey('/items', { refresh: 'false' }, 'test:')).not.toBe(ordinary)
    expect(getAdaptiveCacheKey('/items', { refresh: ['true'] }, 'test:')).not.toBe(ordinary)
  })

  it('bounds default HTTP cache keys for long request paths', () => {
    expect(Buffer.byteLength(getAdaptiveCacheKey('/' + 'x'.repeat(10_000), {}, 'test:'), 'utf8')).toBeLessThan(512)
  })

  it('distinguishes own __proto__ query keys at every depth', () => {
    for (const query of [JSON.parse('{"__proto__":{"x":1}}'), JSON.parse('{"nested":{"__proto__":{"x":1}}}')]) {
      const without = 'nested' in query ? { nested: {} } : {}
      expect(getAdaptiveCacheKey('/items', query, 'test:')).not.toBe(getAdaptiveCacheKey('/items', without, 'test:'))
    }
  })

  it('clears the same canonical key when custom query exclusions are configured', async () => {
    const lru = new ClusteredLruAdaptiveCacheBackend(options().lru, new Logger('silent'))
    cleanups.push(() => lru.quit())
    const backend = {
      name: 'custom' as const,
      fetch: lru.fetch.bind(lru),
      update: lru.update.bind(lru),
      clear: lru.clear.bind(lru),
      invalidateTags: lru.invalidateTags.bind(lru),
      shouldRefresh: lru.shouldRefresh.bind(lru),
      releaseLock: lru.releaseLock.bind(lru),
    }
    const config = { ...options(), backend, ignoreQueryParams: ['refresh', 'tracking'] }
    const cache = new AdaptiveCache(config)
    cleanups.push(() => cache.quit())
    const query = { q: 'a', tracking: 'campaign' }
    const key = getAdaptiveCacheKey('/items', query, 'adaptive:', config.ignoreQueryParams)
    await cache.set(key, 'cached')
    await clearAdaptiveCache('/items', query, 'adaptive:', config)
    expect(await cache.get(key)).toBeNull()
  })

  it('clearing one LRU key preserves other keys in the shared namespace', async () => {
    const config = options()
    const cache = new AdaptiveCache(config)
    cleanups.push(() => cache.quit())
    const key = getAdaptiveCacheKey('/clear-one', {}, 'adaptive:')
    await cache.set(key, 'target')
    await cache.set('unrelated', 'keep')
    await clearAdaptiveCache('/clear-one', {}, 'adaptive:', config)
    expect(await cache.get(key)).toBeNull()
    expect((await cache.get('unrelated'))?.data).toBe('keep')
  })

  it('lets exactly one concurrent LRU refresh claimant win', async () => {
    const cache = makeCache()
    const results = await Promise.all(Array.from({ length: 16 }, () => cache.shouldRefresh('lock', 60)))
    expect(results.filter(([status]) => status === 'UPDATE')).toHaveLength(1)
    expect(results.filter(([status]) => status === 'UPDATING')).toHaveLength(15)
  })

  it('retries LRU acquisition when the previous owner releases between claim and observation', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend(options().lru, new Logger('silent'))
    cleanups.push(() => backend.quit())
    await backend.shouldRefresh('contended', 60, 100, false, 60, 'old-owner')
    const primary = await (backend as any).getCache()
    const claim = primary.setIfAbsent.bind(primary)
    vi.spyOn(primary, 'setIfAbsent').mockImplementationOnce(async (...args: unknown[]) => {
      const acquired = await claim(...args)
      // The other owner releases after our failed atomic claim.
      await primary.delete('contended-lock')
      return acquired
    })
    expect(await backend.shouldRefresh('contended', 60, 100, false, 60, 'new-owner')).toEqual(['UPDATE', 'new-owner'])
    expect(await primary.get('contended-lock')).toBe('new-owner')
  })

  it('never exceeds maxTTL on first writes or changed content', async () => {
    const cache = makeCache({ initialTTL: 10, maxTTL: 2 })
    expect((await cache.set('cap', 'a'))[1]).toBe(2)
    expect((await cache.set('cap', 'b'))[1]).toBe(2)
    expect((await cache.set('cap', 'b'))[1]).toBe(2)
  })

  it('retains adaptive metadata after the LRU data expires', async () => {
    const cache = makeCache({ initialTTL: 1, metaTTL: 60 })
    await cache.set('expiry', 'stable')
    await vi.waitFor(async () => expect(await cache.get('expiry')).toBeNull(), { timeout: 2000, interval: 20 })
    expect((await cache.set('expiry', 'stable'))[1]).toBe(2)
    expect((await cache.get('expiry'))?.metadata.changeCount).toBe(1)
  })

  it('drops an older LRU value when its replacement exceeds the size limit', async () => {
    const config = options()
    const cache = makeCache({ lru: { ...config.lru, maxEntrySizeBytes: 1024 } })
    await cache.set('size', 'small')
    expect((await cache.get('size'))?.data).toBe('small')
    await cache.set('size', 'x'.repeat(2048))
    expect(await cache.get('size')).toBeNull()
    const primary = await (cache as any).backend.getCache()
    expect(await primary.get('sizemeta', { bypassL1: true })).toBeUndefined()
    expect(await primary.get('sizedata:epoch', { bypassL1: true })).toBeUndefined()
  })

  it('counts long clustered-LRU keys against the entry-size limit', async () => {
    const config = options()
    const cache = makeCache({ lru: { ...config.lru, maxEntrySizeBytes: 1024 } })
    const key = 'k'.repeat(220)

    expect((await cache.set(key, 'small'))[0]).toBe('INVALIDATED')
    expect(await cache.get(key)).toBeNull()
    const primary = await (cache as any).backend.getCache()
    expect(await primary.get(key + 'data', { bypassL1: true })).toBeUndefined()
    expect(await primary.get(key + 'meta', { bypassL1: true })).toBeUndefined()
    expect(await primary.get(key + 'data:epoch', { bypassL1: true })).toBeUndefined()
  })
})

describe('real HTTP middleware regressions', () => {
  it.each(['express', 'fastify'] as const)(
    '%s preserves status, content type, and JSON-looking text on hits',
    async (framework) => {
      const config = options()
      const cache = new AdaptiveCache(config)
      cleanups.push(() => cache.quit())
      let calls = 0
      let get: () => Promise<{ status: number; text: string; type: unknown; hit: unknown }>
      if (framework === 'express') {
        const app = express()
        app.get('/text', adaptiveExpressCache(config), (_req, res) => {
          calls++
          res.status(203).type('text/plain').send('123')
        })
        get = async () => {
          const res = await request(app).get('/text').set('Host', 'localhost:80')
          return { status: res.status, text: res.text, type: res.headers['content-type'], hit: res.headers['x-cache'] }
        }
      } else {
        const app = Fastify()
        cleanups.push(() => app.close())
        await app.register(adaptiveFastifyCache(config))
        app.get('/text', async (_req, reply) => {
          calls++
          return reply.code(203).type('text/plain').send('123')
        })
        get = async () => {
          const res = await app.inject('/text')
          return {
            status: res.statusCode,
            text: res.payload,
            type: res.headers['content-type'],
            hit: res.headers['x-cache'],
          }
        }
      }
      const first = await get()
      await vi.waitFor(async () =>
        expect(await cache.get(getAdaptiveCacheKey('/text', {}, 'adaptive:', undefined, 'localhost:80'))).not.toBeNull(),
      )
      const second = await get()
      expect(second.hit).toBe('HIT')
      expect(second.status).toBe(first.status)
      expect(second.type).toBe(first.type)
      expect(second.text).toBe(first.text)
      expect(calls).toBe(1)
    },
  )

  it.each(['express', 'fastify'] as const)('%s preserves binary response bytes', async (framework) => {
    const config = options()
    const cache = new AdaptiveCache(config)
    cleanups.push(() => cache.quit())
    const body = Buffer.from([0, 255, 128, 42])
    let get: () => Promise<Buffer>
    let calls = 0
    if (framework === 'express') {
      const app = express()
      app.get('/binary', adaptiveExpressCache(config), (_req, res) => {
        calls++
        res.send(body)
      })
      get = async () => (await request(app).get('/binary').set('Host', 'localhost:80')).body
    } else {
      const app = Fastify()
      cleanups.push(() => app.close())
      await app.register(adaptiveFastifyCache(config))
      app.get('/binary', async () => {
        calls++
        return body
      })
      get = async () => (await app.inject('/binary')).rawPayload
    }
    expect(await get()).toEqual(body)
    await vi.waitFor(async () =>
      expect(await cache.get(getAdaptiveCacheKey('/binary', {}, 'adaptive:', undefined, 'localhost:80'))).not.toBeNull(),
    )
    expect(await get()).toEqual(body)
    expect(calls).toBe(1)
  })

  it('Fastify leaves streamed responses uncached', async () => {
    const app = Fastify()
    cleanups.push(() => app.close())
    await app.register(adaptiveFastifyCache(options()))
    let calls = 0
    app.get('/stream', async () => {
      calls++
      return Readable.from(['streamed', ' response'])
    })
    for (let i = 0; i < 2; i++) {
      const res = await app.inject('/stream')
      expect(res.payload).toBe('streamed response')
      expect(res.headers['x-cache']).toBe('MISS')
    }
    expect(calls).toBe(2)
  })

  it('Fastify still serves the handler when query canonicalization fails', async () => {
    const app = Fastify({
      routerOptions: {
        querystringParser: () => {
          const query: any = {}
          query.self = query
          return query
        },
      },
    })
    cleanups.push(() => app.close())
    await app.register(adaptiveFastifyCache(options()))
    app.get('/bad-query', async () => ({ ok: true }))
    const response = await app.inject('/bad-query?x=1')
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
    expect(response.headers['x-cache']).toBe('RETRY')
  })

  it('Fastify hits with headers disabled do not extend TTL or perform writes', async () => {
    const config = { ...options(), includeHeaders: false }
    const cache = new AdaptiveCache(config)
    cleanups.push(() => cache.quit())
    const app = Fastify()
    cleanups.push(() => app.close())
    await app.register(adaptiveFastifyCache(config))
    let calls = 0
    app.get('/hit', async () => ({ calls: ++calls }))
    await app.inject('/hit')
    const key = getAdaptiveCacheKey('/hit', {}, 'adaptive:', undefined, 'localhost:80')
    await vi.waitFor(async () => expect(await cache.get(key)).not.toBeNull())
    const update = vi.spyOn(ClusteredLruAdaptiveCacheBackend.prototype, 'update')
    for (let i = 0; i < 3; i++) {
      const hit = await app.inject('/hit')
      expect(hit.json()).toEqual({ calls: 1 })
      expect(hit.headers['x-cache']).toBeUndefined()
    }
    expect(update).not.toHaveBeenCalled()
  })

  it.each(['express', 'fastify'] as const)(
    '%s does not serve GET cache entries to POST requests',
    async (framework) => {
      const config = options()
      const cache = new AdaptiveCache(config)
      cleanups.push(() => cache.quit())
      let post: () => Promise<string>
      if (framework === 'express') {
        const app = express()
        app.use(adaptiveExpressCache(config))
        app.get('/method', (_req, res) => res.send('get'))
        app.post('/method', (_req, res) => res.send('post'))
        await request(app).get('/method').set('Host', 'localhost:80')
        post = async () => (await request(app).post('/method').set('Host', 'localhost:80')).text
      } else {
        const app = Fastify()
        cleanups.push(() => app.close())
        await app.register(adaptiveFastifyCache(config))
        app.get('/method', async () => 'get')
        app.post('/method', async () => 'post')
        await app.inject('/method')
        post = async () => (await app.inject({ method: 'POST', url: '/method' })).payload
      }
      await vi.waitFor(async () =>
        expect(await cache.get(getAdaptiveCacheKey('/method', {}, 'adaptive:', undefined, 'localhost:80'))).not.toBeNull(),
      )
      expect(await post()).toBe('post')
    },
  )
})

const input = {
  key: 'pending',
  dataKey: 'pendingdata',
  metaKey: 'pendingmeta',
  redisPrefix: 'test:',
  encodedData: 'value',
  responseHash: 'hash',
  initialTTL: 10,
  maxTTL: 60,
  ttlScaling: 2,
  metaTTL: 60,
  tags: ['tag'],
}
const makeL1 = (redis = new FakeRedis(), config = options().lru) => {
  const logger = new Logger('silent')
  const lru = new ClusteredLruAdaptiveCacheBackend(config, logger)
  const backend = new L1RedisAdaptiveCacheBackend(
    new RedisAdaptiveCacheBackend(redis as any, logger),
    lru,
    'test:',
    logger,
  )
  cleanups.push(() => backend.quit())
  return { backend, redis }
}

describe('L1 invalidation regressions', () => {
  it.each(['clear', 'tags'] as const)('%s waits for outstanding writes so they cannot resurrect data', async (kind) => {
    const { backend, redis } = makeL1()
    const original = redis.adaptiveCacheUpdate.bind(redis)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    redis.adaptiveCacheUpdate = async (...args) => {
      await gate
      return original(...args)
    }
    await backend.update(input)
    const invalidating =
      kind === 'clear'
        ? backend.clear(input.key, input.dataKey, input.metaKey)
        : backend.invalidateTags(['tag'], 'test:')
    release()
    await invalidating
    await backend.flush()
    expect(await backend.fetch({ ...input, includeDebugHeaders: false })).toBeNull()
    expect(await redis.get(input.dataKey)).toBeNull()
  })

  it('does not hydrate a read that raced with clear', async () => {
    const { backend, redis } = makeL1()
    const authoritative = new RedisAdaptiveCacheBackend(redis as any, new Logger('silent'))
    await authoritative.update(input)
    const original = redis.adaptiveCacheFetch.bind(redis)
    let release!: () => void
    let snapshot!: () => void
    const read = new Promise<void>((resolve) => {
      snapshot = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    redis.adaptiveCacheFetch = async (key) => {
      const result = await original(key)
      snapshot()
      await gate
      return result
    }
    const fetching = backend.fetch({ ...input, includeDebugHeaders: false })
    await read
    await backend.clear(input.key, input.dataKey, input.metaKey)
    release()
    await fetching
    expect(await backend.fetch({ ...input, includeDebugHeaders: false })).toBeNull()
  })

  it('a second instance waits for writes sharing its Redis client before clearing', async () => {
    const redis = new FakeRedis()
    const config = options().lru
    const writer = makeL1(redis, config).backend
    const clearer = makeL1(redis, config).backend
    const original = redis.adaptiveCacheUpdate.bind(redis)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    redis.adaptiveCacheUpdate = async (...args) => {
      await gate
      return original(...args)
    }
    await writer.update(input)
    const clearing = clearer.clear(input.key, input.dataKey, input.metaKey)
    release()
    await clearing
    await writer.flush()
    expect(await writer.fetch({ ...input, includeDebugHeaders: false })).toBeNull()
  })

  it('ignores valid JSON invalidation messages with malformed shapes', async () => {
    const { backend } = makeL1()
    await backend.update(input)
    await backend.flush()
    const subscriber = (backend as any).subscriber as FakeRedis
    for (const payload of ['null', '42', '[]', '{"source":"peer","keys":[null,7]}']) {
      expect(() => subscriber.emit('message', 'test:l1:invalidate', payload)).not.toThrow()
    }
    expect((await backend.fetch({ ...input, includeDebugHeaders: false }))?.encodedData).toBe('value')
  })
})
