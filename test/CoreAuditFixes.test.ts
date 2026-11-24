import { performance } from 'node:perf_hooks'
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { AdaptiveCache } from '../src/AdaptiveCache'
import { cache } from '../src/utils'
import { gate, registerCoreCacheFixture } from './helpers/coreCache'
import { ControlledBackend } from './helpers/httpFixtures'
import { registerRedisCacheSuite } from './helpers/redisCacheSuite'

const MAX_TTL = 2_147_483_647
const { create } = registerCoreCacheFixture()
const fixture = (options: ConstructorParameters<typeof AdaptiveCache>[0] = {}) => {
  const backend = new ControlledBackend()
  return { backend, cache: create({ backend, compress: false, ...options }) }
}

describe('core cache validation', () => {
  it.each(['initialTTL', 'maxTTL', 'staleTTL', 'metaTTL', 'negativeTTL'] as const)(
    'rejects an overflowing %s at construction',
    (name) => {
      expect(() => fixture({ [name]: MAX_TTL + 1 })).toThrow(RangeError)
    },
  )

  it.each([
    { initialTTL: MAX_TTL, staleIfError: 1 },
    { maxTTL: MAX_TTL, staleWhileRevalidate: 1 },
  ])('rejects overflowing configured retention for %j', (options) => {
    expect(() => fixture(options)).toThrow(RangeError)
  })

  it('validates write and dynamic TTLs before capturing a token or updating storage', async () => {
    const { cache, backend } = fixture({ maxTTL: (data) => data.max })
    const capture = vi.spyOn(backend, 'captureWriteToken')
    await expect(cache.set('large-static', 1, { maxTTL: MAX_TTL + 1 })).rejects.toThrow(RangeError)
    await expect(cache.set('large-stale', 1, { staleTTL: MAX_TTL + 1 })).rejects.toThrow(RangeError)
    await expect(cache.set('large-dynamic', { max: MAX_TTL + 1 })).rejects.toThrow(RangeError)
    await expect(cache.set('large-retention', { max: MAX_TTL }, { staleTTL: 0.5 })).rejects.toThrow(RangeError)
    expect(capture).not.toHaveBeenCalled()
    expect(backend.updateInputs).toEqual([])
    await cache.set('boundary', { max: MAX_TTL - 0.5 }, { staleTTL: 0.5 })
    expect(backend.updateInputs[0]).toMatchObject({ maxTTL: MAX_TTL - 0.5, staleTTL: 0.5 })
  })

  it('rejects loader TTL overflow without writing the loaded result', async () => {
    const { cache, backend } = fixture()
    const acquire = vi.spyOn(backend, 'shouldRefresh')
    const loader = vi.fn(async () => 'loaded')
    await expect(cache.getOrSet('negative', loader, { negativeTTL: MAX_TTL + 1 })).rejects.toThrow(RangeError)
    await expect(cache.getOrSet('retention', loader, { maxTTL: MAX_TTL, staleIfError: 1 })).rejects.toThrow(RangeError)
    await expect(cache.getOrSet('tag', loader, { tags: ['\ud800'] })).rejects.toThrow(RangeError)
    expect(loader).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
    await expect(cache.getOrSet('dynamic', loader, { maxTTL: () => MAX_TTL + 1 })).rejects.toThrow(RangeError)
    expect(loader).toHaveBeenCalledOnce()
    expect(backend.updateInputs).toEqual([])
  })

  it('ignores array length without changing the payload or its fingerprint', async () => {
    const normal = fixture()
    const ignored = fixture({ ignoreFields: ['rows.length'] })
    const value = { rows: [{ id: 3 }] }
    await normal.cache.set('normal', value)
    await ignored.cache.set('ignored', value)
    expect(ignored.backend.updateInputs[0].responseHash).toBe(normal.backend.updateInputs[0].responseHash)
    expect((await ignored.cache.get('ignored'))?.data).toEqual(value)
  })

  it('parses fractional seconds and larger units', () => {
    expect(cache('1.5 minutes')).toEqual({ initialTTL: 90 })
    expect(cache('0.5 seconds')).toEqual({ initialTTL: 0.5 })
    expect(cache('1.25')).toEqual({ initialTTL: 1.25 })
    expect(cache('2.5 HOURS')).toEqual({ initialTTL: 9000 })
  })
})

describe('loader deadlines and fallbacks', () => {
  it('releases a lease returned after a pending acquisition has timed out', async () => {
    const { cache, backend } = fixture()
    const acquiring = gate()
    const grant = gate()
    const releasing = gate()
    const finishRelease = gate()
    vi.spyOn(backend, 'shouldRefresh').mockImplementation(async () => {
      acquiring.resolve()
      await grant.promise
      return ['UPDATE', 'late-lock']
    })
    const release = vi.spyOn(backend, 'releaseLock').mockImplementation(async () => {
      releasing.resolve()
      await finishRelease.promise
      return ['UPDATED']
    })
    const loader = vi.fn(async () => 'unused')
    const result = cache.getOrSet('late-lease', loader, { lockWaitTimeoutMs: 15 }).catch((error: Error) => error)
    await acquiring.promise
    const flushed = vi.fn()
    const flushing = cache.flush().then(flushed)
    try {
      const observed = await Promise.race([result, new Promise((resolve) => setTimeout(resolve, 100, 'pending'))])
      expect(observed).toMatchObject({ message: 'Timed out waiting for cache loader lock for late-lease' })
      expect(flushed).not.toHaveBeenCalled()
      grant.resolve()
      await releasing.promise
      await setImmediate()
      expect(flushed).not.toHaveBeenCalled()
    } finally {
      grant.resolve()
      finishRelease.resolve()
      await Promise.all([result, flushing])
    }
    expect(loader).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledExactlyOnceWith(
      'adaptive:loader:late-lease',
      expect.any(Number),
      'late-lock',
      false,
    )
  })

  it.each(['caller', 'lock'])('releases a lease granted after the monotonic %s deadline', async (deadline) => {
    const { cache, backend } = fixture()
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    vi.spyOn(backend, 'shouldRefresh').mockImplementation(async () => {
      clock.mockReturnValue(1100)
      return ['UPDATE', 'late-lock']
    })
    const release = vi.spyOn(backend, 'releaseLock')
    const loader = vi.fn(async () => 'unused')
    const timeout = deadline === 'caller' ? { loadTimeoutMs: 1000 } : { lockWaitTimeoutMs: 1000 }
    const error =
      deadline === 'caller'
        ? { name: 'TimeoutError' }
        : { message: 'Timed out waiting for cache loader lock for late-lease' }
    await expect(cache.getOrSet('late-lease', loader, timeout)).rejects.toMatchObject(error)
    await cache.flush()
    expect(loader).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledExactlyOnceWith(
      'adaptive:loader:late-lease',
      expect.any(Number),
      'late-lock',
      false,
    )
  })

  it('checks monotonic time before work and after a synchronous loader returns', async () => {
    const { cache, backend } = fixture()
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    const read = vi.spyOn(backend, 'fetch')
    const loader = vi.fn(async () => 'unused')
    const tooLate = cache.getOrSet('before-work', loader, { loadTimeoutMs: 1000 })
    clock.mockReturnValue(1100)
    await expect(tooLate).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(read).not.toHaveBeenCalled()
    expect(loader).not.toHaveBeenCalled()

    let signal!: AbortSignal
    await expect(
      cache.getOrSet(
        'late-result',
        async (context) => {
          signal = context.signal
          clock.mockReturnValue(2100)
          return 'too late'
        },
        { loadTimeoutMs: 1000 },
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(signal.aborted).toBe(true)
    expect(backend.updateInputs).toEqual([])
  })

  it('keeps shared work running for a caller whose deadline has not expired', async () => {
    const { cache, backend } = fixture()
    const started = gate()
    const finish = gate()
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    const loader = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      started.resolve()
      await finish.promise
      clock.mockReturnValue(1100)
      signal.throwIfAborted()
      return 'shared value'
    })
    const first = cache.getOrSet('shared', loader, { loadTimeoutMs: 1000 }).catch((error: Error) => error)
    await started.promise
    const second = cache.getOrSet('shared', loader, { loadTimeoutMs: 2000 })
    await setImmediate()
    finish.resolve()
    expect(await first).toMatchObject({ name: 'TimeoutError' })
    await expect(second).resolves.toBe('shared value')
    expect(loader).toHaveBeenCalledOnce()
    expect(backend.updateInputs).toHaveLength(1)
  })

  it('checks the deadline again after fingerprinting and before backend update', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    const { cache, backend } = fixture({
      fingerprint: () => {
        clock.mockReturnValue(1100)
        return 'fingerprint'
      },
    })
    await expect(cache.getOrSet('fingerprint', async () => 'value', { loadTimeoutMs: 1000 })).rejects.toMatchObject({
      name: 'TimeoutError',
    })
    expect(backend.updateInputs).toEqual([])
  })

  it('checks the deadline before returning a fresh hit', async () => {
    const { cache, backend } = fixture()
    await cache.set('hit', 'previous value')
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    const fetch = backend.fetch.bind(backend)
    vi.spyOn(backend, 'fetch').mockImplementation(async (input) => {
      clock.mockReturnValue(1100)
      return fetch(input)
    })
    const loader = vi.fn(async () => 'unused')
    await expect(cache.getOrSet('hit', loader, { loadTimeoutMs: 1000 })).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(loader).not.toHaveBeenCalled()
  })

  it.each([
    { value: null, isNegative: undefined },
    { value: undefined, isNegative: undefined },
    { value: { status: 404 }, isNegative: (value: unknown) => (value as { status: number }).status === 404 },
  ])('propagates the source error when $value is cached as negative', async ({ value, isNegative }) => {
    const { cache } = fixture()
    const options = { isNegative, negativeTTL: 20 }
    await cache.getOrSet('negative', async () => value, options)
    expect((await cache.get('negative'))?.data).toEqual(value)
    const failure = new Error('source unavailable')
    await expect(
      cache.getOrSet(
        'negative',
        async () => {
          throw failure
        },
        {
          ...options,
          forceRefresh: true,
          staleIfError: 5,
        },
      ),
    ).rejects.toBe(failure)
  })

  it('repairs corrupt entries on force refresh and preserves source errors on fallback decoding failure', async () => {
    const { cache, backend } = fixture()
    const corrupt = { encodedData: 'adaptive-cache:v2:gzip:AAAA', ttl: 30 }
    backend.entries.set('corrupt', corrupt)
    const fetch = vi.spyOn(backend, 'fetch')
    const failure = new Error('loader failed')
    await expect(
      cache.getOrSet(
        'corrupt',
        async () => {
          throw failure
        },
        {
          forceRefresh: true,
          staleIfError: 5,
        },
      ),
    ).rejects.toBe(failure)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ allowStale: true }))
    fetch.mockClear()
    await expect(
      cache.getOrSet('corrupt', async () => 'repaired', { forceRefresh: true, staleIfError: 5 }),
    ).resolves.toBe('repaired')
    expect(fetch).not.toHaveBeenCalled()
    const cacheError = new Error('cache write failed')
    vi.spyOn(backend, 'update').mockRejectedValue(cacheError)
    await expect(cache.getOrSet('corrupt', async () => 'unused', { forceRefresh: true, staleIfError: 5 })).rejects.toBe(
      cacheError,
    )
    expect(fetch).not.toHaveBeenCalled()
    expect((await cache.get('corrupt'))?.data).toBe('repaired')
  })
})

describe('operation draining', () => {
  it('waits for a sole caller’s lock release in flush and close after cancellation', async () => {
    const { cache, backend } = fixture()
    const started = gate()
    const releasing = gate()
    const finish = gate()
    vi.spyOn(backend, 'releaseLock').mockImplementation(async () => {
      releasing.resolve()
      await finish.promise
      return ['UPDATED']
    })
    const controller = new AbortController()
    const outcome = cache
      .getOrSet(
        'cancel',
        async () => {
          started.resolve()
          return new Promise(() => {})
        },
        { signal: controller.signal },
      )
      .catch((error: Error) => error)
    await started.promise
    controller.abort()
    await releasing.promise
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    const flushed = vi.fn()
    const closed = vi.fn()
    const flushing = cache.flush().then(flushed)
    const closing = cache.close().then(closed)
    try {
      await setImmediate()
      expect(flushed).not.toHaveBeenCalled()
      expect(closed).not.toHaveBeenCalled()
      expect(backend.quitCalls).toBe(0)
    } finally {
      finish.resolve()
      await Promise.all([flushing, closing])
    }
    expect(backend.quitCalls).toBe(1)
  })

  it('bounds shutdown when lock release stalls', async () => {
    const backend = new ControlledBackend()
    const cache = new AdaptiveCache({ backend, closeTimeoutMs: 15, logLevel: 'silent' })
    const releasing = gate()
    const finish = gate()
    const quit = vi.spyOn(backend, 'quit')
    vi.spyOn(backend, 'releaseLock').mockImplementation(async () => {
      releasing.resolve()
      await finish.promise
      return ['UPDATED']
    })
    const loading = cache.getOrSet('cancel', async () => 'loaded').catch((error: Error) => error)
    await releasing.promise
    try {
      await expect(cache.close()).rejects.toMatchObject({ name: 'TimeoutError' })
      expect(quit).toHaveBeenCalledExactlyOnceWith(false, true)
      expect(await loading).toMatchObject({ name: 'TimeoutError' })
    } finally {
      finish.resolve()
      await cache.flush()
    }
  })

  type ReentrantOperation = (
    cache: AdaptiveCache,
    backend: ControlledBackend,
    hold: () => Promise<void>,
  ) => Promise<unknown>
  const reentrantOperations: Record<string, ReentrantOperation> = {
    get: (cache, backend, hold) => {
      vi.spyOn(backend, 'fetch').mockImplementation(async () => {
        await hold()
        return null
      })
      return cache.get('reentrant')
    },
    set: (cache, backend, hold) => {
      vi.spyOn(backend, 'captureWriteToken').mockImplementation(async () => {
        await hold()
        return '0'
      })
      return cache.set('reentrant', 'value')
    },
    clear: (cache, backend, hold) => {
      vi.spyOn(backend, 'clear').mockImplementation(hold)
      return cache.clear('reentrant')
    },
    invalidateTags: (cache, backend, hold) => {
      vi.spyOn(backend, 'invalidateTags').mockImplementation(async () => {
        await hold()
        return []
      })
      return cache.invalidateTags(['reentrant'])
    },
    invalidateNamespace: (cache, backend, hold) => {
      Object.assign(backend, { invalidateNamespace: hold })
      return cache.invalidateNamespace()
    },
    shouldRefresh: (cache, backend, hold) => {
      vi.spyOn(backend, 'shouldRefresh').mockImplementation(async () => {
        await hold()
        return ['UPDATE', 'reentrant-lock']
      })
      return cache.shouldRefresh('reentrant', 0)
    },
    releaseLock: (cache, backend, hold) => {
      vi.spyOn(backend, 'releaseLock').mockImplementation(async () => {
        await hold()
        return ['UPDATED']
      })
      return cache.releaseLock('reentrant', 'reentrant-lock')
    },
  }

  it.each(Object.entries(reentrantOperations))(
    'drains %s when its backend hook starts close synchronously',
    async (_name, invoke) => {
      const { cache, backend } = fixture()
      const started = gate()
      const finish = gate()
      let closing!: Promise<void>
      const operation = invoke(cache, backend, () => {
        closing = cache.close()
        started.resolve()
        return finish.promise
      })
      await started.promise
      try {
        await setImmediate()
        expect(backend.quitCalls).toBe(0)
      } finally {
        finish.resolve()
        await Promise.all([operation, closing])
      }
      expect(backend.quitCalls).toBe(1)
    },
  )

  it.each(['setMany', 'clearMany'] as const)('waits for siblings before %s rejects', async (method) => {
    const { cache, backend } = fixture()
    const failure = new Error('operation failed')
    const remaining = gate()
    const started = gate()
    const done = vi.fn()
    const failOrWait = async (key: string) => {
      if (key === 'fail') throw failure
      started.resolve()
      await remaining.promise
      done()
    }
    vi.spyOn(backend, 'update').mockImplementation(async ({ key }) => {
      await failOrWait(key)
      return ['CACHED', 2]
    })
    vi.spyOn(backend, 'clear').mockImplementation(failOrWait)
    const operation =
      method === 'setMany'
        ? cache.setMany([
            { key: 'fail', data: 1 },
            { key: 'wait', data: 2 },
          ])
        : cache.clearMany(['fail', 'wait'])
    const rejected = vi.fn()
    const outcome = operation.catch(rejected)
    await started.promise
    try {
      await setImmediate()
      expect(rejected).not.toHaveBeenCalled()
    } finally {
      remaining.resolve()
      await outcome
    }
    expect(done).toHaveBeenCalledOnce()
    expect(rejected).toHaveBeenCalledExactlyOnceWith(failure)
  })
})

describe('core audit regressions with Redis', () => {
  let redisSuite!: Parameters<Parameters<typeof registerRedisCacheSuite>[0]>[0]
  registerRedisCacheSuite((ready) => {
    redisSuite = ready
  })

  it('uses an explicit stale write token and preserves the invalidation fence', async () => {
    const { redisClient } = redisSuite
    const cache = create({ backend: 'redis' })
    expect(cache.client.options.port).toBe(redisClient.options.port)
    const writeToken = await cache.captureWriteToken()
    await cache.invalidateNamespace()
    const capture = vi.spyOn(cache['backend'], 'captureWriteToken')
    await expect(cache.getOrSet('fenced', async () => 'invalidated', { writeToken })).resolves.toBe('invalidated')
    expect(capture).not.toHaveBeenCalled()
    expect(await cache.get('fenced')).toBeNull()
    await expect(cache.getOrSet('fenced', async () => 'fresh')).resolves.toBe('fresh')
    expect((await cache.get('fenced'))?.data).toBe('fresh')
    expect(capture).toHaveBeenCalledOnce()
  })

  it('rejects ill-formed tags and keeps valid Unicode tag invalidation distinct', async () => {
    const cache = create({ backend: 'redis' })
    await cache.set('unicode', 'value', { tags: ['🌱', '\ufffd'] })
    await expect(cache.set('bad', 1, { tags: ['\ud800'] })).rejects.toThrow(/well-formed/)
    await expect(cache.invalidateTags(['\udc00'])).rejects.toThrow(/well-formed/)
    expect(await cache.get('bad')).toBeNull()
    expect((await cache.get('unicode'))?.data).toBe('value')
    await cache.invalidateTags(['🌱'])
    expect(await cache.get('unicode')).toBeNull()
  })

  it('validates cacheResult before calling the source and stores fractional seconds in Redis', async () => {
    const { cacheModule, redisClient } = redisSuite
    const callback = vi.fn(async () => ({ value: 'fresh' }))
    for (const ttl of [0, -1, NaN, Infinity, MAX_TTL + 1]) {
      await expect(cacheModule.cacheResult('invalid', ttl, callback)).rejects.toThrow(RangeError)
    }
    expect(callback).not.toHaveBeenCalled()
    expect(await redisClient.exists('invalid')).toBe(0)
    expect(await cacheModule.cacheResult('fractional', 0.7501, callback)).toEqual({ value: 'fresh' })
    const ttlMs = await redisClient.pttl('fractional')
    expect(ttlMs).toBeGreaterThan(0)
    expect(ttlMs).toBeLessThanOrEqual(751)
    expect(await cacheModule.cacheResult('fractional', 0.75, callback)).toEqual({ value: 'fresh' })
    expect(callback).toHaveBeenCalledOnce()
  })
})
