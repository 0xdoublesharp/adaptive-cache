import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest'
import { GenericContainer, StartedTestContainer } from 'testcontainers'
import Fastify from 'fastify'
import Redis from 'ioredis'
import { getAdaptiveCacheKey as baseAdaptiveCacheKey } from '../src/utils'

let cacheModule: typeof import('../src')
let redisClient: Redis
let container: StartedTestContainer

const adapters: ReturnType<typeof cacheModule.adaptiveFastifyCache>[] = []
const makeAdapter = (...args: Parameters<typeof cacheModule.adaptiveFastifyCache>) => {
  const adapter = cacheModule.adaptiveFastifyCache(...args)
  adapters.push(adapter)
  return adapter
}

const getAdaptiveCacheKey = (...args: Parameters<typeof baseAdaptiveCacheKey>) =>
  baseAdaptiveCacheKey(args[0], args[1], args[2], args[3], 'localhost:80')

describe('Adaptive Fastify Cache', () => {
  beforeAll(async () => {
    container = await new GenericContainer('redis:alpine').withExposedPorts(6379).start()

    const host = container.getHost()
    const port = container.getMappedPort(6379)

    process.env.REDIS_HOST = host
    process.env.REDIS_PORT = port.toString()

    cacheModule = await import('../src/index')
    redisClient = cacheModule.redis
  })

  afterAll(async () => {
    if (redisClient) await redisClient.quit()
    if (container) await container.stop()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(adapters.splice(0).map((adapter) => adapter.close()))
  })

  beforeEach(async () => {
    await redisClient.flushall()
    vi.restoreAllMocks()
  })

  it('should cache successful responses', async () => {
    const fastify = Fastify()
    let callCount = 0

    await fastify.register(makeAdapter(cacheModule.cache('10 seconds')))

    fastify.get('/test', async () => {
      callCount++
      return { value: 'success' }
    })

    const res1 = await fastify.inject({ method: 'GET', url: '/test' })
    expect(res1.statusCode).toBe(200)
    expect(callCount).toBe(1)
    expect(res1.headers['x-cache']).toBe('MISS')

    // Wait for async cache
    await new Promise((r) => setTimeout(r, 100))

    const res2 = await fastify.inject({ method: 'GET', url: '/test' })
    expect(res2.statusCode).toBe(200)
    expect(callCount).toBe(1)
    expect(res2.headers['x-cache']).toBe('HIT')
    expect(JSON.parse(res2.payload)).toEqual({ value: 'success' })
  })

  it('should support tags', async () => {
    const fastify = Fastify()
    await fastify.register(makeAdapter({ tags: ['fastify-tag'] }))

    fastify.get('/tags', async () => {
      return { ok: true }
    })

    await fastify.inject({ method: 'GET', url: '/tags' })
    await new Promise((r) => setTimeout(r, 100))

    const members = await redisClient.zrange('adaptive:__adaptive:tag-index:fastify-tag', 0, -1)
    expect(members.length).toBe(1)
  })

  it('should handle query parameters correctly', async () => {
    const fastify = Fastify()
    let callCount = 0

    await fastify.register(makeAdapter())

    fastify.get('/query', async (req) => {
      callCount++
      return { q: (req.query as any).q }
    })

    await fastify.inject({ method: 'GET', url: '/query?q=1' })
    await new Promise((r) => setTimeout(r, 50))

    await fastify.inject({ method: 'GET', url: '/query?q=1' })
    expect(callCount).toBe(1)

    await fastify.inject({ method: 'GET', url: '/query?q=2' })
    expect(callCount).toBe(2)
  })

  it('should force refresh via query param', async () => {
    const fastify = Fastify()
    let callCount = 0

    await fastify.register(makeAdapter())

    fastify.get('/refresh', async () => {
      callCount++
      return { count: callCount }
    })

    await fastify.inject({ method: 'GET', url: '/refresh' })
    await new Promise((r) => setTimeout(r, 50))

    const res = await fastify.inject({ method: 'GET', url: '/refresh?refresh=true' })
    expect(res.headers['x-cache']).toBe('BYPASS')
    expect(callCount).toBe(2)

    const hit = await fastify.inject({ method: 'GET', url: '/refresh' })
    expect(hit.headers['x-cache']).toBe('HIT')
    expect(JSON.parse(hit.payload)).toEqual({ count: 2 })
    expect(callCount).toBe(2)
  })

  it('should cap the actual stored TTL using the parsed JSON payload', async () => {
    const fastify = Fastify()
    const maxTTL = vi.fn((body) => body.ttl)
    const plugin = makeAdapter({ initialTTL: 30, maxTTL })
    await fastify.register(plugin)
    fastify.get('/maxttl', async () => ({ ttl: 20 }))
    try {
      expect((await fastify.inject('/maxttl')).statusCode).toBe(200)
      await plugin.flush()
      expect(maxTTL).toHaveBeenCalledWith({ ttl: 20 })
      const key = getAdaptiveCacheKey('/maxttl', {}, 'adaptive:')
      const ttl = await redisClient.ttl(key + 'data')
      expect(ttl).toBeGreaterThan(18)
      expect(ttl).toBeLessThanOrEqual(20)
      expect((await fastify.inject('/maxttl')).headers['x-cache']).toBe('HIT')
    } finally {
      await fastify.close()
    }
  })

  it('should serve cached falsy responses as hits', async () => {
    const fastify = Fastify()
    let callCount = 0

    await fastify.register(makeAdapter({ initialTTL: 10 }))

    fastify.get('/zero-response', async () => {
      callCount++
      return 0
    })

    await fastify.inject({ method: 'GET', url: '/zero-response' })
    await new Promise((r) => setTimeout(r, 100))

    const res2 = await fastify.inject({ method: 'GET', url: '/zero-response' })
    expect(res2.headers['x-cache']).toBe('HIT')
    expect(res2.payload).toBe('0')
    expect(callCount).toBe(1)
  })

  it('should cache plain text responses', async () => {
    const fastify = Fastify()
    let callCount = 0

    await fastify.register(makeAdapter({ initialTTL: 10 }))

    fastify.get('/plain-text', async (_req, reply) => {
      callCount++
      reply.header('Content-Type', 'text/plain')
      return 'plain text'
    })

    const first = await fastify.inject({ method: 'GET', url: '/plain-text' })
    expect(first.payload).toBe('plain text')
    await new Promise((r) => setTimeout(r, 100))

    const second = await fastify.inject({ method: 'GET', url: '/plain-text' })
    expect(second.headers['x-cache']).toBe('HIT')
    expect(second.payload).toBe('plain text')
    expect(callCount).toBe(1)
  })

  it('should use default maxTTL if function returns undefined', async () => {
    const fastify = Fastify()
    await fastify.register(
      makeAdapter({
        maxTTL: () => undefined,
        initialTTL: 2000,
      }),
    )

    fastify.get('/maxttl-default', async () => {
      return { ok: true }
    })

    await fastify.inject({ method: 'GET', url: '/maxttl-default' })
    const key = getAdaptiveCacheKey('/maxttl-default', {}, 'adaptive:')
    await vi.waitFor(async () => expect((await redisClient.hgetall(key + 'meta')).dataTTL).toBe('900'))
  })

  it('should handle cache update failure', async () => {
    const { Logger } = await import('../src/lib/logger')
    const errorSpy = vi.spyOn(Logger.prototype, 'error')

    const fastify = Fastify()
    const adapter = makeAdapter()
    // Mock adaptiveCacheUpdate to throw
    vi.spyOn(adapter.cache.client, 'adaptiveCacheUpdate').mockRejectedValue(new Error('Update failed'))

    await fastify.register(adapter)

    fastify.get('/update-fail', async () => {
      return { ok: true }
    })

    await fastify.inject({ method: 'GET', url: '/update-fail' })
    await new Promise((r) => setTimeout(r, 100))

    expect(errorSpy).toHaveBeenCalledWith('Cache update failed:', expect.any(Error))
  })

  it('should handle cache fetch failure', async () => {
    const { Logger } = await import('../src/lib/logger')
    const warnSpy = vi.spyOn(Logger.prototype, 'warn')

    const fastify = Fastify()
    // Mock get to throw
    vi.spyOn(cacheModule.AdaptiveCache.prototype, 'get').mockRejectedValue(new Error('Get failed'))

    await fastify.register(makeAdapter())

    fastify.get('/fetch-fail', async () => {
      return { ok: true }
    })

    const res = await fastify.inject({ method: 'GET', url: '/fetch-fail' })
    expect(res.headers['x-cache']).toBe('RETRY')
    expect(warnSpy).toHaveBeenCalledWith('adaptiveCache failed to fetch data:', expect.any(Error))
  })

  it('should respect includeHeaders: false', async () => {
    const fastify = Fastify()
    await fastify.register(makeAdapter({ includeHeaders: false }))

    fastify.get('/no-headers', async () => {
      return { ok: true }
    })

    const res = await fastify.inject({ method: 'GET', url: '/no-headers' })
    expect(res.headers['x-cache']).toBeUndefined()
  })

  it('should keep adapter lock expiration instance-local', async () => {
    const spy = vi.spyOn(cacheModule.AdaptiveCache, 'setDefaultLockExpirationSeconds')
    const fastify = Fastify()
    await fastify.register(makeAdapter({ lockExpirationSeconds: 99 }))
    expect(spy).not.toHaveBeenCalled()
  })

  it('should handle maxTTL as a function returning a value', async () => {
    const fastify = Fastify()
    await fastify.register(
      makeAdapter({
        maxTTL: (_body) => {
          return 123 // Return a specific TTL
        },
        initialTTL: 2000,
      }),
    )

    fastify.get('/maxttl-fn', async () => {
      return { ok: true }
    })

    await fastify.inject({ method: 'GET', url: '/maxttl-fn' })
    const key = getAdaptiveCacheKey('/maxttl-fn', {}, 'adaptive:')
    await vi.waitFor(async () => expect((await redisClient.hgetall(key + 'meta')).dataTTL).toBe('123'))
  })

  it('should handle tags as a function', async () => {
    const fastify = Fastify()
    await fastify.register(
      makeAdapter({
        tags: (_req) => {
          return ['dynamic-tag']
        },
      }),
    )

    fastify.get('/tags-fn', async () => {
      return { ok: true }
    })

    await fastify.inject({ method: 'GET', url: '/tags-fn' })
    await new Promise((r) => setTimeout(r, 100))

    const members = await redisClient.zrange('adaptive:__adaptive:tag-index:dynamic-tag', 0, -1)
    expect(members.length).toBe(1)
  })

  it('should handle invalid JSON payload when maxTTL is a function', async () => {
    const fastify = Fastify()
    await fastify.register(
      makeAdapter({
        maxTTL: () => 100,
      }),
    )

    fastify.get('/invalid-json', async (req, reply) => {
      reply.header('Content-Type', 'text/plain')
      return 'invalid-json-string'
    })

    const first = await fastify.inject({ method: 'GET', url: '/invalid-json' })
    expect(first.statusCode).toBe(200)
    expect(first.payload).toBe('invalid-json-string')
    await vi.waitFor(async () => {
      const hit = await fastify.inject('/invalid-json')
      expect(hit.headers['x-cache']).toBe('HIT')
      expect(hit.payload).toBe(first.payload)
    })
    await new Promise((r) => setTimeout(r, 100))
  })

  it('should not cache non-success responses (status >= 300)', async () => {
    const fastify = Fastify()
    await fastify.register(makeAdapter())

    const spy = vi.spyOn(cacheModule.AdaptiveCache.prototype, 'set')

    fastify.get('/error', async (req, reply) => {
      reply.code(500)
      return { error: true }
    })

    await fastify.inject({ method: 'GET', url: '/error' })

    expect(spy).not.toHaveBeenCalled()
  })

  it('should handle JSON parse error in onSend when maxTTL is function', async () => {
    const fastify = Fastify()
    await fastify.register(
      makeAdapter({
        maxTTL: () => 100,
      }),
    )

    fastify.get('/bad-json', async (req, reply) => {
      reply.header('content-type', 'application/json')
      return '{"invalid": json'
    })

    const first = await fastify.inject({ method: 'GET', url: '/bad-json' })
    expect(first.statusCode).toBe(200)
    expect(first.payload).toBe('{"invalid": json')
    await vi.waitFor(async () => {
      const hit = await fastify.inject('/bad-json')
      expect(hit.headers['x-cache']).toBe('HIT')
      expect(hit.payload).toBe(first.payload)
    })
  })

  it('should handle route cache read failure (get throws)', async () => {
    const fastify = Fastify()
    await fastify.register(makeAdapter())

    // Mock get to throw
    vi.spyOn(cacheModule.AdaptiveCache.prototype, 'get').mockRejectedValue(new Error('Get failed'))

    fastify.get('/fail', async () => ({ source: 'route' }))
    const res = await fastify.inject({ method: 'GET', url: '/fail' })
    expect(res.headers['x-cache']).toBe('RETRY')
  })

  it('should include debug headers when configured', async () => {
    const fastify = Fastify()
    await fastify.register(makeAdapter({ includeDebugHeaders: true }))

    fastify.get('/debug', async () => {
      return { ok: true }
    })

    // First request (MISS)
    await fastify.inject({ method: 'GET', url: '/debug' })

    // Wait for cache
    await new Promise((r) => setTimeout(r, 100))

    // Second request (HIT)
    const res = await fastify.inject({ method: 'GET', url: '/debug' })

    expect(res.headers['x-cache']).toBe('HIT')
    expect(res.headers['x-cache-data-ttl']).toBeDefined()
    expect(res.headers['x-cache-last-modified']).toBeDefined()
    expect(res.headers['x-cache-refreshed']).toBeDefined()
  })

  it('should respect includeHeaders: false on HIT', async () => {
    const fastify = Fastify()
    await fastify.register(makeAdapter({ includeHeaders: false }))

    let calls = 0
    fastify.get('/no-headers-hit', async () => {
      calls++
      return { ok: true }
    })

    // First request
    await fastify.inject({ method: 'GET', url: '/no-headers-hit' })

    // Wait
    await new Promise((r) => setTimeout(r, 100))

    // Second request (HIT)
    const res = await fastify.inject({ method: 'GET', url: '/no-headers-hit' })

    expect(res.headers['x-cache']).toBeUndefined()
    expect(JSON.parse(res.payload)).toEqual({ ok: true })
    expect(calls).toBe(1)
  })

  it('should handle missing lastChanged in metadata', async () => {
    const fastify = Fastify()
    await fastify.register(makeAdapter({ includeDebugHeaders: true }))

    // Mock get to return metadata without lastChanged
    vi.spyOn(cacheModule.AdaptiveCache.prototype, 'get').mockResolvedValue({
      ttl: 100,
      data: { ok: true },
      metadata: {
        dataTTL: 100,
        changeCount: 1,
        // lastChanged missing
      } as any,
    })

    fastify.get('/missing-meta', async () => {
      return { ok: true }
    })

    const res = await fastify.inject({ method: 'GET', url: '/missing-meta' })

    expect(res.headers['x-cache-last-modified']).toBe('unknown')
  })

  it('should handle invalid tags type', async () => {
    const fastify = Fastify()
    // @ts-expect-error invalid tags type
    await fastify.register(makeAdapter({ tags: 'invalid' }))

    fastify.get('/invalid-tags', async () => {
      return { ok: true }
    })

    const first = await fastify.inject({ method: 'GET', url: '/invalid-tags' })
    expect(first.statusCode).toBe(200)
    expect(first.payload).toBe('{"ok":true}')
    await vi.waitFor(async () => {
      const hit = await fastify.inject('/invalid-tags')
      expect(hit.headers['x-cache']).toBe('HIT')
      expect(hit.payload).toBe(first.payload)
    })
  })
})
