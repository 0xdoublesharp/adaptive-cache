import { performance } from 'node:perf_hooks'
import type {
  AdaptiveCacheBackend,
  AdaptiveCacheOptions,
  AdaptiveCacheSetOptions,
  AdaptiveCacheHit,
  AdaptiveCacheLoadOptions,
  AdaptiveCacheLoaderContext,
  AdaptiveCacheEvent,
} from './types'

interface LoaderCache {
  options: AdaptiveCacheOptions
  backend: AdaptiveCacheBackend
  getKeyPrefix(): string
  read<T>(key: string, options?: { allowStale?: boolean }): Promise<AdaptiveCacheHit<T> | null>
  write(
    key: string,
    data: unknown,
    options: AdaptiveCacheSetOptions,
    lease: { lockKey: string; lockValue: string },
    beforeUpdate: () => void,
  ): Promise<unknown>
  resolveMaxTTL(data: unknown, options: Pick<AdaptiveCacheOptions, 'maxTTL'>): number
  acquireRefreshLock(
    lastUpdateKey: string,
    refreshThreshold: number,
    force: boolean,
  ): ReturnType<AdaptiveCacheBackend['shouldRefresh']>
  track<T>(operation: () => T | PromiseLike<T>): Promise<T>
  emit(event: Omit<AdaptiveCacheEvent, 'timestamp'> & { timestamp?: number }): void
}

type LoadResult<T> = { data: T; backgroundFallback?: boolean }
class SourceError {
  constructor(readonly reason: unknown) {}
}

interface SharedLoad {
  promise: Promise<LoadResult<any>>
  controller: AbortController
  callers: Map<AbortSignal, () => void>
  checkDeadline: () => void
}

const isMissing = (data: unknown): boolean => data === null || data === undefined

// Race every awaited stage, including non-cooperative custom backends, without
// leaving a rejection unobserved if the detached operation later fails.
const waitFor = <T>(work: () => T | PromiseLike<T>, signal: AbortSignal, checkDeadline: () => void): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    if (signal.aborted) return aborted()
    signal.addEventListener('abort', aborted, { once: true })
    void Promise.resolve()
      .then(() => {
        checkDeadline()
        signal.throwIfAborted()
        return work()
      })
      .then((result) => {
        checkDeadline()
        return result
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', aborted))
  })

// Each caller owns its wait deadline. The shared loader lives while at least one
// foreground caller or detached SWR refresh still has an interest in the result.
export class CacheLoader {
  private readonly loads = new Map<string, SharedLoad>()
  private readonly callers = new Set<AbortController>()

  constructor(private readonly cache: LoaderCache) {}

  public abort(reason: unknown): void {
    for (const caller of this.callers) caller.abort(reason)
    for (const load of this.loads.values()) load.controller.abort(reason)
  }

  public async getOrSet<T>(
    key: string,
    loader: (context: AdaptiveCacheLoaderContext) => Promise<T>,
    options: AdaptiveCacheLoadOptions<T> & { loadTimeoutMs: number },
    deadline: number,
  ): Promise<T> {
    const controller = new AbortController()
    const signal = controller.signal
    const abort = () => controller.abort(options.signal!.reason)
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    this.callers.add(controller)
    const timeOut = () =>
      controller.abort(
        new DOMException(`Cache loader timed out after ${options.loadTimeoutMs}ms for ${key}`, 'TimeoutError'),
      )
    const timer = setTimeout(timeOut, Math.max(0, Math.ceil(deadline - performance.now())))
    const expire = () => {
      if (performance.now() >= deadline) timeOut()
    }
    const checkCaller = () => {
      expire()
      signal.throwIfAborted()
    }
    const dispose = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      this.callers.delete(controller)
    }
    let detached = false
    try {
      const swr = options.staleWhileRevalidate ?? this.cache.options.staleWhileRevalidate ?? 0
      const sie = options.staleIfError ?? this.cache.options.staleIfError ?? 0
      const force = options.forceRefresh ?? this.cache.options.forceRefresh ?? false
      checkCaller()
      const hit = force
        ? null
        : await waitFor(() => this.cache.read<T>(key, { allowStale: swr > 0 || sie > 0 }), signal, expire)
      checkCaller()
      if (hit && !hit.stale) return hit.data
      const backgroundHit = hit?.stale && hit.staleAge !== undefined && hit.staleAge < swr ? hit : undefined
      const getLoad = () => {
        let loading = this.loads.get(key)
        loading?.checkDeadline()
        if (!loading || loading.controller.signal.aborted) {
          const shared = new AbortController()
          const callers = new Map<AbortSignal, () => void>([[signal, expire]])
          const checkDeadline = () => {
            let active = false
            let reason: unknown
            for (const [caller, expire] of callers) {
              expire()
              if (caller.aborted) reason = caller.reason
              else active = true
            }
            if (!active) shared.abort(reason)
          }
          loading = {
            controller: shared,
            callers,
            checkDeadline,
            promise: this.cache.track(() =>
              this.load(key, loader, options, force, shared.signal, checkDeadline, backgroundHit),
            ),
          }
          const owned = loading
          this.loads.set(key, loading)
          const remove = () => {
            if (this.loads.get(key) === owned) this.loads.delete(key)
          }
          shared.signal.addEventListener('abort', remove, { once: true })
          void loading.promise.then(remove, remove)
        }
        return loading
      }
      const join = async (loading: SharedLoad): Promise<LoadResult<T>> => {
        loading.callers.set(signal, expire)
        try {
          return await waitFor(() => loading.promise, signal, expire)
        } finally {
          loading.callers.delete(signal)
          if (loading.callers.size === 0)
            loading.controller.abort(signal.reason ?? new DOMException('No cache loader callers remain', 'AbortError'))
        }
      }
      if (backgroundHit) {
        detached = true
        void join(getLoad())
          .catch(() => {
            // The refresh reports its own error event.
          })
          .finally(dispose)
        return backgroundHit.data
      }
      try {
        for (;;) {
          const result = await join(getLoad())
          checkCaller()
          // A foreground joiner must not inherit another caller's stale eligibility.
          if (!result.backgroundFallback) return result.data
        }
      } catch (error) {
        checkCaller()
        if (!(error instanceof SourceError)) throw error
        // Re-read at failure time, under the caller's remaining deadline.
        if (sie > 0) {
          try {
            const fallback = await waitFor(() => this.cache.read<T>(key, { allowStale: true }), signal, expire)
            if (
              fallback &&
              (!fallback.stale || (fallback.staleAge !== undefined && fallback.staleAge < sie)) &&
              !(options.isNegative ?? isMissing)(fallback.data)
            ) {
              checkCaller()
              return fallback.data
            }
          } catch {
            // Cache fallback failures must not replace the original source error.
          }
          checkCaller()
        }
        throw error.reason
      }
    } finally {
      if (!detached) dispose()
    }
  }

  private async load<T>(
    key: string,
    loader: (context: AdaptiveCacheLoaderContext) => Promise<T>,
    options: AdaptiveCacheLoadOptions<T>,
    force: boolean,
    signal: AbortSignal,
    checkDeadline: () => void,
    backgroundHit?: AdaptiveCacheHit<T>,
  ): Promise<LoadResult<T>> {
    const started = performance.now()
    const lockKey = this.cache.getKeyPrefix() + 'loader:' + key
    const waitLimit = options.lockWaitTimeoutMs ?? this.cache.options.lockWaitTimeoutMs ?? 5000
    const lockDeadline = started + waitLimit
    const lockWait = new AbortController()
    const acquiring = AbortSignal.any([signal, lockWait.signal])
    const timeOutLock = () => lockWait.abort(new Error(`Timed out waiting for cache loader lock for ${key}`))
    const timer = setTimeout(timeOutLock, Math.ceil(waitLimit))
    const checkLockDeadline = () => {
      checkDeadline()
      if (performance.now() >= lockDeadline) timeOutLock()
    }
    const beforeUpdate = () => {
      checkDeadline()
      signal.throwIfAborted()
    }
    let lock: string | undefined
    let contended = false
    const release = (value: string) =>
      this.cache.track(async () => {
        try {
          await this.cache.backend.releaseLock(lockKey, Math.floor(Date.now() / 1000), value, false)
        } catch (error) {
          this.cache.emit({
            type: 'error',
            key,
            reason: 'lock-release',
            error,
            durationMs: performance.now() - started,
          })
        }
      })
    try {
      if (options.writeToken === undefined && !this.cache.backend.captureWriteToken)
        throw new Error('Backend does not support captureWriteToken required for fenced loading')
      for (;;) {
        const result = await waitFor(
          () =>
            // A detached acquisition can still grant a lease. Register its release
            // before the acquisition leaves the set of pending operations.
            this.cache.track(async () => {
              checkDeadline()
              acquiring.throwIfAborted()
              const result = await this.cache.acquireRefreshLock(lockKey, 0, false)
              if (result[0] === 'UPDATE') {
                checkLockDeadline()
                if (acquiring.aborted) void release(result[1])
                else lock = result[1]
              }
              return result
            }),
          acquiring,
          checkDeadline,
        )
        if (result[0] === 'UPDATE') break
        if (!contended) {
          this.cache.emit({ type: 'lock-contention', key })
          contended = true
        }
        if (backgroundHit) return { data: backgroundHit.data, backgroundFallback: true }
        if (!force) {
          const shared = await waitFor(() => this.cache.read<T>(key), acquiring, checkLockDeadline)
          if (shared) return { data: shared.data }
        }
        await waitFor(
          () => new Promise((resolve) => setTimeout(resolve, Math.min(25, lockDeadline - performance.now()))),
          acquiring,
          checkLockDeadline,
        )
      }
      clearTimeout(timer)
      if (!force) {
        const shared = await waitFor(() => this.cache.read<T>(key), signal, checkDeadline)
        if (shared) return { data: shared.data }
      }
      const writeToken =
        options.writeToken ??
        (await waitFor(() => this.cache.backend.captureWriteToken!(this.cache.getKeyPrefix()), signal, checkDeadline))
      this.cache.emit({ type: 'refresh', key })
      const data = await waitFor(
        async () => {
          try {
            return await loader({ signal })
          } catch (error) {
            throw new SourceError(error)
          }
        },
        signal,
        checkDeadline,
      )
      const negative = (options.isNegative ?? isMissing)(data)
      const negativeTTL = options.negativeTTL ?? this.cache.options.negativeTTL ?? 0
      if ((!negative || negativeTTL > 0) && (options.shouldStore?.(data) ?? true)) {
        const maxTTL = this.cache.resolveMaxTTL(data, options)
        await waitFor(
          () =>
            this.cache.write(
              key,
              data,
              {
                ...options,
                writeToken,
                maxTTL: negative ? Math.min(maxTTL, negativeTTL) : maxTTL,
                ...(negative ? { staleTTL: 0 } : {}),
              },
              { lockKey: lockKey + '-lock', lockValue: lock! },
              beforeUpdate,
            ),
          signal,
          checkDeadline,
        )
        await waitFor(() => this.cache.backend.flush?.(), signal, checkDeadline)
      }
      return { data }
    } catch (error) {
      this.cache.emit({
        type: 'error',
        key,
        reason: 'refresh',
        error: error instanceof SourceError ? error.reason : error,
        durationMs: performance.now() - started,
      })
      throw error
    } finally {
      clearTimeout(timer)
      if (lock !== undefined) {
        // Start cleanup even after cancellation. Do not let an unresponsive backend
        // hold the shared loader promise or overwrite its original source error.
        const releasing = release(lock)
        try {
          await waitFor(() => releasing, signal, checkDeadline)
        } catch {
          /* Cancellation already reported. */
        }
      }
    }
  }
}
