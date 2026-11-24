import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import { isEncodedHttpResponse } from './httpResponse'
import type { AdaptiveCacheOptions } from './types'

const gzip = promisify(zlib.gzip)
const CODEC_PREFIX = 'adaptive-cache:v2:'
const DEFAULT_MAX_DECODED_BYTES = 64 * 1024 * 1024

const enforcePayloadSize = (raw: string, maxDecodedBytes: number) => {
  if (Buffer.byteLength(raw, 'utf8') > maxDecodedBytes)
    throw new RangeError(`Cache payload exceeds compression.maxDecodedBytes (${maxDecodedBytes})`)
  return raw
}

const sliceBoundedRaw = (encoded: string, start: number, maxDecodedBytes: number) => {
  if (encoded.length - start > maxDecodedBytes)
    throw new RangeError(`Cache payload exceeds compression.maxDecodedBytes (${maxDecodedBytes})`)
  return encoded.slice(start)
}

const decodeBoundedBase64 = (encoded: string, start: number, maxDecodedBytes: number) => {
  // zlib's stored blocks add at most five bytes per 16,383 input bytes, plus
  // gzip framing. This admits payloads written by encode() without allocating
  // an attacker-sized Buffer before maxOutputLength can take effect.
  const maxCompressedBytes = maxDecodedBytes + Math.ceil(maxDecodedBytes / 16_383) * 5 + 64
  const maxEncodedCharacters = Math.ceil(maxCompressedBytes / 3) * 4
  if (encoded.length - start > maxEncodedCharacters)
    throw new RangeError(`Encoded cache payload exceeds compression.maxDecodedBytes (${maxDecodedBytes})`)
  return Buffer.from(encoded.slice(start), 'base64')
}

const gunzip = (bytes: Buffer, maxOutputLength: number) =>
  new Promise<Buffer>((resolve, reject) => {
    zlib.gunzip(bytes, { maxOutputLength }, (error, result) => {
      if (error) reject(error)
      else resolve(result)
    })
  })

export const encodePayload = (data: any): string =>
  JSON.stringify({
    __adaptiveCachePayload: 1,
    type: Buffer.isBuffer(data)
      ? 'buffer'
      : typeof data === 'string'
        ? 'string'
        : typeof data === 'undefined'
          ? 'undefined'
          : 'json',
    value: Buffer.isBuffer(data) ? data.toString('base64') : data,
  })

const decodePayload = (raw: string): any => {
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!parsed || typeof parsed !== 'object' || parsed.__adaptiveCachePayload !== 1) return parsed
  if (parsed.type === 'buffer') return Buffer.from(String(parsed.value || ''), 'base64')
  if (parsed.type === 'undefined') return undefined
  return parsed.value
}

const isCompressed = (value: any) => {
  const data =
    isEncodedHttpResponse(value) && value.isBuffer === true && typeof value.body === 'string'
      ? Buffer.from(value.body.slice(0, 16), 'base64')
      : value
  return (
    Buffer.isBuffer(data) &&
    ((data[0] === 0x1f && data[1] === 0x8b) || // gzip
      (data[0] === 0x50 && data[1] === 0x4b) || // ZIP
      (data[0] === 0x89 && data.subarray(1, 4).toString() === 'PNG') ||
      (data[0] === 0xff && data[1] === 0xd8) || // JPEG
      (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP'))
  )
}

export async function encode(data: any, options: AdaptiveCacheOptions, raw: string): Promise<string> {
  const maxDecodedBytes = options.compression?.maxDecodedBytes ?? DEFAULT_MAX_DECODED_BYTES
  enforcePayloadSize(raw, maxDecodedBytes)
  const settings = options.compression
  if (!settings) return options.compress === false ? raw : zlib.gzipSync(Buffer.from(raw)).toString('base64')
  const bytes = Buffer.from(raw)
  if (
    options.compress === false ||
    bytes.length < (settings.minBytes ?? 0) ||
    (settings.skipCompressed && isCompressed(data))
  ) {
    return CODEC_PREFIX + 'json:' + raw
  }
  const compressed = (settings.async ? await gzip(bytes) : zlib.gzipSync(bytes)).toString('base64')
  return settings.onlyIfSmaller && Buffer.byteLength(compressed) >= bytes.length
    ? CODEC_PREFIX + 'json:' + raw
    : CODEC_PREFIX + 'gzip:' + compressed
}

export async function decode(encoded: string, options: AdaptiveCacheOptions): Promise<any> {
  let raw: string
  const maxDecodedBytes = options.compression?.maxDecodedBytes ?? DEFAULT_MAX_DECODED_BYTES
  if (encoded.startsWith(CODEC_PREFIX + 'json:')) {
    raw = sliceBoundedRaw(encoded, (CODEC_PREFIX + 'json:').length, maxDecodedBytes)
  } else if (encoded.startsWith(CODEC_PREFIX + 'gzip:')) {
    const bytes = decodeBoundedBase64(encoded, (CODEC_PREFIX + 'gzip:').length, maxDecodedBytes)
    raw = (
      options.compression?.async
        ? await gunzip(bytes, maxDecodedBytes)
        : zlib.gunzipSync(bytes, { maxOutputLength: maxDecodedBytes })
    ).toString('utf8')
  } else {
    if (options.compress === false) raw = sliceBoundedRaw(encoded, 0, maxDecodedBytes)
    else {
      const bytes = decodeBoundedBase64(encoded, 0, maxDecodedBytes)
      raw = (
        options.compression?.async
          ? await gunzip(bytes, maxDecodedBytes)
          : zlib.gunzipSync(bytes, { maxOutputLength: maxDecodedBytes })
      ).toString('utf8')
    }
  }
  return decodePayload(enforcePayloadSize(raw, maxDecodedBytes))
}

const isJsonContentType = (value: unknown): boolean => {
  if (typeof value !== 'string') return false
  const mediaType = value.split(';', 1)[0].trim().toLowerCase()
  return mediaType === 'application/json' || mediaType.endsWith('+json')
}

const parseJsonObject = (value: string) => {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

type LosslessJson =
  | { kind: 'object'; fields: Map<string, LosslessJson> }
  | { kind: 'array'; items: LosslessJson[] }
  | { kind: 'scalar'; text: string }

const serializeLosslessJson = (value: LosslessJson): string => {
  if (value.kind === 'object') {
    const fields = Array.from(value.fields, ([key, entry]) => `${JSON.stringify(key)}:${serializeLosslessJson(entry)}`)
    return `{${fields.join(',')}}`
  }
  if (value.kind === 'array') return `[${value.items.map(serializeLosslessJson).join(',')}]`
  return value.text
}

const canonicalizeJsonBody = (body: string, ignoreFields: string[]): string | undefined => {
  // JSON.parse validates quoted tokens. Number tokens retain their original spelling.
  const tokens =
    /[ \t\r\n]*("(?:[^"\\]|\\[\s\S])*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null|[{}[\]:,])/y
  const readToken = () => {
    const match = tokens.exec(body)
    if (!match) throw new SyntaxError('Expected a JSON token')
    return match[1]
  }
  const readList = (close: string, readItem: (token: string) => void) => {
    let token = readToken()
    if (token === close) return
    while (true) {
      readItem(token)
      const separator = readToken()
      if (separator === close) return
      if (separator !== ',') throw new SyntaxError(`Expected a comma or ${close}`)
      token = readToken()
    }
  }
  const readValue = (token: string): LosslessJson => {
    if (token === '{') {
      const fields = new Map<string, LosslessJson>()
      readList('}', (key) => {
        if (key[0] !== '"' || readToken() !== ':') throw new SyntaxError('Expected a JSON property')
        fields.set(JSON.parse(key), readValue(readToken()))
      })
      return { kind: 'object', fields }
    }
    if (token === '[') {
      const items: LosslessJson[] = []
      readList(']', (item) => items.push(readValue(item)))
      return { kind: 'array', items }
    }
    if ('}]:,'.includes(token)) throw new SyntaxError('Expected a JSON value')
    return { kind: 'scalar', text: token[0] === '"' ? JSON.stringify(JSON.parse(token)) : token }
  }

  try {
    const root = readValue(readToken())
    if (root.kind === 'scalar' || /[^ \t\r\n]/.test(body.slice(tokens.lastIndex))) return undefined
    for (const fieldPath of ignoreFields) {
      const fields = fieldPath.split('.')
      let cursor: LosslessJson | undefined = root
      for (const field of fields.slice(0, -1)) {
        cursor = cursor?.kind === 'object' ? cursor.fields.get(field) : undefined
      }
      if (cursor?.kind === 'object') cursor.fields.delete(fields[fields.length - 1])
    }
    return serializeLosslessJson(root)
  } catch {
    return undefined
  }
}

const stripIgnoredFields = (target: any, ignoreFields: string[]) => {
  for (const fieldPath of ignoreFields) {
    const fields = fieldPath.split('.')
    let cursor = target
    for (const field of fields.slice(0, -1)) {
      if (!cursor || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, field)) {
        cursor = undefined
        break
      }
      cursor = cursor[field]
    }
    const leaf = fields[fields.length - 1]
    if (cursor && typeof cursor === 'object' && Object.prototype.propertyIsEnumerable.call(cursor, leaf)) {
      delete cursor[leaf]
    }
  }
}

export function fingerprintTarget(data: any): any {
  if (!isEncodedHttpResponse(data)) return data
  if (data.isBuffer && typeof data.body === 'string') return Buffer.from(data.body, 'base64')
  if (typeof data.body === 'string' && isJsonContentType(data.headers?.['content-type'])) {
    return parseJsonObject(data.body) ?? data.body
  }
  return data.body
}

export function fingerprint(data: any, options: AdaptiveCacheOptions, raw: string): string {
  if (options.ignoreFields?.length && data && typeof data === 'object' && !Buffer.isBuffer(data)) {
    const isHttp = isEncodedHttpResponse(data)
    const input = decodePayload(raw)
    if (isHttp) {
      let jsonBody = false
      if (!input.isBuffer) {
        if (input.body && typeof input.body === 'object') {
          jsonBody = true
          stripIgnoredFields(input.body, options.ignoreFields)
        } else if (typeof input.body === 'string' && isJsonContentType(input.headers?.['content-type'])) {
          const canonical = canonicalizeJsonBody(input.body, options.ignoreFields)
          if (canonical !== undefined) {
            jsonBody = true
            input.body = canonical
          }
        }
      }
      // Express auto-generates ETag from raw JSON bytes including optional or volatile ignored fields.
      if (jsonBody && input.headers) delete input.headers.etag
    } else {
      stripIgnoredFields(input, options.ignoreFields)
    }
    return crypto.createHash('sha256').update(encodePayload(input)).digest('hex')
  }
  return crypto.createHash('sha256').update(raw).digest('hex')
}
