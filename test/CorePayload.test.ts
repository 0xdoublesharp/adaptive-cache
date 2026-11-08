import crypto from 'node:crypto'
import { constants as bufferConstants } from 'node:buffer'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { Logger } from '../src/lib/logger'
import { encodePayload } from '../src/payload'
import { registerCoreCacheFixture } from './helpers/coreCache'

const { create } = registerCoreCacheFixture()

describe('core payload and typed APIs', () => {
  it('evaluates a custom fingerprint before toJSON can mutate the original object', async () => {
    const cache = create({ fingerprint: (value) => value.identity, includeDebugHeaders: true })
    const value = {
      identity: 'before',
      toJSON() {
        const snapshot = { identity: this.identity }
        this.identity = 'after'
        return snapshot
      },
    }
    await cache.set('custom-snapshot', value)
    expect((await cache.get('custom-snapshot'))?.data).toEqual({ identity: 'before' })
    await cache.set('custom-snapshot', { identity: 'after' })
    expect((await cache.get('custom-snapshot'))?.metadata).toMatchObject({ dataTTL: 2, changeCount: 2 })
  })

  it.each([{ ignoreFields: undefined }, { ignoreFields: ['volatile'] }])(
    'fingerprints the stored snapshot with %j',
    async ({ ignoreFields }) => {
      const cache = create({ ignoreFields, compress: false, includeDebugHeaders: true })
      let serializations = 0
      const value = {
        toJSON() {
          return { version: ++serializations, volatile: 'first' }
        },
      }

      await cache.set('snapshot', value)
      expect(serializations).toBe(1)
      expect((await cache.get('snapshot'))?.data).toEqual({ version: 1, volatile: 'first' })

      // Rewriting the stored value must count as unchanged content.
      await cache.set('snapshot', { version: 1, volatile: 'first' })
      expect((await cache.get('snapshot'))?.metadata).toMatchObject({ dataTTL: 4, changeCount: 1 })
    },
  )

  it('round trips selective async compression across differently configured readers', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: crypto.randomUUID() }, new Logger('silent'))
    const writer = create({
      backend,
      compression: { minBytes: 100, async: true, onlyIfSmaller: true, skipCompressed: true },
    })
    const reader = create({ backend, compress: false })
    const values = [
      'short',
      'repeat'.repeat(10000),
      crypto.randomBytes(1024),
      zlib.gzipSync('compressed'),
      undefined,
      { answer: 42 },
    ]
    for (const [i, data] of values.entries()) {
      await writer.set(String(i), data)
      expect((await reader.get(String(i)))?.data).toEqual(data)
    }
  })

  it('ignores nested fingerprint fields without dropping them from the stored payload', async () => {
    const cache = create({ ignoreFields: ['request.id', 'updatedAt'], includeDebugHeaders: true, compress: false })
    await cache.set('fingerprint', { stable: 1, request: { id: 'a', path: '/' }, updatedAt: 1 })
    await cache.set('fingerprint', { stable: 1, request: { id: 'b', path: '/' }, updatedAt: 2 })
    const hit = await cache.get('fingerprint')
    expect(hit?.metadata?.dataTTL).toBe(4)
    expect(hit?.data).toEqual({ stable: 1, request: { id: 'b', path: '/' }, updatedAt: 2 })
  })

  it('bulk operations and observer failures preserve cache behavior and count real outcomes', async () => {
    const cache = create({
      onEvent: () => {
        throw new Error('observer')
      },
    })
    const events: string[] = []
    const unsubscribe = cache.onEvent((event) => {
      events.push(event.type)
    })
    await cache.setMany([
      { key: 'a', data: 1 },
      { key: 'b', data: 2 },
    ])
    const hits = await cache.getMany<number>(['b', 'missing', 'a'])
    expect([...hits.keys()]).toEqual(['b', 'missing', 'a'])
    expect(hits.get('a')?.data).toBe(1)
    expect(hits.get('missing')).toBeNull()
    expect(cache.getStats().counters).toMatchObject({ hit: 2, miss: 1, write: 2 })
    expect(cache.getStats().hitsByLayer.lru).toBe(2)
    unsubscribe()
    await cache.clearMany(['a', 'b'])
    expect((await cache.getMany(['a', 'b'])).get('b')).toBeNull()
    expect(events.sort()).toEqual(['hit', 'hit', 'miss', 'write', 'write'])
    await cache.close()
    await expect(cache.set('closed', 1)).rejects.toThrow('closed')
  })

  it.each([
    { initialTTL: 0 },
    { ttlJitter: 2 },
    { staleIfError: -1 },
    { compression: { minBytes: NaN } },
    { compression: { maxDecodedBytes: 0 } },
    { compression: { maxDecodedBytes: 1.5 } },
    { redis: { maxTagCleanupKeys: 0 } },
    { redis: { maxTagCleanupKeys: 1.5 } },
  ])('rejects invalid options %o', (options) => {
    expect(() => create(options)).toThrow()
  })

  it('accepts valid resource ceilings', () => {
    expect(() => create({ compression: { maxDecodedBytes: 1024 }, redis: { maxTagCleanupKeys: 1 } })).not.toThrow()
  })

  it('reports the buffer ceiling before rejecting an oversized decoded-byte limit', () => {
    expect(() => create({ compression: { maxDecodedBytes: bufferConstants.MAX_LENGTH + 1 } })).toThrow(
      `compression.maxDecodedBytes must be at most ${bufferConstants.MAX_LENGTH}`,
    )
  })

  it('rejects invalid tags consistently through public writes and invalidation', async () => {
    const cache = create()
    await expect(cache.set('invalid-tag', 'value', { tags: [''] })).rejects.toThrow('non-empty')
    await expect(cache.invalidateTags([''])).rejects.toThrow('non-empty')
  })
})

describe('codec compatibility', () => {
  it('reads legacy raw JSON, strings, buffers, and gzip payloads', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: crypto.randomUUID() }, new Logger('silent'))
    const plain = create({ backend, compress: false }),
      compressed = create({ backend })
    const fixtures: Array<[string, unknown, boolean]> = [
      ['{"legacy":true}', { legacy: true }, false],
      ['raw text', 'raw text', false],
      ['{"__adaptiveCachePayload":1,"type":"buffer","value":"AQID"}', Buffer.from([1, 2, 3]), false],
      [zlib.gzipSync('{"old":"gzip"}').toString('base64'), { old: 'gzip' }, true],
    ]
    for (const [i, [encodedData, expected, isGzip]] of fixtures.entries()) {
      await backend.update({
        key: String(i),
        dataKey: i + 'data',
        metaKey: i + 'meta',
        redisPrefix: 'adaptive:',
        encodedData,
        responseHash: String(i),
        initialTTL: 20,
        maxTTL: 20,
        ttlScaling: 2,
        metaTTL: 30,
        tags: [],
      })
      expect((await (isGzip ? compressed : plain).get(String(i)))?.data).toEqual(expected)
    }
  })

  it('custom fingerprints grow TTL while retaining the most recent payload', async () => {
    const cache = create({ fingerprint: (data) => Buffer.from(data.identity), includeDebugHeaders: true })
    await cache.set('custom', { identity: 'same', volatile: 1 })
    await cache.set('custom', { identity: 'same', volatile: 2 })
    expect((await cache.get('custom'))?.metadata?.dataTTL).toBe(4)
    expect((await cache.get('custom'))?.data.volatile).toBe(2)
  })

  it('selective compression avoids growth and known compressed binary formats', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: crypto.randomUUID() }, new Logger('silent'))
    const cache = create({ backend, compression: { onlyIfSmaller: true, skipCompressed: true } })
    const inputs: Array<[string, unknown, string]> = [
      ['tiny', '', 'json:'],
      ['repeat', 'abc'.repeat(1000), 'gzip:'],
      ['gzip', zlib.gzipSync('abc'.repeat(1000)), 'json:'],
    ]
    for (const [key, data, codec] of inputs) {
      await cache.set(key, data)
      const stored = await backend.fetch({
        key,
        dataKey: key + 'data',
        metaKey: key + 'meta',
        redisPrefix: 'adaptive:',
        includeDebugHeaders: false,
      })
      expect(stored?.encodedData).toMatch('adaptive-cache:v2:' + codec)
      expect((await cache.get(key))?.data).toEqual(data)
    }
  })
})

describe('codec policy edge cases', () => {
  it('rejects writes that would exceed the configured payload ceiling', async () => {
    const cache = create({ compression: { maxDecodedBytes: 128 } })
    await expect(cache.set('too-large-to-read', 'x'.repeat(2048))).rejects.toThrow('maxDecodedBytes')
    expect(await cache.get('too-large-to-read')).toBeNull()
  })

  it.each([
    { name: 'marked JSON', marked: true },
    { name: 'legacy plain', marked: false },
  ])('rejects $name payloads above maxDecodedBytes', async ({ marked }) => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: crypto.randomUUID() }, new Logger('silent'))
    const raw = encodePayload('x'.repeat(2048))
    await backend.update({
      key: 'bounded-plain',
      dataKey: 'bounded-plaindata',
      metaKey: 'bounded-plainmeta',
      redisPrefix: 'adaptive:',
      encodedData: marked ? 'adaptive-cache:v2:json:' + raw : raw,
      responseHash: 'bounded-plain',
      initialTTL: 20,
      maxTTL: 20,
      ttlScaling: 2,
      metaTTL: 30,
      tags: [],
    })
    const cache = create({
      backend,
      ...(marked ? {} : { compress: false }),
      compression: { maxDecodedBytes: 128 },
    } as any)
    await expect(cache.get('bounded-plain')).rejects.toThrow('maxDecodedBytes')
  })

  it.each([
    { name: 'marked sync', marked: true, async: false },
    { name: 'marked async', marked: true, async: true },
    { name: 'legacy sync', marked: false, async: false },
    { name: 'legacy async', marked: false, async: true },
  ])('rejects $name gzip payloads above maxDecodedBytes', async ({ marked, async }) => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: crypto.randomUUID() }, new Logger('silent'))
    const raw = encodePayload('x'.repeat(2048))
    const compressed = zlib.gzipSync(raw).toString('base64')
    const encodedData = marked ? 'adaptive-cache:v2:gzip:' + compressed : compressed
    await backend.update({
      key: 'bounded',
      dataKey: 'boundeddata',
      metaKey: 'boundedmeta',
      redisPrefix: 'adaptive:',
      encodedData,
      responseHash: 'bounded',
      initialTTL: 20,
      maxTTL: 20,
      ttlScaling: 2,
      metaTTL: 30,
      tags: [],
    })
    const cache = create({ backend, compression: { async, maxDecodedBytes: 128 } } as any)
    await expect(cache.get('bounded')).rejects.toThrow()
  })

  it.each([
    { name: 'marked', marked: true },
    { name: 'legacy', marked: false },
  ])('rejects oversized $name encoded gzip before base64 allocation', async ({ marked }) => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: crypto.randomUUID() }, new Logger('silent'))
    const base64 = 'A'.repeat(Math.ceil(128 * 1.5) + 4097)
    await backend.update({
      key: 'bounded-encoded',
      dataKey: 'bounded-encodeddata',
      metaKey: 'bounded-encodedmeta',
      redisPrefix: 'adaptive:',
      encodedData: marked ? 'adaptive-cache:v2:gzip:' + base64 : base64,
      responseHash: 'bounded-encoded',
      initialTTL: 20,
      maxTTL: 20,
      ttlScaling: 2,
      metaTTL: 30,
      tags: [],
    })
    const cache = create({ backend, compression: { maxDecodedBytes: 128 } } as any)

    await expect(cache.get('bounded-encoded')).rejects.toThrow('Encoded cache payload')
  })

  it('decodes compressed text asynchronously and respects compress=false with a compression policy', async () => {
    const cache = create({ compression: { async: true } })
    const data = 'asynchronous decompression '.repeat(1000)
    await cache.set('async-read', data)
    expect((await cache.get('async-read'))?.data).toBe(data)
    const disabled = create({ compress: false, compression: { minBytes: 0 } })
    await disabled.set('disabled', data)
    expect((await disabled.get('disabled'))?.data).toBe(data)
  })

  it('ignores absent, primitive, and inherited paths safely without mutating user data', async () => {
    const cache = create({
      ignoreFields: ['missing.id', 'nullable.id', 'text.id', 'constructor.prototype.polluted', 'ignored'],
      includeDebugHeaders: true,
    })
    const first = { nullable: null, text: 'value', ignored: { id: 1 }, keep: 'present' }
    await cache.set('safe-fields', first)
    await cache.set('safe-fields', { ...first, ignored: { id: 2 } })
    expect((await cache.get('safe-fields'))?.metadata?.dataTTL).toBe(4)
    expect(first.ignored).toEqual({ id: 1 })
    expect((await cache.get('safe-fields'))?.data.ignored).toEqual({ id: 2 })
  })

  it('skips redundant gzip for compressed images and ZIP data even when compression is forced for other buffers', async () => {
    const backend = new ClusteredLruAdaptiveCacheBackend({ namespace: crypto.randomUUID() }, new Logger('silent'))
    const cache = create({ backend, compression: { skipCompressed: true, onlyIfSmaller: false } })
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7xsAAAAASUVORK5CYII=',
      'base64',
    )
    const zip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex')
    // Valid 1x1 red images generated with Pillow.
    const jpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3E//Z',
      'base64',
    )
    const webp = Buffer.from(
      'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=',
      'base64',
    )
    for (const [key, data] of [
      ['png', png],
      ['zip', zip],
      ['jpeg', jpeg],
      ['webp', webp],
    ] as const) {
      await cache.set(key, data)
      const stored = await backend.fetch({
        key,
        dataKey: key + 'data',
        metaKey: key + 'meta',
        redisPrefix: 'adaptive:',
        includeDebugHeaders: false,
      })
      expect(stored?.encodedData).toMatch(/^adaptive-cache:v2:json:/)
      expect((await cache.get(key))?.data).toEqual(data)
    }
  })
})
