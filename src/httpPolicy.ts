import crypto from 'node:crypto'
import { types as utilTypes } from 'node:util'
import { getAdaptiveCacheKey } from './utils'

export type HttpRequestLike = {
  method?: string
  headers?: Record<string, unknown>
  get?: (name: string) => unknown
  header?: (name: string) => unknown
}

export type HttpResponseLike = {
  statusCode: number
  getHeader?: (name: string) => unknown
  getHeaders?: () => Record<string, unknown>
}

export const snapshotHttpResponse = (response: HttpResponseLike) => {
  const headers = Object.entries(response.getHeaders?.() || {}).reduce<Record<string, unknown>>(
    (normalized, [name, value]) => {
      normalized[normalizeHeaderName(name)] = Array.isArray(value) ? [...value] : value
      return normalized
    },
    Object.create(null),
  )
  return {
    statusCode: response.statusCode,
    headers,
    getHeaders: () => headers,
    getHeader: (name: string) => headers[normalizeHeaderName(name)],
  }
}

export const normalizeHttpBody = (body: unknown): any =>
  !Buffer.isBuffer(body) && ArrayBuffer.isView(body) ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : body

const getTypedArrayLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'length')!.get!

const isPlainHttpBody = (body: unknown, seen: Set<object>): boolean => {
  if (body === undefined) return seen.size === 0
  if (body === null || typeof body === 'string' || typeof body === 'boolean') return true
  if (typeof body === 'number') return Number.isFinite(body) && !Object.is(body, -0)
  if (typeof body !== 'object' || utilTypes.isProxy(body) || !Object.isExtensible(body)) return false
  if (ArrayBuffer.isView(body)) {
    // Only bare top-level byte transports have a replayable binary envelope.
    // Nested views use JSON conversion; copying can lose their redaction or
    // metadata, and JSON storage cannot retain their native type on a hit.
    // Read the intrinsic length; subclasses can override the public accessor.
    // DataView has no indexed elements, so any own numeric key is metadata.
    const length = utilTypes.isDataView(body) ? 0 : getTypedArrayLength.call(body)
    return (
      seen.size === 0 &&
      (!Buffer.isBuffer(body) || Object.getPrototypeOf(body) === Buffer.prototype) &&
      // Check bounds too: large digit-only names can be ordinary metadata.
      Reflect.ownKeys(body).every(
        (name) => typeof name === 'string' && /^(0|[1-9]\d*)$/.test(name) && Number(name) < length,
      )
    )
  }
  const array = Array.isArray(body)
  if (Object.getPrototypeOf(body) !== (array ? Array.prototype : Object.prototype)) return false
  if (seen.has(body)) return false
  seen.add(body)
  // Inspect without invoking getters. Hidden metadata, accessors, and custom
  // JSON conversion cannot be preserved by a plain JSON cache representation.
  const descriptors = Object.getOwnPropertyDescriptors(body)
  const names = Reflect.ownKeys(descriptors)
  const cacheable = names.every((name) => {
    const descriptor = descriptors[name as keyof typeof descriptors]
    if (typeof name !== 'string' || !('value' in descriptor)) return false
    if (array && name === 'length') return descriptor.writable
    if (!descriptor.enumerable || !descriptor.writable || !descriptor.configurable) return false
    if (array && (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= descriptors.length.value)) return false
    return isPlainHttpBody(descriptor.value, seen)
  })
  // JSON fills array holes with null and duplicates shared object references.
  // Both can change how later framework hooks interpret the cached body.
  return cacheable && (!array || names.length === descriptors.length.value + 1)
}

export const isCacheableHttpBody = (body: unknown): boolean => {
  try {
    return isPlainHttpBody(body, new Set())
  } catch {
    // Inspection is optional. Deep values may still be handled successfully by
    // the framework's serializer or preSerialization hooks.
    return false
  }
}

export type HttpPolicyOptions<Req extends HttpRequestLike = HttpRequestLike> = {
  key?: (req: Req) => string
  varyBy?: string[] | ((req: Req) => unknown)
  shouldCache?: (req: Req, response?: HttpResponseLike) => boolean
  cacheAuthenticated?: boolean
  cacheCookies?: boolean
  negativeTTL?: number
}

const normalizeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeValue)
  if (!value || typeof value !== 'object') return value
  if (Buffer.isBuffer(value)) return value.toString('base64')

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((normalized, key) => {
      normalized[key] = normalizeValue((value as Record<string, unknown>)[key])
      return normalized
    }, Object.create(null))
}

const digest = (value: string | unknown[]) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(normalizeValue(value)))
    .digest('hex')

// Retain the legacy JSON preimage for supported values. Typed extensions use
// tokens outside JSON so an ordinary string or object cannot impersonate them.
const serializeVariation = (value: unknown, ancestors = new Set<object>()): string | undefined => {
  if (value === undefined) return undefined
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (typeof value !== 'object' || utilTypes.isProxy(value) || ancestors.has(value))
    throw new TypeError('Unsupported HTTP cache variation')
  const prototype = Object.getPrototypeOf(value)
  if (prototype === Buffer.prototype) return JSON.stringify(Buffer.prototype.toString.call(value, 'base64'))
  if (prototype === Uint8Array.prototype)
    return `bytes(${JSON.stringify(Buffer.from(value as Uint8Array).toString('base64'))})`
  if (prototype === Date.prototype) return `date(${JSON.stringify(Date.prototype.toISOString.call(value))})`
  if (prototype !== Array.prototype && prototype !== Object.prototype && prototype !== null)
    throw new TypeError('Unsupported HTTP cache variation')

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${Array.from(value, (item) => serializeVariation(item, ancestors) ?? 'null').join(',')}]`
    }
    // Match JSON's integer-key order even though the canonical object was
    // populated with lexicographically sorted keys.
    const keys = Object.keys(value).sort()
    const ordered = Object.keys(Object.fromEntries(keys.map((key) => [key, true])))
    const fields = ordered.flatMap((key) => {
      const item = serializeVariation((value as Record<string, unknown>)[key], ancestors)
      return item === undefined ? [] : [`${JSON.stringify(key)}:${item}`]
    })
    return `{${fields.join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

export const normalizeHeaderName = (name: string) => name.trim().toLowerCase()

export const getRequestHeader = (req: HttpRequestLike, name: string, rawHeaders?: Record<string, unknown>): unknown => {
  const normalized = normalizeHeaderName(name)
  if (rawHeaders) return rawHeaders[normalized]
  const fromHeaders = req.headers?.[normalized]
  if (fromHeaders !== undefined) return fromHeaders
  return req.get?.(normalized) ?? req.header?.(normalized)
}

export const getResponseHeader = (response: HttpResponseLike, name: string): unknown =>
  response.getHeader?.(normalizeHeaderName(name))

export const getDeclaredVaryHeaders = (varyBy: unknown) =>
  Array.isArray(varyBy) ? [...new Set(varyBy.map(normalizeHeaderName).filter(Boolean))].sort() : []

const hasCallerOwnedIsolation = <Req extends HttpRequestLike>(
  options: HttpPolicyOptions<Req>,
  sensitiveHeader: string,
) => {
  if (typeof options.key === 'function' || typeof options.varyBy === 'function') return true
  return getDeclaredVaryHeaders(options.varyBy).includes(sensitiveHeader)
}

export const isRequestCacheable = <Req extends HttpRequestLike>(
  req: Req,
  options: HttpPolicyOptions<Req>,
  rawHeaders?: Record<string, unknown>,
) => {
  if (req.method && req.method.toUpperCase() !== 'GET') return false
  const header = (name: string) => getRequestHeader(req, name, rawHeaders)
  if (['range', 'if-range', 'if-match', 'if-unmodified-since'].some((name) => header(name) !== undefined)) return false
  if (hasCacheControlDirective(header('cache-control'), ['no-store', 'no-cache'])) return false

  const authorization = header('authorization')
  if (
    authorization !== undefined &&
    (!options.cacheAuthenticated || !hasCallerOwnedIsolation(options, 'authorization'))
  ) {
    return false
  }

  const cookie = header('cookie')
  if (cookie !== undefined && (!options.cacheCookies || !hasCallerOwnedIsolation(options, 'cookie'))) {
    return false
  }

  return options.shouldCache?.(req) !== false
}

const hasCacheControlDirective = (value: unknown, names: string[]) => {
  const values = Array.isArray(value) ? value : [value]
  return values.some((header) =>
    String(header ?? '')
      .split(',')
      .some((directive) => {
        const name = directive.trim().split('=', 1)[0].trim().toLowerCase()
        return names.includes(name)
      }),
  )
}

const parseVary = (value: unknown) => {
  const values = Array.isArray(value) ? value : [value]
  return values
    .flatMap((header) => String(header ?? '').split(','))
    .map(normalizeHeaderName)
    .filter(Boolean)
}

export const boundedNegativeTTL = (negativeTTL: number | undefined, maxTTL: number) => {
  if (typeof negativeTTL !== 'number' || !Number.isFinite(negativeTTL) || negativeTTL <= 0) return undefined
  return Math.min(negativeTTL, maxTTL)
}

export const isResponseCacheable = <Req extends HttpRequestLike>(
  req: Req,
  response: HttpResponseLike,
  options: HttpPolicyOptions<Req>,
) => {
  const negative = response.statusCode === 404 && boundedNegativeTTL(options.negativeTTL, Number.MAX_SAFE_INTEGER)
  if (response.statusCode === 206) return false
  if (!((response.statusCode >= 200 && response.statusCode < 300) || negative)) return false
  return hasCacheableResponseHeaders(response, options.varyBy) && options.shouldCache?.(req, response) !== false
}

export const hasCacheableResponseHeaders = (response: HttpResponseLike, varyBy: unknown) => {
  if (hasCacheControlDirective(getResponseHeader(response, 'cache-control'), ['private', 'no-store', 'no-cache']))
    return false
  if (getResponseHeader(response, 'set-cookie') !== undefined) return false

  const declared = new Set(getDeclaredVaryHeaders(varyBy))
  const varied = parseVary(getResponseHeader(response, 'vary'))
  return !varied.includes('*') && !varied.some((name) => !declared.has(name))
}

export const buildHttpCacheKey = <Req extends HttpRequestLike>(input: {
  req: Req
  requestPath: string
  query: unknown
  cachePrefix: string
  ignoreQueryParams?: string[]
  key?: (req: Req) => string
  varyBy?: string[] | ((req: Req) => unknown)
  rawHeaders?: Record<string, unknown>
}) => {
  const customKey = input.key?.(input.req)
  if (input.key && (typeof customKey !== 'string' || customKey.trim().length === 0)) return undefined
  const requestPath = input.key ? `/custom/${digest(String(customKey))}` : input.requestPath
  const header = (name: string) => getRequestHeader(input.req, name, input.rawHeaders)
  const base = getAdaptiveCacheKey(
    requestPath,
    input.key ? {} : input.query,
    input.cachePrefix,
    input.ignoreQueryParams,
    input.key ? undefined : String(header('host') ?? header(':authority') ?? ''),
  )

  if (!input.varyBy) return base
  if (Array.isArray(input.varyBy))
    return `${base}vary:${digest(getDeclaredVaryHeaders(input.varyBy).map((name) => [name, header(name)]))}:`
  const variation = input.varyBy(input.req)
  try {
    const hash = crypto
      .createHash('sha256')
      .update(serializeVariation(variation) ?? 'undefined')
      .digest('hex')
    return `${base}vary:${hash}:`
  } catch {
    return undefined
  }
}
