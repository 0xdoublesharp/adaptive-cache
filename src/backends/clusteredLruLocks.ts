import cluster from 'node:cluster'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import type { UpdateCacheAndReleaseLockLOCK_MISMATCH, UpdateCacheAndReleaseLockUPDATED } from '../types'

type ReleaseResult = UpdateCacheAndReleaseLockUPDATED | UpdateCacheAndReleaseLockLOCK_MISMATCH
type PrimaryCache = {
  get(key: string, options: { allowStale: false; updateAgeOnGet: false }): unknown
  set(key: string, value: number, options: { ttl: number; size: number }): unknown
  delete(key: string): unknown
}
type Request = {
  source: typeof SOURCE
  id: string
  namespace: string
  operation: 'ready' | 'release'
  key: string
  owner: string
  currentTime: number
  recordRefresh: boolean
}
type Pending = { finish: (error?: Error, result?: ReleaseResult) => void }
type State = {
  installed: boolean
  pending: Map<string, Pending>
  onMessage?: (message: unknown) => void
  onDisconnect?: () => void
}

const SOURCE = 'adaptive-cache:clustered-locks:v1'
const stateKey = Symbol.for(SOURCE)
const globals = globalThis as typeof globalThis & { [stateKey]?: State }
const state: State = (globals[stateKey] ??= { installed: false, pending: new Map() })

// Controls are always read with bypassL1. Mutating these reserved keys directly
// therefore needs no upstream L1 broadcast. Keep this entire operation synchronous
// so another worker's acquisition cannot run between comparison and deletion.
export const releasePrimaryLock = (
  cache: PrimaryCache | undefined,
  key: string,
  owner: string,
  currentTime: number,
  recordRefresh: boolean,
): ReleaseResult => {
  const lockKey = key + '-lock'
  const existing = cache?.get(lockKey, { allowStale: false, updateAgeOnGet: false })
  if (!cache || typeof existing !== 'string' || existing !== owner)
    return ['LOCK_MISMATCH', typeof existing === 'string' ? existing : '']
  if (recordRefresh)
    cache.set(key, currentTime, { ttl: 7 * 24 * 60 * 60 * 1000, size: Buffer.byteLength(key, 'utf8') + 16 })
  cache.delete(lockKey)
  return ['UPDATED']
}

const isRequest = (value: unknown): value is Request => {
  if (!value || typeof value !== 'object') return false
  const request = value as Request
  return (
    request.source === SOURCE &&
    typeof request.id === 'string' &&
    typeof request.namespace === 'string' &&
    (request.operation === 'ready' || request.operation === 'release') &&
    typeof request.key === 'string' &&
    typeof request.owner === 'string' &&
    typeof request.currentTime === 'number' &&
    Number.isFinite(request.currentTime) &&
    typeof request.recordRefresh === 'boolean'
  )
}

export const installClusteredLockHandler = (getCache: (namespace: string) => PrimaryCache | undefined) => {
  if (!cluster.isPrimary || state.installed) return
  cluster.on('message', (worker, message: unknown) => {
    if (!isRequest(message)) return
    let result: ReleaseResult | undefined
    let error: string | undefined
    try {
      if (message.operation === 'release')
        result = releasePrimaryLock(
          getCache(message.namespace),
          message.key,
          message.owner,
          message.currentTime,
          message.recordRefresh,
        )
    } catch {
      error = 'Clustered LRU primary lock operation failed'
    }
    if (worker.isConnected()) {
      try {
        worker.send({ source: SOURCE, id: message.id, result, error }, () => {})
      } catch {
        // The caller may disconnect after the synchronous operation completed.
      }
    }
  })
  state.installed = true
}

const onMessage = (message: unknown) => {
  if (!message || typeof message !== 'object') return
  const response = message as { source?: string; id?: string; error?: string; result?: ReleaseResult }
  if (response.source !== SOURCE || typeof response.id !== 'string') return
  state.pending.get(response.id)?.finish(response.error ? new Error(response.error) : undefined, response.result)
}
const onDisconnect = () => {
  for (const pending of state.pending.values()) pending.finish(new Error('Clustered LRU primary disconnected'))
}

export const requestClusteredLock = (
  request: Omit<Request, 'source' | 'id'>,
  timeoutMs: number,
): Promise<ReleaseResult | undefined> =>
  new Promise((resolve, reject) => {
    if (!process.send || !process.connected) {
      reject(new Error('Clustered LRU primary IPC is unavailable'))
      return
    }
    const id = randomUUID()
    const timer = setTimeout(() => {
      finish(
        new Error('Clustered LRU lock operation timed out; call bootstrapClusteredLru() in the primary before forking'),
      )
    }, timeoutMs)
    const finish = (error?: Error, result?: ReleaseResult) => {
      if (!state.pending.delete(id)) return
      clearTimeout(timer)
      if (state.pending.size === 0) {
        process.off('message', state.onMessage!)
        process.off('disconnect', state.onDisconnect!)
        state.onMessage = undefined
        state.onDisconnect = undefined
      }
      if (error) reject(error)
      else resolve(result)
    }
    if (state.pending.size === 0) {
      state.onMessage = onMessage
      state.onDisconnect = onDisconnect
      process.on('message', onMessage)
      process.on('disconnect', onDisconnect)
    }
    state.pending.set(id, { finish })
    try {
      // false means backpressure, not failed delivery. The callback reports errors.
      process.send({ source: SOURCE, id, ...request }, (error) => {
        if (error) finish(error)
      })
    } catch (error) {
      finish(error instanceof Error ? error : new Error('Clustered LRU lock request failed'))
    }
  })
