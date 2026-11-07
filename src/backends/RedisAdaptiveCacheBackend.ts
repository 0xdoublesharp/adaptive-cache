import { normalizeTtlPolicy } from '../ttlPolicy'
import Redis from 'ioredis'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Logger } from '../lib/logger'
import { normalizeCacheTags } from '../tagValidation'
import {
  AdaptiveCacheBackend,
  AdaptiveCacheBackendFetchInput,
  AdaptiveCacheBackendUpdateInput,
  AdaptiveCacheFetchResult,
  AdaptiveCacheMetadata,
  AdaptiveCacheUpdateResult,
} from '../types'

interface RedisFeatureCommands {
  adaptiveCacheFetch(
    dataKey: string,
    allowStale: string,
  ): Promise<
    [
      string | null | false,
      number,
      string | number | false,
      string | number | false,
      string | number | false,
      string | false,
      number?,
      number?,
    ]
  >
  adaptiveCacheUpdate(...args: string[]): ReturnType<Redis['adaptiveCacheUpdate']>
  adaptiveCacheInvalidate(...args: string[]): Promise<string[]>
}

const asMetadataValue = (value: string | number | false | null | undefined) => {
  if (value === false || value === null || typeof value === 'undefined') return undefined
  return value
}

const metadataFromTuple = (
  dataTTL?: string | number | false | null,
  lastChanged?: string | number | false | null,
  changeCount?: string | number | false | null,
  hash?: string | false | null,
): AdaptiveCacheMetadata | undefined => {
  const metadata: AdaptiveCacheMetadata = {}
  const normalizedDataTTL = asMetadataValue(dataTTL)
  const normalizedLastChanged = asMetadataValue(lastChanged)
  const normalizedChangeCount = asMetadataValue(changeCount)
  const normalizedHash = asMetadataValue(hash)

  if (typeof normalizedDataTTL !== 'undefined') metadata.dataTTL = normalizedDataTTL
  if (typeof normalizedLastChanged !== 'undefined') metadata.lastChanged = normalizedLastChanged
  if (typeof normalizedChangeCount !== 'undefined') metadata.changeCount = normalizedChangeCount
  if (typeof normalizedHash === 'string') metadata.hash = normalizedHash

  return Object.keys(metadata).length > 0 ? metadata : undefined
}

const shouldUseTls = (redisURL: string | undefined) =>
  Boolean(process.env.REDIS_TLS_URL) || Boolean(redisURL?.startsWith('rediss://'))

const shouldRejectUnauthorizedTls = () =>
  process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false' && process.env.REDIS_INSECURE_TLS !== 'true'

export type RevisionedFetchResult = AdaptiveCacheFetchResult & { revision?: string; freshUntil?: number }

export class RedisAdaptiveCacheBackend implements AdaptiveCacheBackend {
  public readonly name = 'redis' as const
  public readonly supportsTtlPolicies = true
  public readonly client: Redis
  private readonly logger: Logger
  private readonly ownsClient: boolean
  private readonly maxTagCleanupKeys: number

  constructor(client: Redis, logger: Logger, ownsClient = false, maxTagCleanupKeys = 10_000) {
    if (!Number.isSafeInteger(maxTagCleanupKeys) || maxTagCleanupKeys <= 0)
      throw new RangeError('redis.maxTagCleanupKeys must be a positive safe integer')
    this.client = client
    this.logger = logger
    this.ownsClient = ownsClient
    this.maxTagCleanupKeys = maxTagCleanupKeys
    this.defineLuaScripts()
  }

  public static createClient(logger: Logger) {
    const redisURL = process.env.REDIS_TLS_URL || process.env.REDIS_URL
    const redisParams = shouldUseTls(redisURL) ? { tls: { rejectUnauthorized: shouldRejectUnauthorizedTls() } } : {}

    const client = redisURL
      ? new Redis(redisURL, redisParams)
      : new Redis({
          host: process.env.REDIS_HOST || 'localhost',
          port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
        })

    client.on('error', (err) => {
      logger.error('Redis client error:', err)
    })

    return client
  }

  private defineLuaScripts() {
    const luaPathCandidates = [path.resolve(__dirname, './redis-lua'), path.resolve(__dirname, '../redis-lua')]
    const luaPath = luaPathCandidates.find((candidate) => fs.existsSync(candidate)) || luaPathCandidates[0]

    const scripts = {
      adaptiveCacheFetch: { numberOfKeys: 1, file: 'adaptiveCacheFetch.lua' },
      adaptiveCacheUpdate: { numberOfKeys: 2, file: 'adaptiveCacheUpdate.lua' },
      shouldRefreshCache: { numberOfKeys: 2, file: 'shouldRefreshCache.lua' },
      releaseCacheRefreshLock: { numberOfKeys: 2, file: 'releaseCacheRefreshLock.lua' },
      adaptiveCacheInvalidate: { numberOfKeys: 1, file: 'adaptiveCacheInvalidate.lua' },
      adaptiveCacheValidate: { numberOfKeys: 1, file: 'adaptiveCacheValidate.lua' },
      adaptiveCacheCleanup: { numberOfKeys: 1, file: 'adaptiveCacheCleanup.lua' },
    }

    for (const [name, config] of Object.entries(scripts)) {
      if (!(this.client as any)[name]) {
        this.client.defineCommand(name, {
          numberOfKeys: config.numberOfKeys,
          lua: fs.readFileSync(path.join(luaPath, config.file), 'utf8'),
        })
      }
    }
  }

  public async fetch(input: AdaptiveCacheBackendFetchInput): Promise<RevisionedFetchResult | null> {
    const fetchedAt = Date.now()
    const [cachedData, remainingTTL, dataTTL, lastChanged, changeCount, hash, stale, staleAge, revision] = await (
      this.client as any
    ).adaptiveCacheFetch(input.dataKey, input.allowStale ? '1' : '0')

    if (!cachedData) {
      return null
    }

    let metadata = metadataFromTuple(dataTTL, lastChanged, changeCount, hash)

    if (input.includeDebugHeaders && !metadata) {
      const metaData = await this.client.hgetall(input.metaKey)
      if (Object.keys(metaData).length > 0) {
        metadata = {
          dataTTL: metaData.dataTTL,
          lastChanged: metaData.lastChanged,
          changeCount: metaData.changeCount,
          hash: metaData.hash,
        }
      }
    }

    return {
      encodedData: cachedData,
      revision: typeof revision === 'string' ? revision : undefined,
      freshUntil: fetchedAt + remainingTTL * 1000,
      ttl: remainingTTL,
      metadata,
      stale: stale === 1,
      staleAge: Number(staleAge || 0) / 1000,
      layer: 'redis',
    }
  }

  public async validateRevision(dataKey: string, prefix: string, token: string, revision?: string) {
    if (!revision) return false
    return (await (this.client as any).adaptiveCacheValidate(dataKey, prefix, token, revision)) === 1
  }

  public async update(input: AdaptiveCacheBackendUpdateInput): Promise<AdaptiveCacheUpdateResult> {
    const encodedTags = normalizeCacheTags(input.tags, 'Redis cache write').encoded
    const result = await (this.client as unknown as RedisFeatureCommands).adaptiveCacheUpdate(
      input.dataKey,
      input.metaKey,
      input.responseHash,
      input.encodedData,
      input.initialTTL.toString(),
      input.maxTTL.toString(),
      input.ttlScaling.toString(),
      input.metaTTL.toString(),
      input.writeToken || '',
      input.redisPrefix,
      input.key,
      encodedTags,
      String(input.staleTTL || 0),
      String(1 - Math.random() * (input.ttlJitter || 0)),
      input.lockKey || '',
      input.lockValue || '',
      randomUUID(),
      JSON.stringify(normalizeTtlPolicy(input.ttlPolicy)),
    )

    const [status, ttl, ...metadata] = result
    return [status, Number(ttl), ...metadata]
  }

  public async captureWriteToken(redisPrefix: string) {
    const keys = ['__adaptive:legacy-barrier', redisPrefix + '__adaptive:barrier', redisPrefix + '__adaptive:namespace']
    for (let attempt = 0; attempt < 3; attempt++) {
      const values = await this.client.mget(...keys)
      if (values.every((value) => value !== null)) return values.join(':')
      await Promise.all(
        keys.map((key, index) => (values[index] === null ? this.client.setnx(key, randomUUID()) : undefined)),
      )
    }
    throw new Error('Redis cannot retain invalidation barriers')
  }

  public async clear(key: string, _dataKey: string, _metaKey: string, redisPrefix?: string) {
    await (this.client as unknown as RedisFeatureCommands).adaptiveCacheInvalidate(
      '__adaptive:legacy-barrier',
      'clear',
      redisPrefix || '',
      key,
      '[]',
      randomUUID(),
      randomUUID(),
    )
  }

  public async invalidateNamespace(redisPrefix: string) {
    await (this.client as unknown as RedisFeatureCommands).adaptiveCacheInvalidate(
      '__adaptive:legacy-barrier',
      'namespace',
      redisPrefix,
      '',
      '[]',
      randomUUID(),
      randomUUID(),
    )
  }

  public async invalidateTags(tags: string[], redisPrefix: string): Promise<string[]> {
    const encodedTags = normalizeCacheTags(tags, 'Redis tag invalidation').encoded
    const detached = await (this.client as unknown as RedisFeatureCommands).adaptiveCacheInvalidate(
      '__adaptive:legacy-barrier',
      'tags',
      redisPrefix,
      '',
      encodedTags,
      randomUUID(),
      randomUUID(),
    )
    if (!detached.length) return []
    const snapshots: Array<{ tag: string; indexKey: string; kind: string; remaining: number }> = []
    for (let index = 0; index < detached.length; index += 4) {
      const [tag, indexKey, kind, count] = detached.slice(index, index + 4)
      snapshots.push({ tag, indexKey, kind, remaining: Number(count) })
    }
    const incomplete = () =>
      new Error('Redis tag invalidation cleanup incomplete: detached snapshot expired or was evicted')
    let renewalFailure: Error | undefined
    // Renew every active snapshot, including those queued behind a stalled batch.
    // If this process stops, renewal stops and the original 60s abandonment TTL applies.
    const renewal = globalThis.setInterval(() => {
      void Promise.all(
        snapshots
          .filter((snapshot) => snapshot.remaining > 0)
          .map((snapshot) => this.client.pexpire(snapshot.indexKey, 60000)),
      ).catch((cause) => {
        renewalFailure = Object.assign(
          new Error('Redis tag invalidation cleanup incomplete: detached snapshot renewal failed'),
          { cause },
        )
      })
    }, 10000)
    renewal.unref()
    const keys = new Set<string>()
    let processedMemberships = 0
    try {
      for (const snapshot of snapshots) {
        const { tag, indexKey, kind } = snapshot
        // No SMEMBERS or unbounded Lua member loop, including legacy indexes.
        let cursor = '0'
        while (snapshot.remaining > 0) {
          if (renewalFailure) throw renewalFailure
          let members: string[]
          if (kind === 'zset') {
            members = await this.client.zrange(indexKey, '0', '99')
          } else {
            const page = await this.client.sscan(indexKey, cursor, 'COUNT', '100')
            cursor = page[0]
            members = page[1]
          }
          if (!members.length && (kind === 'zset' || cursor === '0')) throw incomplete()
          for (let offset = 0; offset < members.length; offset += 100) {
            const batch = members.slice(offset, offset + 100)
            if (processedMemberships + batch.length > this.maxTagCleanupKeys)
              throw new Error(
                `Redis tag invalidation cleanup limit exceeded (${this.maxTagCleanupKeys} key memberships)`,
              )
            const removed = await (this.client as any).adaptiveCacheCleanup(
              indexKey,
              redisPrefix,
              tag,
              JSON.stringify(batch),
              kind,
            )
            if (removed < 0 || removed > snapshot.remaining) throw incomplete()
            snapshot.remaining -= removed
            processedMemberships += batch.length
            batch.forEach((key) => keys.add(key))
          }
        }
        await this.client.del(indexKey)
      }
      if (renewalFailure) throw renewalFailure
      return [...keys]
    } finally {
      globalThis.clearInterval(renewal)
    }
  }

  public async shouldRefresh(
    lastUpdateKey: string,
    refreshThreshold: number,
    currentTime: number,
    force: boolean,
    lockExpirationSeconds: number,
    lockValue: string,
  ) {
    const lockKey = lastUpdateKey + '-lock'
    const lockExpiration = lockExpirationSeconds * 1000

    return this.client.shouldRefreshCache(
      lastUpdateKey,
      lockKey,
      currentTime,
      refreshThreshold,
      lockExpiration,
      lockValue,
      force ? 1 : 0,
    )
  }

  public async releaseLock(lastUpdateKey: string, currentTime: number, lockValue: string, recordRefresh = true) {
    const lockKey = lastUpdateKey + '-lock'
    return this.client.releaseCacheRefreshLock(lastUpdateKey, lockKey, currentTime, lockValue, recordRefresh ? 1 : 0)
  }

  public async quit(_preserveSharedCache = false, force = false) {
    if (this.ownsClient) {
      if (force) {
        this.client.disconnect()
        return undefined
      }
      try {
        return await this.client.quit()
      } finally {
        // A rejected QUIT can leave a reconnect timer or socket alive.
        this.client.disconnect()
      }
    }
    return undefined
  }
}
