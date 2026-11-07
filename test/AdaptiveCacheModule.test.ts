import type Redis from 'ioredis'
import { describe, expect, it, vi } from 'vitest'
import { registerRedisCacheSuite } from './helpers/redisCacheSuite'

let cacheModule: typeof import('../src')
let redisClient: Redis

describe('AdaptiveCache Class & Utils', () => {
  registerRedisCacheSuite((suite) => {
    cacheModule = suite.cacheModule
    redisClient = suite.redisClient
  })

  it('should export redis client', () => {
    expect(cacheModule.redis).toBeDefined()
  })

  describe('cacheResult', () => {
    it('should cache function results', async () => {
      let callCount = 0
      const expensiveFn = async () => {
        callCount++
        return { data: 'expensive' }
      }

      const key = 'test-key'
      const result1 = await cacheModule.cacheResult(key, 10, expensiveFn)
      expect(result1).toEqual({ data: 'expensive' })
      expect(callCount).toBe(1)

      const result2 = await cacheModule.cacheResult(key, 10, expensiveFn)
      expect(result2).toEqual({ data: 'expensive' })
      expect(callCount).toBe(1)
    })

    it('should not cache null results', async () => {
      let callCount = 0
      const nullFn = async () => {
        callCount++
        return null
      }

      const key = 'null-key'
      const result1 = await cacheModule.cacheResult(key, 10, nullFn)
      expect(result1).toBeNull()
      expect(callCount).toBe(1)

      const result2 = await cacheModule.cacheResult(key, 10, nullFn)
      expect(result2).toBeNull()
      expect(callCount).toBe(2)
    })

    it('should cache falsy non-null results', async () => {
      let callCount = 0
      const falseFn = async () => {
        callCount++
        return false
      }

      const key = 'false-key'
      const result1 = await cacheModule.cacheResult(key, 10, falseFn)
      const result2 = await cacheModule.cacheResult(key, 10, falseFn)

      expect(result1).toBe(false)
      expect(result2).toBe(false)
      expect(callCount).toBe(1)
    })

    it('should hit cache in cacheResult', async () => {
      const key = 'hit-test'
      await redisClient.set(key, JSON.stringify({ hit: true }))

      const result = await cacheModule.cacheResult(key, 10, async () => ({ hit: false }))
      expect(result).toEqual({ hit: true })
    })
  })

  describe('Lua Scripts', () => {
    it('adaptive cache lua scripts preserve tuple positions and encode update TTLs as decimal text', async () => {
      const cache = new cacheModule.AdaptiveCache({ initialTTL: 10, includeDebugHeaders: true })

      await cache.set('lua-tuple-key', { a: 1 })

      const fetchTuple = await redisClient.adaptiveCacheFetch('lua-tuple-keydata')
      expect(fetchTuple[0]).toEqual(expect.any(String))
      expect(fetchTuple[1]).toEqual(expect.any(Number))
      expect(fetchTuple[2]).toBeDefined()
      expect(fetchTuple[3]).toBeDefined()
      expect(fetchTuple[4]).toBeDefined()
      expect(fetchTuple[5]).toEqual(expect.any(String))

      const updateTuple = await redisClient.adaptiveCacheUpdate(
        'lua-direct-keydata',
        'lua-direct-keymeta',
        'hash-1',
        JSON.stringify({ ok: true }),
        '5',
        '30',
        '2',
        '60',
      )

      expect(updateTuple[0]).toBe('CACHED')
      // Raw RESP integer replies lose fractional seconds. The backend converts
      // this decimal field to a number at the public API boundary.
      expect(updateTuple[1]).toBe('5')
      expect(updateTuple[2]).toBeDefined()
      expect(updateTuple[3]).toBeDefined()
      expect(updateTuple[4]).toBe('hash-1')
      expect(updateTuple[5]).toBe(1)
    })

    it('shouldRefreshCache should manage locks', async () => {
      const lastUpdateKey = 'test-update-key'
      const refreshThreshold = 10

      // First call, should refresh
      const [shouldRefresh, lockVal] = await cacheModule.shouldRefreshCache(lastUpdateKey, refreshThreshold)
      expect(shouldRefresh).toBe('UPDATE')
      expect(lockVal).toBeDefined()

      // Second call immediately, should be UPDATING (locked)
      const [shouldRefresh2] = await cacheModule.shouldRefreshCache(lastUpdateKey, refreshThreshold)
      expect(shouldRefresh2).toBe('UPDATING')

      // Release lock
      await cacheModule.releaseCacheRefreshLock(lastUpdateKey, lockVal as string)

      // Should be able to update again (or EXISTS if within threshold, but here we didn't update the timestamp)
      // Actually `releaseCacheRefreshLock` updates the timestamp to NOW.
      // So if we check again, it should be EXISTS (valid cache)
      const [shouldRefresh3] = await cacheModule.shouldRefreshCache(lastUpdateKey, refreshThreshold)
      expect(shouldRefresh3).toBe('EXISTS')
    })

    it('shouldRefreshCache should handle force option', async () => {
      const lastUpdateKey = 'force-key'
      await redisClient.set(lastUpdateKey, Math.floor(Date.now() / 1000))
      expect((await cacheModule.shouldRefreshCache(lastUpdateKey, 10))[0]).toBe('EXISTS')
      const [shouldRefresh] = await cacheModule.shouldRefreshCache(lastUpdateKey, 10, true)
      expect(shouldRefresh).toBe('UPDATE')
    })

    it('should apply global lockExpiration default', async () => {
      // set a global lock expiration default and ensure shouldRefreshCache still works
      await cacheModule.setDefaultLockExpirationSeconds(30)
      const lastUpdateKey = 'global-lock-key'
      const [shouldRefresh] = await cacheModule.shouldRefreshCache(lastUpdateKey, 10)
      expect(shouldRefresh).toBe('UPDATE')
      const remaining = await redisClient.pttl(lastUpdateKey + '-lock')
      expect(remaining).toBeGreaterThan(29000)
      expect(remaining).toBeLessThanOrEqual(30000)
      cacheModule.setDefaultLockExpirationSeconds(60)
    })

    it('should keep adapter lock expiration instance-local', async () => {
      const spy = vi.spyOn(cacheModule.AdaptiveCache, 'setDefaultLockExpirationSeconds')
      cacheModule.adaptiveExpressCache({ lockExpirationSeconds: 123 })
      expect(spy).not.toHaveBeenCalled()
    })
  })

  describe('Singleton Proxy', () => {
    it('should proxy properties', () => {
      // Access a property that is not a function to cover the getter branch
      expect(cacheModule.redis.status).toBeDefined()
    })

    it('should access non-function properties on redis client', () => {
      // ioredis client has properties like 'status', 'options'
      const status = cacheModule.redis.status
      expect(status).toBeDefined()
    })
  })

  describe('Module Exports', () => {
    it('should export all required members', () => {
      expect(cacheModule.AdaptiveCache).toBeDefined()
      expect(cacheModule.getDefaultCache).toBeDefined()
      expect(cacheModule.redis).toBeDefined()
      expect(cacheModule.adaptiveExpressCache).toBeDefined()
      expect(cacheModule.clearAdaptiveCache).toBeDefined()
      expect(cacheModule.adaptiveFastifyCache).toBeDefined()
      expect(cacheModule.cacheResult).toBeDefined()
      expect(cacheModule.setDefaultLockExpirationSeconds).toBeDefined()
      expect(cacheModule.shouldRefreshCache).toBeDefined()
      expect(cacheModule.releaseCacheRefreshLock).toBeDefined()
    })

    it('shouldRefreshCache should call internal instance', async () => {
      const spy = vi.spyOn(cacheModule.getDefaultCache(), 'shouldRefresh')
      await cacheModule.shouldRefreshCache('key', 10)
      expect(spy).toHaveBeenCalled()
    })

    it('releaseCacheRefreshLock should call internal instance', async () => {
      const spy = vi.spyOn(cacheModule.getDefaultCache(), 'releaseLock')
      await cacheModule.releaseCacheRefreshLock('key', 'lock')
      expect(spy).toHaveBeenCalled()
    })

    it('should call setDefaultLockExpirationSeconds', () => {
      const spy = vi.spyOn(cacheModule.AdaptiveCache, 'setDefaultLockExpirationSeconds')
      cacheModule.setDefaultLockExpirationSeconds(100)
      expect(spy).toHaveBeenCalledWith(100)
    })
  })

  describe('AdaptiveCache Static', () => {
    it('should use static default lock expiration', () => {
      // Just accessing the static property to ensure coverage
      const val = cacheModule.AdaptiveCache.DEFAULT_LOCK_EXPIRATION_SECONDS
      expect(val).toBeDefined()
    })
  })
})
