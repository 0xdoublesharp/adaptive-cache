import {
  AdaptiveCacheBackend,
  AdaptiveCacheBackendName,
  AdaptiveCacheL1RedisOptions,
  AdaptiveCacheLruOptions,
  AdaptiveCacheOptions,
  AdaptiveCacheRedisOptions,
} from './types'
import { AdaptiveCache } from './AdaptiveCache'
import { getDefaultCache, redis } from './singleton'
import { adaptiveExpressCache, clearAdaptiveCache } from './AdaptiveExpressCache'
import { adaptiveFastifyCache } from './AdaptiveFastifyCache'
import { cache } from './utils'

export {
  AdaptiveCacheOptions,
  AdaptiveCacheBackend,
  AdaptiveCacheBackendName,
  AdaptiveCacheL1RedisOptions,
  AdaptiveCacheLruOptions,
  AdaptiveCacheRedisOptions,
  AdaptiveCache,
}
export type {
  AdaptiveCacheTtlPolicy,
  AdaptiveCacheTtlPolicyState,
  AdaptiveCacheHit,
  AdaptiveCacheSetOptions,
  AdaptiveCacheLoadOptions,
  AdaptiveCacheLoaderContext,
  AdaptiveCacheCloseOptions,
  AdaptiveCacheEvent,
  AdaptiveCacheEventType,
  AdaptiveCacheStats,
  AdaptiveCacheLayer,
  AdaptiveCacheCompressionOptions,
  AdaptiveCacheFetchResult,
  AdaptiveCacheBackendFetchInput,
  AdaptiveCacheBackendUpdateInput,
  AdaptiveCacheUpdateResult,
} from './types'
export { getDefaultCache, redis }
export { bootstrapClusteredLru } from './backends/ClusteredLruAdaptiveCacheBackend'
export { adaptiveExpressCache, clearAdaptiveCache, adaptiveFastifyCache, cache }
export type { AdaptiveExpressCacheOptions, AdaptiveExpressCacheMiddleware } from './AdaptiveExpressCache'
export type { AdaptiveFastifyCacheOptions, AdaptiveFastifyCachePlugin } from './AdaptiveFastifyCache'

// Util to easily cache functions outside of the controller flow
export const cacheResult = async (key: string, timeInSeconds: number, callback: () => Promise<any>) => {
  const client = getDefaultCache().client
  // try to fetch the data from redis
  let cached = await client.get(key)
  if (cached) {
    // if we get a result parse it and return it
    return JSON.parse(cached)
  }

  // Fetch results from the callback
  const results = await callback()

  if (results === null || typeof results === 'undefined') {
    return null
  }

  await client.set(key, JSON.stringify(results), 'EX', timeInSeconds)

  return results
}

// Module-level configurable defaults
export const setDefaultLockExpirationSeconds = (secs: number) => {
  AdaptiveCache.setDefaultLockExpirationSeconds(secs)
}

export const shouldRefreshCache = async (
  lastUpdateKey: string,
  refreshThreshold: number,
  force = false,
  lockExpirationSeconds?: number,
) => {
  return getDefaultCache().shouldRefresh(lastUpdateKey, refreshThreshold, force, lockExpirationSeconds)
}

export const releaseCacheRefreshLock = async (lastUpdateKey: string, lockValue: string) => {
  return getDefaultCache().releaseLock(lastUpdateKey, lockValue)
}
