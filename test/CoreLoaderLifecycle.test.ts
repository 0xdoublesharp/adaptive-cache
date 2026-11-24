import crypto from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { AdaptiveCache } from '../src/AdaptiveCache'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { Logger } from '../src/lib/logger'
import { gate, registerCoreCacheFixture } from './helpers/coreCache'

const { create } = registerCoreCacheFixture()
const backend = () => new ClusteredLruAdaptiveCacheBackend({ namespace: crypto.randomUUID() }, new Logger('silent'))

describe('loader execution deadlines and cancellation', () => {
  it('bounds a non-cooperative loader and never stores its late result', async () => {
    const cache = create()
    const started = gate(),
      release = gate()
    let signal!: AbortSignal
    const loading = cache.getOrSet(
      'late',
      async (context) => {
        signal = context.signal
        started.resolve()
        await release.promise
        return 'late'
      },
      { loadTimeoutMs: 50 },
    )
    const outcome = loading.catch((error: Error) => error)
    await started.promise
    expect(await outcome).toMatchObject({ name: 'TimeoutError' })
    expect(signal.aborted).toBe(true)
    release.resolve()
    await setImmediate()
    expect(await cache.get('late')).toBeNull()
    expect(await cache.getOrSet('late', async () => 'retry')).toBe('retry')
  })

  it('does not start work for an already-aborted caller', async () => {
    const cache = create()
    const controller = new AbortController()
    controller.abort()
    const loader = vi.fn(async () => 'unexpected')
    await expect(cache.getOrSet('aborted', loader, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(loader).not.toHaveBeenCalled()
  })

  it.each(['abort', 'timeout'] as const)('keeps useful coalesced work after one caller %s', async (kind) => {
    const cache = create()
    const started = gate(),
      release = gate()
    const controller = new AbortController()
    let workSignal!: AbortSignal
    const loader = vi.fn(async (context) => {
      workSignal = context.signal
      started.resolve()
      await release.promise
      return 'shared'
    })
    const first = cache.getOrSet('shared', loader, {
      signal: controller.signal,
      loadTimeoutMs: kind === 'timeout' ? 15 : 1000,
    })
    const firstOutcome = first.catch((error: Error) => error)
    await started.promise
    const second = cache.getOrSet('shared', loader, { loadTimeoutMs: 1000 })
    await setImmediate()
    if (kind === 'abort') controller.abort()
    expect(await firstOutcome).toMatchObject({ name: kind === 'abort' ? 'AbortError' : 'TimeoutError' })
    expect(workSignal.aborted).toBe(false)
    release.resolve()
    expect(await second).toBe('shared')
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('does not turn explicit cancellation into stale fallback', async () => {
    const cache = create({ staleIfError: 20 })
    await cache.set('stale', 'old')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000)
    const controller = new AbortController(),
      started = gate()
    const loading = cache.getOrSet(
      'stale',
      async () => {
        started.resolve()
        return new Promise<string>(() => {})
      },
      { signal: controller.signal },
    )
    const outcome = loading.catch((error: Error) => error)
    await started.promise
    controller.abort()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
  })

  it.each([-1, NaN, Infinity])('rejects invalid loadTimeoutMs %s', async (loadTimeoutMs) => {
    const cache = create()
    await expect(cache.getOrSet('invalid', async () => 'value', { loadTimeoutMs })).rejects.toThrow('loadTimeoutMs')
    expect(() => create({ loadTimeoutMs })).toThrow('loadTimeoutMs')
  })

  it('preserves a source rejection when lock cleanup rejects', async () => {
    const store = backend(),
      cache = create({ backend: store })
    vi.spyOn(store, 'releaseLock').mockRejectedValue(new Error('cleanup failed'))
    const source = new Error('source failed')
    await expect(
      cache.getOrSet('failure', async () => {
        throw source
      }),
    ).rejects.toBe(source)
  })
})

describe('bounded close', () => {
  it('aborts non-cooperative work and forces backend teardown at its deadline', async () => {
    const store = backend()
    const cache = new AdaptiveCache({ backend: store, logLevel: 'silent' })
    const quit = vi.spyOn(store, 'quit')
    const started = gate()
    let signal!: AbortSignal
    const loading = cache
      .getOrSet('forever', async (context) => {
        signal = context.signal
        started.resolve()
        return new Promise<string>(() => {})
      })
      .catch((error: Error) => error)
    await started.promise
    const closing = cache.close({ timeoutMs: 15 })
    await expect(closing).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(signal.aborted).toBe(true)
    expect(await loading).toMatchObject({ name: 'TimeoutError' })
    expect(quit).toHaveBeenCalledWith(false, true)
    await expect(cache.close()).rejects.toMatchObject({ name: 'TimeoutError' })
    await expect(cache.getOrSet('new', async () => 'new')).rejects.toThrow('closed')
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('bounds a stalled backend flush and a stalled forced teardown', async () => {
    const store = Object.assign(backend(), { flush: vi.fn(() => new Promise<void>(() => {})) })
    const flush = store.flush
    const quit = vi.spyOn(store, 'quit').mockImplementation(() => new Promise(() => {}))
    const cache = new AdaptiveCache({ backend: store, logLevel: 'silent', closeTimeoutMs: 15 })
    await expect(cache.close()).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(flush).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledWith(false, true)
    quit.mockRestore()
    await store.quit()
  })

  it('shares graceful close and validates shutdown deadlines', async () => {
    const store = backend(),
      cache = create({ backend: store })
    const quit = vi.spyOn(store, 'quit')
    for (const timeoutMs of [-1, NaN, Infinity]) await expect(cache.close({ timeoutMs })).rejects.toThrow('timeoutMs')
    await Promise.all([cache.close({ timeoutMs: 1000 }), cache.close()])
    expect(quit).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledWith(false)
  })
})

describe('cancellation across cache stages', () => {
  it('cancels a blocked initial cache read without starting the loader', async () => {
    const store = backend(),
      cache = create({ backend: store })
    const started = gate(),
      release = gate()
    const fetch = store.fetch.bind(store)
    vi.spyOn(store, 'fetch').mockImplementationOnce(async (input) => {
      started.resolve()
      await release.promise
      return fetch(input)
    })
    const controller = new AbortController(),
      loader = vi.fn(async () => 'unused')
    const outcome = cache.getOrSet('read-blocked', loader, { signal: controller.signal }).catch((error: Error) => error)
    await started.promise
    controller.abort()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    release.resolve()
    await setImmediate()
    expect(loader).not.toHaveBeenCalled()
  })

  it('releases a lease whose acquisition resolves after caller cancellation', async () => {
    const store = backend(),
      cache = create({ backend: store })
    const started = gate(),
      release = gate()
    const acquire = store.shouldRefresh.bind(store)
    const releaseLock = vi.spyOn(store, 'releaseLock')
    vi.spyOn(store, 'shouldRefresh').mockImplementationOnce(async (...args) => {
      const result = await acquire(...args)
      started.resolve()
      await release.promise
      return result
    })
    const controller = new AbortController()
    const outcome = cache
      .getOrSet('late-lease', async () => 'unused', { signal: controller.signal })
      .catch((error: Error) => error)
    await started.promise
    controller.abort()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    release.resolve()
    await setImmediate()
    expect(releaseLock).toHaveBeenCalledWith(
      'adaptive:loader:late-lease',
      expect.any(Number),
      expect.any(String),
      false,
    )
    expect(await cache.getOrSet('late-lease', async () => 'retry')).toBe('retry')
  })

  it('checks cancellation after encoding and before writing to storage', async () => {
    const controller = new AbortController()
    const store = backend(),
      update = vi.spyOn(store, 'update')
    const cache = create({
      backend: store,
      fingerprint: () => {
        controller.abort()
        return 'fingerprint'
      },
    })
    await expect(cache.getOrSet('encoding', async () => 'value', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    await setImmediate()
    expect(update).not.toHaveBeenCalled()
    expect(await cache.get('encoding')).toBeNull()
  })

  it('bounds background stale refreshes that ignore cancellation', async () => {
    const store = backend(),
      cache = create({ backend: store, staleWhileRevalidate: 10, loadTimeoutMs: 15 })
    await cache.set('swr', 'old')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000)
    const started = gate()
    let signal!: AbortSignal
    expect(
      await cache.getOrSet('swr', async (context) => {
        signal = context.signal
        started.resolve()
        return new Promise<string>(() => {})
      }),
    ).toBe('old')
    await started.promise
    await cache.flush()
    expect(signal.aborted).toBe(true)
    expect((await cache.get('swr', { allowStale: true }))?.data).toBe('old')
  })

  it('supports caller-defined negative values with a positive negative TTL', async () => {
    const cache = create()
    expect(
      await cache.getOrSet('negative-custom', async () => 404, {
        isNegative: (value) => value === 404,
        negativeTTL: 1,
      }),
    ).toBe(404)
    expect((await cache.get('negative-custom'))?.data).toBe(404)
  })
})

describe('shutdown backend failures', () => {
  it('does not force teardown twice when graceful quit rejects after the deadline', async () => {
    const store = backend()
    const originalQuit = store.quit.bind(store)
    const started = gate()
    let failQuit!: (error: Error) => void
    const quit = vi.spyOn(store, 'quit').mockImplementation((_preserve, force?: boolean) => {
      if (force) return originalQuit()
      started.resolve()
      return new Promise((_resolve, reject) => {
        failQuit = reject
      })
    })
    const cache = new AdaptiveCache({ backend: store, logLevel: 'silent' })
    const closing = cache.close({ timeoutMs: 15 })
    const outcome = closing.catch((error: Error) => error)
    await started.promise
    expect(await outcome).toMatchObject({ name: 'TimeoutError' })
    failQuit(new Error('late graceful rejection'))
    await setImmediate()

    expect(quit).toHaveBeenCalledTimes(2)
    expect(quit.mock.calls).toEqual([[false], [false, true]])
    await expect(cache.close()).rejects.toMatchObject({ name: 'TimeoutError' })
  })

  it.each(['flush', 'quit'])('forces cleanup after immediate %s rejection and preserves the error', async (stage) => {
    const store = Object.assign(backend(), { flush: vi.fn(async () => {}) })
    const originalQuit = store.quit.bind(store)
    const failure = new Error('graceful shutdown failed')
    if (stage === 'flush') store.flush.mockRejectedValue(failure)
    const quit = vi.spyOn(store, 'quit').mockImplementation(async (_preserve, force?: boolean) => {
      if (!force && stage === 'quit') throw failure
      return originalQuit()
    })
    const unsubscribe = vi.fn()
    vi.spyOn(store, 'onEvent').mockReturnValue(unsubscribe)
    const cache = new AdaptiveCache({ backend: store, logLevel: 'silent' })

    await expect(cache.quit(true)).rejects.toBe(failure)
    await setImmediate()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledWith(true, true)
    await expect(cache.close()).rejects.toBe(failure)
    expect(quit).toHaveBeenCalledTimes(stage === 'quit' ? 2 : 1)
  })

  it('does not resume graceful teardown after a timed-out flush later finishes', async () => {
    const release = gate()
    const store = Object.assign(backend(), { flush: vi.fn(() => release.promise) })
    const cache = new AdaptiveCache({ backend: store, logLevel: 'silent' })
    const quit = vi.spyOn(store, 'quit')
    await expect(cache.close({ timeoutMs: 5 })).rejects.toMatchObject({ name: 'TimeoutError' })
    release.resolve()
    await setImmediate()
    expect(quit).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledWith(false, true)
  })

  it('observes rejected forced teardown and retains the timeout outcome', async () => {
    const store = Object.assign(backend(), { flush: vi.fn(() => new Promise<void>(() => {})) })
    const originalQuit = store.quit.bind(store)
    vi.spyOn(store, 'quit').mockRejectedValue(new Error('teardown failed'))
    const cache = new AdaptiveCache({ backend: store, logLevel: 'silent' })
    await expect(cache.close({ timeoutMs: 5 })).rejects.toMatchObject({ name: 'TimeoutError' })
    await setImmediate()
    await expect(cache.close()).rejects.toMatchObject({ name: 'TimeoutError' })
    await originalQuit()
  })

  it('preserves graceful teardown failures for every concurrent caller', async () => {
    const store = backend(),
      originalQuit = store.quit.bind(store)
    const failure = new Error('graceful teardown failed')
    vi.spyOn(store, 'quit').mockRejectedValue(failure)
    const cache = new AdaptiveCache({ backend: store, logLevel: 'silent' })
    await expect(cache.close()).rejects.toBe(failure)
    await expect(cache.quit()).rejects.toBe(failure)
    await originalQuit()
  })

  it('permits custom backends without a quit hook', async () => {
    const store = backend(),
      originalQuit = store.quit.bind(store)
    const cache = new AdaptiveCache({ backend: Object.assign(store, { quit: undefined }), logLevel: 'silent' })
    await expect(cache.close()).resolves.toBeUndefined()
    await originalQuit()
  })
})

describe('source error preservation', () => {
  it('keeps the loader error when a stale fallback read also fails', async () => {
    const store = backend(),
      cache = create({ backend: store, staleIfError: 20 })
    await cache.set('fallback-error', 'old')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3000)
    const source = new Error('source failed')
    await expect(
      cache.getOrSet('fallback-error', async () => {
        vi.spyOn(store, 'fetch').mockRejectedValue(new Error('cache failed'))
        throw source
      }),
    ).rejects.toBe(source)
  })
})

describe('shutdown observer cleanup isolation', () => {
  it.each(['synchronous', 'asynchronous'])(
    'continues graceful teardown when %s backend unsubscribe fails',
    async (failureKind) => {
      const store = backend()
      const unsubscribe = vi.fn(() => {
        const error = new Error('unsubscribe failed')
        if (failureKind === 'asynchronous') return Promise.reject(error)
        throw error
      })
      vi.spyOn(store, 'onEvent').mockReturnValue(unsubscribe)
      const quit = vi.spyOn(store, 'quit')
      const observer = vi.fn(() => {
        throw new Error('observer failed')
      })
      const cache = new AdaptiveCache({ backend: store, logLevel: 'silent', onEvent: observer })
      await expect(Promise.all([cache.close(), cache.close()])).resolves.toEqual([undefined, undefined])
      await expect(cache.close()).resolves.toBeUndefined()
      expect(unsubscribe).toHaveBeenCalledTimes(1)
      expect(quit).toHaveBeenCalledTimes(1)
      expect(quit).toHaveBeenCalledWith(false)
      expect(observer).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', reason: 'backend-unsubscribe' }))
    },
  )

  it.each(['synchronous', 'asynchronous'])(
    'forces teardown and settles the deadline when %s backend unsubscribe fails',
    async (failureKind) => {
      const store = Object.assign(backend(), { flush: vi.fn(() => new Promise<void>(() => {})) })
      const unsubscribe = vi.fn(() => {
        const error = new Error('unsubscribe failed')
        if (failureKind === 'asynchronous') return Promise.reject(error)
        throw error
      })
      vi.spyOn(store, 'onEvent').mockReturnValue(unsubscribe)
      const quit = vi.spyOn(store, 'quit')
      const cache = new AdaptiveCache({ backend: store, logLevel: 'silent' })
      const first = cache.close({ timeoutMs: 5 }).catch((error: Error) => error)
      const second = cache.close().catch((error: Error) => error)
      const result = await Promise.race([
        Promise.all([first, second]),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 30)),
      ])
      expect(result).not.toBe('pending')
      expect(result).toEqual([
        expect.objectContaining({ name: 'TimeoutError' }),
        expect.objectContaining({ name: 'TimeoutError' }),
      ])
      await expect(cache.close()).rejects.toMatchObject({ name: 'TimeoutError' })
      expect(unsubscribe).toHaveBeenCalledTimes(1)
      expect(quit).toHaveBeenCalledTimes(1)
      expect(quit).toHaveBeenCalledWith(false, true)
      expect(cache.getStats().counters.error).toBe(1)
    },
  )
})

describe('Node timer range validation', () => {
  const overflow = 2147483648
  const maximum = overflow - 1

  it('rejects overflowing load deadlines at the constructor and per-call boundaries', async () => {
    const cache = create()
    const loader = vi.fn(async () => 'value')
    expect(() => create({ loadTimeoutMs: overflow })).toThrow(/loadTimeoutMs.*2147483647/)
    expect(() => cache.resolveLoadTimeoutMs({ loadTimeoutMs: overflow })).toThrow(/loadTimeoutMs.*2147483647/)
    await expect(cache.getOrSet('overflow', loader, { loadTimeoutMs: overflow })).rejects.toThrow(
      /loadTimeoutMs.*2147483647/,
    )
    expect(loader).not.toHaveBeenCalled()
  })

  it('rejects overflowing shutdown deadlines at the constructor and close boundaries', async () => {
    const cache = create()
    expect(() => create({ closeTimeoutMs: overflow })).toThrow(/closeTimeoutMs.*2147483647/)
    await expect(cache.close({ timeoutMs: overflow })).rejects.toThrow(/timeoutMs.*2147483647/)
    expect(await cache.getOrSet('still-open', async () => 'value')).toBe('value')
  })

  it('accepts the maximum timer delay and preserves deadline precedence', async () => {
    const cache = create({ loadTimeoutMs: maximum, closeTimeoutMs: maximum })
    expect(cache.resolveLoadTimeoutMs()).toBe(maximum)
    expect(cache.resolveLoadTimeoutMs({ loadTimeoutMs: 7 })).toBe(7)
    expect(await cache.getOrSet('maximum', async () => 'value')).toBe('value')
    await expect(cache.close({ timeoutMs: maximum })).resolves.toBeUndefined()
  })
})
