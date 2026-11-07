import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
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
    value?.__adaptiveCacheHttpResponse === 1 && value.isBuffer === true && typeof value.body === 'string'
      ? Buffer.from(value.body, 'base64')
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

export function fingerprint(data: any, options: AdaptiveCacheOptions, raw: string): string {
  if (options.ignoreFields?.length && data && typeof data === 'object' && !Buffer.isBuffer(data)) {
    const input = decodePayload(raw)
    for (const path of options.ignoreFields) {
      const fields = path.split('.')
      let cursor = input
      for (const field of fields.slice(0, -1)) {
        if (!cursor || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, field)) {
          cursor = undefined
          break
        }
        cursor = cursor[field]
      }
      if (cursor && typeof cursor === 'object') delete cursor[fields[fields.length - 1]]
    }
    return crypto.createHash('sha256').update(encodePayload(input)).digest('hex')
  }
  return crypto.createHash('sha256').update(raw).digest('hex')
}
