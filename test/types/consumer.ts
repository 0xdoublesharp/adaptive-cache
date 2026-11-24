import express, { type Request } from 'express'
import fastify, { type FastifyRequest } from 'fastify'
import type Redis from 'ioredis'
import {
  AdaptiveCache,
  adaptiveExpressCache,
  adaptiveFastifyCache,
  type AdaptiveCacheMetadata,
  type AdaptiveCacheLruLocalL1Options,
  type AdaptiveCacheTtlPolicy,
  type AdaptiveCacheTtlPolicyState,
  type HttpPolicyOptions,
  type ExpressRequestLike,
  type FastifyRequestLike,
} from '../../dist/index.js'
const metadata: AdaptiveCacheMetadata = { dataTTL: 5, changeCount: 1 }
const localL1: AdaptiveCacheLruLocalL1Options = { enabled: true, experimental: true }
const httpPolicy: HttpPolicyOptions = { varyBy: ['accept-language'] }
const expressReq: ExpressRequestLike = { originalUrl: '/items', query: {} }
const fastifyReq: FastifyRequestLike = { url: '/items', query: {} }
void [metadata, localL1, httpPolicy, expressReq, fastifyReq]
const policy: AdaptiveCacheTtlPolicy = { type: 'ewma', halfLifeSeconds: 30, targetChangeProbability: 0.1 }
const cache = new AdaptiveCache({ backend: 'clustered-lru', ttlPolicy: policy })
const value: Promise<{ id: number }> = cache.getOrSet('item', async () => ({ id: 1 }))
void value
const expressMiddleware = adaptiveExpressCache({
  backend: 'clustered-lru',
  ttlPolicy: { type: 'aimd', increaseSeconds: 2 },
})
express().use(expressMiddleware)
void expressMiddleware.clear({} as Request)
const plugin = adaptiveFastifyCache({ backend: 'clustered-lru', ttlPolicy: policy })
void fastify().register(plugin)
void plugin.clear({} as FastifyRequest)
const state: AdaptiveCacheTtlPolicyState = {
  signature: 'policy',
  observedAt: 1000,
  observedHash: 'hash',
  changeRate: 0.1,
}
void state

const typedExpress = adaptiveExpressCache<Request & { tenant: string }>({
  backend: 'clustered-lru',
  key: (req) => req.tenant,
  loader: async (req) => ({ id: req.params.id, tenant: req.tenant }),
})
express().use(typedExpress)
const typedFastify = adaptiveFastifyCache<FastifyRequest<{ Params: { id: string } }> & { tenant: string }>({
  backend: 'clustered-lru',
  key: (req) => req.tenant,
  loader: async (req) => ({ id: req.params.id, tenant: req.tenant }),
})
void fastify().register(typedFastify)

// Raw Redis replies use decimal text to preserve fractional TTLs; cache writes
// continue to expose a numeric TTL to package consumers.
void cache.set('typed-write', {}).then((result) => result[1].toFixed(2))
const checkRawRedisTTL = async (redis: Redis) => {
  const result = await redis.adaptiveCacheUpdate('data', 'meta', 'hash', '{}', '0.5', '1', '2', '60')
  const ttl: string | number = result[1]
  void ttl
  // @ts-expect-error Raw RESP TTLs require conversion before arithmetic.
  result[1].toFixed(2)
}
void checkRawRedisTTL
