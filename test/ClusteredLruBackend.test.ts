import { describe, expect, it } from 'vitest'
import { AdaptiveCache } from '../src'

const namespace = (name: string) => `adaptive-cache-test-${name}-${Date.now()}-${Math.random()}`

describe('Clustered LRU backend', () => {
  it('should cache data and adapt TTL without Redis', async () => {
    const cache = new AdaptiveCache({
      backend: 'clustered-lru',
      initialTTL: 2,
      maxTTL: 20,
      ttlScaling: 2,
      includeDebugHeaders: true,
      lru: {
        namespace: namespace('lru-adapt'),
        maxSizeBytes: 1024 * 1024,
      },
    })

    await cache.set('lru-adapt-key', { val: 1 })
    const first = await cache.get('lru-adapt-key')
    expect(first?.data).toEqual({ val: 1 })
    expect(Number(first?.metadata.dataTTL)).toBe(2)

    await cache.set('lru-adapt-key', { val: 1 })
    const second = await cache.get('lru-adapt-key')
    expect(Number(second?.metadata.dataTTL)).toBeGreaterThan(2)

    await cache.set('lru-adapt-key', { val: 2 })
    const third = await cache.get('lru-adapt-key')
    expect(third?.data).toEqual({ val: 2 })
    expect(Number(third?.metadata.dataTTL)).toBe(2)
    expect(Number(third?.metadata.changeCount)).toBeGreaterThan(1)
  })

  it('should invalidate tags in standalone clustered LRU mode', async () => {
    const cache = new AdaptiveCache({
      backend: 'clustered-lru',
      lru: {
        namespace: namespace('lru-tags'),
        maxSizeBytes: 1024 * 1024,
      },
    })

    await cache.set('lru-tag-key', { val: 1 }, { tags: ['lru-tag'] })
    expect(await cache.get('lru-tag-key')).not.toBeNull()

    await cache.invalidateTags(['lru-tag'])

    expect(await cache.get('lru-tag-key')).toBeNull()
  })

  it('should skip oversized L1 entries', async () => {
    const cache = new AdaptiveCache({
      backend: 'clustered-lru',
      lru: {
        namespace: namespace('lru-oversized'),
        maxSizeBytes: 1024,
        maxEntrySizeBytes: 256,
      },
    })

    await cache.set('lru-oversized-key', { value: 'x'.repeat(1024) })

    expect(await cache.get('lru-oversized-key')).toBeNull()
  })
})
