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
  snapshotHttpResponse,
  normalizeHttpBody,
} from './httpPolicy'
import { AdaptiveCache } from './AdaptiveCache'
import { getDefaultCache } from './singleton'
import { getAdaptiveCacheKey } from './utils'
import {
  AdaptiveCacheBackend,
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

export type ExpressResponseLike = HttpResponseLike & {
  getHeaders?: () => Record<string, unknown>
  send: (body: any) => any
  set: (field: string, value: any) => any
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

const cachedResponseView = (response: ReturnType<typeof decodeHttpResponse>): HttpResponseLike => ({
  statusCode: response.statusCode || 200,
  getHeader: (name) => response.headers?.[name.toLowerCase()],
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
    const { loadOnce, wait, remaining } = createHttpLoader(
      (context) => loader!(req, context),
      cacheInstance.resolveLoadTimeoutMs(options),
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
    if (req.method && req.method.toUpperCase() !== 'GET') return next()
    if (owned && closed) return serveBypass()

    let requestEligible: boolean
    try {
      requestEligible = isRequestCacheable(req, options)
    } catch (error) {
      cacheInstance.logger.error('adaptiveCache request policy failed:', error)
      return serveBypass('RETRY')
    }
    if (!requestEligible) {
      return serveBypass()
    }

    const overrideCache = req.query?.refresh === 'true' || forceRefresh
    const originalSend = res.send

    try {
      const adaptiveCacheKey = requestCacheKey(req)
      if (!adaptiveCacheKey) return serveBypass()

      if (loader) {
        let existing = overrideCache
          ? null
          : await wait(() => cacheInstance.get(adaptiveCacheKey, { allowStale: true }))
        if (existing) {
          const cached = decodeHttpResponse(existing.data)
          if (!responseCacheable(req, cachedResponseView(cached))) {
            await wait(() => cacheInstance.clear(adaptiveCacheKey))
            existing = null
          } else if (!existing.stale) {
            if (includeHeaders) {
              res.set('X-Cache', 'HIT')
              res.set('X-Cache-TTL', existing.ttl.toString())
            }
            if (cached.statusCode) res.statusCode = cached.statusCode
            setCachedHeaders(res, cached.headers)
            return res.send(cached.body)
          }
        }

        if (includeHeaders) res.set('X-Cache', overrideCache ? 'BYPASS' : 'MISS')
        let loadedThisRequest = false
        let loaderStoreAllowed = true
        let loaderBodyCacheable = true
        const loaderResponse = snapshotHttpResponse(res)
        const loadOptions: AdaptiveCacheLoadOptions<unknown> = {
          maxTTL: (data) => {
            const response = decodeHttpResponse(data)
            const value = cacheInstance.resolveMaxTTL(response.body, { maxTTL: options.maxTTL })
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
          shouldStore: (data: unknown) =>
            loaderBodyCacheable &&
            loaderStoreAllowed &&
            responseCacheable(req, cachedResponseView(decodeHttpResponse(data))),
        }
        const value = await cacheInstance.getOrSet(
          adaptiveCacheKey,
          async (context) => {
            const body = await loadOnce(context)
            loadedThisRequest = true
            loaderStoreAllowed = responseCacheable(req, loaderResponse)
            if (!loaderStoreAllowed) return UNSHAREABLE_HTTP_RESULT
            loaderBodyCacheable = isCacheableHttpBody(body)
            if (!loaderBodyCacheable) return UNSHAREABLE_HTTP_RESULT
            return encodeHttpResponse(
              cloneHttpBody(body),
              loaderResponse.statusCode,
              loaderResponse.getHeader('content-type'),
              loaderResponse.headers,
            )
          },
          loadOptions,
        )
        if (value === UNSHAREABLE_HTTP_RESULT) return res.send(await wait(loadOnce))
        const response = decodeHttpResponse(value)
        if (!responseCacheable(req, cachedResponseView(response)) && !loadedThisRequest) {
          await wait(() => cacheInstance.clear(adaptiveCacheKey))
          return res.send(await wait(loadOnce))
        }
        if (response.statusCode) res.statusCode = response.statusCode
        setCachedHeaders(res, response.headers)
        return res.send(cloneHttpBody(response.body))
      }

      const result = await wait(() => cacheInstance.get(adaptiveCacheKey))
      let hitFailed = false
      if (result && !overrideCache) {
        try {
          const response = decodeHttpResponse(result.data)
          if (responseCacheable(req, cachedResponseView(response))) {
            if (includeHeaders) {
              res.set('X-Cache', 'HIT')
              res.set('X-Cache-TTL', result.ttl.toString())
            }
            if (result.metadata) {
              res.set('X-Cache-Data-TTL', result.metadata.dataTTL)
              res.set('X-Cache-Last-Modified', result.metadata.lastChanged || 'unknown')
              res.set('X-Cache-Refreshed', result.metadata.changeCount)
            }
            if (response.statusCode) res.statusCode = response.statusCode
            setCachedHeaders(res, response.headers)
            return res.send(response.body)
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

      res.send = function (body: any) {
        res.send = originalSend
        body = normalizeHttpBody(body)
        const originalContentEncoding = res.getHeader?.('content-encoding')
        const sent = originalSend.call(res, body)
        if (!isCacheableHttpBody(body) || !responseCacheable(req, res)) return sent

        const responseHeaders = { ...res.getHeaders?.() }
        for (const name of Object.keys(responseHeaders)) {
          if (name.toLowerCase() === 'content-encoding') delete responseHeaders[name]
        }
        if (originalContentEncoding !== undefined) responseHeaders['content-encoding'] = originalContentEncoding
        const response = encodeHttpResponse(body, res.statusCode, res.getHeader?.('content-type'), responseHeaders)
        const update = async () => {
          let currentMaxTTL = cacheInstance.resolveMaxTTL(parseJsonBody(body), { maxTTL: options.maxTTL })
          if (typeof options.maxTTL === 'function') cacheInstance.logger.debug('Overriding maxTTL:', currentMaxTTL)
          if (res.statusCode === 404) {
            currentMaxTTL = boundedNegativeTTL(options.negativeTTL, currentMaxTTL) as number
          }
          const requestTags = Array.isArray(tags) ? tags : typeof tags === 'function' ? tags(req) : []
          await cacheInstance.set(adaptiveCacheKey, response, {
            maxTTL: currentMaxTTL,
            tags: requestTags,
            writeToken: writeFence.token,
          })
        }
        trackWrite(update().catch((error) => cacheInstance.logger.error('Cache update failed:', error)))
        return sent
      }

      return next()
    } catch (error) {
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
