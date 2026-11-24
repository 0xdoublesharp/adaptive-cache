import {
  createHttpLoader,
  HttpSourceError,
  isHttpLoadCancellation,
  unwrapHttpSourceError,
  UNSHAREABLE_HTTP_RESULT,
} from './httpLoader'
import {
  encodeHttpResponse,
  decodeHttpResponse,
  cloneHttpBody,
  CachedHttpHeaders,
  HttpResponseTransport,
  watchHttpResponse,
} from './httpResponse'
import {
  boundedNegativeTTL,
  buildHttpCacheKey,
  hasCacheableResponseHeaders,
  HttpPolicyOptions,
  HttpResponseLike,
  isCacheableHttpBody,
  isRequestCacheable,
  isResponseCacheable,
  snapshotHttpResponse,
  normalizeHttpBody,
} from './httpPolicy'
import { AdaptiveCache } from './AdaptiveCache'
import { getDefaultCache } from './singleton'
import { getAdaptiveCacheKey } from './utils'
import {
  AdaptiveCacheBackend,
  AdaptiveCacheHit,
  AdaptiveCacheLoaderContext,
  AdaptiveCacheLoadOptions,
  AdaptiveCacheOptions,
} from './types'

export type ExpressRequestLike = {
  method?: string
  originalUrl: string
  query: any
  params?: Record<string, string | string[]>
  headers?: Record<string, unknown>
  get?: (name: string) => unknown
  header?: (name: string) => unknown
}

export type ExpressResponseLike = HttpResponseLike &
  Partial<HttpResponseTransport> & {
    getHeaders?: () => Record<string, unknown>
    send: (body: any) => any
    set: (field: string, value: any) => any
    end?: (...args: any[]) => any
    write?: (...args: any[]) => any
  }

type ExpressNextFunctionLike = (err?: unknown) => void

export type AdaptiveExpressCacheOptions<Req extends ExpressRequestLike = ExpressRequestLike> = AdaptiveCacheOptions &
  HttpPolicyOptions<Req> & {
    cache?: AdaptiveCache
    tags?: string[] | ((req: Req) => string[])
    loader?: (req: Req, context: AdaptiveCacheLoaderContext) => Promise<unknown>
  }

export type AdaptiveExpressCacheMiddleware<Req extends ExpressRequestLike = ExpressRequestLike> = ((
  req: ExpressRequestLike,
  res: ExpressResponseLike,
  next: ExpressNextFunctionLike,
) => Promise<unknown>) & {
  cache: AdaptiveCache
  clear: (req: Req) => Promise<void>
  flush: () => Promise<void>
  close: () => Promise<void>
}

const parseJsonBody = (body: any) => {
  if (typeof body !== 'string') return body
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

const shouldShareDefaultRedisClient = (options: AdaptiveCacheOptions) =>
  !options.backend || options.backend === 'redis' || options.backend === 'l1-redis'

// Temporary invalidators own their observer, but borrow the caller's backend.
const borrowBackend = (backend: AdaptiveCacheBackend): AdaptiveCacheBackend =>
  new Proxy({} as AdaptiveCacheBackend, {
    get(_target, property) {
      if (property === 'quit' || property === 'flush') return undefined
      const value = Reflect.get(backend, property, backend)
      return typeof value === 'function' ? value.bind(backend) : value
    },
  })

const setCachedHeaders = (res: ExpressResponseLike, headers?: CachedHttpHeaders) => {
  for (const [name, value] of Object.entries(headers || {})) res.set(name, value)
}

const setHitHeaders = (res: ExpressResponseLike, includeHeaders: boolean, hit: AdaptiveCacheHit<unknown>) => {
  if (includeHeaders) {
    res.set('X-Cache', 'HIT')
    res.set('X-Cache-TTL', hit.ttl.toString())
  }
  if (hit.metadata) {
    res.set('X-Cache-Data-TTL', hit.metadata.dataTTL)
    res.set('X-Cache-Last-Modified', hit.metadata.lastChanged || 'unknown')
    res.set('X-Cache-Refreshed', hit.metadata.changeCount)
  }
}

const cachedResponseView = (response: ReturnType<typeof decodeHttpResponse>): HttpResponseLike => ({
  statusCode: response.statusCode || 200,
  getHeader: (name) => response.headers?.[name.toLowerCase()],
})

const responseHeaders = (res: ExpressResponseLike, contentEncoding: unknown) => {
  const headers = { ...res.getHeaders?.() }
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === 'content-encoding') delete headers[name]
  }
  if (contentEncoding !== undefined) headers['content-encoding'] = contentEncoding
  return headers
}

const captureWriteToken = async (cache: AdaptiveCache): Promise<{ token?: string; writable: boolean }> => {
  if (!cache.supportsWriteFencing()) return { writable: true }
  try {
    return { token: await cache.captureWriteToken(), writable: true }
  } catch (error) {
    cache.logger.warn('adaptiveCache failed to capture write token:', error)
    return { writable: false }
  }
}

export const adaptiveExpressCache = <Req extends ExpressRequestLike = ExpressRequestLike>(
  options: AdaptiveExpressCacheOptions<Req> = {},
): AdaptiveExpressCacheMiddleware<Req> => {
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
      requestPath: req.originalUrl.split('?')[0],
      query: req.query,
      cachePrefix,
      ignoreQueryParams,
      key: options.key,
      varyBy: options.varyBy,
    })
  const pendingWrites = new Set<Promise<unknown>>()
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
      cacheInstance.logger.error('adaptiveCache response policy failed:', error)
      return false
    }
  }

  const middleware = async (req: any, res: ExpressResponseLike, next: ExpressNextFunctionLike) => {
    const method = req.method?.toUpperCase()
    if (method && method !== 'GET' && !(loader && method === 'HEAD')) return next()
    const transport =
      loader && res.prependOnceListener ? watchHttpResponse(res as HttpResponseTransport, res) : undefined
    const { loadOnce, wait, remaining, signal, expire } = createHttpLoader(
      (context) => loader!(req, context),
      cacheInstance.resolveLoadTimeoutMs(options),
      transport?.signal,
    )
    const serveBypass = async (diagnostic: 'BYPASS' | 'RETRY' = 'BYPASS') => {
      if (includeHeaders || diagnostic === 'RETRY') res.set('X-Cache', diagnostic)
      if (!loader) return next()
      try {
        return res.send(await wait(loadOnce))
      } catch (error) {
        return next(unwrapHttpSourceError(error))
      }
    }
    if (owned && closed) return serveBypass()

    const allowsReplay = () => hasCacheableResponseHeaders(res, options.varyBy)
    let requestEligible: boolean
    try {
      requestEligible = isRequestCacheable(req, options)
    } catch (error) {
      cacheInstance.logger.error('adaptiveCache request policy failed:', error)
      return serveBypass('RETRY')
    }
    if (!requestEligible || !allowsReplay()) {
      return serveBypass()
    }

    const overrideCache = req.query?.refresh === 'true' || forceRefresh
    const originalSend = res.send
    let sendStarted = false

    try {
      const adaptiveCacheKey = requestCacheKey(req)
      if (!adaptiveCacheKey) return serveBypass()

      if (loader) {
        const existing = overrideCache
          ? null
          : await wait(() => cacheInstance.get(adaptiveCacheKey, { allowStale: true }))
        if (existing) {
          const cached = decodeHttpResponse(existing.data)
          if (!responseCacheable(req, cachedResponseView(cached))) {
            await wait(() => cacheInstance.clear(adaptiveCacheKey))
          } else if (!existing.stale) {
            if (!allowsReplay()) return serveBypass()
            setHitHeaders(res, includeHeaders, existing)
            if (cached.statusCode) res.statusCode = cached.statusCode
            setCachedHeaders(res, cached.headers)
            return res.send(cached.body)
          }
        }

        if (includeHeaders) res.set('X-Cache', overrideCache ? 'BYPASS' : 'MISS')
        let background = false
        let storeAllowed = true
        const loaderResponse = snapshotHttpResponse(res)
        const loadOptions: AdaptiveCacheLoadOptions<unknown> = {
          maxTTL: (data) => {
            const response = decodeHttpResponse(data)
            const value = cacheInstance.resolveMaxTTL(cloneHttpBody(response.body), { maxTTL: options.maxTTL })
            return response.statusCode === 404 ? boundedNegativeTTL(options.negativeTTL, value) : value
          },
          tags: Array.isArray(tags) ? tags : typeof tags === 'function' ? tags(req) : [],
          staleWhileRevalidate: options.staleWhileRevalidate,
          staleIfError: options.staleIfError,
          negativeTTL: options.negativeTTL,
          isNegative: (data) => decodeHttpResponse(data).statusCode === 404,
          forceRefresh: overrideCache,
          lockWaitTimeoutMs: options.lockWaitTimeoutMs,
          loadTimeoutMs: remaining(),
          signal,
          shouldStore: (data: unknown) =>
            storeAllowed &&
            data !== UNSHAREABLE_HTTP_RESULT &&
            responseCacheable(req, cachedResponseView(decodeHttpResponse(data))),
        }
        const value = await wait(() => {
          if (!allowsReplay()) return Promise.resolve(UNSHAREABLE_HTTP_RESULT)
          return cacheInstance
            .getOrSet(
              adaptiveCacheKey,
              async (context) => {
                const body = await loadOnce(context)
                if (!responseCacheable(req, loaderResponse) || !isCacheableHttpBody(body))
                  return UNSHAREABLE_HTTP_RESULT
                const candidate = cloneHttpBody(body)
                // Core resolves a detached SWR call with stale data before the
                // refresh can publish. That response belongs to the stale hit.
                if (!allowsReplay()) return UNSHAREABLE_HTTP_RESULT
                expire()
                if (background || signal.aborted) {
                  // A surviving waiter may use the source after the initiating
                  // client is gone. Only a completed foreground send or a
                  // detached refresh can populate the cache.
                  storeAllowed = background
                  return encodeHttpResponse(
                    candidate,
                    loaderResponse.statusCode,
                    loaderResponse.getHeader('content-type'),
                    loaderResponse.headers,
                  )
                }
                const contentEncoding = res.getHeader?.('content-encoding')
                sendStarted = true
                try {
                  res.send(cloneHttpBody(candidate))
                } catch (error) {
                  sendStarted = false
                  throw new HttpSourceError(error)
                }
                if (transport && !(await transport.completion)) return UNSHAREABLE_HTTP_RESULT
                if (!responseCacheable(req, res)) return UNSHAREABLE_HTTP_RESULT
                return encodeHttpResponse(
                  candidate,
                  res.statusCode,
                  res.getHeader?.('content-type'),
                  responseHeaders(res, contentEncoding),
                )
              },
              loadOptions,
            )
            .then((value) => {
              background = true
              return value
            })
        })
        if (sendStarted) return res
        if (!allowsReplay()) return serveBypass()
        if (value === UNSHAREABLE_HTTP_RESULT) return res.send(await wait(loadOnce))
        const response = decodeHttpResponse(value)
        if (!responseCacheable(req, cachedResponseView(response))) {
          await wait(() => cacheInstance.clear(adaptiveCacheKey))
          return res.send(await wait(loadOnce))
        }
        if (response.statusCode) res.statusCode = response.statusCode
        setCachedHeaders(res, response.headers)
        return res.send(cloneHttpBody(response.body))
      }

      const result = await wait(() => cacheInstance.get(adaptiveCacheKey))
      if (!allowsReplay()) return serveBypass()
      let hitFailed = false
      if (result && !overrideCache) {
        try {
          const response = decodeHttpResponse(result.data)
          if (responseCacheable(req, cachedResponseView(response))) {
            setHitHeaders(res, includeHeaders, result)
            if (response.statusCode) res.statusCode = response.statusCode
            setCachedHeaders(res, response.headers)
            return result.data?.__adaptiveCacheHttpResponse === 1 && result.data.expressEnd === true
              ? res.end!(response.body)
              : res.send(response.body)
          }
        } catch (error) {
          cacheInstance.logger.warn('adaptiveCache failed to fetch data:', error)
          res.set('X-Cache', 'RETRY')
          hitFailed = true
        }
      }

      if (includeHeaders && !hitFailed) res.set('X-Cache', overrideCache ? 'BYPASS' : 'MISS')
      const writeFence = await wait(() => captureWriteToken(cacheInstance))
      if (!writeFence.writable) return next()

      const capture = (body: unknown, contentEncoding: unknown, expressEnd?: true) => {
        if (!isCacheableHttpBody(body) || !responseCacheable(req, res)) return
        const response = {
          ...encodeHttpResponse(
            body,
            res.statusCode,
            res.getHeader?.('content-type'),
            responseHeaders(res, contentEncoding),
          ),
          ...(expressEnd ? { expressEnd } : {}),
        }
        const update = async () => {
          let currentMaxTTL = cacheInstance.resolveMaxTTL(cloneHttpBody(parseJsonBody(body)), {
            maxTTL: options.maxTTL,
          })
          if (typeof options.maxTTL === 'function') cacheInstance.logger.debug('Overriding maxTTL:', currentMaxTTL)
          if (res.statusCode === 404) {
            currentMaxTTL = boundedNegativeTTL(options.negativeTTL, currentMaxTTL) as number
          }
          const requestTags = Array.isArray(tags) ? tags : typeof tags === 'function' ? tags(req) : []
          await cacheInstance.set(adaptiveCacheKey, response, {
            maxTTL: currentMaxTTL,
            tags: requestTags,
            writeToken: writeFence.token,
            ...(res.statusCode === 404 ? { staleTTL: 0 } : {}),
          })
        }
        trackWrite(update().catch((error) => cacheInstance.logger.error('Cache update failed:', error)))
      }

      let viaSend = false
      res.send = function (body: any) {
        res.send = originalSend
        viaSend = true
        body = normalizeHttpBody(body)
        const contentEncoding = res.getHeader?.('content-encoding')
        const sent = originalSend.call(res, body)
        capture(body, contentEncoding)
        return sent
      }

      const { end, write } = res
      if (end && write) {
        let streamed = false
        res.prependOnceListener?.('pipe', () => {
          streamed = true
        })
        res.write = function (...args: any[]) {
          streamed = true
          return write.apply(this, args)
        }
        res.end = function (chunk: unknown, ...args: any[]) {
          res.end = end
          res.write = write
          const contentEncoding = res.getHeader?.('content-encoding')
          const ended = end.call(this, chunk, ...args)
          if (!streamed && !viaSend && (typeof chunk === 'string' || chunk instanceof Uint8Array)) {
            const body = typeof chunk === 'string' && Buffer.isEncoding(args[0]) ? Buffer.from(chunk, args[0]) : chunk
            capture(body, contentEncoding, true)
          }
          return ended
        }
      }

      return next()
    } catch (error) {
      if (sendStarted) return res
      if (loader && (error instanceof HttpSourceError || isHttpLoadCancellation(error)))
        return next(unwrapHttpSourceError(error))
      cacheInstance.logger.error('adaptiveCache failed:', error)
      res.set('X-Cache', 'RETRY')
      if (!loader) return next()
      try {
        return originalSend.call(res, await wait(loadOnce))
      } catch (sourceError) {
        return next(unwrapHttpSourceError(sourceError))
      }
    }
  }

  return Object.assign(middleware, { cache: cacheInstance, clear, flush, close })
}

export const clearAdaptiveCache = async (
  requestPath: string,
  querystring: any,
  redisPrefix = 'adaptive:',
  options: AdaptiveCacheOptions = {},
  authority?: string,
) => {
  const cachePrefix = options.keyPrefix || redisPrefix
  const adaptiveCacheKey = getAdaptiveCacheKey(
    requestPath,
    querystring,
    cachePrefix,
    options.ignoreQueryParams,
    authority,
  )
  const needsScopedWrapper = Boolean(options.backend) || cachePrefix !== 'adaptive:'
  const cache = needsScopedWrapper
    ? new AdaptiveCache(
        {
          ...options,
          backend:
            options.backend && typeof options.backend === 'object' ? borrowBackend(options.backend) : options.backend,
          keyPrefix: cachePrefix,
          redisPrefix: cachePrefix,
          lru: { ...options.lru, localL1: false },
        },
        shouldShareDefaultRedisClient(options) ? getDefaultCache().client : undefined,
      )
    : getDefaultCache()

  let failure: { error: unknown } | undefined
  try {
    await cache.clear(adaptiveCacheKey)
  } catch (error) {
    failure = { error }
  }
  if (needsScopedWrapper) {
    try {
      await cache.quit(true)
    } catch (error) {
      failure ??= { error }
    }
  }
  if (failure) throw failure.error
}
