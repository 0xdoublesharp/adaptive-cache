import crypto from 'node:crypto'
import express from 'express'
import Fastify from 'fastify'
import Redis from 'ioredis'
import request from 'supertest'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AdaptiveCache } from '../src/AdaptiveCache'
import { adaptiveExpressCache } from '../src/AdaptiveExpressCache'
import { adaptiveFastifyCache } from '../src/AdaptiveFastifyCache'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { L1RedisAdaptiveCacheBackend } from '../src/backends/L1RedisAdaptiveCacheBackend'
import { RedisAdaptiveCacheBackend } from '../src/backends/RedisAdaptiveCacheBackend'
import { isResponseCacheable } from '../src/httpPolicy'
import { encodeHttpResponse } from '../src/httpResponse'
import { Logger } from '../src/lib/logger'
import { getAdaptiveCacheKey } from '../src/utils'
import { ControlledBackend, controlledCache } from './helpers/httpFixtures'

const caches: AdaptiveCache[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(caches.splice(0).map((cache) => cache.close()))
})

describe('module completeness and bug regressions', () => {
  it('does not retain stale data beyond negativeTTL for Express handler 404 responses', async () => {
    const backend = new ControlledBackend()
    const cache = new AdaptiveCache({
      backend,
      compress: false,
      initialTTL: 30,
      maxTTL: 60,
      staleWhileRevalidate: 60,
      staleIfError: 60,
    })
    caches.push(cache)
    const app = express()
    const middleware = adaptiveExpressCache({
      cache,
      negativeTTL: 2,
      staleWhileRevalidate: 60,
      staleIfError: 60,
    })
    app.get('/missing', middleware, (_req, res) => res.status(404).json({ missing: true }))

    await request(app).get('/missing').set('Host', 'localhost:80').expect(404)
    await middleware.flush()

    expect(backend.updateInputs.at(-1)?.maxTTL).toBe(2)
    expect(backend.updateInputs.at(-1)?.staleTTL).toBe(0)
  })

  it('emits debug metadata headers on Express and Fastify loader-mode cache hits', async () => {
    const expressBackend = new ControlledBackend()
    const expressCache = new AdaptiveCache({
      backend: expressBackend,
      compress: false,
      includeDebugHeaders: true,
      initialTTL: 30,
      maxTTL: 60,
    })
    caches.push(expressCache)
    const expressApp = express()
    const expressAdapter = adaptiveExpressCache({
      cache: expressCache,
      includeDebugHeaders: true,
      loader: async () => ({ source: 'express-loader' }),
    })
    expressApp.get('/debug-loader', expressAdapter)

    await request(expressApp).get('/debug-loader').set('Host', 'localhost:80').expect(200)
    const expressHit = await request(expressApp).get('/debug-loader').set('Host', 'localhost:80').expect(200)
    expect(expressHit.headers['x-cache']).toBe('HIT')
    expect(expressHit.headers['x-cache-data-ttl']).toBeDefined()
    expect(expressHit.headers['x-cache-last-modified']).toBeDefined()
    expect(expressHit.headers['x-cache-refreshed']).toBeDefined()

    const fastifyBackend = new ControlledBackend()
    const fastifyCache = new AdaptiveCache({
      backend: fastifyBackend,
      compress: false,
      includeDebugHeaders: true,
      initialTTL: 30,
      maxTTL: 60,
    })
    caches.push(fastifyCache)
    const fastifyApp = Fastify()
    const fastifyAdapter = adaptiveFastifyCache({
      cache: fastifyCache,
      includeDebugHeaders: true,
      loader: async () => ({ source: 'fastify-loader' }),
    })
    await fastifyApp.register(fastifyAdapter)
    fastifyApp.get('/debug-loader', async () => ({ source: 'route' }))
    try {
      await fastifyApp.inject('/debug-loader')
      const fastifyHit = await fastifyApp.inject('/debug-loader')
      expect(fastifyHit.headers['x-cache']).toBe('HIT')
      expect(fastifyHit.headers['x-cache-data-ttl']).toBeDefined()
      expect(fastifyHit.headers['x-cache-last-modified']).toBeDefined()
      expect(fastifyHit.headers['x-cache-refreshed']).toBeDefined()
    } finally {
      await fastifyApp.close()
    }
  })

  it('fails closed on clustered LRU scalar reads without recreating evicted control keys', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: `fail-closed-${crypto.randomUUID()}` },
      new Logger('silent'),
    )
    const cache = new AdaptiveCache({ backend, keyPrefix: 'fc:', compress: false, logLevel: 'silent' })
    caches.push(cache)

    await cache.set('fc:item', { ok: true }, { tags: ['red'] })
    const raw = await (backend as any).getCache()
    await raw.delete('fc:__adaptive:tag-epoch:red')

    expect(await cache.get('fc:item')).toBeNull()
    expect(await raw.get('fc:__adaptive:tag-epoch:red', { bypassL1: true })).toBeUndefined()

    await cache.set('fc:item2', { ok: true })
    await raw.delete('fc:__adaptive:namespace')
    expect(await cache.get('fc:item2')).toBeNull()
    expect(await raw.get('fc:__adaptive:namespace', { bypassL1: true })).toBeUndefined()
  })

  it('handles undefined querystring in getAdaptiveCacheKey without throwing', () => {
    const withUndefined = getAdaptiveCacheKey('/items', undefined, 'prefix:')
    const withEmpty = getAdaptiveCacheKey('/items', {}, 'prefix:')
    const withNull = getAdaptiveCacheKey('/items', null, 'prefix:')

    expect(withUndefined).toMatch(/^prefix:\/items:[0-9a-f]{64}:$/)
    expect(withUndefined).not.toBe(withEmpty)
    expect(withUndefined).not.toBe(withNull)
  })

  it('rejects Cache-Control directives with whitespace before equals sign', () => {
    const makeResponse = (header: string) => ({
      statusCode: 200,
      getHeader: (name: string) => (name === 'cache-control' ? header : undefined),
    })
    expect(isResponseCacheable({}, makeResponse('max-age=60, private = "authorization"'), {})).toBe(false)
    expect(isResponseCacheable({}, makeResponse('no-cache = "etag"'), {})).toBe(false)
    expect(isResponseCacheable({}, makeResponse('no-store = 1'), {})).toBe(false)
  })

  it('supports allowStale option in getMany across batch and fallback backends', async () => {
    const lruBackend = new ClusteredLruAdaptiveCacheBackend(
      { namespace: `many-stale-${crypto.randomUUID()}` },
      new Logger('silent'),
    )
    const lruCache = new AdaptiveCache({ backend: lruBackend, keyPrefix: 'ms:', compress: false, logLevel: 'silent' })
    caches.push(lruCache)
    await lruCache.set('ms:a', 'value-a', { maxTTL: 1, staleTTL: 10 })
    const raw = await (lruBackend as any).getCache()
    const envelope = await raw.get('ms:adata')
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(envelope.freshUntil + 1000)

    expect((await lruCache.getMany(['ms:a'])).get('ms:a')).toBeNull()
    const staleBatch = await lruCache.getMany(['ms:a'], { allowStale: true })
    expect(staleBatch.get('ms:a')).toMatchObject({ data: 'value-a', stale: true, ttl: 0 })
    nowSpy.mockRestore()

    const { backend: fallbackBackend, cache: fallbackCache } = controlledCache()
    caches.push(fallbackCache)
    await fallbackCache.set('fb:a', 'value-fb')
    fallbackBackend.staleKeys.add('fb:a')
    expect((await fallbackCache.getMany(['fb:a'])).get('fb:a')).toBeNull()
    expect((await fallbackCache.getMany(['fb:a'], { allowStale: true })).get('fb:a')).toMatchObject({
      data: 'value-fb',
      stale: true,
    })
  })

  it('validates refreshThreshold in shouldRefresh', async () => {
    const { cache } = controlledCache()
    caches.push(cache)
    await expect(cache.shouldRefresh('key', -1)).rejects.toThrow(RangeError)
    await expect(cache.shouldRefresh('key', Number.NaN)).rejects.toThrow(RangeError)
    await expect(cache.shouldRefresh('key', Number.POSITIVE_INFINITY)).rejects.toThrow(RangeError)
  })

  it('applies ignoreFields and custom fingerprint to Express and Fastify HTTP response bodies', async () => {
    const expressCache = new AdaptiveCache({
      backend: new ClusteredLruAdaptiveCacheBackend(
        { namespace: `http-fp-express-${crypto.randomUUID()}` },
        new Logger('silent'),
      ),
      initialTTL: 5,
      maxTTL: 60,
      ttlScaling: 2,
      includeDebugHeaders: true,
      ignoreFields: ['generatedAt', 'meta.requestId'],
      logLevel: 'silent',
    })
    caches.push(expressCache)
    let tick = 0
    const expressApp = express()
    const expressMw = adaptiveExpressCache({ cache: expressCache, forceRefresh: true, includeDebugHeaders: true })
    expressApp.get('/items', expressMw, (_req, res) => {
      res.json({ stable: 'same', generatedAt: ++tick, meta: { requestId: `r-${tick}`, keep: 1 } })
    })
    expressApp.get('/optional', expressMw, (_req, res) => {
      if (tick++ % 2 === 0) res.json({ stable: 'same' })
      else res.json({ stable: 'same', generatedAt: tick })
    })
    let plainVariant = 0
    expressApp.get('/plain-json', expressMw, (_req, res) => {
      res.type('text/plain').send(plainVariant++ === 0 ? '{"a":1}' : '{ "a" : 1 }')
    })
    let bigIntVariant = 0
    expressApp.get('/bigint-json', expressMw, (_req, res) => {
      res
        .type('application/problem+json')
        .send(bigIntVariant++ === 0 ? '{"id":9007199254740993}' : '{"id":9007199254740992}')
    })
    expressApp.get('/no-ct', expressMw, (_req, res) => {
      res.removeHeader('Content-Type')
      res.end('{"a":1}')
    })
    expressApp.get('/invalid-json', expressMw, (_req, res) => {
      res.type('application/vnd.test+json').send('{invalid')
    })
    expressApp.get('/text', expressMw, (_req, res) => {
      res.type('text/plain').send('plain-text')
    })
    expressApp.get('/bool', expressMw, (_req, res) => {
      res.json(false)
    })
    expressApp.get('/bin', expressMw, (_req, res) => {
      res.type('application/octet-stream').send(Buffer.from([1, 2, 3]))
    })
    await request(expressApp).get('/items').set('Host', 'localhost:80').expect(200)
    await expressMw.flush()
    await request(expressApp).get('/items').set('Host', 'localhost:80').expect(200)
    await expressMw.flush()
    const expressHit = await expressCache.get(getAdaptiveCacheKey('/items', {}, 'adaptive:', undefined, 'localhost:80'))
    expect(expressHit?.metadata?.dataTTL).toBe(10)
    expect(expressHit?.metadata?.changeCount).toBe(1)

    // Optional ignored field: omitting vs including generatedAt must still hash identically while preserving ETag for replay.
    const opt1 = await request(expressApp).get('/optional').set('Host', 'localhost:80').expect(200)
    expect(opt1.headers.etag).toBeDefined()
    await expressMw.flush()
    await request(expressApp).get('/optional').set('Host', 'localhost:80').expect(200)
    await expressMw.flush()
    const optHit = await expressCache.get(getAdaptiveCacheKey('/optional', {}, 'adaptive:', undefined, 'localhost:80'))
    expect(optHit?.metadata?.dataTTL).toBe(10)
    expect((optHit?.data as any)?.headers?.etag).toBeDefined()

    // Plain-text JSON-looking bodies must NOT be canonicalized as JSON.
    await request(expressApp).get('/plain-json').set('Host', 'localhost:80').expect(200)
    await expressMw.flush()
    await request(expressApp).get('/plain-json').set('Host', 'localhost:80').expect(200)
    await expressMw.flush()
    const plainHit = await expressCache.get(
      getAdaptiveCacheKey('/plain-json', {}, 'adaptive:', undefined, 'localhost:80'),
    )
    expect(plainHit?.metadata?.dataTTL).toBe(5)
    expect(plainHit?.metadata?.changeCount).toBe(2)

    // Untouched JSON strings (+json media types) keep original bytes, preserving integers above Number.MAX_SAFE_INTEGER.
    await request(expressApp).get('/bigint-json').set('Host', 'localhost:80').expect(200)
    await expressMw.flush()
    await request(expressApp).get('/bigint-json').set('Host', 'localhost:80').expect(200)
    await expressMw.flush()
    const bigIntHit = await expressCache.get(
      getAdaptiveCacheKey('/bigint-json', {}, 'adaptive:', undefined, 'localhost:80'),
    )
    expect(bigIntHit?.metadata?.dataTTL).toBe(5)
    expect(bigIntHit?.metadata?.changeCount).toBe(2)

    const rawParser = (res: any, cb: (err: Error | null, body: string) => void) => {
      let raw = ''
      res.on('data', (chunk: Buffer | string) => {
        raw += String(chunk)
      })
      res.on('end', () => cb(null, raw))
    }
    await request(expressApp).get('/no-ct').set('Host', 'localhost:80').expect(200)
    await expressCache.set('no-ct-envelope', encodeHttpResponse('{"a":1}', 200, undefined, {}))
    await request(expressApp).get('/invalid-json').set('Host', 'localhost:80').buffer(true).parse(rawParser).expect(200)
    await request(expressApp).get('/text').set('Host', 'localhost:80').expect(200)
    await request(expressApp).get('/bool').set('Host', 'localhost:80').expect(200)
    await request(expressApp).get('/bin').set('Host', 'localhost:80').expect(200)
    await expressMw.flush()

    const fastifyCache = new AdaptiveCache({
      backend: new ClusteredLruAdaptiveCacheBackend(
        { namespace: `http-fp-fastify-${crypto.randomUUID()}` },
        new Logger('silent'),
      ),
      initialTTL: 5,
      maxTTL: 60,
      ttlScaling: 2,
      includeDebugHeaders: true,
      ignoreFields: ['generatedAt'],
      logLevel: 'silent',
    })
    caches.push(fastifyCache)
    const fastifyApp = Fastify()
    const fastifyPlugin = adaptiveFastifyCache({
      cache: fastifyCache,
      forceRefresh: true,
      includeDebugHeaders: true,
    })
    await fastifyApp.register(fastifyPlugin)
    fastifyApp.get('/items', async () => ({ stable: 'same', generatedAt: ++tick }))
    fastifyApp.get('/num', async () => 42)
    try {
      await fastifyApp.inject('/items')
      await fastifyPlugin.flush()
      await fastifyApp.inject('/items')
      await fastifyApp.inject('/num')
      await fastifyPlugin.flush()
      const fastifyHit = await fastifyCache.get(
        getAdaptiveCacheKey('/items', {}, 'adaptive:', undefined, 'localhost:80'),
      )
      expect(fastifyHit?.metadata?.dataTTL).toBe(10)
      expect(fastifyHit?.metadata?.changeCount).toBe(1)
    } finally {
      await fastifyApp.close()
    }

    const customFpCache = new AdaptiveCache({
      backend: new ClusteredLruAdaptiveCacheBackend(
        { namespace: `http-custom-fp-${crypto.randomUUID()}` },
        new Logger('silent'),
      ),
      initialTTL: 5,
      maxTTL: 60,
      ttlScaling: 2,
      includeDebugHeaders: true,
      fingerprint: (body) => (Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : String(body.id)),
      logLevel: 'silent',
    })
    caches.push(customFpCache)
    const fpApp = express()
    const fpMw = adaptiveExpressCache({ cache: customFpCache, forceRefresh: true })
    fpApp.get('/custom', fpMw, (_req, res) => res.json({ id: 'same', nonce: ++tick }))
    fpApp.get('/custom-bin', fpMw, (_req, res) => res.type('application/octet-stream').send(Buffer.from('abc')))
    fpApp.get('/custom-text', fpMw, (_req, res) => res.type('text/plain').send('{"id":"plain"}'))
    fpApp.get('/custom-invalid-json', fpMw, (_req, res) => res.type('application/vnd.test+json').send('{invalid'))
    await request(fpApp).get('/custom').set('Host', 'localhost:80').expect(200)
    await fpMw.flush()
    await request(fpApp).get('/custom').set('Host', 'localhost:80').expect(200)
    await fpMw.flush()
    const customHit = await customFpCache.get(
      getAdaptiveCacheKey('/custom', {}, 'adaptive:', undefined, 'localhost:80'),
    )
    expect(customHit?.metadata?.dataTTL).toBe(10)
    await request(fpApp).get('/custom-bin').set('Host', 'localhost:80').expect(200)
    await request(fpApp).get('/custom-text').set('Host', 'localhost:80').expect(200)
    await request(fpApp)
      .get('/custom-invalid-json')
      .set('Host', 'localhost:80')
      .buffer(true)
      .parse(rawParser)
      .expect(200)
    await fpMw.flush()

    const fastifyFpApp = Fastify()
    const fastifyFpPlugin = adaptiveFastifyCache({ cache: customFpCache, forceRefresh: true })
    await fastifyFpApp.register(fastifyFpPlugin)
    fastifyFpApp.get('/fastify-custom', async () => ({ id: 'same', nonce: ++tick }))
    try {
      await fastifyFpApp.inject('/fastify-custom')
      await fastifyFpPlugin.flush()
      await fastifyFpApp.inject('/fastify-custom')
      await fastifyFpPlugin.flush()
      const fastifyCustomHit = await customFpCache.get(
        getAdaptiveCacheKey('/fastify-custom', {}, 'adaptive:', undefined, 'localhost:80'),
      )
      expect(fastifyCustomHit?.metadata?.dataTTL).toBe(10)
    } finally {
      await fastifyFpApp.close()
    }
  })
})

describe('L1 Redis sub-second and 1-second freshness preservation', () => {
  let container: StartedTestContainer
  let client: Redis
  beforeAll(async () => {
    container = await new GenericContainer('redis:alpine').withExposedPorts(6379).start()
    client = new Redis({ host: container.getHost(), port: container.getMappedPort(6379) })
  })
  afterAll(async () => {
    await client?.quit()
    await container?.stop()
  })

  it('serves L1 hits for 1-second and fractional sub-second TTLs without extending Redis expiry', async () => {
    const logger = new Logger('silent')
    const redisBackend = new RedisAdaptiveCacheBackend(client, logger)
    const lru = new ClusteredLruAdaptiveCacheBackend(
      { namespace: `l1-subsec-${crypto.randomUUID()}`, maxSizeBytes: 1024 * 1024 },
      logger,
    )
    const backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'subsec:', logger, 'await-redis')
    const cache = new AdaptiveCache(
      { backend, keyPrefix: 'subsec:', initialTTL: 0.8, maxTTL: 1, compress: false, logLevel: 'silent' },
      client,
    )
    caches.push(cache)

    await cache.set('subsec:frac', { ok: true })
    // Wait a few ms so integer-second floor(remaining / 1000) is strictly 0.
    await new Promise((resolve) => setTimeout(resolve, 25))
    const hit = await cache.get('subsec:frac')
    expect(hit?.data).toEqual({ ok: true })
    expect(hit?.layer).toBe('l1')

    // Seed a true 1-second entry directly into Redis so L1 starts cold and hydrates on fetch().
    const redisSeeder = new AdaptiveCache(
      { backend: redisBackend, keyPrefix: 'subsec:', initialTTL: 1, maxTTL: 1, compress: false, logLevel: 'silent' },
      client,
    )
    caches.push(redisSeeder)
    await redisSeeder.set('subsec:one', { one: true })
    await new Promise((resolve) => setTimeout(resolve, 25))
    const coldHit = await cache.get('subsec:one')
    expect(coldHit?.data).toEqual({ one: true })
    expect(coldHit?.layer).toBe('redis')
    const warmHit = await cache.get('subsec:one')
    expect(warmHit?.data).toEqual({ one: true })
    expect(warmHit?.layer).toBe('l1')

    // After the 0.8s TTL expires, L1 must not serve the entry past Redis freshness.
    await new Promise((resolve) => setTimeout(resolve, 850))
    expect(await cache.get('subsec:frac')).toBeNull()

    // If Redis no longer has a fresh entry by the time L1 reconciles, L1 deletes its local copy.
    vi.spyOn(redisBackend, 'fetch').mockResolvedValueOnce(null)
    await cache.set('subsec:gone', { gone: true })
    expect(
      await lru.fetch({
        key: 'subsec:gone',
        dataKey: 'subsec:gonedata',
        metaKey: 'subsec:gonemeta',
        redisPrefix: 'subsec:',
        includeDebugHeaders: false,
      }),
    ).toBeNull()
  })
})
