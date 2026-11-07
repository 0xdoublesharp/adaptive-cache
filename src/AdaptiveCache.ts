import Redis from 'ioredis'
import { constants as bufferConstants } from 'node:buffer'
import crypto from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { encode, decode, encodePayload, fingerprint } from './payload'
import { Logger } from './lib/logger'
import { CacheLoader } from './CacheLoader'
import { normalizeTtlPolicy, validateTtlPolicySeed } from './ttlPolicy'
import { normalizeCacheTags } from './tagValidation'
import { ClusteredLruAdaptiveCacheBackend } from './backends/ClusteredLruAdaptiveCacheBackend'
import { L1RedisAdaptiveCacheBackend } from './backends/L1RedisAdaptiveCacheBackend'
import { RedisAdaptiveCacheBackend } from './backends/RedisAdaptiveCacheBackend'
import {
  AdaptiveCacheBackend,
  AdaptiveCacheBackendFetchInput,
  AdaptiveCacheFetchResult,
  AdaptiveCacheOptions,
  AdaptiveCacheSetOptions,
  AdaptiveCacheHit,
  AdaptiveCacheLoadOptions,
  AdaptiveCacheLoaderContext,
  AdaptiveCacheCloseOptions,
  AdaptiveCacheStats,
  AdaptiveCacheEvent,
} from './types'

const DEFAULT_MAX_TTL = 60 * 15
const MAX_TIMER_DELAY_MS = 2147483647

const validateNumber = (name: string, value: number | undefined, min = 0, inclusive = true) => {
  if (value !== undefined && (!Number.isFinite(value) || (inclusive ? value < min : value <= min))) {
    throw new RangeError(`${name} must be a finite number ${inclusive ? 'at least' : 'greater than'} ${min}`)
  }
}

const validateTimer = (name: string, value: number | undefined) => {
  validateNumber(name, value)
  if (value !== undefined && value > MAX_TIMER_DELAY_MS)
    throw new RangeError(`${name} must be at most ${MAX_TIMER_DELAY_MS} milliseconds`)
}

const validateSettings = (options: AdaptiveCacheOptions | AdaptiveCacheLoadOptions) => {
  for (const name of [
    'staleWhileRevalidate',
    'staleIfError',
    'negativeTTL',
    'lockWaitTimeoutMs',
    'ttlJitter',
    'staleTTL',
  ] as const) {
    validateNumber(name, (options as AdaptiveCacheLoadOptions)[name])
  }
  validateTimer('loadTimeoutMs', (options as AdaptiveCacheLoadOptions).loadTimeoutMs)
  if (options.ttlJitter !== undefined && options.ttlJitter > 1)
    throw new RangeError('ttlJitter must be between 0 and 1')
  if (typeof options.maxTTL === 'number') validateNumber('maxTTL', options.maxTTL, 0, false)
}

export class AdaptiveCache {
  public static DEFAULT_LOCK_EXPIRATION_SECONDS = 60
  public static DEFAULT_LOAD_TIMEOUT_MS = 30000
  public static DEFAULT_CLOSE_TIMEOUT_MS = 5000

  public static setDefaultLockExpirationSeconds(secs: number) {
    validateNumber('lockExpirationSeconds', secs, 0, false)
    AdaptiveCache.DEFAULT_LOCK_EXPIRATION_SECONDS = secs
  }

  public logger: Logger
  private options: AdaptiveCacheOptions
  private backend: AdaptiveCacheBackend
  private redisClient?: Redis
  private readonly loader: CacheLoader
  private readonly ttlPolicy: ReturnType<typeof normalizeTtlPolicy>
  private readonly pending = new Set<Promise<unknown>>()
  private readonly listeners = new Set<(event: AdaptiveCacheEvent) => void>()
  private readonly stats: AdaptiveCacheStats = {
    counters: {
      hit: 0,
      miss: 0,
      stale: 0,
      refresh: 0,
      write: 0,
      invalidate: 0,
      'lock-contention': 0,
      error: 0,
      eviction: 0,
    },
    hitsByLayer: { l1: 0, redis: 0, lru: 0 },
  }
  private closing = false
  private closePromise?: Promise<unknown>
  private unsubscribeBackend?: () => void

  constructor(options: AdaptiveCacheOptions = {}, client?: Redis) {
    validateSettings(options)
    validateTimer('closeTimeoutMs', options.closeTimeoutMs)
    this.ttlPolicy = normalizeTtlPolicy(options.ttlPolicy)
    for (const name of ['initialTTL', 'ttlScaling', 'metaTTL', 'lockExpirationSeconds'] as const)
      validateNumber(name, options[name], 0, false)
    if (options.metaTTL !== undefined && !Number.isInteger(options.metaTTL))
      throw new RangeError('metaTTL must be a positive integer number of seconds')
    validateNumber('compression.minBytes', options.compression?.minBytes)
    validateNumber('compression.maxDecodedBytes', options.compression?.maxDecodedBytes, 0, false)
    if (
      options.compression?.maxDecodedBytes !== undefined &&
      !Number.isSafeInteger(options.compression.maxDecodedBytes)
    )
      throw new RangeError('compression.maxDecodedBytes must be a positive safe integer')
    if (
      options.compression?.maxDecodedBytes !== undefined &&
      options.compression.maxDecodedBytes > bufferConstants.MAX_LENGTH
    )
      throw new RangeError(`compression.maxDecodedBytes must be at most ${bufferConstants.MAX_LENGTH}`)
    validateNumber('redis.maxTagCleanupKeys', options.redis?.maxTagCleanupKeys, 0, false)
    if (options.redis?.maxTagCleanupKeys !== undefined && !Number.isSafeInteger(options.redis.maxTagCleanupKeys))
      throw new RangeError('redis.maxTagCleanupKeys must be a positive safe integer')
    validateTtlPolicySeed(this.ttlPolicy, options.initialTTL ?? 5)
    this.options = options
    this.logger = new Logger(options.logLevel || 'info')
    this.backend = this.createBackend(options, client)
    if (this.ttlPolicy.type !== 'adaptive' && !this.backend.supportsTtlPolicies)
      throw new Error('Backend does not support configurable TTL policies')
    this.loader = new CacheLoader({
      options: this.options,
      backend: this.backend,
      getKeyPrefix: this.getKeyPrefix.bind(this),
      read: this.read.bind(this),
      write: this.write.bind(this),
      resolveMaxTTL: this.resolveMaxTTL.bind(this),
      acquireRefreshLock: this.acquireRefreshLock.bind(this),
      track: this.track.bind(this),
      emit: this.emit.bind(this),
    })
    if (options.onEvent) this.listeners.add(options.onEvent)
    this.unsubscribeBackend = this.backend.onEvent?.((event) => this.emit(event))
  }

  public get client(): Redis {
    if (!this.redisClient) {
      throw new Error('This AdaptiveCache instance is not using a Redis-backed backend.')
    }
    return this.redisClient
  }

  private createBackend(options: AdaptiveCacheOptions, client?: Redis): AdaptiveCacheBackend {
    if (options.backend && typeof options.backend === 'object') {
      this.redisClient = client
      return options.backend
    }

    const backendName = options.backend || 'redis'

    if (backendName === 'clustered-lru') {
      return new ClusteredLruAdaptiveCacheBackend(options.lru, this.logger)
    }

    const ownsClient = !client
    this.redisClient = client || RedisAdaptiveCacheBackend.createClient(this.logger)
    try {
      const redisBackend = new RedisAdaptiveCacheBackend(
        this.redisClient,
        this.logger,
        ownsClient,
        options.redis?.maxTagCleanupKeys,
      )

      if (backendName === 'l1-redis') {
        return new L1RedisAdaptiveCacheBackend(
          redisBackend,
          new ClusteredLruAdaptiveCacheBackend(options.lru, this.logger),
          this.getKeyPrefix(),
          this.logger,
          options.l1Redis?.writeMode,
        )
      }

      return redisBackend
    } catch (error) {
      if (ownsClient) this.redisClient.disconnect()
      throw error
    }
  }

  private getKeyPrefix() {
    return this.options.keyPrefix || this.options.redisPrefix || 'adaptive:'
  }

  private assertOpen() {
    if (this.closing) throw new Error('AdaptiveCache is closed')
  }

  private emit(event: Omit<AdaptiveCacheEvent, 'timestamp'> & { timestamp?: number }) {
    const complete: AdaptiveCacheEvent = { timestamp: Date.now(), backend: this.backend.name, ...event }
    this.stats.counters[complete.type] += complete.count ?? 1
    if (complete.type === 'hit' && complete.layer) this.stats.hitsByLayer[complete.layer]++
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(complete)).catch(() => {
          /* Async observers are isolated too. */
        })
      } catch {
        /* Observers cannot affect cache operations. */
      }
    }
  }

  public onEvent(listener: (event: AdaptiveCacheEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  public getStats(): AdaptiveCacheStats {
    return { counters: { ...this.stats.counters }, hitsByLayer: { ...this.stats.hitsByLayer } }
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise)
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    )
    return promise
  }

  public async get<T = any>(key: string, options: { allowStale?: boolean } = {}): Promise<AdaptiveCacheHit<T> | null> {
    this.assertOpen()
    return this.track(this.read<T>(key, options))
  }

  private fetchInput(key: string, options: { allowStale?: boolean }): AdaptiveCacheBackendFetchInput {
    return {
      key,
      dataKey: key + 'data',
      metaKey: key + 'meta',
      redisPrefix: this.getKeyPrefix(),
      includeDebugHeaders: this.options.includeDebugHeaders ?? false,
      allowStale: options.allowStale,
    }
  }

  private async read<T>(
    key: string,
    options: { allowStale?: boolean } = {},
    fetch?: () => Promise<AdaptiveCacheFetchResult | null>,
  ): Promise<AdaptiveCacheHit<T> | null> {
    const started = performance.now()
    try {
      const result = await (fetch ? fetch() : this.backend.fetch(this.fetchInput(key, options)))
      if (!result) {
        this.emit({ type: 'miss', key, durationMs: performance.now() - started })
        return null
      }
      const hit: AdaptiveCacheHit<T> = { ttl: result.ttl, data: await decode(result.encodedData, this.options) }
      if (result.stale) {
        hit.stale = true
        hit.staleAge = result.staleAge
      }
      // Keep the historical enumerable hit shape while exposing layer attribution.
      if (result.layer) Object.defineProperty(hit, 'layer', { value: result.layer, enumerable: false })
      if (this.options.includeDebugHeaders && result.metadata) {
        hit.metadata = {
          dataTTL: result.metadata.dataTTL,
          lastChanged: result.metadata.lastChanged,
          changeCount: result.metadata.changeCount,
        }
      }
      this.emit({
        type: result.stale ? 'stale' : 'hit',
        key,
        layer: result.layer,
        ttl: result.ttl,
        durationMs: performance.now() - started,
      })
      return hit
    } catch (error) {
      this.logger.warn('adaptiveCache failed to fetch data:', error)
      this.emit({ type: 'error', key, reason: 'read', error, durationMs: performance.now() - started })
      throw error
    }
  }

  public supportsWriteFencing(): boolean {
    return typeof this.backend.captureWriteToken === 'function'
  }

  public async captureWriteToken(): Promise<string> {
    this.assertOpen()
    if (!this.backend.captureWriteToken)
      throw new Error('Backend does not support captureWriteToken required for fenced loading')
    return this.track(this.backend.captureWriteToken(this.getKeyPrefix()))
  }

  public async set(key: string, data: any, options: AdaptiveCacheSetOptions = {}) {
    this.assertOpen()
    return this.track(this.write(key, data, options))
  }

  public resolveMaxTTL(data: any, options: Pick<AdaptiveCacheOptions, 'maxTTL'> = {}): number {
    const requested = typeof options.maxTTL === 'function' ? options.maxTTL(data) : options.maxTTL
    if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) return requested
    if (typeof this.options.maxTTL === 'number') return this.options.maxTTL
    if (typeof this.options.maxTTL === 'function') {
      const calculated = this.options.maxTTL(data)
      if (typeof calculated === 'number' && Number.isFinite(calculated) && calculated > 0) return calculated
    }
    return DEFAULT_MAX_TTL
  }

  private async write(
    key: string,
    data: any,
    options: AdaptiveCacheSetOptions = {},
    lease?: { lockKey: string; lockValue: string },
    signal?: AbortSignal,
  ) {
    validateSettings(options)
    const tags = normalizeCacheTags(options.tags ?? [], 'Cache write').tags
    const started = performance.now()
    try {
      const { initialTTL = 5, ttlScaling = 2, metaTTL = 60 * 60 * 24 * 7 } = this.options
      const maxTTL = this.resolveMaxTTL(data, options)
      validateTtlPolicySeed(this.ttlPolicy, Math.min(initialTTL, maxTTL))
      const writeToken = options.writeToken ?? (await this.backend.captureWriteToken?.(this.getKeyPrefix()))
      if (this.options.compression?.async && writeToken === undefined)
        throw new Error('Backend does not support captureWriteToken required for asynchronous encoding')
      // Hash and encode one snapshot so getters/toJSON cannot change the stored
      // value between fingerprinting and serialization.
      const customHash = this.options.fingerprint
        ? crypto.createHash('sha256').update(this.options.fingerprint(data)).digest('hex')
        : undefined
      const payload = encodePayload(data)
      const responseHash = customHash ?? fingerprint(data, this.options, payload)
      const encodedData = await encode(data, this.options, payload)
      signal?.throwIfAborted()
      const result = await this.backend.update({
        key,
        dataKey: key + 'data',
        metaKey: key + 'meta',
        redisPrefix: this.getKeyPrefix(),
        encodedData,
        responseHash,
        initialTTL: Math.min(initialTTL, maxTTL),
        maxTTL,
        ttlScaling,
        ...(this.ttlPolicy.type === 'adaptive' ? {} : { ttlPolicy: this.ttlPolicy }),
        metaTTL,
        tags,
        writeToken,
        staleTTL: options.staleTTL ?? Math.max(this.options.staleWhileRevalidate ?? 0, this.options.staleIfError ?? 0),
        ttlJitter: options.ttlJitter ?? this.options.ttlJitter,
        ...lease,
        allowOptimistic: options.writeToken === undefined && !lease && !this.options.compression?.async,
      })
      this.logger.debug('adaptiveCache:', this.backend.name, key + 'meta', result)
      if (result[0] === 'INVALIDATED') {
        this.emit({ type: 'invalidate', key, reason: 'write-rejected', durationMs: performance.now() - started })
      } else {
        this.emit({ type: 'write', key, ttl: result[1], durationMs: performance.now() - started })
      }
      return result
    } catch (error) {
      this.logger.error('Cache operation failed:', error)
      this.emit({ type: 'error', key, reason: 'write', error, durationMs: performance.now() - started })
      throw error
    }
  }

  public resolveLoadTimeoutMs(options: Pick<AdaptiveCacheLoadOptions<unknown>, 'loadTimeoutMs'> = {}): number {
    const timeoutMs = options.loadTimeoutMs ?? this.options.loadTimeoutMs ?? AdaptiveCache.DEFAULT_LOAD_TIMEOUT_MS
    validateTimer('loadTimeoutMs', timeoutMs)
    return timeoutMs
  }

  public async getOrSet<T>(
    key: string,
    loader: (context: AdaptiveCacheLoaderContext) => Promise<T>,
    options: AdaptiveCacheLoadOptions<T> = {},
  ): Promise<T> {
    this.assertOpen()
    validateSettings(options)
    return this.track(
      this.loader.getOrSet(key, loader, {
        ...options,
        loadTimeoutMs: this.resolveLoadTimeoutMs(options),
      }),
    )
  }

  public async getMany<T = any>(keys: string[]): Promise<Map<string, AdaptiveCacheHit<T> | null>> {
    this.assertOpen()
    if (!keys.length) return new Map()
    if (!this.backend.fetchMany)
      return new Map(await Promise.all(keys.map(async (key) => [key, await this.get<T>(key)] as const)))
    const inputs = keys.map((key) => this.fetchInput(key, {}))
    // Defer custom backend execution until every per-key read is tracked for close().
    const batch = Promise.resolve().then(() => this.backend.fetchMany!(inputs))
    const reads = inputs.map(({ key }, index) =>
      this.track(
        this.read<T>(key, {}, async () => {
          const results = await batch
          if (results.length !== inputs.length) throw new Error('Backend fetchMany result length must match inputs')
          return results[index]
        }),
      ).then((hit) => [key, hit] as const),
    )
    return new Map(await Promise.all(reads))
  }

  public async setMany(
    entries: Array<{ key: string; data: unknown; options?: AdaptiveCacheSetOptions }>,
  ): Promise<void> {
    this.assertOpen()
    await Promise.all(entries.map(({ key, data, options }) => this.set(key, data, options)))
  }

  public async clearMany(keys: string[]): Promise<void> {
    this.assertOpen()
    await Promise.all(keys.map((key) => this.clear(key)))
  }

  public async invalidateNamespace(): Promise<void> {
    this.assertOpen()
    if (!this.backend.invalidateNamespace) throw new Error('Backend does not support namespace invalidation')
    return this.track(
      (async () => {
        await this.backend.invalidateNamespace!(this.getKeyPrefix())
        this.emit({ type: 'invalidate', reason: 'namespace' })
      })(),
    )
  }

  public async invalidateTags(tags: string[]) {
    this.assertOpen()
    const normalized = normalizeCacheTags(tags, 'Cache invalidation').tags
    return this.track(
      (async () => {
        await this.backend.invalidateTags(normalized, this.getKeyPrefix())
        this.emit({ type: 'invalidate', reason: 'tags' })
      })(),
    )
  }

  public async clear(key: string) {
    this.assertOpen()
    return this.track(
      (async () => {
        await this.backend.clear(key, key + 'data', key + 'meta', this.getKeyPrefix())
        this.emit({ type: 'invalidate', key, reason: 'clear' })
      })(),
    )
  }

  public async shouldRefresh(
    lastUpdateKey: string,
    refreshThreshold: number,
    force = false,
    lockExpirationSeconds?: number,
  ) {
    this.assertOpen()
    return this.track(this.acquireRefreshLock(lastUpdateKey, refreshThreshold, force, lockExpirationSeconds))
  }

  // Accepted loaders can finish acquiring/releasing locks while close() drains them.
  private async acquireRefreshLock(
    lastUpdateKey: string,
    refreshThreshold: number,
    force: boolean,
    lockExpirationSeconds?: number,
  ) {
    validateNumber('lockExpirationSeconds', lockExpirationSeconds, 0, false)
    const currentTime = Math.floor(Date.now() / 1000)
    const effectiveLockSeconds =
      typeof lockExpirationSeconds === 'number'
        ? lockExpirationSeconds
        : (this.options.lockExpirationSeconds ?? AdaptiveCache.DEFAULT_LOCK_EXPIRATION_SECONDS)
    const lockValue = crypto.randomUUID()

    const result = await this.backend.shouldRefresh(
      lastUpdateKey,
      refreshThreshold,
      currentTime,
      force,
      effectiveLockSeconds,
      lockValue,
    )

    return result
  }

  public async releaseLock(lastUpdateKey: string, lockValue: string) {
    this.assertOpen()
    const currentTime = Math.floor(Date.now() / 1000)
    return this.track(this.backend.releaseLock(lastUpdateKey, currentTime, lockValue))
  }

  public quit(preserveSharedCache = false) {
    return this.beginClose(preserveSharedCache, this.options.closeTimeoutMs ?? AdaptiveCache.DEFAULT_CLOSE_TIMEOUT_MS)
  }

  private detachBackendObserver() {
    const unsubscribe = this.unsubscribeBackend
    this.unsubscribeBackend = undefined
    const failed = (error: unknown) => this.emit({ type: 'error', reason: 'backend-unsubscribe', error })
    try {
      void Promise.resolve(unsubscribe?.()).catch(failed)
    } catch (error) {
      failed(error)
    }
  }

  private beginClose(preserveSharedCache: boolean, timeoutMs: number): Promise<unknown> {
    if (!this.closePromise) {
      validateTimer('timeoutMs', timeoutMs)
      this.closing = true
      this.closePromise = new Promise((resolve, reject) => {
        let expired = false
        const forceTeardown = () => {
          this.detachBackendObserver()
          // Forced teardown must not itself keep close pending for custom backends.
          void Promise.resolve()
            .then(() => this.backend.quit?.(preserveSharedCache, true))
            .catch(() => {})
        }
        const timer = setTimeout(() => {
          expired = true
          const error = new DOMException(`AdaptiveCache close timed out after ${timeoutMs}ms`, 'TimeoutError')
          this.loader.abort(error)
          forceTeardown()
          reject(error)
        }, timeoutMs)
        void (async () => {
          await this.flush()
          if (expired) return
          this.detachBackendObserver()
          return this.backend.quit?.(preserveSharedCache)
        })().then(
          (result) => {
            clearTimeout(timer)
            resolve(result)
          },
          (error) => {
            clearTimeout(timer)
            if (!expired) forceTeardown()
            reject(error)
          },
        )
      })
    }
    return this.closePromise
  }

  public async close(options: AdaptiveCacheCloseOptions = {}): Promise<void> {
    validateTimer('timeoutMs', options.timeoutMs)
    await this.beginClose(
      false,
      options.timeoutMs ?? this.options.closeTimeoutMs ?? AdaptiveCache.DEFAULT_CLOSE_TIMEOUT_MS,
    )
  }

  public async flush() {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
    return this.backend.flush?.()
  }
}
