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
) => {
  const deadline = Date.now() + timeoutMs
  const localController = new AbortController()
  let source: Promise<any> | undefined
  const remaining = () => Math.max(1, deadline - Date.now())
  const wait = <T>(work: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new DOMException(`HTTP cache load timed out after ${timeoutMs}ms`, 'TimeoutError')
        localController.abort(error)
        reject(error)
      }, remaining())
      void Promise.resolve()
        .then(work)
        .then(
          (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          (error) => {
            clearTimeout(timer)
            reject(error)
          },
        )
    })
  // The source can outlive its initiating request while another core caller is
  // still waiting. Only nonshared waits use this HTTP request's deadline.
  const loadOnce = (context: AdaptiveCacheLoaderContext = { signal: localController.signal }) =>
    (source ??= Promise.resolve()
      .then(() => {
        context.signal.throwIfAborted()
        return loader(context)
      })
      .then(normalizeHttpBody, (error) => {
        throw new HttpSourceError(error)
      }))
  return { wait, loadOnce, remaining }
}
