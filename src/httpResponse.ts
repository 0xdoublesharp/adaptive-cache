import { HttpResponseLike, normalizeHttpBody, snapshotHttpResponse } from './httpPolicy'

export type CachedHttpHeaders = Record<string, string | string[]>

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

const normalizeHeaders = (headers: Record<string, unknown> = {}, contentType?: unknown): CachedHttpHeaders => {
  const normalized: CachedHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase()
    if (!REPLAYABLE_HEADERS.has(lowerName) || value === undefined) continue
    normalized[lowerName] = Array.isArray(value) ? value.map(String) : String(value)
  }
  if (typeof contentType === 'string') normalized['content-type'] = contentType
  return normalized
}

// HTTP metadata belongs to the cached response, not to debug headers.
export const encodeHttpResponse = (
  body: any,
  statusCode: number,
  contentType: unknown,
  headers: Record<string, unknown> = {},
) => {
  body = normalizeHttpBody(body)
  return {
    __adaptiveCacheHttpResponse: 1,
    statusCode,
    contentType: typeof contentType === 'string' ? contentType : undefined,
    headers: normalizeHeaders(headers, contentType),
    isBuffer: Buffer.isBuffer(body),
    body: Buffer.isBuffer(body) ? body.toString('base64') : body,
  }
}

export const decodeHttpResponse = (data: any) => {
  if (!data || data.__adaptiveCacheHttpResponse !== 1) return { body: data }
  return {
    body: data.isBuffer ? Buffer.from(data.body, 'base64') : data.body,
    statusCode: data.statusCode as number,
    contentType: data.contentType as string | undefined,
    headers: normalizeHeaders(data.headers, data.contentType),
  }
}
