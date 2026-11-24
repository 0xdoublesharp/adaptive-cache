import {
  getDeclaredHeaderNames,
  HttpResponseLike,
  normalizeHeaderName,
  normalizeHttpBody,
  snapshotHttpResponse,
} from './httpPolicy'

export type CachedHttpHeaders = Record<string, string | string[]>

type DecodedHttpResponse = {
  body: any
  statusCode?: number
  contentType?: string
  headers?: CachedHttpHeaders
  policyHeaders?: CachedHttpHeaders
}

export type HttpResponseTransport = {
  writableEnded: boolean
  prependOnceListener: (event: string, listener: () => void) => unknown
  removeListener: (event: string, listener: () => void) => unknown
}

export const watchHttpResponse = (
  transport: HttpResponseTransport,
  response: HttpResponseLike,
): { completion: Promise<ReturnType<typeof snapshotHttpResponse> | undefined>; signal: AbortSignal } => {
  const controller = new AbortController()
  let resolve!: (value?: ReturnType<typeof snapshotHttpResponse>) => void
  const completion = new Promise<ReturnType<typeof snapshotHttpResponse> | undefined>((done) => (resolve = done))
  const finish = () => settle(true)
  const close = () => settle(false)
  const settle = (finished: boolean) => {
    transport.removeListener('finish', finish)
    transport.removeListener('close', close)
    transport.removeListener('error', close)
    if (!finished && !transport.writableEnded) controller.abort()
    resolve(finished ? snapshotHttpResponse(response) : undefined)
  }
  transport.prependOnceListener('finish', finish)
  transport.prependOnceListener('close', close)
  transport.prependOnceListener('error', close)
  return { completion, signal: controller.signal }
}

// Coalesced loads share their result, but framework hooks may mutate a body.
// Keep each response independent while preserving nested buffers and undefined.
export const cloneHttpBody = (body: any): any => {
  if (Buffer.isBuffer(body)) return Buffer.from(body)
  if (Array.isArray(body)) return body.map(cloneHttpBody)
  if (body && typeof body === 'object')
    return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, cloneHttpBody(value)]))
  return body
}

const REPLAYABLE_HEADERS = new Set([
  'cache-control',
  'content-encoding',
  'content-language',
  'content-type',
  'etag',
  'last-modified',
  'vary',
])

const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'set-cookie2'])

const normalizeHeaders = (headers: Record<string, unknown> = {}, names: Set<string>): CachedHttpHeaders => {
  const normalized: CachedHttpHeaders = Object.create(null)
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = normalizeHeaderName(name)
    if (!names.has(lowerName) || value === undefined) continue
    normalized[lowerName] = Array.isArray(value) ? value.map(String) : String(value)
  }
  return normalized
}

const normalizeReplayHeaders = (headers: Record<string, unknown> | undefined, contentType: unknown) => {
  const normalized = normalizeHeaders(headers, REPLAYABLE_HEADERS)
  if (typeof contentType === 'string') normalized['content-type'] = contentType
  return normalized
}

const normalizePolicyHeaders = (headers: Record<string, unknown> | undefined, declaredNames: string[] | undefined) => {
  if (!declaredNames?.length) return {}
  const names = getDeclaredHeaderNames(declaredNames)
  const allowed = new Set(names.filter((name) => !REPLAYABLE_HEADERS.has(name) && !SENSITIVE_HEADERS.has(name)))
  const policyHeaders = normalizeHeaders(headers, allowed)
  return Object.keys(policyHeaders).length ? { policyHeaders } : {}
}

const encodedHttpResponses = new WeakSet<object>()

export const isEncodedHttpResponse = (value: unknown): value is Record<string, any> =>
  Boolean(value && typeof value === 'object' && encodedHttpResponses.has(value))

// HTTP metadata belongs to the cached response, not to debug headers.
export const encodeHttpResponse = (
  body: any,
  statusCode: number,
  contentType: unknown,
  headers: Record<string, unknown> = {},
  policyHeaders?: string[],
) => {
  body = normalizeHttpBody(body)
  const envelope = {
    __adaptiveCacheHttpResponse: 1,
    statusCode,
    contentType: typeof contentType === 'string' ? contentType : undefined,
    headers: normalizeReplayHeaders(headers, contentType),
    ...normalizePolicyHeaders(headers, policyHeaders),
    isBuffer: Buffer.isBuffer(body),
    body: Buffer.isBuffer(body) ? body.toString('base64') : body,
  }
  encodedHttpResponses.add(envelope)
  return envelope
}

export const decodeHttpResponse = (data: any): DecodedHttpResponse => {
  if (!data || data.__adaptiveCacheHttpResponse !== 1) return { body: data }
  return {
    body: data.isBuffer ? Buffer.from(data.body, 'base64') : data.body,
    statusCode: data.statusCode as number,
    contentType: data.contentType as string | undefined,
    headers: normalizeReplayHeaders(data.headers, data.contentType),
    ...normalizePolicyHeaders(data.policyHeaders, Object.keys(data.policyHeaders ?? {})),
  }
}

export const cachedPolicyResponse = (response: DecodedHttpResponse) => {
  const headers: CachedHttpHeaders = Object.assign(Object.create(null), response.policyHeaders, response.headers)
  return {
    statusCode: response.statusCode || 200,
    headers,
    getHeaders: () => headers,
    getHeader: (name: string) => headers[normalizeHeaderName(name)],
  }
}
