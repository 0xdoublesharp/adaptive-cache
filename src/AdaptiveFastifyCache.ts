import {
  createHttpLoader,
  HttpSourceError,
  isHttpLoadCancellation,
  unwrapHttpSourceError,
  UNSHAREABLE_HTTP_RESULT,
} from './httpLoader'
import { encodeHttpResponse, decodeHttpResponse, cloneHttpBody, CachedHttpHeaders } from './httpResponse'
import {
  boundedNegativeTTL,
  buildHttpCacheKey,
  HttpPolicyOptions,
  HttpResponseLike,
  isCacheableHttpBody,
  isRequestCacheable,
  isResponseCacheable,
  normalizeHttpBody,
  snapshotHttpResponse,
} from './httpPolicy'
import { AdaptiveCache } from './AdaptiveCache'
import { AdaptiveCacheLoaderContext, AdaptiveCacheLoadOptions, AdaptiveCacheOptions } from './types'

export type FastifyRequestLike = {
  method?: string
  url: string
  query: any
  params?: unknown
  headers?: Record<string, unknown>
  get?: (name: string) => unknown
  header?: (name: string) => unknown
}

export type FastifyReplyLike = HttpResponseLike & {
  sent?: boolean
  header: (name: string, value: any) => FastifyReplyLike
  getHeaders?: () => Record<string, unknown>
  send: (payload?: any) => any
  serializer: (fn: (payload: any) => string) => FastifyReplyLike
}

type FastifyInstanceLike = {
  addHook: (name: 'onRoute' | 'onResponse' | 'onError' | 'onClose', handler: (...args: any[]) => unknown) => unknown
}

export type AdaptiveFastifyCacheOptions<Req extends FastifyRequestLike = FastifyRequestLike> = AdaptiveCacheOptions &
  HttpPolicyOptions<Req> & {
    cache?: AdaptiveCache
    tags?: string[] | ((req: Req) => string[])
    loader?: (req: Req, context: AdaptiveCacheLoaderContext) => Promise<unknown>
  }

export type AdaptiveFastifyCachePlugin<Req extends FastifyRequestLike = FastifyRequestLike> = ((
  instance: FastifyInstanceLike,
  registrationOptions?: { prefix?: string },
) => Promise<void>) & {
  cache: AdaptiveCache
  clear: (req: Req) => Promise<void>
  flush: () => Promise<void>
  close: () => Promise<void>
}

const setCachedHeaders = (reply: FastifyReplyLike, headers?: CachedHttpHeaders) => {
  for (const [name, value] of Object.entries(headers || {})) reply.header(name, value)
}

const cachedResponseView = (response: ReturnType<typeof decodeHttpResponse>): HttpResponseLike => ({
  statusCode: response.statusCode || 200,
  getHeader: (name) => response.headers?.[name.toLowerCase()],
})

// The final status/headers determine storage policy, while each request must
// enter Fastify's serialization and send hooks with the original representation.
const finalizeResponse = (candidate: ReturnType<typeof encodeHttpResponse>, reply: FastifyReplyLike) => ({
  ...encodeHttpResponse(
    decodeHttpResponse(candidate).body,
    reply.statusCode,
    reply.getHeader?.('content-type'),
    reply.getHeaders?.(),
  ),
  fastifyReplay: { statusCode: candidate.statusCode, headers: candidate.headers },
})

const replayResponse = (data: any) => ({
  ...decodeHttpResponse(data),
  ...(data?.__adaptiveCacheHttpResponse === 1 ? data.fastifyReplay : undefined),
})

const captureWriteToken = async (cache: AdaptiveCache): Promise<{ token?: string; writable: boolean }> => {
  if (!cache.supportsWriteFencing()) return { writable: true }
  try {
    return { token: await cache.captureWriteToken(), writable: true }
  } catch (error) {
    cache.logger.warn('adaptiveCache failed to capture write token:', error)
    return { writable: false }
  }
}

const asFastifyPlugin = <Req extends FastifyRequestLike>(plugin: AdaptiveFastifyCachePlugin<Req>) =>
  Object.assign(plugin, {
    [Symbol.for('skip-override')]: true,
    [Symbol.for('fastify.display-name')]: 'adaptive-fastify-cache',
    [Symbol.for('plugin-meta')]: { name: 'adaptive-fastify-cache' },
  })

export const adaptiveFastifyCache = <Req extends FastifyRequestLike = FastifyRequestLike>(
  options: AdaptiveFastifyCacheOptions<Req> = {},
): AdaptiveFastifyCachePlugin<Req> => {
  const {
    redisPrefix = 'adaptive:',
    keyPrefix,
    includeHeaders = true,
    forceRefresh = false,
    tags,
    ignoreQueryParams,
    loader,
  } = options
  const cachePrefix = keyPrefix || redisPrefix
  const owned = !options.cache
  const cacheInstance = options.cache || new AdaptiveCache(options)
  const requestCacheKey = (req: Req) =>
    buildHttpCacheKey({
      req,
      requestPath: req.url.split('?')[0],
      query: req.query,
      cachePrefix,
      ignoreQueryParams,
      key: options.key,
      varyBy: options.varyBy,
    })
  const pendingWrites = new Set<Promise<unknown>>()
  const cacheHits = new WeakSet<FastifyRequestLike>()
  const bypassed = new WeakSet<FastifyRequestLike>()
  const loaderResponses = new WeakSet<FastifyRequestLike>()
  const sendStarted = new WeakSet<FastifyRequestLike>()
  const candidates = new WeakMap<FastifyRequestLike, ReturnType<typeof encodeHttpResponse>>()
  const publications = new WeakMap<FastifyRequestLike, (reply?: FastifyReplyLike) => void>()
  const cacheKeys = new WeakMap<FastifyRequestLike, string>()
  const writeTokens = new WeakMap<FastifyRequestLike, string>()
  let closed = false
  let closePromise: Promise<void> | undefined

  const trackWrite = (promise: Promise<unknown>) => {
    pendingWrites.add(promise)
    const forget = () => pendingWrites.delete(promise)
    void promise.then(forget, forget)
    return promise
  }

  const clear = async (req: Req): Promise<void> => {
    if (owned && closed) throw new Error('HTTP cache adapter is closed')
    const key = requestCacheKey(req)
    if (!key) throw new TypeError('Custom cache key must be a non-empty string')
    await cacheInstance.clear(key)
  }

  const flush = async () => {
    await Promise.allSettled([...pendingWrites])
    await cacheInstance.flush()
  }

  const close = (): Promise<void> => {
    if (!owned) return Promise.resolve()
    if (!closePromise) {
      closed = true
      closePromise = cacheInstance.close()
    }
    return closePromise
  }

  const responseCacheable = (req: Req, response: HttpResponseLike) => {
    try {
      return isResponseCacheable(req, response, options)
    } catch (error) {
      cacheInstance.logger.warn('adaptiveCache response policy failed:', error)
      return false
    }
  }

  const plugin = async (instance: FastifyInstanceLike, registrationOptions: { prefix?: string } = {}) => {
    const prefix = (registrationOptions.prefix || '').replace(/\/$/, '')
    const handleRequest = async (req: Req, reply: FastifyReplyLike) => {
      let cancelPublication = () => {}
      const { loadOnce, wait, remaining } = createHttpLoader(
        (context) => loader!(req, context),
        cacheInstance.resolveLoadTimeoutMs(options),
      )
      const serveBypass = async (diagnostic: 'BYPASS' | 'RETRY' = 'BYPASS') => {
        bypassed.add(req)
        if (includeHeaders || diagnostic === 'RETRY') reply.header('X-Cache', diagnostic)
        if (loader) {
          loaderResponses.add(req)
          try {
            return reply.send(await wait(loadOnce))
          } catch (error) {
            throw unwrapHttpSourceError(error)
          }
        }
      }
      if (req.method && req.method.toUpperCase() !== 'GET') return
      if (owned && closed) return serveBypass()

      let requestEligible: boolean
      try {
        requestEligible = isRequestCacheable(req, options)
      } catch (error) {
        cacheInstance.logger.warn('adaptiveCache request policy failed:', error)
        return serveBypass('RETRY')
      }

      if (!requestEligible) {
        return serveBypass()
      }

      const overrideCache = req.query?.refresh === 'true' || forceRefresh

      try {
        const adaptiveCacheKey = requestCacheKey(req)
        if (!adaptiveCacheKey) return serveBypass()
        cacheKeys.set(req, adaptiveCacheKey)

        if (loader) {
          loaderResponses.add(req)
          let existing = overrideCache
            ? null
            : await wait(() => cacheInstance.get(adaptiveCacheKey, { allowStale: true }))
          if (existing) {
            const cached = decodeHttpResponse(existing.data)
            if (!responseCacheable(req, cachedResponseView(cached))) {
              await wait(() => cacheInstance.clear(adaptiveCacheKey))
              existing = null
            } else if (!existing.stale) {
              const response = replayResponse(existing.data)
              if (includeHeaders) {
                reply.header('X-Cache', 'HIT')
                reply.header('X-Cache-TTL', existing.ttl.toString())
              }
              if (response.statusCode) reply.statusCode = response.statusCode
              setCachedHeaders(reply, response.headers)
              return reply.send(response.body)
            }
          }

          if (includeHeaders) reply.header('X-Cache', overrideCache ? 'BYPASS' : 'MISS')
          const loaderResponse = snapshotHttpResponse(reply)
          let active = true
          let publish!: (value: unknown) => void
          const publication = new Promise<unknown>((resolve) => (publish = resolve))
          cancelPublication = () => {
            active = false
            publications.delete(req)
            publish(UNSHAREABLE_HTTP_RESULT)
          }
          const loadOptions: AdaptiveCacheLoadOptions<unknown> = {
            maxTTL: (data) => {
              const response = decodeHttpResponse(data)
              const value = cacheInstance.resolveMaxTTL(response.body, { maxTTL: options.maxTTL })
              return response.statusCode === 404 ? boundedNegativeTTL(options.negativeTTL, value) : value
            },
            tags: Array.isArray(tags) ? tags : typeof tags === 'function' ? tags(req) : [],
            // A background result cannot pass this request's final response
            // hooks after its stale response has already been sent.
            staleWhileRevalidate: 0,
            staleIfError: options.staleIfError,
            negativeTTL: options.negativeTTL,
            isNegative: (data) => decodeHttpResponse(data).statusCode === 404,
            forceRefresh: overrideCache,
            lockWaitTimeoutMs: options.lockWaitTimeoutMs,
            loadTimeoutMs: remaining(),
            shouldStore: (data: unknown) =>
              data !== UNSHAREABLE_HTTP_RESULT && responseCacheable(req, cachedResponseView(decodeHttpResponse(data))),
          }
          const value = await cacheInstance.getOrSet(
            adaptiveCacheKey,
            async (context) => {
              const body = await loadOnce(context)
              if (!active || !responseCacheable(req, loaderResponse) || !isCacheableHttpBody(body))
                return UNSHAREABLE_HTTP_RESULT
              const candidate = encodeHttpResponse(
                cloneHttpBody(body),
                loaderResponse.statusCode,
                loaderResponse.getHeader('content-type'),
                loaderResponse.headers,
              )
              publications.set(req, (finalReply) => {
                publications.delete(req)
                publish(
                  active && finalReply && responseCacheable(req, finalReply)
                    ? finalizeResponse(candidate, finalReply)
                    : UNSHAREABLE_HTTP_RESULT,
                )
              })
              // Start sending without awaiting the thenable reply. onResponse
              // approves publication only after every serialization/send hook.
              sendStarted.add(req)
              try {
                reply.send(cloneHttpBody(decodeHttpResponse(candidate).body))
              } catch (error) {
                sendStarted.delete(req)
                cancelPublication()
                throw new HttpSourceError(error)
              }
              return publication
            },
            loadOptions,
          )
          if (sendStarted.has(req)) return reply
          if (value === UNSHAREABLE_HTTP_RESULT) return reply.send(await wait(loadOnce))
          const response = decodeHttpResponse(value)
          if (!responseCacheable(req, cachedResponseView(response))) {
            await wait(() => cacheInstance.clear(adaptiveCacheKey))
            return reply.send(await wait(loadOnce))
          }
          const replay = replayResponse(value)
          if (replay.statusCode) reply.statusCode = replay.statusCode
          setCachedHeaders(reply, replay.headers)
          return reply.send(cloneHttpBody(replay.body))
        }

        const result = await wait(() => cacheInstance.get(adaptiveCacheKey))
        if (result && !overrideCache) {
          const response = decodeHttpResponse(result.data)
          if (responseCacheable(req, cachedResponseView(response))) {
            const replay = replayResponse(result.data)
            if (includeHeaders) {
              reply.header('X-Cache', 'HIT')
              reply.header('X-Cache-TTL', result.ttl.toString())
            }
            if (result.metadata) {
              reply.header('X-Cache-Data-TTL', result.metadata.dataTTL)
              reply.header('X-Cache-Last-Modified', result.metadata.lastChanged || 'unknown')
              reply.header('X-Cache-Refreshed', result.metadata.changeCount)
            }
            if (replay.statusCode) reply.statusCode = replay.statusCode
            setCachedHeaders(reply, replay.headers)
            cacheHits.add(req)
            return reply.send(replay.body)
          }
        }

        if (includeHeaders) reply.header('X-Cache', overrideCache ? 'BYPASS' : 'MISS')
        const writeFence = await wait(() => captureWriteToken(cacheInstance))
        if (!writeFence.writable) {
          bypassed.add(req)
          return
        }
        if (writeFence.token !== undefined) writeTokens.set(req, writeFence.token)
      } catch (error) {
        cancelPublication()
        if (sendStarted.has(req)) return reply
        if (loader && (error instanceof HttpSourceError || isHttpLoadCancellation(error)))
          throw unwrapHttpSourceError(error)
        cacheInstance.logger.warn('adaptiveCache failed to fetch data:', error)
        reply.header('X-Cache', 'RETRY')
        bypassed.add(req)
        if (loader) {
          try {
            return reply.send(await wait(loadOnce))
          } catch (sourceError) {
            throw unwrapHttpSourceError(sourceError)
          }
        }
      }
    }

    instance.addHook(
      'onRoute',
      (route: { url: string; method: string | string[]; handler: (this: unknown, ...args: any[]) => unknown }) => {
        if (prefix && route.url !== prefix && !route.url.startsWith(prefix + '/')) return
        const originalHandler = route.handler
        route.handler = async function (req: Req, reply: FastifyReplyLike) {
          await handleRequest(req, reply)
          if (reply.sent || sendStarted.has(req)) return reply
          // A serializer installed by the skipped handler would be absent on
          // hits. Preserve its output by leaving this response uncached.
          const serializer = reply.serializer
          reply.serializer = function (fn) {
            bypassed.add(req)
            return serializer.call(this, fn)
          }
          const send = reply.send
          reply.send = function (body: unknown) {
            reply.send = send
            if (cacheKeys.has(req) && !bypassed.has(req) && isCacheableHttpBody(body)) {
              const candidate = encodeHttpResponse(
                cloneHttpBody(normalizeHttpBody(body)),
                reply.statusCode,
                reply.getHeader?.('content-type'),
                reply.getHeaders?.(),
              )
              candidates.set(req, candidate)
              body = cloneHttpBody(decodeHttpResponse(candidate).body)
            }
            return send.call(this, body)
          }
          return originalHandler.call(this, req, reply)
        }
      },
    )

    instance.addHook('onError', async (req: Req) => {
      bypassed.add(req)
      publications.get(req)?.()
    })

    instance.addHook('onResponse', async (req: Req, reply: FastifyReplyLike) => {
      publications.get(req)?.(reply)
      if (req.method && req.method.toUpperCase() !== 'GET') return
      if (cacheHits.has(req) || bypassed.has(req) || loaderResponses.has(req)) return
      const candidate = candidates.get(req)
      if (!candidate) return
      const adaptiveCacheKey = cacheKeys.get(req)
      if (!adaptiveCacheKey || !responseCacheable(req, reply)) return

      const response = finalizeResponse(candidate, reply)
      const update = async () => {
        const payload = decodeHttpResponse(candidate).body
        let body = payload
        if (typeof payload === 'string') {
          try {
            body = JSON.parse(payload)
          } catch {
            // Plain text stays plain text for dynamic TTL callbacks.
          }
        }
        let currentMaxTTL = cacheInstance.resolveMaxTTL(body, { maxTTL: options.maxTTL })
        if (typeof options.maxTTL === 'function') cacheInstance.logger.debug('Overriding maxTTL:', currentMaxTTL)
        if (reply.statusCode === 404) {
          currentMaxTTL = boundedNegativeTTL(options.negativeTTL, currentMaxTTL) as number
        }
        const requestTags = Array.isArray(tags) ? tags : typeof tags === 'function' ? tags(req) : []
        await cacheInstance.set(adaptiveCacheKey, response, {
          maxTTL: currentMaxTTL,
          tags: requestTags,
          writeToken: writeTokens.get(req),
          ...(reply.statusCode === 404 ? { staleTTL: 0 } : {}),
        })
      }
      trackWrite(update().catch((error) => cacheInstance.logger.error('Cache update failed:', error)))
    })

    instance.addHook('onClose', close)
  }

  return asFastifyPlugin(Object.assign(plugin, { cache: cacheInstance, clear, flush, close }))
}
