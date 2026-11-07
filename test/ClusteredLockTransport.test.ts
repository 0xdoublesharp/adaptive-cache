import cluster from 'node:cluster'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installClusteredLockHandler, releasePrimaryLock, requestClusteredLock } from '../src/backends/clusteredLruLocks'

vi.mock('node:process', async () => {
  const { EventEmitter } = await import('node:events')
  return { default: Object.assign(new EventEmitter(), { connected: true, send: vi.fn() }) }
})
vi.mock('node:cluster', async () => {
  const { EventEmitter } = await import('node:events')
  return { default: Object.assign(new EventEmitter(), { isPrimary: true }) }
})

const source = 'adaptive-cache:clustered-locks:v1'
const ipc = process as any
const primary = cluster as any
const request = {
  namespace: 'test',
  operation: 'release' as const,
  key: 'refresh',
  owner: 'owner',
  currentTime: 100,
  recordRefresh: true,
}
const state = () => (globalThis as any)[Symbol.for(source)]
const reply = (sent: any, result: unknown = ['UPDATED']) => ({ source, id: sent.id, result })

beforeEach(() => {
  vi.useFakeTimers()
  ipc.connected = true
  ipc.send = vi.fn()
  primary.isPrimary = true
  primary.isWorker = false
  state().installed = false
})
afterEach(() => {
  expect(state().pending.size).toBe(0)
  expect(ipc.listenerCount('message')).toBe(0)
  expect(ipc.listenerCount('disconnect')).toBe(0)
  primary.removeAllListeners()
  vi.useRealTimers()
})

describe('clustered lock request lifecycle', () => {
  it.each(['missing send', 'disconnected'])('rejects an unavailable IPC channel: %s', async (mode) => {
    if (mode === 'missing send') ipc.send = undefined
    else ipc.connected = false
    await expect(requestClusteredLock(request, 100)).rejects.toThrow('IPC is unavailable')
  })

  it('accepts delivered requests under backpressure and ignores irrelevant or late messages', async () => {
    let callback!: (error: Error | null) => void
    ipc.send.mockImplementation((_sent: unknown, cb: typeof callback) => {
      callback = cb
      return false
    })
    const pending = requestClusteredLock(request, 100)
    const sent = ipc.send.mock.calls[0][0]
    for (const message of [
      null,
      'noise',
      {},
      { source, id: 1 },
      { source, id: 'unrelated' },
      { source: 'other', id: sent.id },
    ])
      ipc.emit('message', message)
    expect(state().pending.size).toBe(1)
    callback(null)
    ipc.emit('message', reply(sent))
    await expect(pending).resolves.toEqual(['UPDATED'])
    callback(new Error('late send error'))
    ipc.emit('message', reply(sent))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates a primary failure and cleans up the pending request', async () => {
    const pending = requestClusteredLock(request, 100)
    ipc.emit('message', { ...reply(ipc.send.mock.calls[0][0]), error: 'primary failed' })
    await expect(pending).rejects.toThrow('primary failed')
  })

  it.each(['callback', 'throw error', 'throw primitive'])('cleans up a send failure: %s', async (mode) => {
    ipc.send.mockImplementation((_sent: unknown, callback: (error: Error) => void) => {
      if (mode === 'callback') callback(new Error('send failed'))
      else if (mode === 'throw error') throw new Error('send failed')
      else throw 'send failed'
    })
    await expect(requestClusteredLock(request, 100)).rejects.toThrow(
      mode === 'throw primitive' ? 'lock request failed' : 'send failed',
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects every pending request on disconnect', async () => {
    const first = requestClusteredLock(request, 100)
    const second = requestClusteredLock(request, 100)
    const checked = Promise.all([
      expect(first).rejects.toThrow('primary disconnected'),
      expect(second).rejects.toThrow('primary disconnected'),
    ])
    ipc.emit('disconnect')
    await checked
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds missing-handler waits and removes its listeners', async () => {
    const pending = requestClusteredLock(request, 100)
    const checked = expect(pending).rejects.toThrow('bootstrapClusteredLru()')
    await vi.advanceTimersByTimeAsync(100)
    await checked
  })

  it('shares one listener across separately loaded module copies', async () => {
    const first = requestClusteredLock(request, 100)
    vi.resetModules()
    const other = await import('../src/backends/clusteredLruLocks')
    const second = other.requestClusteredLock(request, 100)
    expect(ipc.listenerCount('message')).toBe(1)
    ipc.emit('message', reply(ipc.send.mock.calls[0][0]))
    await expect(first).resolves.toEqual(['UPDATED'])
    expect(ipc.listenerCount('message')).toBe(1)
    ipc.emit('message', reply(ipc.send.mock.calls[1][0]))
    await expect(second).resolves.toEqual(['UPDATED'])
  })
})

describe('clustered primary lock handler', () => {
  const worker = () => ({
    isConnected: vi.fn(() => true),
    send: vi.fn((_message: unknown, callback: () => void) => callback()),
  })
  const cache = () => ({ get: vi.fn((): unknown => 'owner'), set: vi.fn(), delete: vi.fn() })

  it('installs once, only in the primary', () => {
    primary.isPrimary = false
    installClusteredLockHandler(() => undefined)
    expect(primary.listenerCount('message')).toBe(0)
    primary.isPrimary = true
    installClusteredLockHandler(() => undefined)
    installClusteredLockHandler(() => undefined)
    expect(primary.listenerCount('message')).toBe(1)
  })

  it('ignores malformed requests and acknowledges readiness without mutating a cache', () => {
    const getCache = vi.fn(() => undefined)
    const client = worker()
    installClusteredLockHandler(getCache)
    const valid = { source, id: 'id', ...request }
    for (const message of [
      null,
      'noise',
      {},
      { ...valid, source: 'other' },
      { ...valid, id: 1 },
      { ...valid, namespace: 1 },
      { ...valid, operation: 'unknown' },
      { ...valid, key: 1 },
      { ...valid, owner: 1 },
      { ...valid, currentTime: '100' },
      { ...valid, currentTime: Infinity },
      { ...valid, recordRefresh: 1 },
    ])
      primary.emit('message', client, message)
    expect(client.send).not.toHaveBeenCalled()
    primary.emit('message', client, { ...valid, operation: 'ready' })
    expect(client.send).toHaveBeenCalledWith({ source, id: 'id', result: undefined, error: undefined }, expect.any(Function))
    expect(getCache).not.toHaveBeenCalled()
  })

  it.each([false, true])('releases only the matching owner with recordRefresh=%s', (recordRefresh) => {
    const store = cache()
    const client = worker()
    installClusteredLockHandler(() => store)
    primary.emit('message', client, { source, id: 'id', ...request, recordRefresh })
    expect(store.get).toHaveBeenCalledWith('refresh-lock', { allowStale: false, updateAgeOnGet: false })
    expect(store.delete).toHaveBeenCalledWith('refresh-lock')
    if (recordRefresh) expect(store.set).toHaveBeenCalledWith('refresh', 100, { ttl: 604800000, size: 23 })
    else expect(store.set).not.toHaveBeenCalled()
    expect(client.send.mock.calls[0][0].result).toEqual(['UPDATED'])
  })

  it.each([undefined, 123, 'successor'])('preserves an absent or different lease: %s', (owner) => {
    const store = cache()
    store.get.mockReturnValue(owner)
    expect(releasePrimaryLock(store, 'refresh', 'owner', 100, true)).toEqual([
      'LOCK_MISMATCH',
      typeof owner === 'string' ? owner : '',
    ])
    expect(store.set).not.toHaveBeenCalled()
    expect(store.delete).not.toHaveBeenCalled()
  })

  it('treats a destroyed namespace as a missing lease', () => {
    expect(releasePrimaryLock(undefined, 'refresh', 'owner', 100, true)).toEqual(['LOCK_MISMATCH', ''])
  })

  it('reports primary operation errors without exposing lease values', () => {
    const client = worker()
    installClusteredLockHandler(() => {
      throw new Error('sensitive owner value')
    })
    primary.emit('message', client, { source, id: 'id', ...request })
    expect(client.send.mock.calls[0][0].error).toBe('Clustered LRU primary lock operation failed')
  })

  it.each(['disconnected', 'send throws'])('tolerates a worker disappearing after release: %s', (mode) => {
    const client = worker()
    const store = cache()
    if (mode === 'disconnected') client.isConnected.mockReturnValue(false)
    else client.send.mockImplementation(() => {
      throw new Error('closed')
    })
    installClusteredLockHandler(() => store)
    expect(() => primary.emit('message', client, { source, id: 'id', ...request })).not.toThrow()
    expect(store.delete).toHaveBeenCalledWith('refresh-lock')
  })
})

describe('clustered backend lock transport wiring', () => {
  it('bootstraps the peer and routes primary releases through its public cache registry', async () => {
    vi.resetModules()
    const { ClusteredLruAdaptiveCacheBackend: Backend, bootstrapClusteredLru } = await import(
      '../src/backends/ClusteredLruAdaptiveCacheBackend'
    )
    const store = { get: () => 'owner', set: vi.fn(), delete: vi.fn() }
    const bootstrap = vi.fn()
    const load = vi.spyOn(Backend, 'loadModule').mockReturnValue({
      LRUCacheClustered: { bootstrap, getAllCaches: () => new Map([['test', store]]) },
    })
    try {
      bootstrapClusteredLru()
      bootstrapClusteredLru()
      expect(bootstrap).toHaveBeenCalledTimes(2)
      expect(primary.listenerCount('message')).toBe(1)
      const send = vi.fn((_message: unknown, callback: () => void) => callback())
      primary.emit('message', { isConnected: () => true, send }, { source, id: 'id', ...request })
      expect(send.mock.calls[0][0]).toMatchObject({ result: ['UPDATED'] })
      expect(store.delete).toHaveBeenCalledWith('refresh-lock')
    } finally {
      load.mockRestore()
    }
  })

  it('checks readiness once before worker acquisition and requires an atomic release result', async () => {
    primary.isPrimary = false
    primary.isWorker = true
    const { ClusteredLruAdaptiveCacheBackend: Backend, bootstrapClusteredLru } = await import(
      '../src/backends/ClusteredLruAdaptiveCacheBackend'
    )
    const { Logger } = await import('../src/lib/logger')
    const backend = new Backend(undefined, new Logger('silent'))
    const getCache = vi.spyOn(backend as any, 'getCache').mockResolvedValue({
      get: async (key: string) => (key.endsWith('-lock') ? 'owner' : undefined),
      setIfAbsent: async () => true,
    })
    ipc.send.mockImplementation((sent: any, callback: (error: null) => void) => {
      callback(null)
      ipc.emit('message', reply(sent, sent.operation === 'ready' ? undefined : ['UPDATED']))
    })
    try {
      expect(() => bootstrapClusteredLru()).toThrow('cluster primary')
      expect(await backend.shouldRefresh('refresh', 0, 100, false, 60, 'owner')).toEqual(['UPDATE', 'owner'])
      expect(await backend.shouldRefresh('refresh', 0, 100, false, 60, 'owner')).toEqual(['UPDATE', 'owner'])
      expect(ipc.send.mock.calls.filter(([sent]: any[]) => sent.operation === 'ready')).toHaveLength(1)
      expect(await backend.releaseLock('refresh', 100, 'owner')).toEqual(['UPDATED'])
      ipc.send.mockImplementation((sent: any) => ipc.emit('message', { source, id: sent.id }))
      await expect(backend.releaseLock('refresh', 100, 'owner')).rejects.toThrow('no lock result')
    } finally {
      getCache.mockRestore()
    }
  })
})
