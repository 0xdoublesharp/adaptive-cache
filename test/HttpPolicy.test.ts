import { describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { ReadableStream } from 'node:stream/web'
import {
  boundedNegativeTTL,
  buildHttpCacheKey,
  getDeclaredVaryHeaders,
  getRequestHeader,
  getResponseHeader,
  isCacheableHttpBody,
  isRequestCacheable,
  isResponseCacheable,
  normalizeHeaderName,
  snapshotHttpResponse,
} from '../src/httpPolicy'
import {
  cachedPolicyResponse,
  cloneHttpBody,
  decodeHttpResponse,
  encodeHttpResponse,
  isEncodedHttpResponse,
} from '../src/httpResponse'

const variedKey = (variation: unknown) =>
  buildHttpCacheKey({
    req: {},
    requestPath: '/records',
    query: { q: 'same' },
    cachePrefix: 'tenant:',
    varyBy: () => variation,
  })
const response = (headers: Record<string, unknown>, statusCode = 200) => ({
  statusCode,
  getHeader: (name: string) => headers[name],
})

it('clones mutable HTTP bodies without losing buffers, undefined, or own prototype-named keys', () => {
  const original = { items: [{ buffer: Buffer.from('body') }, undefined], ...JSON.parse('{"__proto__":{"own":true}}') }
  const copy = cloneHttpBody(original)
  expect(copy).toEqual(original)
  expect(Buffer.isBuffer(copy.items[0].buffer)).toBe(true)
  expect(Object.hasOwn(copy, '__proto__')).toBe(true)
  expect(Object.getPrototypeOf(copy)).toBe(Object.prototype)
  copy.items[0].buffer[0] = 0
  copy.items.push('extra')
  copy.__proto__.own = false
  expect(original.items).toHaveLength(2)
  expect(original.items[0].buffer.toString()).toBe('body')
  expect(original.__proto__.own).toBe(true)
})

describe('HTTP cache key canonicalization', () => {
  it('canonicalizes nested object keys inside ordered arrays without modifying input', () => {
    const original = { z: [{ b: 2, a: 1 }, 'tail'], a: { y: true, x: false } }
    const reordered = { a: { x: false, y: true }, z: [{ a: 1, b: 2 }, 'tail'] }
    const before = JSON.stringify(original)
    expect(variedKey(original)).toBe(variedKey(reordered))
    expect(variedKey(original)).not.toBe(variedKey({ ...original, z: ['tail', { a: 1, b: 2 }] }))
    expect(JSON.stringify(original)).toBe(before)
  })

  it('preserves Buffer content, undefined versus null, and own prototype-named fields in variations', () => {
    expect(variedKey(Buffer.from([0, 255, 1]))).toBe(variedKey(Buffer.from([0, 255, 1])))
    expect(variedKey(Buffer.from([0, 255, 1]))).not.toBe(variedKey(Buffer.from([0, 255, 2])))
    expect(variedKey(undefined)).not.toBe(variedKey(null))
    const withPrototypeKey = JSON.parse('{"nested":{"__proto__":{"tenant":"a"}}}')
    expect(variedKey(withPrototypeKey)).not.toBe(variedKey({ nested: {} }))
    expect(variedKey(withPrototypeKey)).not.toBe(variedKey(JSON.parse('{"nested":{"__proto__":{"tenant":"b"}}}')))
    expect(Object.prototype).not.toHaveProperty('tenant')
  })

  it('normalizes and deduplicates declared header variations while keeping missing and empty values distinct', () => {
    const input = {
      requestPath: '/records',
      query: {},
      cachePrefix: 'tenant:',
      req: { headers: { 'accept-language': 'fr', accept: 'application/json' } },
    }
    expect(buildHttpCacheKey({ ...input, varyBy: [' Accept-Language ', 'ACCEPT', 'accept'] })).toBe(
      buildHttpCacheKey({ ...input, varyBy: ['accept', 'accept-language'] }),
    )
    expect(buildHttpCacheKey({ ...input, varyBy: ['accept'] })).toMatch(/vary:[0-9a-f]{64}:v$/)
    expect(getDeclaredVaryHeaders([' Z ', '', 'z', ' A '])).toEqual(['a', 'z'])
    expect(getDeclaredVaryHeaders(() => 'variation')).toEqual([])
    expect(buildHttpCacheKey({ ...input, req: {}, varyBy: ['accept'] })).not.toBe(
      buildHttpCacheKey({ ...input, req: { headers: { accept: '' } }, varyBy: ['accept'] }),
    )
  })

  it('keeps custom identities within their namespace and lets custom keys own path and query identity', () => {
    const common = {
      req: {},
      requestPath: '/one',
      query: { token: 'first' },
      cachePrefix: 'private:',
      key: () => '../tenant/a',
    }
    const first = buildHttpCacheKey(common)
    expect(first).toMatch(/^private:/)
    expect(first).toBe(buildHttpCacheKey({ ...common, requestPath: '/two', query: { token: 'second' } }))
    expect(first).not.toBe(buildHttpCacheKey({ ...common, cachePrefix: 'other:' }))
    expect(first).not.toBe(buildHttpCacheKey({ ...common, key: () => '../tenant/b' }))
    const varyBy = () => 'variant'
    const keyShapes = [
      first,
      buildHttpCacheKey({ ...common, varyBy }),
      buildHttpCacheKey({ ...common, key: undefined }),
      buildHttpCacheKey({ ...common, key: undefined, varyBy }),
    ]
    expect(new Set(keyShapes).size).toBe(4)
  })
})

describe('HTTP header lookup and cache policy', () => {
  it('normalizes lookup names and preserves empty values before falling back to framework getters', () => {
    expect(normalizeHeaderName('  CONTENT-Type ')).toBe('content-type')
    expect(getRequestHeader({ headers: { authorization: '' }, get: () => 'getter' }, ' AUTHORIZATION ')).toBe('')
    expect(getRequestHeader({ get: (name) => (name === 'accept' ? 'from-get' : undefined) }, ' ACCEPT ')).toBe(
      'from-get',
    )
    expect(
      getRequestHeader(
        { get: () => null, header: (name) => (name === 'accept' ? 'from-header' : undefined) },
        ' ACCEPT ',
      ),
    ).toBe('from-header')
    expect(getRequestHeader({}, 'missing')).toBeUndefined()
    expect(getResponseHeader(response({ 'content-type': 'text/plain' }), ' CONTENT-TYPE ')).toBe('text/plain')
    expect(getResponseHeader({ statusCode: 200 }, 'missing')).toBeUndefined()
  })

  it('requires caller-owned credential isolation even when caching credentials is enabled', () => {
    const request = { method: 'GET', headers: { authorization: 'Bearer a', cookie: 'session=a' } }
    expect(isRequestCacheable(request, { cacheAuthenticated: true, cacheCookies: true })).toBe(false)
    expect(
      isRequestCacheable(request, { cacheAuthenticated: true, cacheCookies: true, varyBy: ['authorization'] }),
    ).toBe(false)
    expect(
      isRequestCacheable(request, {
        cacheAuthenticated: true,
        cacheCookies: true,
        varyBy: ['authorization', 'cookie'],
      }),
    ).toBe(true)
    expect(isRequestCacheable(request, { cacheAuthenticated: true, cacheCookies: true, varyBy: () => 'user-a' })).toBe(
      true,
    )
    expect(isRequestCacheable({ method: 'post' }, {})).toBe(false)
    expect(isRequestCacheable({}, { shouldCache: () => false })).toBe(false)
  })

  it('recognizes private and no-store directives across case, parameters, and multiple field values', () => {
    for (const header of [
      'public, NO-STORE',
      'max-age=10, private="authorization"',
      ['public', ' Private '],
      'no-cache',
      'NO-CACHE="etag"',
    ]) {
      expect(isResponseCacheable({}, response({ 'cache-control': header }), {})).toBe(false)
    }
    for (const header of ['', undefined, null, ['max-age=10', undefined], 'public, x-private=true']) {
      expect(isResponseCacheable({}, response({ 'cache-control': header }), {})).toBe(true)
    }
    expect(isResponseCacheable({}, response({ 'set-cookie': '' }), {})).toBe(false)
  })

  it('bypasses requests that prohibit storage or require validation', () => {
    for (const header of ['no-store', 'NO-CACHE', ['public', ' no-store ']]) {
      expect(isRequestCacheable({ headers: { 'cache-control': header } }, {})).toBe(false)
    }
    expect(isRequestCacheable({ headers: { 'cache-control': 'max-age=60' } }, {})).toBe(true)
  })

  it('combines Vary field values and rejects undeclared identity dimensions', () => {
    const allowed = { varyBy: ['accept-language', 'accept-encoding'] }
    expect(isResponseCacheable({}, response({ vary: [' ACCEPT-LANGUAGE, ', 'accept-encoding'] }), allowed)).toBe(true)
    expect(isResponseCacheable({}, response({ vary: ['accept-language', '*'] }), allowed)).toBe(false)
    expect(isResponseCacheable({}, response({ vary: 'x-tenant' }), allowed)).toBe(false)
    expect(isResponseCacheable({}, response({ vary: [null, '', ' , '] }), {})).toBe(true)
    expect(isResponseCacheable({}, response({ vary: 'accept-language' }), { varyBy: () => ({ locale: 'fr' }) })).toBe(
      false,
    )
  })

  it('limits negative responses and passes a response view to the caller policy', () => {
    for (const ttl of [undefined, NaN, Infinity, 0, -1]) expect(boundedNegativeTTL(ttl, 10)).toBeUndefined()
    expect(boundedNegativeTTL(20, 3)).toBe(3)
    expect(isResponseCacheable({}, response({}, 404), {})).toBe(false)
    expect(isResponseCacheable({}, response({}, 404), { negativeTTL: 1 })).toBe(true)
    expect(isResponseCacheable({}, response({}, 500), { negativeTTL: 1 })).toBe(false)
    const policy = { shouldCache: (_req: unknown, res?: { statusCode: number }) => res?.statusCode === 204 }
    expect(isResponseCacheable({}, response({}, 204), policy)).toBe(true)
    expect(isResponseCacheable({}, response({}, 200), policy)).toBe(false)
  })
})

describe('HTTP response snapshots and payload identity', () => {
  it('captures status and normalized headers without modifying the live response map', () => {
    const languages = ['en']
    const headers = { 'Content-Type': 'application/json', 'X-Trace': 'first', 'Content-Language': languages }
    const live = { statusCode: 404, getHeaders: () => headers }
    const snapshot = snapshotHttpResponse(live)
    live.statusCode = 200
    headers['Content-Type'] = 'text/plain'
    languages.push('fr')
    expect(snapshot.statusCode).toBe(404)
    expect(snapshot.getHeader(' CONTENT-TYPE ')).toBe('application/json')
    expect(snapshot.headers['x-trace']).toBe('first')
    expect(snapshot.getHeader('Content-Language')).toEqual(['en'])
    expect(Object.keys(headers)).toEqual(['Content-Type', 'X-Trace', 'Content-Language'])
    expect(snapshotHttpResponse({ statusCode: 204 }).getHeader('missing')).toBeUndefined()
  })

  it('copies replayable header arrays and never replays cookies or hop-by-hop headers', () => {
    const languages = ['en', 'fr']
    const headers = {
      'Content-Language': languages,
      ETag: 42,
      'Cache-Control': ['public', 'max-age=10'],
      'Content-Type': 'ignored/by-explicit-type',
      'Set-Cookie': ['session=secret'],
      Connection: 'close',
      Vary: undefined,
    }
    const encoded = encodeHttpResponse(Buffer.from([0, 255, 8]), 206, 'application/octet-stream', headers)
    languages.push('de')
    const decoded = decodeHttpResponse(encoded)
    expect(decoded).toMatchObject({
      body: Buffer.from([0, 255, 8]),
      statusCode: 206,
      contentType: 'application/octet-stream',
    })
    expect(decoded.headers).toEqual({
      'content-language': ['en', 'fr'],
      etag: '42',
      'cache-control': ['public', 'max-age=10'],
      'content-type': 'application/octet-stream',
    })
    decoded.headers!['content-language'] = ['changed']
    expect(encoded.headers['content-language']).toEqual(['en', 'fr'])
  })

  it('preserves legacy payloads and empty binary responses without inventing HTTP metadata', () => {
    for (const value of [null, undefined, 'plain', '{"looks":"json"}', { legacy: true }]) {
      expect(decodeHttpResponse(value)).toEqual({ body: value })
    }
    expect(decodeHttpResponse(encodeHttpResponse(Buffer.alloc(0), 204, undefined))).toEqual({
      body: Buffer.alloc(0),
      statusCode: 204,
      contentType: undefined,
      headers: {},
    })
    expect(decodeHttpResponse({ __adaptiveCacheHttpResponse: 1, statusCode: 200, body: 'old envelope' })).toEqual({
      body: 'old envelope',
      statusCode: 200,
      contentType: undefined,
      headers: {},
    })
  })

  it('stores only declared policy headers separately from wire headers and excludes credentials', () => {
    const markers = ['yes', 42]
    const encoded = encodeHttpResponse(
      'body',
      201,
      undefined,
      { 'X-Marker': markers, 'X-Missing': undefined, 'Set-Cookie': 'session=secret', ETag: 'tag', 'X-Trace': 'trace' },
      [' X-Marker ', 'x-marker', '', 'X-Missing', 'Set-Cookie', 'ETag'],
    )
    expect(encoded.policyHeaders).toEqual({ 'x-marker': ['yes', '42'] })
    expect(encoded.headers).toEqual({ etag: 'tag' })
    markers.push('later')

    const decoded = decodeHttpResponse(JSON.parse(JSON.stringify(encoded)))
    expect(decoded.policyHeaders).toEqual({ 'x-marker': ['yes', '42'] })
    expect(decoded.headers).toEqual({ etag: 'tag' })
    const response = cachedPolicyResponse(decoded)
    expect(response.statusCode).toBe(201)
    expect(response.getHeaders()).toEqual({ etag: 'tag', 'x-marker': ['yes', '42'] })
    expect(response.getHeader(' X-MARKER ')).toEqual(['yes', '42'])
    expect(response.getHeader('set-cookie')).toBeUndefined()
    expect(response.getHeader('__proto__')).toBeUndefined()
    expect(
      encodeHttpResponse('body', 200, undefined, { 'Set-Cookie': 'session=secret' }, ['set-cookie']),
    ).not.toHaveProperty('policyHeaders')
  })

  it('tracks provenance for the original encoder output', () => {
    const encoded = encodeHttpResponse('body', 200, undefined)
    expect(isEncodedHttpResponse(encoded)).toBe(true)
    for (const value of [{ ...encoded }, null, undefined, 'body']) expect(isEncodedHttpResponse(value)).toBe(false)
  })

  it('excludes Node and Web streams while accepting ordinary binary and structured bodies', async () => {
    const node = Readable.from(['body'])
    const web = new ReadableStream({
      start(controller) {
        controller.close()
      },
    })
    expect(isCacheableHttpBody(node)).toBe(false)
    expect(isCacheableHttpBody(web)).toBe(false)
    for (const body of [
      null,
      undefined,
      'text',
      Buffer.from('bytes'),
      new Uint8Array([1]),
      new DataView(new ArrayBuffer(1)),
      { data: [] },
    ])
      expect(isCacheableHttpBody(body)).toBe(true)
    expect(isCacheableHttpBody({ nested: Buffer.from('bytes') })).toBe(false)
    const view = new DataView(new ArrayBuffer(1))
    Object.defineProperty(view, '0', { value: true })
    expect(isCacheableHttpBody(view)).toBe(false)
    const metadata = Buffer.from('bytes')
    let lengthReads = 0
    Object.defineProperty(metadata, 'length', {
      get() {
        lengthReads++
        return 5
      },
    })
    expect(isCacheableHttpBody(metadata)).toBe(false)
    expect(lengthReads).toBe(0)
    node.destroy()
    await web.cancel()
  })
})
