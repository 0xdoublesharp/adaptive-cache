import crypto from 'node:crypto'
import { AdaptiveCacheOptions } from './types'

const cacheTime = process.env.CACHE_TIME || '5 seconds'

export const parseDuration = (duration: string | number): number => {
  if (typeof duration === 'number') return duration
  if (typeof duration === 'string') {
    const parts = duration.split(' ')
    const val = parseInt(parts[0])
    if (isNaN(val)) return 5
    const unit = parts[1]
    if (!unit) return val
    if (unit.startsWith('second')) return val
    if (unit.startsWith('minute')) return val * 60
    if (unit.startsWith('hour')) return val * 3600
    if (unit.startsWith('day')) return val * 86400
  }
  return 5
}

export const cache = (time: string | number = cacheTime): AdaptiveCacheOptions => {
  return { initialTTL: parseDuration(time) }
}

const DEFAULT_IGNORED_QUERY_PARAMS = ['refresh']
const MAX_PLAIN_REQUEST_PATH_BYTES = 1024

const normalizeQueryValue = (value: any): any => {
  if (Array.isArray(value)) return value.map(normalizeQueryValue)
  if (!value || typeof value !== 'object') return value

  return Object.keys(value)
    .sort()
    .reduce<Record<string, any>>((normalized, key) => {
      normalized[key] = normalizeQueryValue(value[key])
      return normalized
    }, Object.create(null))
}

export const normalizeCacheQuery = (querystring: any, ignoreQueryParams: string[] = DEFAULT_IGNORED_QUERY_PARAMS) => {
  if (!querystring || typeof querystring !== 'object') return querystring

  const ignored = new Set(ignoreQueryParams)
  const usesDefaultControlPolicy = ignoreQueryParams === DEFAULT_IGNORED_QUERY_PARAMS
  return Object.keys(querystring)
    .filter((key) => {
      if (!ignored.has(key)) return true
      // Only the scalar value recognized by both HTTP adapters is a default
      // control input. Other values remain application input and must be keyed.
      if (usesDefaultControlPolicy) return querystring[key] !== 'true'
      return false
    })
    .sort()
    .reduce<Record<string, any>>((normalized, key) => {
      normalized[key] = normalizeQueryValue(querystring[key])
      return normalized
    }, Object.create(null))
}

export const getAdaptiveCacheKey = (
  requestPath: string,
  querystring: any,
  redisPrefix: string,
  ignoreQueryParams?: string[],
  authority?: string,
) => {
  const pathKey =
    Buffer.byteLength(requestPath, 'utf8') <= MAX_PLAIN_REQUEST_PATH_BYTES
      ? requestPath
      : `path-sha256:${crypto.createHash('sha256').update(requestPath).digest('hex')}`
  const baseKey = pathKey + ':'
  const queryKey =
    crypto
      .createHash('sha256')
      .update(JSON.stringify(normalizeCacheQuery(querystring, ignoreQueryParams)))
      .digest('hex') + ':'
  const authorityKey =
    authority === undefined
      ? ''
      : `authority:${crypto.createHash('sha256').update(authority.trim().toLowerCase()).digest('hex')}:`
  return redisPrefix + authorityKey + baseKey + queryKey
}
