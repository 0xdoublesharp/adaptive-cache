import zlib from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { decodeHttpResponse, encodeHttpResponse } from '../src/httpResponse'
import { decode, encode, encodePayload, fingerprint, fingerprintTarget } from '../src/payload'
import { registerCoreCacheFixture } from './helpers/coreCache'

const { create } = registerCoreCacheFixture()
const ignoreOptions = { ignoreFields: ['ignored'] }
const noIgnore = { ignoreFields: [] }
const jsonType = 'application/problem+json; charset=utf-8'
const hash = (value: unknown, options = ignoreOptions) => fingerprint(value, options, encodePayload(value))
const response = (body: unknown, etag = '"original"') => encodeHttpResponse(body, 200, jsonType, { etag })
const hashWithoutEtag = (body: unknown) => hash(encodeHttpResponse(body, 200, jsonType), noIgnore)

describe('HTTP envelope provenance', () => {
  it('ignores top-level fields in plain JSON with an HTTP marker', () => {
    const data = { __adaptiveCacheHttpResponse: 1, body: { stable: 'x' }, volatile: 1 }
    const options = { ignoreFields: ['volatile'] }

    expect(hash(data, options)).toBe(hash({ ...data, volatile: 2 }, options))
    expect(hash(data, options)).not.toBe(hash({ ...data, body: { stable: 'y' } }, options))
  })

  it('passes the full plain object to a custom fingerprint', async () => {
    const data = { __adaptiveCacheHttpResponse: 1, body: { stable: 'x' }, volatile: 1 }
    const custom = vi.fn((_value: unknown) => 'custom')

    await create({ fingerprint: custom }).set('http-marker', data)

    expect(custom.mock.calls[0]?.[0]).toBe(data)
  })

  it('only skips compression for a trusted binary envelope', async () => {
    const envelope = response(zlib.gzipSync('already compressed'))
    const plain = { ...envelope }
    const options = { compression: { skipCompressed: true } }

    expect(await encode(envelope, options, encodePayload(envelope))).toMatch(/^adaptive-cache:v2:json:/)
    expect(await encode(plain, options, encodePayload(plain))).toMatch(/^adaptive-cache:v2:gzip:/)
  })

  it.each([
    [response(Buffer.from([1, 2])), Buffer.from([1, 2])],
    [encodeHttpResponse('{"a":1}', 200, 'Application/JSON'), { a: 1 }],
    [response('{invalid'), '{invalid'],
    [response('false'), 'false'],
    [encodeHttpResponse('{"a":1}', 200, 'text/plain'), '{"a":1}'],
    [response({ a: 1 }), { a: 1 }],
  ])('passes the trusted response body %j to custom fingerprints', (envelope, expected) => {
    expect(fingerprintTarget(envelope)).toEqual(expected)
  })
})

describe('lossless HTTP JSON fingerprints', () => {
  it('compacts whitespace even when an optional ignored field is absent', () => {
    expect(hash(response('{ "name": "A" }'))).toBe(hash(response('{"name":"A","ignored":1}', '"other"')))
  })

  it('preserves distinct unsafe integers when stripping ignored fields', () => {
    expect(hash(response('{"id":9007199254740993,"ignored":1}'))).not.toBe(
      hash(response('{"id":9007199254740992,"ignored":2}')),
    )
    expect(hash(response('{"id":9007199254740993}'))).toBe(
      hash(response('{ "id" : 9007199254740993 , "ignored" : 9 }')),
    )
  })

  it('handles nested objects, escaped keys and strings, and all JSON value kinds', () => {
    const body = String.raw`{
      "generatedAt": 123,
      "meta" : {"request\u0049d": "old", "keep": 1, "keep": 2},
      "__proto__": {"ignored": 1, "keep": true},
      "array": [ {}, [], {"ignored": false}, null, "two  spaces\n\"\\\/" ],
      "numbers": [ -0, -12.030E+04, 6e-7, 1e999 ]
    }`
    const expected = String.raw`{"meta":{"keep":2},"__proto__":{"keep":true},"array":[{},[],{"ignored":false},null,"two  spaces\n\"\\/"],"numbers":[-0,-12.030E+04,6e-7,1e999]}`
    const ignoreFields = [
      'generatedAt',
      'meta.requestId',
      '__proto__.ignored',
      'array.2.ignored',
      'meta.keep.any.path',
      'missing.nested.ignored',
      'constructor.prototype.ignored',
    ]

    expect(hash(response(`\t\r\n${body}\r\n\t `), { ignoreFields })).toBe(hashWithoutEtag(expected))
  })

  it('compacts a root array without traversing its indices', () => {
    expect(hash(response(' [ { "ignored" : 1 } ] '), { ignoreFields: ['0.ignored', 'ignored'] })).toBe(
      hashWithoutEtag('[{"ignored":1}]'),
    )
    expect(hash(response(' [ ] '))).toBe(hashWithoutEtag('[]'))
    expect(hash(response(' { "ignored": true } '))).toBe(hashWithoutEtag('{}'))
  })

  it.each([
    '{invalid',
    '{1:2}',
    '{"a" 1}',
    '{"a":}',
    '{"a":1 "b":2}',
    '{"ignored":1,}',
    '{}[]',
    '[1,]',
    '[01]',
    '[1e]',
    '[1.]',
    '["unterminated]',
    String.raw`["\x"]`,
    '["unescaped\nnewline"]',
    '[\v1]',
    '{}\u00a0',
    '',
    ' false ',
    'null',
    '42',
    '"text"',
  ])('hashes original bytes and ETag for malformed or scalar JSON %j', (body) => {
    const value = response(body)

    expect(hash(value)).toBe(hash(value, noIgnore))
  })

  it('preserves differences in text/plain body bytes', () => {
    const textResponse = (body: string) => encodeHttpResponse(body, 200, 'text/plain')

    expect(hash(textResponse('{"a":1}'))).not.toBe(hash(textResponse('{ "a" : 1 }')))
  })

  it.each([response(false), response(Buffer.from([1])), encodeHttpResponse('{"ignored":1}', 200, undefined)])(
    'preserves non-JSON response bodies %j',
    (value) => {
      expect(hash(value)).toBe(hash(value, noIgnore))
    },
  )

  it('continues to strip ignored fields from object bodies', () => {
    expect(hash(response({ keep: true, ignored: 1 }))).toBe(hashWithoutEtag({ keep: true }))
  })

  it('decodes an empty buffer payload', async () => {
    const empty = Buffer.alloc(0)

    await expect(decode(encodePayload(empty), { compress: false })).resolves.toEqual(empty)
  })

  it('retains the original raw payload and ETag for replay', async () => {
    const body = '{ "id": 9007199254740993, "ignored": 1 }'
    const envelope = response(body)
    const raw = encodePayload(envelope)
    const options = { ...ignoreOptions, compress: false }

    expect(fingerprint(envelope, options, raw)).toBe(hash(response('{"id":9007199254740993}', '"other"')))
    expect(encodePayload(envelope)).toBe(raw)
    const stored = await encode(envelope, options, raw)
    expect(stored).toBe(raw)
    expect(decodeHttpResponse(await decode(stored, options))).toMatchObject({ body, headers: { etag: '"original"' } })
  })
})
