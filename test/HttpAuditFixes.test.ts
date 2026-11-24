import Fastify from 'fastify'
import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { createServer, get as httpGet } from 'node:http'
import type { AddressInfo } from 'node:net'
import { performance } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import { setImmediate } from 'node:timers'
import { setImmediate as nextTurn } from 'node:timers/promises'
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { adaptiveFastifyCache } from '../src/AdaptiveFastifyCache'
import { adaptiveExpressCache } from '../src/AdaptiveExpressCache'
import { createHttpLoader } from '../src/httpLoader'
import { buildHttpCacheKey, type HttpResponseLike } from '../src/httpPolicy'
import { encodeHttpResponse } from '../src/httpResponse'
import { getAdaptiveCacheKey } from '../src/utils'
import { gate } from './helpers/coreCache'
import { controlledCache } from './helpers/httpFixtures'

describe('HTTP audit regressions', () => {
  it.each(['immediate', 'scheduled'] as const)(
    'preserves a synchronous Fastify handler with %s reply.send',
    async (mode) => {
      const { cache } = controlledCache()
      const app = Fastify()
      const adapter = adaptiveFastifyCache({ cache })
      let sends = 0
      await app.register(adapter)
      app.addHook('onSend', async (_req, _reply, payload) => {
        sends++
        return payload
      })
      app.get('/data', (_req, reply) => {
        if (mode === 'scheduled') setImmediate(() => reply.send('data'))
        else reply.send('data')
      })
      try {
        expect((await app.inject('/data')).payload).toBe('data')
        await adapter.flush()
        const hit = await app.inject('/data')
        expect(hit.payload).toBe('data')
        expect(hit.headers['x-cache']).toBe('HIT')
        expect(sends).toBe(2)
      } finally {
        await app.close()
        await cache.close()
      }
    },
  )
})

describe('Fastify raw request headers', () => {
  const schema = { headers: { type: 'object', additionalProperties: false } }

  it.each(['authorization', 'cookie', 'range', 'if-range', 'cache-control', 'if-match', 'if-unmodified-since'])(
    'evaluates %s through built-in policy even when validation strips it',
    async (name) => {
      const { cache, backend } = controlledCache()
      const app = Fastify()
      const adapter = adaptiveFastifyCache({ cache })
      const fetch = vi.spyOn(backend, 'fetch')
      await app.register(adapter)
      app.get('/data', { schema }, (req) => ({ stripped: req.headers[name] === undefined }))
      try {
        const header = name === 'cache-control' ? 'no-store' : 'present'
        const response = await app.inject({ url: '/data', headers: { [name]: header } })
        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({ stripped: true })
        expect(response.headers['x-cache']).toBe('BYPASS')
        await adapter.flush()
        expect(fetch).not.toHaveBeenCalled()
        expect(backend.updateInputs).toHaveLength(0)
      } finally {
        await app.close()
        await cache.close()
      }
    },
  )

  it('keeps authority and header-list variants in the existing key format after validation', async () => {
    const { cache, backend } = controlledCache()
    const app = Fastify()
    const varyBy = ['authorization', 'x-variant']
    const adapter = adaptiveFastifyCache({ cache, varyBy, cacheAuthenticated: true })
    await app.register(adapter)
    let calls = 0
    app.get('/data', { schema }, () => String(++calls))
    const request = async (headers: Record<string, string>, expected: string) => {
      const result = await app.inject({ url: '/data', headers })
      expect(result.payload).toBe(expected)
      await adapter.flush()
    }
    try {
      const first = { host: 'one.example', authorization: 'test', 'x-variant': 'one' }
      const inputs = [first, { ...first, host: 'two.example' }, { ...first, 'x-variant': 'two' }]
      for (const [index, headers] of inputs.entries()) await request(headers, String(index + 1))
      await request(first, '1')
      expect(backend.updatedKeys).toEqual(
        inputs.map((headers) =>
          buildHttpCacheKey({ req: { headers }, requestPath: '/data', query: {}, cachePrefix: 'adaptive:', varyBy }),
        ),
      )
      const authorityKey = buildHttpCacheKey({
        req: { headers: { host: 'ignored.example' } },
        rawHeaders: { ':authority': 'one.example', 'x-variant': 'one', authorization: 'test' },
        requestPath: '/data',
        query: {},
        cachePrefix: 'adaptive:',
        varyBy,
      })
      expect(authorityKey).toBe(backend.updatedKeys[0])
    } finally {
      await app.close()
      await cache.close()
    }
  })
})

const restrictionCases = [
  ['cache-control', 'private, no-store'],
  ['cache-control', 'no-cache'],
  ['set-cookie', 'test=1'],
  ['vary', '*'],
  ['vary', 'x-undeclared'],
] as const

for (const framework of ['express', 'fastify'] as const) {
  for (const mode of ['handler', 'loader'] as const) {
    it.each([true, false])(
      `${framework} ${mode} keeps custom headers off replay with policy opt-in %s`,
      async (optIn) => {
        const { cache, backend } = controlledCache()
        const source = vi.fn(async () => 'origin')
        const options = {
          cache,
          ...(mode === 'loader' ? { loader: source } : {}),
          ...(optIn
            ? {
                policyHeaders: ['X-Policy-Marker'],
                shouldCache: (_req: unknown, res?: HttpResponseLike) =>
                  !res || res.getHeader?.('x-policy-marker') === 'yes',
              }
            : {}),
        }
        let get: (first: boolean) => Promise<{ body: string; headers: Record<string, unknown> }>
        let close = async () => {}
        let flush: () => Promise<void>
        if (framework === 'express') {
          const app = express()
          const adapter = adaptiveExpressCache(options)
          app.get(
            '/data',
            (req, res, next) => {
              if (mode === 'loader' && req.headers['x-origin']) res.set('X-Policy-Marker', 'yes')
              next()
            },
            adapter,
            async (_req, res) => res.set('X-Policy-Marker', 'yes').send(await source()),
          )
          get = async (first) => {
            const response = await request(app)
              .get('/data')
              .set('Host', 'localhost:80')
              .set('x-origin', first ? 'yes' : '')
            return { body: response.text, headers: response.headers }
          }
          flush = adapter.flush
        } else {
          const app = Fastify()
          const adapter = adaptiveFastifyCache(options)
          await app.register(adapter)
          app.get(
            '/data',
            {
              preHandler: async (req, reply) => {
                if (mode === 'loader' && req.headers['x-origin']) reply.header('X-Policy-Marker', 'yes')
              },
            },
            (_req, reply) => {
              reply.header('X-Policy-Marker', 'yes')
              return source()
            },
          )
          get = async (first) => {
            const response = await app.inject({ url: '/data', headers: { 'x-origin': first ? 'yes' : '' } })
            return { body: response.payload, headers: response.headers }
          }
          flush = adapter.flush
          close = () => app.close()
        }
        try {
          expect(await get(true)).toMatchObject({ body: 'origin', headers: { 'x-policy-marker': 'yes' } })
          await flush()
          const hit = await get(false)
          expect(hit).toMatchObject({ body: 'origin', headers: { 'x-cache': 'HIT' } })
          expect(hit.headers).not.toHaveProperty('x-policy-marker')
          expect(source).toHaveBeenCalledTimes(1)
          expect(backend.updatedKeys).toHaveLength(1)
          const entry = await cache.get<{ headers: Record<string, unknown>; policyHeaders?: Record<string, unknown> }>(
            backend.updatedKeys[0],
          )
          expect(entry?.data.headers).not.toHaveProperty('x-policy-marker')
          if (optIn) expect(entry?.data.policyHeaders).toEqual({ 'x-policy-marker': 'yes' })
          else expect(entry?.data).not.toHaveProperty('policyHeaders')
        } finally {
          await close()
          await cache.close()
        }
      },
    )

    it.each(restrictionCases)(`${framework} ${mode} preserves an already-set %s: %s`, async (name, value) => {
      const { cache, backend } = controlledCache()
      const go = vi.spyOn(cache, 'getOrSet')
      const source = vi.fn(async () => 'origin')
      const options = { cache, ...(mode === 'loader' ? { loader: source } : {}) }
      const warm = encodeHttpResponse('warm', 200, 'text/plain', { 'cache-control': 'public', vary: '' })
      const key = getAdaptiveCacheKey('/data', {}, 'adaptive:', undefined, 'localhost:80')
      let get: (restricted: boolean) => Promise<{ status: number; body: string; headers: Record<string, unknown> }>
      let close = async () => {}
      if (framework === 'express') {
        const app = express()
        app.use((req, res, next) => {
          if (req.headers['x-restrict']) res.set(name, value)
          next()
        })
        app.get('/data', adaptiveExpressCache(options), async (_req, res) => res.send(await source()))
        get = async (restricted) => {
          const response = await request(app)
            .get('/data')
            .set('Host', 'localhost:80')
            .set('x-restrict', restricted ? 'yes' : '')
          return { status: response.status, body: response.text, headers: response.headers }
        }
      } else {
        const app = Fastify()
        await app.register(adaptiveFastifyCache(options))
        app.get(
          '/data',
          {
            preHandler: async (req, reply) => {
              if (req.headers['x-restrict']) reply.header(name, value)
            },
          },
          source,
        )
        get = async (restricted) => {
          const response = await app.inject({ url: '/data', headers: { 'x-restrict': restricted ? 'yes' : '' } })
          return { status: response.statusCode, body: response.payload, headers: response.headers }
        }
        close = () => app.close()
      }
      try {
        await cache.set(key, warm)
        expect(await get(false)).toMatchObject({ status: 200, body: 'warm', headers: { 'x-cache': 'HIT' } })
        const response = await get(true)
        expect(response).toMatchObject({ status: 200, body: 'origin', headers: { 'x-cache': 'BYPASS' } })
        expect([response.headers[name]].flat()).toEqual([value])
        expect(source).toHaveBeenCalledTimes(1)
        expect(go).not.toHaveBeenCalled()
        expect(backend.updateInputs).toHaveLength(1)
      } finally {
        await close()
        await cache.close()
      }
    })

    it(`${framework} ${mode} isolates TTL callback mutations from response replay`, async () => {
      const { cache } = controlledCache()
      const body = { nested: { value: 'original' } }
      const source = vi.fn(async () => body)
      const options = {
        cache,
        maxTTL: (inspected: typeof body) => {
          inspected.nested.value = 'mutated'
          return 12
        },
        ...(mode === 'loader' ? { loader: source } : {}),
      }
      let get: () => Promise<{ body: unknown; headers: Record<string, unknown> }>
      let close = async () => {}
      let flush: () => Promise<void>
      if (framework === 'express') {
        const app = express()
        const adapter = adaptiveExpressCache(options)
        app.get('/data', adapter, async (_req, res) => res.send(await source()))
        get = async () => request(app).get('/data').set('Host', 'localhost:80')
        flush = adapter.flush
      } else {
        const app = Fastify()
        const adapter = adaptiveFastifyCache(options)
        await app.register(adapter)
        app.addHook('onSend', async (_req, reply, payload) => {
          reply.header('etag', '"original"')
          return payload
        })
        app.get('/data', source)
        get = async () => {
          const response = await app.inject('/data')
          return { body: response.json(), headers: response.headers }
        }
        flush = adapter.flush
        close = () => app.close()
      }
      try {
        const first = await get()
        await flush()
        const hit = await get()
        const original = { nested: { value: 'original' } }
        expect(first.body).toEqual(original)
        expect(hit.body).toEqual(original)
        expect(body).toEqual(original)
        expect(hit.headers['x-cache']).toBe('HIT')
        expect(hit.headers.etag).toBe(first.headers.etag)
        expect(source).toHaveBeenCalledTimes(1)
      } finally {
        await close()
        await cache.close()
      }
    })
  }

  it(`${framework} uses the loader for implicit HEAD without reading or populating cache`, async () => {
    const { cache, backend } = controlledCache()
    const source = vi.fn(async () => 'loader result')
    const placeholder = vi.fn(() => 'wrong handler')
    const fetch = vi.spyOn(backend, 'fetch')
    if (framework === 'express') {
      const app = express()
      app.get('/data', adaptiveExpressCache({ cache, loader: source }), placeholder)
      const response = await request(app).head('/data')
      expect(response.status).toBe(200)
      expect(response.headers['content-length']).toBe('13')
      expect(response.text).toBeUndefined()
    } else {
      const app = Fastify()
      try {
        await app.register(adaptiveFastifyCache({ cache, loader: source }))
        app.get('/data', placeholder)
        const response = await app.inject({ method: 'HEAD', url: '/data' })
        expect(response.statusCode).toBe(200)
        expect(response.headers['content-length']).toBe('13')
        expect(response.payload).toBe('')
      } finally {
        await app.close()
      }
    }
    await cache.close()
    expect(source).toHaveBeenCalledTimes(1)
    expect(placeholder).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(backend.updateInputs).toHaveLength(0)
  })
}

it.each(restrictionCases)('checks late Express loader %s: %s before publishing', async (name, value) => {
  const { cache, backend } = controlledCache()
  const source = vi.fn(async () => ({ value: 'origin' }))
  const app = express()
  app.use((_req, res, next) => {
    const end = res.end
    res.end = function (...args: any[]) {
      res.set(name, value)
      return end.apply(this, args as Parameters<typeof end>)
    }
    next()
  })
  const adapter = adaptiveExpressCache({ cache, loader: source })
  app.get('/data', adapter)
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(app).get('/data').set('Host', 'localhost:80')
      expect([response.headers[name]].flat()).toEqual([value])
      expect(response.body).toEqual({ value: 'origin' })
      await adapter.flush()
    }
    expect(source).toHaveBeenCalledTimes(2)
    expect(backend.updateInputs).toHaveLength(0)
  } finally {
    await cache.close()
  }
})

it('keeps an Express result with a late restriction out of a concurrent loader join', async () => {
  const { cache, backend } = controlledCache()
  const app = express()
  const loading = gate()
  const joined = gate()
  const release = gate()
  const getOrSet = cache.getOrSet.bind(cache)
  let waits = 0
  vi.spyOn(cache, 'getOrSet').mockImplementation((...args) => {
    const result = getOrSet(...args)
    if (++waits === 2) joined.resolve()
    return result
  })
  const source = vi.fn(async () => {
    loading.resolve()
    await release.promise
    return 'origin'
  })
  app.use((_req, res, next) => {
    const end = res.end
    res.end = function (...args: any[]) {
      res.set('cache-control', 'private')
      return end.apply(this, args as Parameters<typeof end>)
    }
    next()
  })
  const adapter = adaptiveExpressCache({ cache, loader: source })
  app.get('/data', adapter)
  const get = () =>
    request(app)
      .get('/data')
      .set('Host', 'localhost:80')
      .then((result) => result)
  try {
    const first = get()
    await loading.promise
    const second = get()
    await joined.promise
    release.resolve()
    for (const response of await Promise.all([first, second])) {
      expect(response.text).toBe('origin')
      expect(response.headers['cache-control']).toBe('private')
    }
    await adapter.flush()
    expect(source).toHaveBeenCalledTimes(2)
    expect(backend.updateInputs).toHaveLength(0)
  } finally {
    release.resolve()
    await cache.close()
  }
})

it.each(['blocked', 'throws'])(
  'publishes a Fastify loader when an earlier onResponse hook %s',
  async (behavior) => {
    const { cache, backend } = controlledCache()
    const app = Fastify()
    const entered = gate()
    const release = gate()
    const updating = gate()
    const write = gate()
    const original = backend.update.bind(backend)
    vi.spyOn(backend, 'update').mockImplementation(async (input) => {
      updating.resolve()
      await write.promise
      return original(input)
    })
    app.addHook('onResponse', async () => {
      entered.resolve()
      if (behavior === 'throws') throw new Error('observer failed')
      await release.promise
    })
    const source = vi.fn(async () => 'source')
    const adapter = adaptiveFastifyCache({ cache, loader: source })
    await app.register(adapter)
    app.get('/data', () => 'placeholder')
    try {
      const first = await app.inject('/data')
      expect(first.payload).toBe('source')
      await entered.promise
      let flushed = false
      const flush = adapter.flush().then(() => (flushed = true))
      await updating.promise
      expect(flushed).toBe(false)
      write.resolve()
      await flush
      expect(backend.updateInputs).toHaveLength(1)
      expect((await app.inject('/data')).headers['x-cache']).toBe('HIT')
      expect(source).toHaveBeenCalledTimes(1)
    } finally {
      release.resolve()
      write.resolve()
      await app.close()
      await cache.close()
    }
  },
  3000,
)

it.each(['if-match', 'if-unmodified-since'])(
  'lets Express evaluate %s against the origin on a warm route',
  async (name) => {
    const { cache, backend } = controlledCache()
    const app = express()
    const adapter = adaptiveExpressCache({ cache })
    app.get('/data', adapter, (req, res) => {
      if (req.headers[name]) res.status(412).send('failed precondition')
      else res.send('origin')
    })
    try {
      const get = () => request(app).get('/data').set('Host', 'localhost:80')
      expect((await get()).status).toBe(200)
      await adapter.flush()
      const response = await get().set(name, 'stale')
      expect(response.status).toBe(412)
      expect(response.headers['x-cache']).toBe('BYPASS')
      expect((await get()).headers['x-cache']).toBe('HIT')
      expect(backend.updateInputs).toHaveLength(1)
    } finally {
      await cache.close()
    }
  },
)

it('captures one-shot Express end chunks once and skips streaming writes', async () => {
  const { cache, backend } = controlledCache()
  const app = express()
  const adapter = adaptiveExpressCache({ cache })
  let coldCalls = 0
  app.get('/text', adapter, (_req, res) => {
    res.end(`raw ${++coldCalls}`)
  })
  app.get('/buffer', adapter, (_req, res) => res.end(Buffer.from('bytes')))
  app.get('/encoded', adapter, (_req, res) => res.end('e9', 'hex'))
  app.get('/send', adapter, (_req, res) => res.send('sent'))
  app.get('/stream', adapter, (_req, res) => {
    res.write('part ')
    res.end('end')
  })
  app.get('/pipe', adapter, (_req, res) => Readable.from(['piped']).pipe(res))
  app.get('/pipe-end', adapter, (_req, res) => {
    const stream = Readable.from([])
    stream.pipe(res, { end: false })
    stream.on('end', () => res.end('footer'))
  })
  app.get('/empty', adapter, (_req, res) => res.end())
  const get = (path: string) => request(app).get(path).set('Host', 'localhost:80')
  try {
    for (const path of ['/text', '/buffer', '/encoded', '/send']) {
      const first = await get(path)
      await adapter.flush()
      const second = await get(path)
      expect(first.status).toBe(200)
      expect(second.headers['x-cache']).toBe('HIT')
      expect(second.headers['content-type']).toBe(first.headers['content-type'])
      expect(second.text).toBe(first.text)
    }
    expect(coldCalls).toBe(1)
    for (const path of ['/stream', '/pipe', '/pipe-end', '/empty']) {
      expect((await get(path)).headers['x-cache']).toBe('MISS')
      await adapter.flush()
      expect((await get(path)).headers['x-cache']).toBe('MISS')
    }
    expect(backend.updateInputs).toHaveLength(4)
  } finally {
    await cache.close()
  }
})

describe('function-valued varyBy', () => {
  const key = (value: unknown) =>
    buildHttpCacheKey({
      req: {},
      requestPath: '/data',
      query: {},
      cachePrefix: 'adaptive:',
      varyBy: () => value,
    })

  it('accepts legacy JSON and buffers and preserves typed extensions without collisions', () => {
    const date = new Date('2026-01-01T00:00:00Z')
    const variants = [
      date,
      date.toISOString(),
      { date: date.toISOString() },
      new Date(date.getTime() + 1),
      new Uint8Array([1]),
      new Uint8Array([2]),
    ]
    const keys = variants.map(key)
    expect(keys.every((value) => value?.match(/^adaptive:.*vary:[0-9a-f]{64}:v$/))).toBe(true)
    expect(new Set(keys).size).toBe(variants.length)
    expect(key([date])).toBe(key([new Date(date)]))
    expect(key({ z: [true, undefined, null, Buffer.from('x')], 2: 17, 10: 'ten' })).toBe(
      key(Object.assign(Object.create(null), { 10: 'ten', 2: 17, z: [true, null, null, 'eA=='], omitted: undefined })),
    )
  })

  it('separates a varied key from a literal unvaried path that embeds the query digest and vary delimiter', () => {
    const common = { req: { headers: { host: 'example.test' } }, cachePrefix: 'shared:' }
    const query = { filter: 'open' }
    const queryDigest = createHash('sha256').update(JSON.stringify(query)).digest('hex')
    const variation = { filter: 'closed' }
    const varied = buildHttpCacheKey({ ...common, requestPath: '/data', query, varyBy: () => variation })
    const unvaried = buildHttpCacheKey({ ...common, requestPath: `/data:${queryDigest}:vary`, query: variation })
    expect(varied).toBe(`${unvaried}v`)
    expect(varied).not.toBe(unvaried)
  })

  it('bypasses unsupported values even inside a supported container', () => {
    class Custom {
      value = 1
    }
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    for (const value of [
      new Map(),
      new Set(),
      /value/,
      new Custom(),
      Symbol('value'),
      () => 1,
      1n,
      NaN,
      Infinity,
      new Date(NaN),
      cycle,
      new Proxy({}, {}),
    ]) {
      expect(key({ nested: [value] })).toBeUndefined()
    }
  })
})

it.each(['before wait', 'before invocation', 'after invocation'])(
  'rejects a monotonic deadline exceeded %s',
  async (when) => {
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const source = vi.fn(async () => {
      now = 50
      return 'result'
    })
    try {
      const loader = createHttpLoader(source, 50)
      if (when === 'before wait') now = 50
      const result = loader.wait(loader.loadOnce)
      if (when === 'before invocation') now = 50
      await expect(result).rejects.toMatchObject({ name: 'TimeoutError' })
      expect(source).toHaveBeenCalledTimes(when === 'after invocation' ? 1 : 0)
    } finally {
      clock.mockRestore()
    }
  },
)

for (const framework of ['express', 'fastify'] as const) {
  it(`${framework} aborts shared work after the last client disconnects`, async () => {
    const { cache, backend } = controlledCache()
    const entered = gate()
    const joined = gate()
    const left = gate()
    let shared!: AbortSignal
    const getOrSet = cache.getOrSet.bind(cache)
    let callers = 0
    vi.spyOn(cache, 'getOrSet').mockImplementation((...args) => {
      const pending = getOrSet(...args)
      if (++callers === 2) joined.resolve()
      return pending
    })
    const source = vi.fn(async (_req: unknown, context: { signal: AbortSignal }) => {
      shared = context.signal
      const aborted = new Promise<never>((_, reject) => {
        shared.addEventListener(
          'abort',
          () => {
            left.resolve()
            reject(shared.reason)
          },
          { once: true },
        )
      })
      entered.resolve()
      return aborted
    })
    let url: string
    let close: () => Promise<unknown>
    let flush: () => Promise<void>
    if (framework === 'express') {
      const app = express()
      const adapter = adaptiveExpressCache({ cache, loader: source })
      app.get('/data', adapter)
      const server = createServer(app)
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const { port } = server.address() as AddressInfo
      url = `http://127.0.0.1:${port}/data`
      close = () => new Promise((resolve) => server.close(resolve))
      flush = adapter.flush
    } else {
      const app = Fastify()
      const adapter = adaptiveFastifyCache({ cache, loader: source })
      await app.register(adapter)
      app.get('/data', () => 'placeholder')
      url = `${await app.listen({ port: 0, host: '127.0.0.1' })}/data`
      close = () => app.close()
      flush = adapter.flush
    }
    const client = () => httpGet(url).on('error', () => {})
    const first = client()
    let second: ReturnType<typeof client> | undefined
    try {
      await entered.promise
      second = client()
      await joined.promise
      await nextTurn()
      const firstClosed = once(first, 'close').catch(() => undefined)
      first.destroy()
      await firstClosed
      await nextTurn()
      expect(shared.aborted).toBe(false)
      second.destroy()
      await left.promise
      expect(shared.reason).toMatchObject({ name: 'AbortError' })
      expect(source).toHaveBeenCalledTimes(1)
      await flush()
      expect(backend.updateInputs).toHaveLength(0)
    } finally {
      first.destroy()
      second?.destroy()
      await close()
      await cache.close()
    }
  }, 3000)
}

for (const framework of ['express', 'fastify'] as const) {
  it.each(['handler read', 'loader read', 'loader miss', 'loader join'] as const)(
    `${framework} bypasses if headers become restrictive during a %s`,
    async (stage) => {
      const { cache, backend } = controlledCache()
      const reached = gate()
      const release = gate()
      const setPrivate = new Map<string, () => void>()
      const source = vi.fn(async () => 'origin')
      const options = { cache, ...(stage === 'handler read' ? {} : { loader: source }) }
      const getOrSet = vi.spyOn(cache, 'getOrSet')
      const key = getAdaptiveCacheKey('/data', {}, 'adaptive:', undefined, 'localhost:80')
      let get: () => Promise<{ headers: Record<string, unknown>; payload: string }>
      let close = async () => {}
      if (framework === 'express') {
        const app = express()
        app.use((req, res, next) => {
          setPrivate.set(String(req.headers['x-case']), () => res.set('cache-control', 'private'))
          next()
        })
        app.get('/data', adaptiveExpressCache(options), async (_req, res) => res.send(await source()))
        get = async () => {
          const response = await request(app).get('/data').set('Host', 'localhost:80').set('x-case', 'restricted')
          return { headers: response.headers, payload: response.text }
        }
      } else {
        const app = Fastify()
        app.addHook('onRequest', async (req, reply) => {
          setPrivate.set(String(req.headers['x-case']), () => reply.header('cache-control', 'private'))
        })
        await app.register(adaptiveFastifyCache(options))
        app.get('/data', source)
        get = () => app.inject({ url: '/data', headers: { 'x-case': 'restricted' } })
        close = () => app.close()
      }
      try {
        const publicValue = encodeHttpResponse('warm', 200, 'text/plain', { 'cache-control': 'public' })
        if (stage === 'loader join') {
          // Pause the returned shared value between the adapter's initial miss
          // and the point where it can replay the value on this response.
          getOrSet.mockImplementation(async () => {
            reached.resolve()
            await release.promise
            return publicValue as any
          })
        } else {
          if (stage !== 'loader miss') await cache.set(key, publicValue)
          const getFromCache = cache.get.bind(cache)
          vi.spyOn(cache, 'get').mockImplementation(async (...args) => {
            reached.resolve()
            await release.promise
            return getFromCache(...args)
          })
        }
        const response = get()
        await reached.promise
        setPrivate.get('restricted')!()
        release.resolve()
        expect(await response).toMatchObject({
          payload: 'origin',
          headers: { 'cache-control': 'private', 'x-cache': 'BYPASS' },
        })
        expect(getOrSet).toHaveBeenCalledTimes(stage === 'loader join' ? 1 : 0)
        expect(source).toHaveBeenCalledTimes(1)
        expect(backend.updateInputs).toHaveLength(stage.endsWith('read') ? 1 : 0)
      } finally {
        release.resolve()
        await close()
        await cache.close()
      }
    },
  )

  it(`${framework} leaves a POST handler in control when a loader is configured`, async () => {
    const { cache } = controlledCache()
    const loader = vi.fn(async () => 'loader')
    try {
      if (framework === 'express') {
        const app = express()
        app.post('/data', adaptiveExpressCache({ cache, loader }), (_req, res) => res.send('post'))
        expect((await request(app).post('/data')).text).toBe('post')
      } else {
        const app = Fastify()
        try {
          await app.register(adaptiveFastifyCache({ cache, loader }))
          app.post('/data', () => 'post')
          expect((await app.inject({ method: 'POST', url: '/data' })).payload).toBe('post')
        } finally {
          await app.close()
        }
      }
      expect(loader).not.toHaveBeenCalled()
    } finally {
      await cache.close()
    }
  })
}

it('rejects an Express candidate when its response becomes private while the loader runs', async () => {
  const { cache, backend } = controlledCache()
  const app = express()
  const entered = gate()
  const release = gate()
  let reply!: express.Response
  const loader = vi.fn(async () => {
    entered.resolve()
    await release.promise
    return 'origin'
  })
  const adapter = adaptiveExpressCache({ cache, loader })
  app.get(
    '/data',
    (_req, res, next) => {
      reply = res
      next()
    },
    adapter,
  )
  try {
    const pending = request(app)
      .get('/data')
      .then((response) => response)
    await entered.promise
    reply.set('cache-control', 'private')
    release.resolve()
    expect(await pending).toMatchObject({ text: 'origin', headers: { 'cache-control': 'private' } })
    await adapter.flush()
    expect(loader).toHaveBeenCalledTimes(1)
    expect(backend.updateInputs).toHaveLength(0)
  } finally {
    release.resolve()
    await cache.close()
  }
})

it('forwards a synchronous Express send error once and discards the loader candidate', async () => {
  const { cache, backend } = controlledCache()
  const app = express()
  const error = new Error('send failure')
  const observed = vi.fn()
  const loader = vi.fn(async () => 'origin')
  const adapter = adaptiveExpressCache({ cache, loader })
  app.use((_req, res, next) => {
    const send = res.send
    res.send = function (body) {
      if (body === 'origin') throw error
      return send.call(this, body)
    }
    next()
  })
  app.get('/data', adapter)
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    observed(error)
    res.status(500).send('failed')
  })
  try {
    expect((await request(app).get('/data')).status).toBe(500)
    expect(observed).toHaveBeenCalledExactlyOnceWith(error)
    expect(loader).toHaveBeenCalledTimes(1)
    await adapter.flush()
    expect(backend.updateInputs).toHaveLength(0)
  } finally {
    await cache.close()
  }
})

it('declines Express loader publication when transport closes without finishing', async () => {
  const { cache, backend } = controlledCache()
  const transport = Object.assign(new EventEmitter(), {
    statusCode: 200,
    writableEnded: true,
    set: vi.fn(),
    send: vi.fn(() => transport.emit('close')),
  })
  const adapter = adaptiveExpressCache({ cache, loader: async () => 'body' })
  try {
    await adapter({ originalUrl: '/data', query: {}, method: 'GET' }, transport, vi.fn())
    await adapter.flush()
    expect(transport.send).toHaveBeenCalledExactlyOnceWith('body')
    expect(backend.updateInputs).toHaveLength(0)
    for (const event of ['close', 'finish', 'error']) expect(transport.listenerCount(event)).toBe(0)
  } finally {
    await cache.close()
  }
})

it('preserves legacy Express hits and capture for a response with only send', async () => {
  const { cache, backend } = controlledCache()
  const key = getAdaptiveCacheKey('/data', {}, 'adaptive:', undefined, '')
  const incoming = { originalUrl: '/data', query: {}, method: 'GET' }
  const response = () => ({ statusCode: 202, getHeader: () => undefined, set: vi.fn(), send: vi.fn() })
  const adapter = adaptiveExpressCache({ cache })
  try {
    await cache.set(key, { expressEnd: true, legacy: true })
    const hit = response()
    const unused = vi.fn()
    await adapter(incoming, hit, unused)
    expect(hit.send).toHaveBeenCalledExactlyOnceWith({ expressEnd: true, legacy: true })
    expect(hit.statusCode).toBe(202)
    expect(unused).not.toHaveBeenCalled()
    await cache.clear(key)
    Object.defineProperty(backend, 'captureWriteToken', { value: undefined })
    const miss = response()
    await adapter(incoming, miss, () => miss.send('new'))
    await adapter.flush()
    expect(backend.updateInputs).toHaveLength(2)
    expect(miss.send).toHaveBeenCalledExactlyOnceWith('new')
  } finally {
    await cache.close()
  }
})

it('preserves canonical header-list hashing for structural header values', () => {
  const key = (header: unknown) =>
    buildHttpCacheKey({
      req: { headers: { 'x-variant': header } },
      requestPath: '/',
      query: {},
      cachePrefix: 'adaptive:',
      varyBy: ['x-variant'],
    })
  expect(key({ z: ['test'], a: Buffer.from('x') })).toBe(key({ a: 'eA==', z: ['test'] }))
})
