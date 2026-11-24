import { performance } from 'node:perf_hooks'
import { normalizeHttpBody } from './httpPolicy'
import type { AdaptiveCacheLoaderContext } from './types'

// Shared cache loads can fail in a different HTTP request. Preserve the source
// exception's identity so every waiter can distinguish it from a cache outage.
export class HttpSourceError extends Error {
  constructor(readonly sourceError: unknown) {
    super('HTTP source loader failed')
  }
}

// Shared cache work may report an unsupported transport, but must never share its
// consumable body. Each HTTP caller then obtains its own once-only source result.
export const UNSHAREABLE_HTTP_RESULT = Symbol('unshareable HTTP result')

export const unwrapHttpSourceError = (error: unknown) => (error instanceof HttpSourceError ? error.sourceError : error)

export const isHttpLoadCancellation = (error: unknown) =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')

export const createHttpLoader = (
  loader: (context: AdaptiveCacheLoaderContext) => Promise<unknown>,
  timeoutMs: number,
  clientSignal?: AbortSignal,
) => {
  const deadline = performance.now() + timeoutMs
  const localController = new AbortController()
  const signal = clientSignal ? AbortSignal.any([localController.signal, clientSignal]) : localController.signal
  let source: Promise<any> | undefined
  const timeout = () =>
    localController.abort(new DOMException(`HTTP cache load timed out after ${timeoutMs}ms`, 'TimeoutError'))
  const expire = () => {
    const time = deadline - performance.now()
    if (time <= 0) timeout()
    return time
  }
  const remaining = () => {
    const time = expire()
    signal.throwIfAborted()
    return time
  }
  const wait = async <T>(work: () => Promise<T>): Promise<T> => {
    const timer = setTimeout(timeout, Math.ceil(remaining()))
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      const result = await Promise.race([
        cancelled,
        Promise.resolve().then(() => {
          remaining()
          return work()
        }),
      ])
      remaining()
      return result
    } catch (error) {
      // Core can time out before this request's timer runs. Keep the local
      // signal authoritative for a source that still has other waiters.
      if (isHttpLoadCancellation(error)) localController.abort(error)
      throw error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }
  // The source can outlive its initiating request while another core caller is
  // still waiting. Only nonshared waits use this HTTP request's deadline.
  const loadOnce = (context: AdaptiveCacheLoaderContext = { signal }) =>
    (source ??= Promise.resolve()
      .then(() => {
        context.signal.throwIfAborted()
        return loader(context)
      })
      .then(normalizeHttpBody, (error) => {
        throw new HttpSourceError(error)
      }))
  return { wait, loadOnce, remaining, signal, expire }
}
