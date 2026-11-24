import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import Redis from 'ioredis'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AdaptiveCache } from '../src/AdaptiveCache'
import { ClusteredLruAdaptiveCacheBackend } from '../src/backends/ClusteredLruAdaptiveCacheBackend'
import { L1RedisAdaptiveCacheBackend } from '../src/backends/L1RedisAdaptiveCacheBackend'
import { RedisAdaptiveCacheBackend } from '../src/backends/RedisAdaptiveCacheBackend'
import { Logger } from '../src/lib/logger'

const repoRoot = path.resolve(__dirname, '..')
const tlaDir = path.join(repoRoot, 'formal', 'tla')
const traceKeys = ['k1', 'k2'] as const
const traceWriters = ['w1', 'w2'] as const
const traceTags = ['t1', 't2'] as const
const traceRuns = Number(process.env.TLA_TRACE_RUNS || 4)
const traceSeed = process.env.TLA_TRACE_SEED

const traceKey = fc.constantFrom(...traceKeys)
const traceTag = fc.constantFrom(...traceTags)
const traceOperation = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('write'),
      writer: fc.constantFrom(...traceWriters),
      key: traceKey,
      tags: fc.subarray([...traceTags]),
    }),
  },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('read'), key: traceKey }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('clear'), key: traceKey }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('invalidate-tag'), tag: traceTag }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'invalidate-namespace' } as const) },
)

const findJava = () => {
  if (process.env.JAVA_HOME) {
    const candidate = path.join(process.env.JAVA_HOME, 'bin', 'java')
    if (fs.existsSync(candidate)) return candidate
  }
  for (const candidate of ['/opt/homebrew/opt/openjdk@21/bin/java', '/opt/homebrew/opt/openjdk/bin/java', 'java']) {
    if (spawnSync(candidate, ['-version'], { stdio: 'ignore' }).status === 0) return candidate
  }
  return null
}

const findTlaJar = () => {
  const candidates = [
    process.env.TLA2TOOLS_JAR,
    path.join(tlaDir, 'tla2tools.jar'),
    '/Volumes/Scratch/adaptive-cache/tools/tla2tools.jar',
    '/Volumes/Scratch/ensemble-contracts/tools/tla-1.7.4/tla2tools.jar',
    '/Volumes/Scratch/SnowskyEcho/tools/tla/tla2tools.jar',
    path.join(os.homedir(), '.tla', 'tla2tools.jar'),
    '/usr/local/lib/tla2tools.jar',
  ].filter(Boolean) as string[]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

type TraceEvent =
  | { op: 'CaptureToken'; writer: string; key: string; tags: string[] }
  | { op: 'CommitWrite'; writer: string; accepted: boolean }
  | { op: 'ClearKey'; key: string }
  | { op: 'InvalidateTag'; tag: string }
  | { op: 'CleanupAll' }
  | { op: 'InvalidateNamespace' }
  | { op: 'HydrateL1'; node: string; key: string }
  | { op: 'AssertRedisRead'; key: string; present: boolean; val: string }
  | { op: 'AssertL1Read'; node: string; key: string; present: boolean; val: string }

const toTlaSet = (items: string[]) => `{${items.join(', ')}}`

const formatEvent = (ev: TraceEvent): string => {
  switch (ev.op) {
    case 'CaptureToken':
      return `[op |-> "CaptureToken", writer |-> ${ev.writer}, key |-> ${ev.key}, tags |-> ${toTlaSet(ev.tags)}]`
    case 'CommitWrite':
      return `[op |-> "CommitWrite", writer |-> ${ev.writer}, accepted |-> ${ev.accepted ? 'TRUE' : 'FALSE'}]`
    case 'ClearKey':
      return `[op |-> "ClearKey", key |-> ${ev.key}]`
    case 'InvalidateTag':
      return `[op |-> "InvalidateTag", tag |-> ${ev.tag}]`
    case 'CleanupAll':
      return `[op |-> "CleanupAll"]`
    case 'InvalidateNamespace':
      return `[op |-> "InvalidateNamespace"]`
    case 'HydrateL1':
      return `[op |-> "HydrateL1", node |-> ${ev.node}, key |-> ${ev.key}]`
    case 'AssertRedisRead':
      return `[op |-> "AssertRedisRead", key |-> ${ev.key}, present |-> ${ev.present ? 'TRUE' : 'FALSE'}, val |-> ${ev.val}]`
    case 'AssertL1Read':
      return `[op |-> "AssertL1Read", node |-> ${ev.node}, key |-> ${ev.key}, present |-> ${ev.present ? 'TRUE' : 'FALSE'}, val |-> ${ev.val}]`
  }
}

const createTraceCaches = (client: Redis) => {
  const logger = new Logger('silent')
  const redisBackend = new RedisAdaptiveCacheBackend(client, logger)
  const lru = new ClusteredLruAdaptiveCacheBackend({ namespace: `trace-${randomUUID()}` }, logger)
  const l1Backend = new L1RedisAdaptiveCacheBackend(redisBackend, lru, 'trace:', logger, 'await-redis')
  const redisCache = new AdaptiveCache(
    { backend: redisBackend, keyPrefix: 'trace:', initialTTL: 60, maxTTL: 60, compress: false, logLevel: 'silent' },
    client,
  )
  const l1Cache = new AdaptiveCache(
    { backend: l1Backend, keyPrefix: 'trace:', initialTTL: 60, maxTTL: 60, compress: false, logLevel: 'silent' },
    client,
  )
  return { redisCache, l1Cache }
}

const validateTrace = (trace: TraceEvent[]) => {
  const java = findJava()
  const jar = findTlaJar()
  if (!java || !jar) {
    if (process.env.REQUIRE_TLA_TRACE === '1') {
      throw new Error('REQUIRE_TLA_TRACE=1 was set, but Java or tla2tools.jar was not found.')
    }
    return
  }

  // Allocation starts at 2. Count rejected commits too, as CommitWrite checks the bound.
  const maxId =
    2 +
    trace.filter(
      ({ op }) => op === 'CommitWrite' || op === 'ClearKey' || op === 'InvalidateTag' || op === 'InvalidateNamespace',
    ).length

  const workDir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'adaptive-cache-trace-'))
  try {
    fs.copyFileSync(path.join(tlaDir, 'AdaptiveCacheFencing.tla'), path.join(workDir, 'AdaptiveCacheFencing.tla'))
    fs.copyFileSync(
      path.join(tlaDir, 'AdaptiveCacheFencingTrace.tla'),
      path.join(workDir, 'AdaptiveCacheFencingTrace.tla'),
    )
    const traceData = `---- MODULE TraceData ----
EXTENDS AdaptiveCacheFencing, Sequences
CONSTANTS k1, k2, t1, t2, w1, w2, n1
Trace == <<
  ${trace.map(formatEvent).join(',\n  ')}
>>
====
`
    const cfg = `SPECIFICATION TraceSpec
CONSTANTS
    Keys = {k1, k2}
    Tags = {t1, t2}
    Writers = {w1, w2}
    Nodes = {n1}
    NoVal = NoVal
    k1 = k1
    k2 = k2
    t1 = t1
    t2 = t2
    w1 = w1
    w2 = w2
    n1 = n1
    MaxId = ${maxId}
    MaxTime = 1
INVARIANTS
    TypeOK
    NoResurrectionAfterInvalidation
    L1CoherenceWithoutPubSub
    UnconfirmedOptimisticNeverServed
    TagInvalidatedNeverReadable
    CleanupPreservesFreshWrites
    FailClosedOnEvictedRevision
PROPERTIES
    TraceComplete
`
    fs.writeFileSync(path.join(workDir, 'TraceData.tla'), traceData)
    fs.writeFileSync(path.join(workDir, 'AdaptiveCacheFencingTrace.cfg'), cfg)
    const metadir = path.join(workDir, 'meta')
    fs.mkdirSync(metadir, { recursive: true })

    const result = spawnSync(
      java,
      [
        '-Xmx256m',
        '-XX:+UseParallelGC',
        `-Djava.io.tmpdir=${workDir}`,
        // The local fingerprint set uses RMI. Skip a machine hostname lookup on startup.
        '-Djava.rmi.server.hostname=127.0.0.1',
        '-cp',
        jar,
        'tlc2.TLC',
        '-workers',
        '1',
        '-deadlock',
        '-metadir',
        metadir,
        '-config',
        path.join(workDir, 'AdaptiveCacheFencingTrace.cfg'),
        path.join(workDir, 'AdaptiveCacheFencingTrace.tla'),
      ],
      { cwd: workDir, encoding: 'utf8' },
    )
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('Model checking completed. No error has been found.')
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

describe('TLA+ runtime trace conformance against real Redis + L1', () => {
  let container: StartedTestContainer
  let client: Redis

  beforeAll(async () => {
    container = await new GenericContainer('redis:alpine').withExposedPorts(6379).start()
    client = new Redis({ host: container.getHost(), port: container.getMappedPort(6379) })
    await client.ping()
  })

  afterAll(async () => {
    try {
      await client?.quit()
    } finally {
      client?.disconnect()
      await container?.stop()
    }
  })

  it('produces an execution trace accepted by AdaptiveCacheFencingTrace.tla', async () => {
    await client.flushall()
    const { redisCache, l1Cache } = createTraceCaches(client)

    const trace: TraceEvent[] = []
    const keyMap: Record<string, string> = { k1: 'trace:k1:', k2: 'trace:k2:' }
    const activeTokens = new Map<string, { token: string; key: string; tags: string[] }>()

    const capture = async (writer: string, key: string, tags: string[]) => {
      const token = await redisCache.captureWriteToken()
      activeTokens.set(writer, { token, key, tags })
      trace.push({ op: 'CaptureToken', writer, key, tags })
    }

    const commit = async (writer: string) => {
      const state = activeTokens.get(writer)!
      activeTokens.delete(writer)
      const res = await redisCache.set(keyMap[state.key], writer, {
        writeToken: state.token,
        tags: state.tags,
      })
      const accepted = res[0] !== 'INVALIDATED'
      trace.push({ op: 'CommitWrite', writer, accepted })
      return accepted
    }

    const checkRedis = async (key: string) => {
      const hit = await redisCache.get<string>(keyMap[key])
      trace.push({ op: 'AssertRedisRead', key, present: Boolean(hit), val: hit ? hit.data : 'NoVal' })
      return hit
    }

    const hydrateAndCheckL1 = async (key: string) => {
      const first = await l1Cache.get<string>(keyMap[key])
      if (first) {
        if (first.layer === 'redis') trace.push({ op: 'HydrateL1', node: 'n1', key })
        const second = await l1Cache.get<string>(keyMap[key])
        trace.push({
          op: 'AssertL1Read',
          node: 'n1',
          key,
          present: Boolean(second && second.layer === 'l1'),
          val: second && second.layer === 'l1' ? second.data : 'NoVal',
        })
        return second
      }
      trace.push({ op: 'AssertL1Read', node: 'n1', key, present: false, val: 'NoVal' })
      return null
    }

    try {
      // 1. Concurrent writers w1 & w2 capture tokens; w1 writes k1 with tag t1; hydrate L1
      await capture('w1', 'k1', ['t1'])
      await capture('w2', 'k1', ['t2'])
      expect(await commit('w1')).toBe(true)
      expect((await checkRedis('k1'))?.data).toBe('w1')
      expect((await hydrateAndCheckL1('k1'))?.layer).toBe('l1')

      // 2. Tag invalidation of t1 fences in-flight w2 and immediately invalidates k1 in Redis & L1
      await redisCache.invalidateTags(['t1'])
      trace.push({ op: 'InvalidateTag', tag: 't1' })
      trace.push({ op: 'CleanupAll' })
      expect(await commit('w2')).toBe(false)
      expect(await checkRedis('k1')).toBeNull()
      expect(await hydrateAndCheckL1('k1')).toBeNull()

      // 3. Post-invalidation rewrite of k1 with t1 & t2, plus k2 with t2
      await capture('w1', 'k1', ['t1', 't2'])
      expect(await commit('w1')).toBe(true)
      await capture('w2', 'k2', ['t2'])
      expect(await commit('w2')).toBe(true)
      expect((await checkRedis('k1'))?.data).toBe('w1')
      expect((await checkRedis('k2'))?.data).toBe('w2')
      expect((await hydrateAndCheckL1('k1'))?.layer).toBe('l1')

      // 4. Clear k1 leaves k2 untouched and fences an in-flight writer on k2
      await capture('w1', 'k2', ['t1'])
      await redisCache.clear(keyMap.k1)
      trace.push({ op: 'ClearKey', key: 'k1' })
      expect(await commit('w1')).toBe(false)
      expect(await checkRedis('k1')).toBeNull()
      expect((await checkRedis('k2'))?.data).toBe('w2')

      // 5. Namespace invalidation invalidates k2 and fences in-flight writes
      await capture('w2', 'k2', ['t1'])
      await redisCache.invalidateNamespace()
      trace.push({ op: 'InvalidateNamespace' })
      expect(await commit('w2')).toBe(false)
      expect(await checkRedis('k2')).toBeNull()
      expect(await hydrateAndCheckL1('k2')).toBeNull()
    } finally {
      await l1Cache.close()
      await redisCache.close()
    }

    validateTrace(trace)
  })

  it(
    'produces randomized execution traces accepted by AdaptiveCacheFencingTrace.tla',
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(traceOperation, { minLength: 10, maxLength: 16 }), async (operations) => {
          await client.flushall()
          const { redisCache, l1Cache } = createTraceCaches(client)
          const trace: TraceEvent[] = []
          type Key = (typeof traceKeys)[number]
          type Writer = (typeof traceWriters)[number]
          type Tag = (typeof traceTags)[number]

          let generation = 0
          const pending = new Map<Writer, { token: string; key: Key; tags: Tag[]; generation: number }>()
          const entries = new Map<Key, { writer: Writer; tags: Tag[] }>()

          const checkRedis = async (key: Key) => {
            const hit = await redisCache.get<Writer>(`trace:${key}:`)
            const expected = entries.get(key)
            if (expected) expect(hit, key).toMatchObject({ data: expected.writer, layer: 'redis' })
            else expect(hit, key).toBeNull()
            trace.push({ op: 'AssertRedisRead', key, present: hit !== null, val: hit?.data ?? 'NoVal' })
            return hit
          }

          const checkL1 = async (key: Key) => {
            const redis = await checkRedis(key)
            const first = await l1Cache.get<Writer>(`trace:${key}:`)
            if (redis) {
              expect(first?.data, key).toBe(redis.data)
              expect(['l1', 'redis'], key).toContain(first?.layer)
            } else {
              expect(first, key).toBeNull()
            }

            const local = first?.layer === 'l1' ? first : null
            trace.push({ op: 'AssertL1Read', node: 'n1', key, present: local !== null, val: local?.data ?? 'NoVal' })
            if (first?.layer === 'redis') {
              // Record the L1 miss before the Redis fallback populates it.
              trace.push({ op: 'HydrateL1', node: 'n1', key })
              const hydrated = await l1Cache.get<Writer>(`trace:${key}:`)
              expect(hydrated, key).toMatchObject({ data: first.data, layer: 'l1' })
              trace.push({ op: 'AssertL1Read', node: 'n1', key, present: true, val: hydrated!.data })
            }
          }

          try {
            for (const operation of operations) {
              switch (operation.kind) {
                case 'write': {
                  const { writer, key, tags } = operation
                  // A writer's next step captures when idle and commits when in flight.
                  const write = pending.get(writer)
                  if (!write) {
                    const token = await redisCache.captureWriteToken()
                    expect(token).toMatch(/.+/)
                    pending.set(writer, { token, key, tags, generation })
                    trace.push({ op: 'CaptureToken', writer, key, tags })
                    continue
                  }

                  const [status] = await redisCache.set(`trace:${write.key}:`, writer, {
                    writeToken: write.token,
                    tags: write.tags,
                  })
                  expect(status, writer).toBe(write.generation === generation ? 'CACHED' : 'INVALIDATED')
                  const accepted = status === 'CACHED'
                  trace.push({ op: 'CommitWrite', writer, accepted })
                  pending.delete(writer)
                  if (accepted) entries.set(write.key, { writer, tags: write.tags })
                  break
                }
                case 'read':
                  await checkL1(operation.key)
                  continue
                case 'clear':
                  await redisCache.clear(`trace:${operation.key}:`)
                  trace.push({ op: 'ClearKey', key: operation.key })
                  generation++
                  entries.delete(operation.key)
                  break
                case 'invalidate-tag':
                  await redisCache.invalidateTags([operation.tag])
                  trace.push({ op: 'InvalidateTag', tag: operation.tag }, { op: 'CleanupAll' })
                  generation++
                  for (const [key, entry] of entries) {
                    if (entry.tags.includes(operation.tag)) entries.delete(key)
                  }
                  break
                case 'invalidate-namespace':
                  await redisCache.invalidateNamespace()
                  trace.push({ op: 'InvalidateNamespace' })
                  generation++
                  entries.clear()
                  break
              }

              for (const key of traceKeys) await checkRedis(key)
            }

            for (const key of traceKeys) await checkL1(key)
          } finally {
            await l1Cache.close()
            await redisCache.close()
          }

          validateTrace(trace)
        }),
        { numRuns: traceRuns, ...(traceSeed === undefined ? {} : { seed: Number(traceSeed) }) },
      )
    },
    Math.max(30_000, traceRuns * 5_000),
  )
})
