import 'ioredis'

export type RedisStatusEXISTS = 'EXISTS'
export type RedisStatusUPDATING = 'UPDATING'
export type RedisStatusUPDATE = 'UPDATE'

export type RedisStatusUPDATED = 'UPDATED'
export type RedisStatusLOCK_MISMATCH = 'LOCK_MISMATCH'

export type ShouldRefreshCacheEXISTS = [status: RedisStatusEXISTS, ttl: number]
export type ShouldRefreshCacheUPDATING = [status: RedisStatusUPDATING, otherLock: string]
export type ShouldRefreshCacheUPDATE = [status: RedisStatusUPDATE, lockValue: string]

export type UpdateCacheAndReleaseLockUPDATED = [status: RedisStatusUPDATED]
export type UpdateCacheAndReleaseLockLOCK_MISMATCH = [status: RedisStatusLOCK_MISMATCH, otherLock: string]

declare module 'ioredis' {
  interface Redis {
    adaptiveCacheFetch(
      dataKey: string,
    ): Promise<
      [
        data: string | null,
        ttl: number,
        dataTTL?: string | number | false,
        lastChanged?: string | number | false,
        changeCount?: string | number | false,
        hash?: string | false,
      ]
    >
    adaptiveCacheUpdate(
      dataKey: string,
      metaKey: string,
      hash: string,
      data: string,
      initialTTL: string,
      maxTTL: string,
      ttlScaling: string,
      metaTTL: string,
    ): Promise<
      [
        status: string | false,
        dataTTL: string | number,
        lastChanged?: string | number | false,
        changeCount?: string | number | false,
        hash?: string | false,
        changed?: number | false,
      ]
    >
    shouldRefreshCache(
      lastUpdateKey: string,
      lockKey: string,
      currentTime: number,
      refreshThreshold: number,
      lockExpiration: number,
      lockValue: string,
      force: number,
    ): Promise<ShouldRefreshCacheEXISTS | ShouldRefreshCacheUPDATING | ShouldRefreshCacheUPDATE>
    releaseCacheRefreshLock(
      lastUpdateKey: string,
      lockKey: string,
      currentTime: number,
      lockValue: string,
      recordRefresh?: number,
    ): Promise<UpdateCacheAndReleaseLockUPDATED | UpdateCacheAndReleaseLockLOCK_MISMATCH>
  }
}

export type AdaptiveCacheBackendName = 'redis' | 'l1-redis' | 'clustered-lru'

export type AdaptiveCacheTtlPolicy =
  | { type: 'adaptive' }
  | { type: 'aimd'; increaseSeconds?: number; decreaseFactor?: number }
  | { type: 'ewma'; halfLifeSeconds?: number; targetChangeProbability?: number }

export interface AdaptiveCacheTtlPolicyState {
  signature: string
  observedAt: number
  observedHash: string
  changeRate: number
}

export interface AdaptiveCacheMetadata {
  dataTTL?: string | number
  lastChanged?: string | number
  changeCount?: string | number
  hash?: string
  changed?: boolean
  ttlPolicyState?: AdaptiveCacheTtlPolicyState
}

export interface AdaptiveCacheFetchResult {
  encodedData: string
  ttl: number
  metadata?: AdaptiveCacheMetadata
  stale?: boolean
  staleAge?: number
  layer?: AdaptiveCacheLayer
}

export type AdaptiveCacheUpdateResult = [
  status: string | false,
  dataTTL: number,
  lastChanged?: string | number | false,
  changeCount?: string | number | false,
  hash?: string | false,
  changed?: number | false,
]

export interface AdaptiveCacheSetOptions {
  maxTTL?: number
  tags?: string[]
  staleTTL?: number
  writeToken?: string
  ttlJitter?: number
}

export type AdaptiveCacheBackendSetOptions = AdaptiveCacheSetOptions

export interface AdaptiveCacheHit<T = any> {
  data: T
  ttl: number
  metadata?: AdaptiveCacheMetadata
  stale?: boolean
  staleAge?: number
  layer?: AdaptiveCacheLayer
}

export interface AdaptiveCacheLoaderContext {
  /** Shared work is aborted when all interested callers leave or shutdown expires. */
  signal: AbortSignal
}

export interface AdaptiveCacheCloseOptions {
  /** Maximum shutdown time in milliseconds. Defaults to closeTimeoutMs or 5000. */
  timeoutMs?: number
}

export interface AdaptiveCacheLoadOptions<T = any> extends Omit<AdaptiveCacheSetOptions, 'maxTTL'> {
  maxTTL?: number | ((data: T) => number | undefined)
  staleWhileRevalidate?: number
  staleIfError?: number
  negativeTTL?: number
  isNegative?: (data: T) => boolean
  shouldStore?: (data: T) => boolean
  forceRefresh?: boolean
  lockWaitTimeoutMs?: number
  /** Per-caller deadline, including cache and lock waits. Defaults to 30000ms. */
  loadTimeoutMs?: number
  signal?: AbortSignal
}

export type AdaptiveCacheLayer = 'l1' | 'redis' | 'lru'
export type AdaptiveCacheEventType =
  'hit' | 'miss' | 'stale' | 'refresh' | 'write' | 'invalidate' | 'lock-contention' | 'error' | 'eviction'
export interface AdaptiveCacheEvent {
  type: AdaptiveCacheEventType
  timestamp: number
  key?: string
  backend?: AdaptiveCacheBackendName | 'custom'
  layer?: AdaptiveCacheLayer
  durationMs?: number
  ttl?: number
  reason?: string
  error?: unknown
  count?: number
}
export interface AdaptiveCacheStats {
  counters: Record<AdaptiveCacheEventType, number>
  hitsByLayer: Record<AdaptiveCacheLayer, number>
}
export interface AdaptiveCacheCompressionOptions {
  minBytes?: number
  async?: boolean
  skipCompressed?: boolean
  onlyIfSmaller?: boolean
  /** Maximum serialized payload bytes accepted for writes and decoded reads. Defaults to 64 MiB. */
  maxDecodedBytes?: number
}

export interface AdaptiveCacheBackendFetchInput {
  key: string
  dataKey: string
  metaKey: string
  redisPrefix: string
  includeDebugHeaders: boolean
  allowStale?: boolean
}

export interface AdaptiveCacheBackendUpdateInput {
  ttlPolicy?: AdaptiveCacheTtlPolicy
  key: string
  dataKey: string
  metaKey: string
  redisPrefix: string
  encodedData: string
  responseHash: string
  initialTTL: number
  maxTTL: number
  ttlScaling: number
  metaTTL: number
  tags: string[]
  writeToken?: string
  staleTTL?: number
  ttlJitter?: number
  lockKey?: string
  lockValue?: string
  allowOptimistic?: boolean
}

export interface AdaptiveCacheBackend {
  readonly name: AdaptiveCacheBackendName | 'custom'
  readonly supportsTtlPolicies?: boolean
  captureWriteToken?(redisPrefix: string): Promise<string>
  invalidateNamespace?(redisPrefix: string): Promise<void>
  onEvent?(listener: (event: AdaptiveCacheEvent) => void): () => void
  fetch(input: AdaptiveCacheBackendFetchInput): Promise<AdaptiveCacheFetchResult | null>
  /** Results must align with inputs, including duplicates. */
  fetchMany?(inputs: AdaptiveCacheBackendFetchInput[]): Promise<Array<AdaptiveCacheFetchResult | null>>
  update(input: AdaptiveCacheBackendUpdateInput): Promise<AdaptiveCacheUpdateResult>
  clear(key: string, dataKey: string, metaKey: string, redisPrefix?: string): Promise<void>
  invalidateTags(tags: string[], redisPrefix: string): Promise<string[]>
  shouldRefresh(
    lastUpdateKey: string,
    refreshThreshold: number,
    currentTime: number,
    force: boolean,
    lockExpirationSeconds: number,
    lockValue: string,
  ): Promise<ShouldRefreshCacheEXISTS | ShouldRefreshCacheUPDATING | ShouldRefreshCacheUPDATE>
  releaseLock(
    lastUpdateKey: string,
    currentTime: number,
    lockValue: string,
    recordRefresh?: boolean,
  ): Promise<UpdateCacheAndReleaseLockUPDATED | UpdateCacheAndReleaseLockLOCK_MISMATCH>
  flush?(): Promise<unknown>
  quit?(preserveSharedCache?: boolean, force?: boolean): Promise<unknown>
}

export interface AdaptiveCacheLruLocalL1Options {
  enabled?: boolean
  experimental?: boolean
  max?: number
  maxSize?: number
  ttl?: number
  updateAgeOnGet?: boolean
  allowStale?: boolean
  invalidation?: 'broadcast' | 'ttl-only'
  methods?: {
    get?: boolean
    has?: boolean
    fetch?: boolean
    memoize?: boolean
  }
}

export interface AdaptiveCacheLruOptions {
  namespace?: string
  maxSizeBytes?: number
  maxEntrySizeBytes?: number
  timeout?: number
  failsafe?: 'resolve' | 'reject'
  localL1?: boolean | AdaptiveCacheLruLocalL1Options
}

export interface AdaptiveCacheL1RedisOptions {
  writeMode?: 'async' | 'await-redis'
}

export interface AdaptiveCacheRedisOptions {
  /** Maximum key memberships processed by one tag invalidation. Defaults to 10,000. */
  maxTagCleanupKeys?: number
}

export interface AdaptiveCacheOptions {
  ttlPolicy?: AdaptiveCacheTtlPolicy
  initialTTL?: number // Initial TTL for data in seconds
  maxTTL?: number | ((data: any) => number | undefined) // Maximum TTL for data in seconds or function that returns TTL
  ttlScaling?: number // Factor to multiply TTL on unchanged content
  redisPrefix?: string // Prefix for Redis keys
  keyPrefix?: string // Alias for redisPrefix that also applies to non-Redis backends
  includeHeaders?: boolean // Whether to include cache status header
  includeDebugHeaders?: boolean // Whether to include metadata headers
  forceRefresh?: boolean // Force refresh the cache but maintain TTL
  lockExpirationSeconds?: number // Lock expiration in seconds for shouldRefreshCache (default 60)
  metaTTL?: number // Fixed TTL for metadata storage (in seconds)
  compression?: AdaptiveCacheCompressionOptions
  fingerprint?: (data: any) => string | Buffer
  ignoreFields?: string[]
  ttlJitter?: number
  staleWhileRevalidate?: number
  staleIfError?: number
  negativeTTL?: number
  lockWaitTimeoutMs?: number
  /** Default deadline for each getOrSet caller, in milliseconds. Defaults to 30000. */
  loadTimeoutMs?: number
  /** Default close deadline in milliseconds. Defaults to 5000. */
  closeTimeoutMs?: number
  onEvent?: (event: AdaptiveCacheEvent) => void
  compress?: boolean // Compress the cached data, default: true
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent' // Logging level
  backend?: AdaptiveCacheBackendName | AdaptiveCacheBackend
  lru?: AdaptiveCacheLruOptions
  l1Redis?: AdaptiveCacheL1RedisOptions
  redis?: AdaptiveCacheRedisOptions
  ignoreQueryParams?: string[] // Query params ignored when computing middleware cache keys
}
