# Loading, freshness, and cache policy

Configure loading, freshness, invalidation, and HTTP response caching with the policies below. All built-in backends share the public cache API; Redis-backed modes provide atomic checks across hosts, while clustered LRU keeps volatile state on one host.

## Load a value once

```typescript
import { AdaptiveCache } from '@0xdoublesharp/adaptive-cache'

const cache = new AdaptiveCache({
  keyPrefix: 'catalog:',
  initialTTL: 10,
  maxTTL: 300,
  staleWhileRevalidate: 30,
  staleIfError: 120,
  ttlJitter: 0.1,
})

const product = await cache.getOrSet('catalog:product:42', () => loadProduct('42'))
const hit = await cache.get<Product>('catalog:product:42')
```

Direct API keys are complete keys. `keyPrefix` selects the namespace for tags, invalidation barriers, and loader locks; it does not prepend text to direct API keys. Include your namespace in those keys. Middleware constructs prefixed keys for you.

Concurrent calls on one instance share the loader promise for that key. Redis-backed instances also coordinate through a distributed lock. A waiter has a bounded timeout (`lockWaitTimeoutMs`, default 5000); a loader error is never stored as a cached value. Concurrent callers for the same key should use the same loader and policy. The first caller determines the shared work.

Explicit `forceRefresh` calls bypass fresh hits and stale-while-revalidate. They still share in-flight work on one instance. Across instances, forced refreshes serialize through the lock and each runs its loader, so a failed owner cannot cause a forced waiter to accept the old cached value. The configured stale-if-error fallback still applies if a forced loader fails.

Fresh values return immediately. During `staleWhileRevalidate`, an expired value returns immediately while one background loader refreshes it. During `staleIfError`, a failed foreground refresh may return the previous value. Each window is measured independently from freshness expiry, and fallback is checked again after the loader fails. Neither window extends the other. Ordinary `get()` never returns stale data; use `get(key, { allowStale: true })` to inspect retained entries with `stale` and `staleAge` in seconds.

`getOrSet` accepts per-call overrides for both windows, `maxTTL`, `tags`, `ttlJitter`, `forceRefresh`, and `lockWaitTimeoutMs`. Direct `set()` accepts `staleTTL` to retain data beyond freshness. Jitter is a fraction from 0 to 1 that shortens the fresh TTL; it never increases `maxTTL`.

Loader `maxTTL` can also be a function of the loaded value. `cache.resolveMaxTTL(value, { maxTTL })` resolves an optional override against the instance's configured limit; omitting the second argument uses the instance defaults.

Use `shouldStore(value)` to return a loaded result without caching it when your storage policy rejects it. It controls writes; it does not change whether an existing value is a hit.

## Bound loader lifetime

`getOrSet` defaults to a 30000ms deadline for each caller. It includes the initial read, lock wait, loader execution, storage wait, and stale fallback read. Set constructor `loadTimeoutMs` or override it per call. This deadline is separate from `lockWaitTimeoutMs` and lock expiration. The load deadline and shutdown deadline options accept finite milliseconds from `0` through `2147483647`, inclusive. Values outside that range throw `RangeError` instead of overflowing Node timers.

```typescript
const result = await cache.getOrSet(
  'catalog:product:42',
  async ({ signal }) => {
    const response = await fetch(productUrl, { signal })
    return response.json()
  },
  { signal: requestAbortSignal, loadTimeoutMs: 2000 },
)
```

`cache.resolveLoadTimeoutMs({ loadTimeoutMs })` validates and returns the effective load deadline, resolving the supplied override, instance setting, then the 30000ms default. Omitting its argument returns the instance default. HTTP adapters use the same resolver, including when they receive an injected cache.

The exported `AdaptiveCacheLoaderContext` contains the shared loader's `AbortSignal`; a loader may omit the context argument when it does not need cancellation. Each caller has its own deadline and optional `signal`. One caller leaving does not cancel work another caller still needs. Shared work aborts when its last interested caller leaves or shutdown expires. Stale background refresh retains its own bounded interest.

A deadline rejects with a `DOMException` named `TimeoutError`; explicit cancellation preserves `signal.reason`, ordinarily an `AbortError`. Neither becomes a successful stale fallback. Ignoring the loader signal cannot keep the caller waiting beyond its deadline. A detached result cannot start a later cache write. Cancellation does not retract a backend write already submitted, which remains subject to lease and invalidation checks.

## Choose a TTL policy

Use `ttlPolicy: { type: 'aimd' }` for additive growth and proportional decreases, or `ttlPolicy: { type: 'ewma' }` to weight observations by elapsed time. Both are opt-in; the adaptive policy is the default. See [TTL policies](ttl-policies.md) for configuration and limitations.

## Cache negative results briefly

```typescript
const account = await cache.getOrSet('catalog:account:missing', findAccount, {
  negativeTTL: 5,
})
```

For `getOrSet`, `null` and `undefined` are negative results and are not cached by default. Direct `set()` still supports storing those values. Set `negativeTTL` to opt in. Use `isNegative(value)` for a different result representation. Negative entries have no stale retention. Thrown errors remain errors, subject only to the stale-if-error policy for a previously successful value.

## Invalidate without resurrecting old work

```typescript
await cache.clear('catalog:product:42')
await cache.invalidateTags(['category:books'])
await cache.invalidateNamespace()
```

Built-in backends capture write tokens before loaders and asynchronous encoding. Invalidation advances a barrier so work started before invalidation cannot write its old value back. A caller already awaiting a loader can still receive its result; that result is not retained when its token has been invalidated. Retagging removes obsolete memberships, so invalidating an old tag does not remove a newly retagged value.

Namespace invalidation makes the namespace's previous entries unreadable without scanning all payload keys. Physical payloads expire normally. Targeted invalidation can conservatively reject other in-flight writes within the same namespace, while preserving already-cached unrelated entries.

Each accepted Redis write also changes an entry revision, even when the content fingerprint stays the same. Every L1 hit validates that revision and invalidation controls against Redis. A missed update publication cannot leave an older L1 payload readable. Optimistic ordinary `set()` still returns before Redis reconciliation, but an unconfirmed L1 entry falls through to Redis.

Redis tag indexes are expiry-scored sorted sets at `<prefix>__adaptive:tag-index:<tag>`. Writes prune expired memberships with bounded maintenance. Tag invalidation atomically detaches the index and advances its epoch, making its previous entries unreadable immediately. Cleanup then processes bounded batches and checks generations before deleting payloads, so a concurrent fresh write survives. Active cleanup renews each unfinished detached snapshot to a 60-second TTL every 10 seconds, including snapshots queued behind a stalled batch. Abandoned snapshots expire without renewal. The drain checks original cardinality against actual member removals and resolves only when every snapshot reaches zero. A lost or evicted snapshot, failed renewal, or incomplete drain rejects explicitly rather than reporting complete invalidation. Versioned entries remain epoch-fenced even if physical cleanup fails. Returned keys are a deduplicated membership snapshot and may include a concurrently rewritten key whose fresh payload survived cleanup.

Writes and invalidation share the same tag limits: at most 1024 non-empty strings, 4096 UTF-8 bytes per tag, and 256 KiB for the encoded list. Duplicate tags are normalized. Redis cleanup processes at most `redis.maxTagCleanupKeys` key memberships per invalidation, defaulting to 10000; the option must be a positive safe integer. A key belonging to two requested tags consumes two memberships, so overlapping indexes cannot bypass the work limit. Exceeding the limit rejects physical cleanup while the versioned entries remain epoch-fenced.

Redis entries keep freshness and generation information with the payload. Losing a separate control or tag-index key under Redis memory eviction causes a miss instead of reviving invalidated data. Readers and invalidators also support legacy raw entries and `<prefix>tag:<tag>` sets. Raw entries do not carry epoch guarantees and may remain readable until their original TTL if a detached cleanup snapshot is lost; treat a rejected invalidation as incomplete for those entries. Compatibility and rollout details are in the [release guide](releases.md).

L1 invalidation is an eviction accelerator. Messages are limited to 256 KiB, 1024 keys, and 4096 UTF-8 bytes per key. A subscriber queues at most 4096 distinct keys and deletes them in batches of 128. Oversized messages or excess queued keys are dropped, while Redis revision validation remains authoritative for every read. `flush()` waits for accepted work, retries a failed batch once, and rejects if that retry fails. Pending writes and hydration generations are shared only by backends using the same Redis client and prefix; that shared state is released after the last backend closes.

Redis performs token and loader ownership checks atomically with writes. Clustered LRU remains a host-local option: its dependency does not expose a distributed compare-and-write transaction. Its lease release uses an adaptive-cache primary handler to compare ownership, optionally record completion, and delete the lease atomically. Cluster primaries must call `bootstrapClusteredLru()` before forking; standalone use initializes automatically. Use Redis when strict cross-worker or cross-host write fencing is required. Custom backends must implement `captureWriteToken` for `getOrSet` and `invalidateNamespace` for namespace invalidation; unsupported operations fail explicitly. `supportsWriteFencing()` reports method availability, not an atomicity guarantee. `captureWriteToken()` and `set(key, value, { writeToken })` also expose fencing for caller-managed work.

## Ignore volatile fields when adapting TTL

```typescript
const cache = new AdaptiveCache({
  ignoreFields: ['generatedAt', 'metadata.requestId'],
  // Or provide fingerprint: (value) => aStringOrBuffer
})
```

These options change the content fingerprint used to grow or reset TTL. They do not strip fields from the stored value. Dotted paths identify fields to ignore. A custom fingerprint takes precedence over `ignoreFields`.

## Selective compression

```typescript
const cache = new AdaptiveCache({
  compression: {
    minBytes: 1024,
    async: true,
    skipCompressed: true,
    onlyIfSmaller: true,
    maxDecodedBytes: 64 * 1024 * 1024,
  },
})
```

The byte threshold applies to the serialized payload. Already-compressed buffers are detected for gzip, ZIP, PNG, JPEG, and WebP. `onlyIfSmaller` accounts for base64 storage overhead. Asynchronous gzip keeps compression work off the JavaScript thread. JSON serialization and fingerprinting remain synchronous. Writes and decoded reads reject serialized payloads above `maxDecodedBytes`, which defaults to 64 MiB and applies to marked, legacy, compressed, and plain entries. Encoded gzip input is also length-checked before base64 allocation.

Entries written using `compression` carry a codec marker, so readers can decode them regardless of their compression settings. The boolean `compress` option selects the unmarked codec when no selective settings are supplied; readers of those entries must use the matching setting. `compress: false` disables compression even when selective options are supplied. Buffers, strings, JSON values, and `undefined` retain their types. `maxDecodedBytes` must be a positive safe integer within Node's buffer-size limit.

## Observe and drain work

```typescript
const unsubscribe = cache.onEvent((event) => {
  recordCacheEvent(event.type, event.layer, event.durationMs)
})
const stats = cache.getStats()
await cache.flush()
unsubscribe()
await cache.close()
```

Events cover hits, misses, stale reads, refreshes, writes, invalidation, lock contention, errors, and LRU evictions. Hits identify the serving layer (`l1`, `redis`, or `lru`). Statistics are per-instance snapshots; observer exceptions cannot break cache operations. `flush()` drains pending work and background writes without a deadline. `close({ timeoutMs })` rejects new operations, drains accepted work, flushes the backend, and releases owned resources. Its default deadline is 5000ms, configured through constructor `closeTimeoutMs` or the call's `timeoutMs`. `quit(preserveSharedCache?)` uses the same bounded default. Concurrent or repeated close calls share the first outcome.

Successful close resolves after graceful teardown. On expiry it aborts owned loader work, requests forced backend teardown, and rejects with `TimeoutError`. An earlier graceful failure also requests forced teardown while retaining the original error. Forced teardown is not awaited, since a custom backend may stall. Built-in Redis teardown disconnects owned clients and subscribers; an injected Redis client stays caller-owned. Custom backends can implement `quit(preserveSharedCache?, force?)` to release resources immediately when `force` is true. Teardown should be idempotent because a graceful attempt may be followed by a forced call. Backend observer unsubscribe errors emit an isolated error event with reason `backend-unsubscribe` and cannot block graceful or forced close. The unsubscribe hook runs once across repeated or concurrent closes, which share the same shutdown attempt and outcome.

Partially initialized clustered caches can be torn down even when their health check rejects or stalls. Once closed, that backend rejects further access, including work whose initialization completes later. Redis backend initialization failures disconnect newly allocated clients. The one-shot `clearAdaptiveCache` helper releases its own observer without flushing or closing a borrowed custom backend, and cleanup errors cannot replace a preceding clear failure.

LRU eviction counts include internal metadata and coordination entries reported by the dependency. Fenced writes rejected after invalidation emit an invalidation event with reason `write-rejected`. Loader lock-release failures emit an error event with reason `lock-release`; cleanup does not replace the loader result or its original error. Public lock operations participate in shutdown draining and reject new calls once closing begins.

Bulk helpers return explicit outcomes: `getMany(keys)` returns a `Map` of each key to a typed hit or `null`; `setMany([{ key, data, options }])` and `clearMany(keys)` await all submitted operations. They are convenience APIs, not multi-key transactions.

On clustered LRU, `getMany()` batches payload reads using upstream `mGet()`, then reads distinct namespace, entry, and tag epochs from the primary. Missing or changed controls return misses, and retention is checked after the control read. Duplicate keys retain per-occurrence events and Map insertion order. Redis, L1 Redis, and custom backends without batch support retain individual reads. All reads, including empty `getMany()` calls, reject after close.

Custom backends may implement `fetchMany(inputs)`, returning one result or `null` per input in exactly the same order, including duplicates. A result-length mismatch rejects the operation. Payload decoding and events use the same path as `get()`; a batch error emits a read error for every requested key. Each accepted read remains tracked until decoding completes, even if another key has already failed.

## HTTP identity and ownership

Both Express and Fastify apply request identity and response storage policy before reusing a cached result. Fastify 5 requires version 5.12.6 or later; Fastify 4 is also supported.

Default HTTP keys contain `<prefix>authority:<sha256(authority)>:<path>:<sha256(normalized-query)>:`. Authority comes from `Host`, with `:authority` as a fallback, and is trimmed and lowercased. The port remains part of identity. Forwarded host headers are not implicitly trusted. Query keys are sorted. Only scalar `refresh=true` is treated as a control parameter and ignored by default; other `refresh` values remain part of the key. An explicit `ignoreQueryParams` list removes every named parameter regardless of value. Paths over 1024 UTF-8 bytes use a SHA-256 representation. Custom `key(request)` functions replace authority/path/query identity and must include any required host or tenant isolation themselves. Declared header variations append their own hash.

Both middleware factories accept an injected `cache`, a custom `key(request)`, declared `varyBy` headers (or a function returning a key dimension), and `shouldCache(request, response?)`. Header dimensions are case-insensitive. Custom keys remain inside the middleware prefix.

```typescript
import { adaptiveExpressCache } from '@0xdoublesharp/adaptive-cache'

const productResponses = adaptiveExpressCache({
  cache,
  keyPrefix: 'catalog:',
  key: (req) => `product:${req.params?.id}`,
  varyBy: ['Accept-Language'],
  loader: (req, { signal }) => loadProduct(req.params?.id, { signal }),
  staleWhileRevalidate: 30,
  staleIfError: 120,
})
app.get('/products/:id', productResponses)
```

Keep an injected cache's namespace aligned with the middleware `keyPrefix` when you want `invalidateNamespace()` to target those responses. The injected instance determines backend, codec, and default cache settings; the adapter controls HTTP key construction and policy.

Range and If-Range requests bypass caching, and partial `206` responses are never stored. Request `Cache-Control: no-store` or `no-cache` bypasses both reuse and storage. Authorization and Cookie requests bypass caching by default. Enabling `cacheAuthenticated` or `cacheCookies` requires a key that isolates the relevant user, tenant, or session; the opt-in flag alone does not construct that identity. Responses with `Cache-Control: private`, `no-store`, or `no-cache`, `Set-Cookie`, `Vary: *`, or undeclared `Vary` headers are neither stored nor shared between concurrent loader callers. Conditional revalidation of `no-cache` responses is not implemented. Use explicit header names in `varyBy` when responses advertise `Vary`.

Custom key functions must return a nonempty string. Invalid results bypass caching. If compression middleware adds `Vary: Accept-Encoding`, include `Accept-Encoding` in `varyBy` alongside your other header dimensions; otherwise those responses will not be stored.

Cached responses replay only `Cache-Control`, `Content-Encoding`, `Content-Language`, `Content-Type`, `ETag`, `Last-Modified`, and `Vary`, along with status and body. Arbitrary application headers are not replayed. Node and WHATWG streams bypass storage. Explicit HTTP loaders can cache JSON-compatible plain objects/arrays, finite numbers, booleans, null, strings, and buffers. ArrayBuffer views, including typed arrays and DataView, normalize to buffers before sending and storage. Native `Response`, `Blob`, `ArrayBuffer`, Date, and other objects whose native metadata cannot be replayed bypass storage; the framework still determines how to send them. Unsupported native or consumable results also bypass sharing. Each request calls its loader once and receives its own result, so loaders returning streams or native responses must create an independent result per invocation. Direct API serialization is a separate contract.

Normal middleware intercepts the route handler response. Optional `loader(request, { signal })` mode coalesces eligible source work using `getOrSet`. Pass the signal to cancellable source I/O. Shared work aborts when its last interested caller leaves; one caller reaching its deadline does not abort work another caller still needs. Bypassed and fallback loads receive a local signal bounded by that request's deadline. Express loaders support background stale refresh. Fastify validates final response policy in `onResponse`, after all serialization and send hooks; followers await that verdict before receiving a shared candidate. Each response receives an independent body, and raw bodies and pre-hook metadata are replayed so transformations run once per request. Final status and headers govern storage and negative TTLs. Call `.flush()` when a subsequent operation must observe completed writes.

Raw bodies must round-trip as ordinary mutable JSON trees. Getters, custom `toJSON`, hidden or symbol metadata, proxies, cycles, repeated object references, undefined fields, negative zero, sparse arrays, nonstandard property attributes, and excessive nesting bypass copying and caching so framework hooks retain their original behavior. Binary bodies are cached only as bare top-level transports; nested buffers/views and buffers with custom metadata or prototypes bypass caching. Fastify handlers that install a per-response `reply.serializer()` also bypass caching because that serializer would be absent when a hit skips the handler.

Fastify refreshes expired loader entries in the foreground even if `staleWhileRevalidate` is configured. A background candidate cannot pass its origin's response hooks after a stale response has already been sent. `staleIfError` remains available. If the originating request times out before approving its candidate, surviving waiters run their own loaders within their remaining deadlines. Direct `cache.getOrSet()` retains background refresh and independent caller deadlines for request-independent work. Opt-in `negativeTTL` allows brief caching of 404 responses. Other unsuccessful statuses remain uncached.

Middleware exposes `.cache`, `.clear(request)`, `.flush()`, and `.close()`.

```typescript
await productResponses.clear({
  originalUrl: '/products/42',
  query: {},
  params: { id: '42' },
  headers: { host: 'shop.example:8080', 'accept-language': 'en' },
})
```

Pass the identity of the request whose cached response should be removed, including any parameters and headers used by `key` or `varyBy`. Fastify uses `url` instead of `originalUrl`. Clearing one variant leaves other variants intact. Clearing uses the injected cache when present and does not apply GET, authentication, or `shouldCache` eligibility checks, so mutation handlers can invalidate cached GET results. Invalid custom keys and clearing a closed owned adapter reject explicitly. If the key callback throws, the clear rejects rather than silently reporting success.

Cache read, lock, and storage failures bypass caching while still running configured loaders. A request retains its source promise, so a storage failure cannot run a successful loader twice. Source errors propagate with their original thrown identity to the framework error handler, including across coalesced callers. HTTP deadlines cover the preliminary cache read, shared core load, explicit bypasses, and outage fallback source wait. Express callers timing out leave shared source work available to other interested callers; Fastify sharing requires the origin's final approval as described above. Each caller's `TimeoutError` or `AbortError` remains terminal; it does not start an unbounded fallback loader. Injected-cache load deadline settings are inherited. Request-policy exceptions bypass storage while still running configured loaders. Normal-handler mode continues to the handler. Every adapter without `cache` creates its own cache and, when needed, its own Redis connection. It does not use the process-wide `getDefaultCache()` instance. Injected caches remain caller-owned. Fastify closes owned caches through its `onClose` hook. Applications using Express should call the middleware's `close()` during shutdown, after accepting no further requests. Closed adapters bypass caching. Closing an adapter does not close an injected cache; its caller manages that resource.

Install the Fastify adapter before declaring the routes it should wrap, and await registration. Cache lookup and loader execution run inside the handler wrapper after validation, `preValidation`, and `preHandler`, including authorization checks. Routes declared before installation remain uncached. Register without a prefix to wrap later routes in that scope. A registration `prefix` limits wrapping to matching route paths and descendants of that path; it does not move route declarations under that prefix. Normal Fastify encapsulation still applies.

```typescript
await fastify.register(adaptiveFastifyCache({ cache, keyPrefix: 'catalog:' }), { prefix: '/api' })
fastify.get('/api/products', { preHandler: authorize }, loadProducts)
fastify.get('/health', healthCheck) // Outside /api, uncached.
```

Prefer `.clear(request)` so default authority, custom keys, and `varyBy` match lookup exactly. Include `headers.host`, including its port, when constructing a clearing request. For default keys on the process-wide cache, pass authority as the fifth argument:

```typescript
await clearAdaptiveCache('/products/42', {}, 'catalog:', {}, 'shop.example:8080')
```

Omitting authority targets an authority-free key instead of the default HTTP identity. The helper cannot reproduce arbitrary custom keys or header variations. It also does not target an injected cache instance; use the adapter's `.clear(request)` for those cases. Use `.cache.invalidateTags()` on the owning adapter for tag invalidation rather than `getDefaultCache()`.

## Release and compatibility reference

The [changelog](../CHANGELOG.md) records versioned changes. The [release guide](releases.md) contains migration instructions, cache-format compatibility, and the publishing process.
