import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import express from 'express'
import request from 'supertest'
import { AdaptiveCache } from '../src/AdaptiveCache'
import { adaptiveFastifyCache } from '../src/AdaptiveFastifyCache'
import { adaptiveExpressCache } from '../src/AdaptiveExpressCache'
import { ControlledBackend, controlledCache } from './helpers/httpFixtures'

describe('HTTP hardening regressions', () => {
  it('runs Fastify authentication and validation before hits and explicit loaders', async () => {
    const { cache } = controlledCache()
    const app = Fastify()
    let revoked = false
    let calls = 0
    const plugin = adaptiveFastifyCache({
      cache,
      cacheAuthenticated: true,
      varyBy: ['authorization'],
      loader: async () => ({ calls: ++calls }),
    })
    await app.register(plugin)
    app.get(
      '/data',
      {
        schema: {
          querystring: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
          headers: { type: 'object', required: ['x-validation'], properties: { 'x-validation': { type: 'integer' } } },
        },
        preHandler: async (_req, reply) => {
          if (revoked) return reply.code(401).send('revoked')
        },
      },
      async () => 'route',
    )
    const headers = { authorization: 'Bearer token', 'x-validation': '1' }
    expect((await app.inject({ url: '/data?id=1', headers })).statusCode).toBe(200)
    revoked = true
    expect((await app.inject({ url: '/data?id=1', headers })).statusCode).toBe(401)
    revoked = false
    expect(
      (await app.inject({ url: '/data?id=1', headers: { ...headers, 'x-validation': 'invalid' } })).statusCode,
    ).toBe(400)
    expect((await app.inject({ url: '/data', headers })).statusCode).toBe(400)
    expect(calls).toBe(1)
    await app.close()
  })

  it('limits a prefixed Fastify loader to matching routes', async () => {
    const { cache } = controlledCache()
    const app = Fastify()
    await app.register(adaptiveFastifyCache({ cache, loader: async () => 'loader' }), { prefix: '/api' })
    app.get('/api/data', async () => 'route')
    app.get('/outside', async () => 'outside')
    expect((await app.inject('/api/data')).payload).toBe('loader')
    expect((await app.inject('/outside')).payload).toBe('outside')
    await app.close()
  })

  it('awaits delayed Fastify onSend hooks for loader responses and hits without replaying the route', async () => {
    const { cache } = controlledCache()
    const app = Fastify()
    let loaderCalls = 0
    let handlerCalls = 0
    let entered!: () => void
    let release!: () => void
    const sending = new Promise<void>((resolve) => {
      entered = resolve
    })
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    await app.register(
      adaptiveFastifyCache({
        cache,
        loader: async () => {
          loaderCalls++
          return 'source'
        },
      }),
    )
    app.addHook('onSend', async (_req, reply, payload) => {
      entered()
      await barrier
      reply.header('content-language', 'en')
      return payload + ':sent'
    })
    app.get('/delayed-send', async () => {
      handlerCalls++
      return 'route'
    })
    let settled = false
    const response = app.inject('/delayed-send').then((result) => {
      settled = true
      return result
    })
    await sending
    expect(settled).toBe(false)
    expect(loaderCalls).toBe(1)
    expect(handlerCalls).toBe(0)
    release()
    const first = await response
    const second = await app.inject('/delayed-send')
    expect(first.payload).toBe('source:sent')
    expect(second.payload).toBe(first.payload)
    expect(second.statusCode).toBe(first.statusCode)
    expect(second.headers['content-type']).toBe(first.headers['content-type'])
    expect(second.headers['content-language']).toBe('en')
    expect(second.headers['x-cache']).toBe('HIT')
    expect(loaderCalls).toBe(1)
    expect(handlerCalls).toBe(0)
    await app.close()
  })

  it('safely bypasses routes declared before Fastify plugin installation', async () => {
    const { cache, backend } = controlledCache()
    const app = Fastify()
    let loaders = 0
    let authenticated = false
    app.register(
      adaptiveFastifyCache({
        cache,
        loader: async () => {
          loaders++
          return 'loader'
        },
      }),
    )
    app.get(
      '/early',
      {
        preHandler: async (_req, reply) => {
          if (!authenticated) return reply.code(401).send('denied')
        },
      },
      async () => 'route',
    )
    expect((await app.inject('/early')).statusCode).toBe(401)
    authenticated = true
    expect((await app.inject('/early')).payload).toBe('route')
    expect(loaders).toBe(0)
    expect(backend.entries.size).toBe(0)
    await app.close()
  })

  for (const framework of ['express', 'fastify'] as const) {
    it(`${framework} isolates authority and clears the selected host only`, async () => {
      const { cache } = controlledCache()
      let calls = 0
      if (framework === 'express') {
        const app = express()
        const adapter = adaptiveExpressCache({
          cache,
          loader: async (req) => ({ host: req.headers?.host, calls: ++calls }),
        })
        app.get('/data', adapter)
        const get = (host: string) => request(app).get('/data').set('Host', host)
        expect((await get('ONE.example:123')).body.host).toBe('ONE.example:123')
        expect((await get('two.example:123')).body.host).toBe('two.example:123')
        await adapter.clear({ originalUrl: '/data', query: {}, headers: { host: 'one.example:123' } })
        expect((await get('two.example:123')).body.calls).toBe(2)
        expect((await get('one.example:123')).body.calls).toBe(3)
      } else {
        const app = Fastify()
        const adapter = adaptiveFastifyCache({
          cache,
          loader: async (req) => ({ host: req.headers?.host, calls: ++calls }),
        })
        await app.register(adapter)
        app.get('/data', async () => 'route')
        const get = (host: string) => app.inject({ url: '/data', headers: { host } })
        expect((await get('ONE.example:123')).json().host).toBe('ONE.example:123')
        expect((await get('two.example:123')).json().host).toBe('two.example:123')
        await adapter.clear({ url: '/data', query: {}, headers: { host: 'one.example:123' } })
        expect((await get('two.example:123')).json().calls).toBe(2)
        expect((await get('one.example:123')).json().calls).toBe(3)
        await app.close()
      }
    })

    it(`${framework} preserves a source exception after a cache read outage without replay`, async () => {
      const { cache, backend } = controlledCache()
      vi.spyOn(backend, 'fetch').mockRejectedValue(new Error('cache offline'))
      const failure = new Error('source rejected during outage')
      const observed: unknown[] = []
      let loaderCalls = 0
      let handlerCalls = 0
      const loader = async () => {
        loaderCalls++
        throw failure
      }
      let status: number
      let diagnostic: unknown
      if (framework === 'express') {
        const app = express()
        app.get('/outage-error', adaptiveExpressCache({ cache, loader }), (_req, res) => {
          handlerCalls++
          res.send('route')
        })
        app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
          observed.push(error)
          res.status(500).send('source failed')
        })
        const response = await request(app).get('/outage-error').set('Host', 'localhost')
        status = response.status
        diagnostic = response.headers['x-cache']
      } else {
        const app = Fastify()
        await app.register(adaptiveFastifyCache({ cache, loader }))
        app.get('/outage-error', async () => {
          handlerCalls++
          return 'route'
        })
        app.setErrorHandler((error, _req, reply) => {
          observed.push(error)
          reply.code(500).send('source failed')
        })
        const response = await app.inject('/outage-error')
        status = response.statusCode
        diagnostic = response.headers['x-cache']
        await app.close()
      }
      expect(status).toBe(500)
      expect(diagnostic).toBe('RETRY')
      expect(loaderCalls).toBe(1)
      expect(handlerCalls).toBe(0)
      expect(observed).toHaveLength(1)
      expect(observed[0]).toBe(failure)
      expect(backend.entries.size).toBe(0)
    })

    for (const failure of ['fetch', 'decode', 'capture', 'update', 'source'] as const) {
      it(`${framework} executes source once during ${failure} failure`, async () => {
        const { cache, backend } = controlledCache()
        if (failure === 'fetch') vi.spyOn(backend, 'fetch').mockRejectedValue(new Error('cache offline'))
        if (failure === 'decode')
          backend.fetchQueue.push({ encodedData: 'adaptive-cache:v2:gzip:invalid-gzip', ttl: 30 })
        if (failure === 'capture') backend.captureError = new Error('token offline')
        if (failure === 'update') vi.spyOn(backend, 'update').mockRejectedValue(new Error('write offline'))
        let calls = 0
        const loader = async () => {
          calls++
          if (failure === 'source') throw new Error('source failed')
          return 'source'
        }
        let status: number
        let body: string
        let diagnostic: unknown
        if (framework === 'express') {
          const app = express()
          app.get('/data', adaptiveExpressCache({ cache, loader }))
          const result = await request(app).get('/data').set('Host', 'localhost')
          status = result.status
          body = result.text
          diagnostic = result.headers['x-cache']
        } else {
          const app = Fastify()
          await app.register(adaptiveFastifyCache({ cache, loader }))
          app.get('/data', async () => 'route')
          const result = await app.inject('/data')
          status = result.statusCode
          body = result.payload
          diagnostic = result.headers['x-cache']
          await app.close()
        }
        expect(calls).toBe(1)
        if (failure === 'source') expect(diagnostic).toBe('MISS')
        expect(status).toBe(failure === 'source' ? 500 : 200)
        expect(body).toContain(failure === 'source' ? 'source failed' : 'source')
      })
    }
  }

  for (const framework of ['express', 'fastify'] as const) {
    it(`${framework} bounds adapter close even with a stalled response write`, async () => {
      const backend = new ControlledBackend()
      let release!: () => void
      const write = new Promise<void>((resolve) => {
        release = resolve
      })
      vi.spyOn(backend, 'update').mockImplementation(async () => {
        await write
        return ['CACHED', 30]
      })
      const app = framework === 'fastify' ? Fastify() : undefined
      const adapter =
        framework === 'fastify'
          ? adaptiveFastifyCache({ backend, compress: false, closeTimeoutMs: 20 })
          : adaptiveExpressCache({ backend, compress: false, closeTimeoutMs: 20 })
      if (app) {
        await app.register(adapter as ReturnType<typeof adaptiveFastifyCache>)
        app.get('/stalled', async () => 'source')
        await app.inject('/stalled')
      } else {
        const expressApp = express()
        expressApp.get('/stalled', adapter as ReturnType<typeof adaptiveExpressCache>, (_req, res) =>
          res.send('source'),
        )
        await request(expressApp).get('/stalled')
      }
      const first = adapter.close()
      const second = adapter.close()
      const outcome = await Promise.race([
        Promise.allSettled([first, second]),
        new Promise<'unbounded'>((resolve) => setTimeout(() => resolve('unbounded'), 200)),
      ])
      release()
      expect(outcome).not.toBe('unbounded')
      expect(first).toBe(second)
      expect(outcome).toMatchObject([
        { status: 'rejected', reason: { name: 'TimeoutError' } },
        { status: 'rejected', reason: { name: 'TimeoutError' } },
      ])
      if (app) await app.close().catch(() => {})
    })
  }

  for (const framework of ['express', 'fastify'] as const) {
    it(`${framework} forwards loader cancellation when the final HTTP caller times out`, async () => {
      const { backend } = controlledCache()
      const cache = new AdaptiveCache({ backend, compress: false, loadTimeoutMs: 20 })
      let observedSignal: AbortSignal | undefined
      let releaseFallback = () => {}
      const fallback = new Promise<void>((resolve) => {
        releaseFallback = resolve
      })
      const loader = async (_req: unknown, context?: { signal: AbortSignal }) => {
        observedSignal = context?.signal
        if (!observedSignal) await fallback
        else if (!observedSignal.aborted)
          await new Promise<void>((resolve) => observedSignal?.addEventListener('abort', () => resolve(), { once: true }))
        return 'late-source'
      }
      let status: number
      if (framework === 'express') {
        const app = express()
        app.get('/cancel-source', adaptiveExpressCache({ cache, loader }))
        status = (await request(app).get('/cancel-source')).status
      } else {
        const app = Fastify()
        await app.register(adaptiveFastifyCache({ cache, loader }))
        app.get('/cancel-source', async () => 'route')
        status = (await app.inject('/cancel-source')).statusCode
        await app.close()
      }
      releaseFallback()
      expect(status).toBe(500)
      expect(observedSignal?.aborted).toBe(true)
    })

    for (const stage of ['read', 'source'] as const) {
      it(`${framework} bounds a stalled ${stage} and never retries after the load deadline`, async () => {
        const { backend } = controlledCache()
        const cache = new AdaptiveCache({ backend, compress: false, loadTimeoutMs: 20 })
        let release!: () => void
        const barrier = new Promise<void>((resolve) => {
          release = resolve
        })
        if (stage === 'read')
          vi.spyOn(backend, 'fetch').mockImplementation(async () => {
            await barrier
            return null
          })
        let calls = 0
        const loader = async () => {
          calls++
          await barrier
          return 'source'
        }
        let response: Promise<{ status: number }>
        let close = async () => {}
        if (framework === 'express') {
          const app = express()
          app.get(
            '/deadline',
            adaptiveExpressCache({ cache, loader, ...(stage === 'read' ? { loadTimeoutMs: 20 } : {}) }),
          )
          response = request(app)
            .get('/deadline')
            .then((result) => ({ status: result.status }))
        } else {
          const app = Fastify()
          await app.register(
            adaptiveFastifyCache({ cache, loader, ...(stage === 'read' ? { loadTimeoutMs: 20 } : {}) }),
          )
          app.get('/deadline', async () => 'route')
          response = app.inject('/deadline').then((result) => ({ status: result.statusCode }))
          close = () => app.close()
        }
        const result = await Promise.race([
          response,
          new Promise<'unbounded'>((resolve) => setTimeout(() => resolve('unbounded'), 200)),
        ])
        release()
        await response
        await close()
        expect(result).not.toBe('unbounded')
        expect(result).toEqual({ status: 500 })
        expect(calls).toBe(stage === 'read' ? 0 : 1)
      })
    }

    it(`${framework} preserves the same source exception for coalesced callers`, async () => {
      const { cache } = controlledCache()
      const failure = new Error('original source failure')
      const observed: unknown[] = []
      let calls = 0
      let release!: () => void
      const barrier = new Promise<void>((resolve) => {
        release = resolve
      })
      const loader = async () => {
        calls++
        await barrier
        throw failure
      }
      let first: Promise<unknown>
      let second: Promise<unknown>
      let close = async () => {}
      if (framework === 'express') {
        const app = express()
        app.get('/shared', adaptiveExpressCache({ cache, loader }))
        app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
          observed.push(error)
          res.status(500).send('failed')
        })
        first = request(app)
          .get('/shared')
          .set('Host', 'localhost')
          .then((result) => result.status)
        second = request(app)
          .get('/shared')
          .set('Host', 'localhost')
          .then((result) => result.status)
      } else {
        const app = Fastify()
        await app.register(adaptiveFastifyCache({ cache, loader }))
        app.get('/shared', async () => 'route')
        app.setErrorHandler((error, _req, reply) => {
          observed.push(error)
          reply.code(500).send('failed')
        })
        first = app.inject('/shared')
        second = app.inject('/shared')
        close = () => app.close()
      }
      await vi.waitFor(() => expect(calls).toBe(1))
      release()
      await Promise.all([first, second])
      await close()
      expect(calls).toBe(1)
      expect(observed).toHaveLength(2)
      expect(observed[0]).toBe(failure)
      expect(observed[1]).toBe(failure)
    })
  }

  it('preserves Express typed binary bytes and headers for handlers and loaders', async () => {
    for (const explicit of [false, true]) {
      const { cache } = controlledCache()
      const app = express()
      let calls = 0
      const body = () => {
        calls++
        return new Uint8Array([0, 1, 255])
      }
      const adapter = adaptiveExpressCache({ cache, ...(explicit ? { loader: async () => body() } : {}) })
      app.get('/binary', adapter, (_req, res) => res.send(body()))
      const first = await request(app).get('/binary').set('Host', 'localhost')
      await adapter.flush()
      const second = await request(app).get('/binary').set('Host', 'localhost')
      expect(first.body).toEqual(Buffer.from([0, 1, 255]))
      expect(second.body).toEqual(first.body)
      expect(second.headers['content-type']).toBe(first.headers['content-type'])
      expect(second.status).toBe(first.status)
      expect(calls).toBe(1)
    }
  })

  it('normalizes typed binary loader bodies and bypasses Fetch Response storage', async () => {
    for (const fetchResponse of [false, true]) {
      const { cache, backend } = controlledCache()
      const app = Fastify()
      let calls = 0
      await app.register(
        adaptiveFastifyCache({
          cache,
          loader: async () => {
            calls++
            return fetchResponse
              ? new globalThis.Response('fetch-body', {
                  status: 202,
                  headers: { 'content-type': 'text/plain', 'content-language': 'en' },
                })
              : new Uint8Array([0, 1, 255])
          },
        }),
      )
      app.get('/data', async () => 'route')
      const first = await app.inject('/data')
      const second = await app.inject('/data')
      expect(second.rawPayload).toEqual(first.rawPayload)
      expect(second.statusCode).toBe(first.statusCode)
      expect(second.headers['content-type']).toBe(first.headers['content-type'])
      expect(second.headers['content-language']).toBe(first.headers['content-language'])
      expect(first.rawPayload).toEqual(fetchResponse ? Buffer.from('fetch-body') : Buffer.from([0, 1, 255]))
      expect(calls).toBe(fetchResponse ? 2 : 1)
      if (fetchResponse) expect(backend.entries.size).toBe(0)
      await app.close()
    }
  })
})
