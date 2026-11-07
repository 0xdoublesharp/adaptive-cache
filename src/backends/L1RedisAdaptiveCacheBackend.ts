import Redis from 'ioredis'
import { randomUUID } from 'node:crypto'
import { Logger } from '../lib/logger'
import { normalizeCacheTags } from '../tagValidation'
import {
  AdaptiveCacheBackend,
  AdaptiveCacheBackendFetchInput,
  AdaptiveCacheBackendUpdateInput,
  AdaptiveCacheUpdateResult,
} from '../types'
import { ClusteredLruAdaptiveCacheBackend } from './ClusteredLruAdaptiveCacheBackend'
import { RedisAdaptiveCacheBackend } from './RedisAdaptiveCacheBackend'

interface InvalidationMessage {
  source: string
  keys: string[]
}

interface ClientState {
  pendingUpdates: Set<Promise<void>>
  hydrations: Set<Promise<unknown>>
  generation: number
  references: number
}

// Middleware and temporary invalidators share the same caller-owned client.
const clientStates = new WeakMap<Redis, Map<string, ClientState>>()
const MAX_INVALIDATION_PAYLOAD_BYTES = 256 * 1024
const MAX_INVALIDATION_KEYS = 1024
const MAX_INVALIDATION_KEY_BYTES = 4096
const MAX_PENDING_INVALIDATION_KEYS = 4096
const INVALIDATION_BATCH_SIZE = 128

export class L1RedisAdaptiveCacheBackend implements AdaptiveCacheBackend {
  public readonly name = 'l1-redis' as const
  public readonly supportsTtlPolicies = true
  public readonly client: Redis
  private readonly redis: RedisAdaptiveCacheBackend
  private readonly lru: ClusteredLruAdaptiveCacheBackend
  private readonly logger: Logger
  private readonly writeMode: 'async' | 'await-redis'
  private readonly state: ClientState
  private readonly stateMap: Map<string, ClientState>
  private readonly sourceId = randomUUID()
  private readonly channel: string
  private readonly redisPrefix: string
  private subscriber?: Redis
  private readonly pendingInvalidationKeys = new Set<string>()
  private invalidationDrain?: Promise<void>
  private invalidationFailure?: unknown
  private stateReleased = false

  constructor(
    redis: RedisAdaptiveCacheBackend,
    lru: ClusteredLruAdaptiveCacheBackend,
    redisPrefix: string,
    logger: Logger,
    writeMode: 'async' | 'await-redis' = 'async',
  ) {
    this.redisPrefix = redisPrefix
    this.redis = redis
    this.client = redis.client
    let states = clientStates.get(this.client)
    if (!states) {
      states = new Map()
      clientStates.set(this.client, states)
    }
    let state = states.get(redisPrefix)
    if (!state) {
      state = { pendingUpdates: new Set(), hydrations: new Set(), generation: 0, references: 0 }
      states.set(redisPrefix, state)
    }
    state.references++
    this.state = state
    this.stateMap = states
    this.lru = lru
    this.logger = logger
    this.writeMode = writeMode
    this.channel = redisPrefix + 'l1:invalidate'
    this.subscribeInvalidations()
  }

  public async fetch(input: AdaptiveCacheBackendFetchInput) {
    const token = await this.redis.captureWriteToken(input.redisPrefix)
    const l1Result = await this.lru.fetch(input)
    if (
      l1Result &&
      l1Result.writeToken === token &&
      (await this.redis.validateRevision(input.dataKey, input.redisPrefix, token, l1Result.revision))
    ) {
      // Validation latency cannot extend the L1 lifetime.
      if (!l1Result.freshUntil || l1Result.freshUntil > Date.now()) return { ...l1Result, layer: 'l1' as const }
    }
    if (l1Result) await this.lru.deleteKeys([input.key])

    // Pub/sub accelerates eviction; Redis revision checks keep reads coherent
    // even while the subscriber is unavailable or still connecting.
    const generation = this.state.generation
    const redisResult = await this.redis.fetch(input)
    if (redisResult && redisResult.ttl > 0 && generation === this.state.generation) {
      const hydration = this.lru.hydrateFromFetch(input, redisResult, token)
      this.state.hydrations.add(hydration)
      try {
        await hydration
      } catch (err) {
        this.logger.warn('Failed to hydrate clustered LRU from Redis:', err)
      } finally {
        this.state.hydrations.delete(hydration)
      }
    }

    return redisResult
  }

  public async update(input: AdaptiveCacheBackendUpdateInput): Promise<AdaptiveCacheUpdateResult> {
    input = { ...input, tags: normalizeCacheTags(input.tags, 'L1 Redis cache write').tags }
    const token = input.writeToken || (await this.redis.captureWriteToken(input.redisPrefix))
    // Explicitly fenced writes cannot be visible before Redis accepts them.
    const optimistic = this.writeMode === 'async' && (!input.writeToken || input.allowOptimistic) && !input.lockKey
    if (optimistic) {
      await this.lru.storeConservative({ ...input, writeToken: token })
    }

    const redisUpdate = this.redis
      .update({ ...input, writeToken: token })
      .then<AdaptiveCacheUpdateResult>(async (result) => {
        if (result[0] === 'INVALIDATED') return result
        if (token !== (await this.redis.captureWriteToken(input.redisPrefix))) return ['INVALIDATED', 0]
        // Use the remaining Redis lifetime: hydration latency and jitter must not extend freshness.
        const current = await this.redis.fetch({ ...input, includeDebugHeaders: true })
        if (current && current.ttl > 0 && current.encodedData === input.encodedData) {
          await this.lru.hydrateFromFetch({ ...input, includeDebugHeaders: true }, current, token)
        }
        if (!current || current.ttl <= 0) await this.lru.deleteKeys([input.key])
        const changed = result[5] === 1
        if (changed) {
          await this.publishInvalidation([input.key])
        }
        return result
      })

    const trackedUpdate = redisUpdate.then(
      () => undefined,
      () => undefined,
    )
    this.state.pendingUpdates.add(trackedUpdate)
    trackedUpdate.then(() => this.state.pendingUpdates.delete(trackedUpdate))

    if (!optimistic) {
      return redisUpdate.catch((err) => {
        this.logger.error('Redis adaptive cache update failed after L1 write:', err)
        throw err
      })
    }

    redisUpdate.catch((err) => {
      this.logger.error('Redis adaptive cache update failed after L1 write:', err)
    })

    return ['CACHED', input.initialTTL, Math.floor(Date.now() / 1000), 0, input.responseHash, 1]
  }

  public captureWriteToken(redisPrefix: string) {
    return this.redis.captureWriteToken(redisPrefix)
  }

  public onEvent(listener: Parameters<ClusteredLruAdaptiveCacheBackend['onEvent']>[0]) {
    return this.lru.onEvent(listener)
  }

  public async invalidateNamespace(redisPrefix: string) {
    this.state.generation++
    await this.redis.invalidateNamespace(redisPrefix)
    await this.lru.invalidateNamespace(redisPrefix)
  }

  public async clear(key: string, dataKey: string, metaKey: string, redisPrefix = this.redisPrefix) {
    this.state.generation++
    await this.flush()
    await this.redis.clear(key, dataKey, metaKey, redisPrefix)
    this.state.generation++
    await Promise.allSettled([...this.state.hydrations])
    await this.lru.clear(key, dataKey, metaKey, redisPrefix)
    await this.publishInvalidation([key])
  }

  public async invalidateTags(tags: string[], redisPrefix: string) {
    tags = normalizeCacheTags(tags, 'L1 Redis tag invalidation').tags
    this.state.generation++
    await this.flush()
    const redisKeys = await this.redis.invalidateTags(tags, redisPrefix)
    this.state.generation++
    await Promise.allSettled([...this.state.hydrations])
    const lruKeys = await this.lru.invalidateTags(tags, redisPrefix)
    const keys = Array.from(new Set([...lruKeys, ...redisKeys]))

    if (keys.length > 0) {
      await this.lru.deleteKeys(keys)
      await this.publishInvalidation(keys)
    }

    return keys
  }

  public shouldRefresh(
    lastUpdateKey: string,
    refreshThreshold: number,
    currentTime: number,
    force: boolean,
    lockExpirationSeconds: number,
    lockValue: string,
  ) {
    return this.redis.shouldRefresh(
      lastUpdateKey,
      refreshThreshold,
      currentTime,
      force,
      lockExpirationSeconds,
      lockValue,
    )
  }

  public releaseLock(lastUpdateKey: string, currentTime: number, lockValue: string, recordRefresh = true) {
    return this.redis.releaseLock(lastUpdateKey, currentTime, lockValue, recordRefresh)
  }

  public async quit(preserveSharedCache = false, force = false) {
    const failures: unknown[] = []
    for (const cleanup of [
      async () => {
        if (!force) await this.flush()
      },
      async () => {
        const subscriber = this.subscriber
        if (!subscriber) return
        try {
          if (!force) await subscriber.quit()
        } finally {
          subscriber.disconnect()
          this.subscriber = undefined
        }
      },
      // Disconnect Redis before a potentially stalled local cache teardown.
      () => this.redis.quit(preserveSharedCache, force),
      () => this.lru.quit(preserveSharedCache),
    ]) {
      try {
        await cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
    this.releaseClientState()
    if (failures.length > 0) throw failures[0]
  }

  public async flush() {
    await Promise.allSettled(Array.from(this.state.pendingUpdates))
    let retried = false
    for (;;) {
      while (this.invalidationDrain) await this.invalidationDrain
      if (!this.invalidationFailure) return
      if (!retried && this.pendingInvalidationKeys.size > 0) {
        retried = true
        this.invalidationFailure = undefined
        this.scheduleInvalidationDrain()
        continue
      }
      throw this.invalidationFailure
    }
  }

  private subscribeInvalidations() {
    try {
      this.subscriber = this.client.duplicate()
      this.subscriber.on('message', (channel, payload) => {
        if (channel === this.channel) this.handleInvalidation(payload)
      })
      this.subscriber.on('error', (err) => {
        this.logger.warn('Redis L1 invalidation subscriber error:', err)
      })
      this.subscriber.subscribe(this.channel).catch((err) => {
        this.logger.warn('Failed to subscribe to Redis L1 invalidations:', err)
      })
    } catch (err) {
      this.logger.warn('Failed to start Redis L1 invalidation subscriber:', err)
    }
  }

  private handleInvalidation(payload: string) {
    if (Buffer.byteLength(payload, 'utf8') > MAX_INVALIDATION_PAYLOAD_BYTES) return
    let message: InvalidationMessage
    try {
      message = JSON.parse(payload)
    } catch (err) {
      this.logger.warn('Invalid Redis L1 invalidation message:', err)
      return
    }

    if (
      !message ||
      typeof message !== 'object' ||
      typeof message.source !== 'string' ||
      message.source === this.sourceId ||
      !Array.isArray(message.keys) ||
      message.keys.length === 0 ||
      message.keys.length > MAX_INVALIDATION_KEYS ||
      !message.keys.every(
        (key) => typeof key === 'string' && key.length > 0 && Buffer.byteLength(key, 'utf8') <= MAX_INVALIDATION_KEY_BYTES,
      )
    ) {
      return
    }

    let added = false
    for (const key of new Set(message.keys)) {
      if (this.pendingInvalidationKeys.has(key)) continue
      if (this.pendingInvalidationKeys.size >= MAX_PENDING_INVALIDATION_KEYS) break
      this.pendingInvalidationKeys.add(key)
      added = true
    }
    if (!added) return
    this.state.generation++
    this.scheduleInvalidationDrain()
  }

  private scheduleInvalidationDrain() {
    if (this.invalidationDrain || this.pendingInvalidationKeys.size === 0) return
    let failed = false
    const drain = async () => {
      while (this.pendingInvalidationKeys.size > 0) {
        const keys = Array.from(this.pendingInvalidationKeys).slice(0, INVALIDATION_BATCH_SIZE)
        await Promise.allSettled([...this.state.hydrations])
        await this.lru.deleteKeys(keys)
        keys.forEach((key) => this.pendingInvalidationKeys.delete(key))
      }
    }
    const tracked = drain()
      .then(() => {
        this.invalidationFailure = undefined
      })
      .catch((err) => {
        failed = true
        this.invalidationFailure = err
        this.logger.warn('Failed to apply Redis L1 invalidation:', err)
      })
      .finally(() => {
        this.invalidationDrain = undefined
        if (!failed) this.scheduleInvalidationDrain()
      })
    this.invalidationDrain = tracked
  }

  private async publishInvalidation(keys: string[]) {
    if (keys.length === 0) return
    try {
      const baseBytes = Buffer.byteLength(JSON.stringify({ source: this.sourceId, keys: [] }), 'utf8')
      let batch: string[] = []
      let batchBytes = baseBytes
      const publishBatch = async () => {
        if (batch.length === 0) return
        await this.client.publish(this.channel, JSON.stringify({ source: this.sourceId, keys: batch }))
        batch = []
        batchBytes = baseBytes
      }
      for (const key of new Set(keys)) {
        if (typeof key !== 'string' || key.length === 0 || Buffer.byteLength(key, 'utf8') > MAX_INVALIDATION_KEY_BYTES)
          continue
        const encodedBytes = Buffer.byteLength(JSON.stringify(key), 'utf8')
        const separatorBytes = batch.length === 0 ? 0 : 1
        if (
          batch.length >= MAX_INVALIDATION_KEYS ||
          batchBytes + separatorBytes + encodedBytes > MAX_INVALIDATION_PAYLOAD_BYTES
        )
          await publishBatch()
        batch.push(key)
        batchBytes += (batch.length === 1 ? 0 : 1) + encodedBytes
      }
      await publishBatch()
    } catch (err) {
      this.logger.warn('Failed to publish Redis L1 invalidation:', err)
    }
  }

  private releaseClientState() {
    if (this.stateReleased) return
    this.stateReleased = true
    this.state.references--
    if (this.state.references === 0) this.stateMap.delete(this.redisPrefix)
  }
}
