import assert from 'node:assert/strict'
import cluster from 'node:cluster'
import { createRequire } from 'node:module'

const run = async () => {
  const previousListeners = new Set(cluster.listeners('message'))
  const { ClusteredLruAdaptiveCacheBackend, bootstrapClusteredLru } = await import(
    '../../src/backends/ClusteredLruAdaptiveCacheBackend'
  )

  // The bundled fixture lives in TMPDIR; resolve the installed peer from the
  // owning package, exactly as the unbundled adapter does.
  const requirePeer = createRequire(process.argv[2])
  ClusteredLruAdaptiveCacheBackend.loadModule = () => requirePeer('@0xdoublesharp/lru-cache-clustered')
  const namespace = `release-worker-${process.env.LOCK_TEST_ID}`
  const backend = new ClusteredLruAdaptiveCacheBackend(
    { namespace, timeout: 1000, maxSizeBytes: 1024 * 1024 },
    { debug() {}, warn() {}, error() {}, info() {} } as any,
  )
  const keys = ['release-without-marker', 'release-with-marker']

  const runWorker = async () => {
    process.once('disconnect', () => process.exit())
    if (process.env.LOCK_TEST_NO_BOOTSTRAP === '1') {
      assert.equal(
        await backend.fetch({
          key: 'missing',
          dataKey: 'missingdata',
          metaKey: 'missingmeta',
          redisPrefix: 'test:',
          includeDebugHeaders: false,
        }),
        null,
      )
      await assert.rejects(backend.shouldRefresh('unavailable', 0, 100, false, 60, 'owner'), /bootstrapClusteredLru/)
      process.send!({ kind: 'done' })
      return
    }
    for (const [index, key] of keys.entries()) {
      const recordRefresh = index === 1
      assert.deepEqual(await backend.releaseLock(key, 100, 'owner', recordRefresh), ['UPDATED'])
      assert.deepEqual(await backend.releaseLock(key, 101, 'owner', recordRefresh), ['LOCK_MISMATCH', 'successor'])
      assert.deepEqual(await backend.shouldRefresh(key, 0, 101, false, 60, 'other'), ['UPDATING', 'successor'])
    }
    await backend.quit(true)
    process.send!({ kind: 'done' })
  }

  const runPrimary = async () => {
    const noBootstrap = process.env.LOCK_TEST_NO_BOOTSTRAP === '1'
    if (noBootstrap) {
      // Model an application which bootstraps only the peer, omitting adaptive-cache.
      // Its regular cache IPC works, but atomic lock IPC must fail closed.
      const peer = ClusteredLruAdaptiveCacheBackend.loadModule()
      peer.LRUCacheClustered.bootstrap()
      // Remove only the handler installed by importing this fixture's adapter.
      for (const listener of cluster.listeners('message')) {
        if (!previousListeners.has(listener)) cluster.off('message', listener)
      }
    } else {
      bootstrapClusteredLru()
      bootstrapClusteredLru()
    }
    let primary: any
    if (!noBootstrap) {
      for (const key of keys) await backend.shouldRefresh(key, 0, 100, false, 60, 'owner')
      primary = (await (backend as any).getCache()).getCache()
      const get = primary.get.bind(primary)
      const pending = new Set(keys.map((key) => key + '-lock'))
      primary.get = (key: string) => {
        const value = get(key)
        if (pending.delete(key)) {
          globalThis.queueMicrotask(() => primary.set(key, 'successor', { ttl: 60_000, size: 128 }))
        }
        return value
      }
    }
    const worker = cluster.fork()
    try {
      await new Promise<void>((resolve, reject) => {
        worker.on('message', (message) => {
          if (message?.kind === 'done') resolve()
          if (message?.kind === 'failed') reject(new Error(message.error))
        })
        worker.once('error', reject)
        worker.once('exit', (code) => reject(new Error(`Worker exited before completion: ${code}`)))
      })
      if (!noBootstrap) {
        for (const key of keys) assert.equal(primary.get(key + '-lock'), 'successor')
        assert.equal(primary.get(keys[0]), undefined)
        assert.equal(primary.get(keys[1]), 100)
      }
      const exit = new Promise<void>((resolve) => worker.once('exit', () => resolve()))
      worker.disconnect()
      await exit
      await backend.quit()
      process.send!({ kind: 'done' })
    } finally {
      if (!worker.isDead()) worker.kill()
    }
  }

  await (cluster.isPrimary ? runPrimary() : runWorker())
}

void run().catch((error) => {
  process.send!({ kind: 'failed', error: String(error) }, () => process.exit(1))
})
