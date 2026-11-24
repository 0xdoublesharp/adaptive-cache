# Changelog

Notable changes by version. See [releases and maintenance](docs/releases.md) for the release workflow and compatibility reference.

## 0.5.0 - 2026-11-23

This release hardens L1/Redis invalidation, loader deadlines and fencing, HTTP privacy and key framing, updates `@0xdoublesharp/lru-cache-clustered` to `2.1.5`, and adds TLA+ and Lean 4 formal verification. Review the [0.5.0 upgrade notes](docs/releases.md#upgrading-to-050) before deploying.

### Added

- Export `AdaptiveCacheMetadata`, `AdaptiveCacheLruLocalL1Options`, `HttpPolicyOptions`, `HttpRequestLike`, `HttpResponseLike`, `ExpressRequestLike`, `ExpressResponseLike`, `FastifyRequestLike`, and `FastifyReplyLike` from the package entry point.
- Allow batched reads to return stale entries with `getMany(keys, { allowStale: true })`.
- Support opt-in `policyHeaders` on Express and Fastify adapters so read-side `shouldCache` checks can inspect declared non-replayable headers without persisting arbitrary headers or leaking them on the wire.
- Add TLA+ specifications with liveness checks, trace conformance against live Redis and its L1 cache, and Lean 4 proofs (including total HTTP cache-key framing injectivity). Run `verify:tla` for the specifications, `verify:trace` for runtime conformance, `verify:lean` for the proofs, or `verify:formal` for both the specifications and proofs. See the [formal verification guide](formal/README.md).

### Changed

- Update `@0xdoublesharp/lru-cache-clustered` to `2.1.5` (with an exact-version release-age exception) and require optional peer version `^2.1.5` for LRU-backed modes.
- Refresh eligible same-major development dependencies and security overrides under the seven-day release-age policy (`fastify` 5.12.8, `supertest` 7.3.2, `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser` 8.73.0, `vitest` and `@vitest/coverage-v8` 5.1.0, `eslint` 10.15.0, `prettier` 3.10.1, `vite` 8.3.8, `glob` 14.0.6, and `minimatch` 11.0.9).

### Fixed

- Round clustered-LRU write TTLs up to positive integer milliseconds (`Math.max(1, Math.ceil(ms))`), matching `@0xdoublesharp/lru-cache-clustered` 2.1.4+ integer-TTL validation.
- Let `l1-redis` `clear()` and `invalidateTags()` proceed when an unrelated local L1 subscriber drain fails.
- Use the remaining freshness in milliseconds from Redis Lua to hydrate `l1-redis`, including entries with a sub-second lifetime remaining and entries configured with `initialTTL` of one second or less.
- Give cached Express handler 404 responses a zero stale window (`staleTTL: 0`).
- Include cache metadata headers on Express and Fastify loader-mode hits, matching handler-mode hits.
- Apply `ignoreFields` and custom `fingerprint` callbacks to HTTP response bodies inside the cache envelope. Exclude Express-generated ETags from the fingerprint when ignored fields are removed from the body used for hashing.
- Bypass the local L1 for namespace generation and tag epoch checks on scalar clustered-LRU reads. Treat missing invalidation state as a cache miss when the entry depends on it.
- Retry the clustered-LRU lock handler readiness check on the next acquisition after a transient IPC failure.
- Handle `undefined` query values when generating keys with `getAdaptiveCacheKey()`.
- Recognize `Cache-Control` directives with whitespace before `=`.
- Validate `refreshThreshold` before acquiring a refresh lock.
- Decode only a bounded base64 prefix when checking cached HTTP binary responses for compression.
- Preserve explicit `writeToken` values passed to `getOrSet()`, enforce `lockWaitTimeoutMs` and monotonic caller deadlines across blocking loader/backend waits, track pending lock releases through `flush()` and `close()`, exclude negative entries from `staleIfError`, skip initial reads on `forceRefresh`, prevent reentrant `close()` from dropping accepted operations, and settle all `setMany()` / `clearMany()` siblings before rejecting.
- Reject ill-formed Unicode surrogates in tags, reject user keys colliding with the reserved `__adaptive:` control namespace, validate TTL upper bounds and decode tag JSON before any Redis Lua mutations, support fractional lease durations and decimal `cache()`/`cacheResult()` durations, and skip non-enumerable properties (such as array `.length`) in `ignoreFields`.
- Normalize numeric Redis Lua replies for `ioredis` `{ stringNumbers: true }`, treat empty string (`''`) encoded Redis payloads as valid hits, make `invalidateTags([])` a true no-op, track Lua script digests per Redis client, handle `force` and non-numeric `lastUpdate` safely in `shouldRefreshCache.lua`, include all variable envelope fields in clustered-LRU entry byte limits, and prevent local-L1 subscriber leaks when preserving a shared clustered cache on `quit(true)`.
- Snapshot raw Fastify request headers in `onRequest` before header schema validation, honor current response privacy restrictions on Express/Fastify hits and loader joins, validate Express foreground loader late headers, preserve synchronous Fastify `reply.send()` handler semantics, settle Fastify candidate publication from transport completion, reject non-plain `varyBy` callback values, terminate varied HTTP cache keys with `:v` so varied and unvaried adapters sharing a prefix cannot collide, bypass `If-Match`/`If-Unmodified-Since` preconditions, clone bodies passed to `maxTTL` callbacks, enforce strict monotonic HTTP loader deadlines, abort HTTP loader work on premature client disconnect, support implicit `HEAD` on loader-backed routes, and capture one-shot Express `res.end(body)` responses.
- Strip `ignoreFields` and normalize JSON whitespace on string HTTP JSON bodies losslessly without rounding integers above `Number.MAX_SAFE_INTEGER`, and track HTTP response envelopes by provenance so plain user JSON containing `__adaptiveCacheHttpResponse` is never misclassified during fingerprinting.

### Compatibility notes

Varied HTTP cache keys (`varyBy` configured) now terminate with `:v` so varied and unvaried adapters sharing a prefix cannot collide; existing varied entries miss once and repopulate. LRU-backed modes require optional peer `@0xdoublesharp/lru-cache-clustered@^2.1.5`. Stricter validations now reject ill-formed Unicode tags, keys starting with `<prefix>__adaptive:`, out-of-range TTLs, and non-plain `varyBy` callback values, and bypass conditional `If-Match` / `If-Unmodified-Since` requests. See [upgrading to 0.5.0](docs/releases.md#upgrading-to-050).

## 0.4.1 - 2026-11-08

### Changed

- Update `@0xdoublesharp/lru-cache-clustered` to 2.1.3 and require optional peer version `^2.1.3` for LRU-backed modes.
- Allow the newly published 2.1.3 release through the seven-day dependency wait period with an exact-version exception.

## 0.4.0 - 2026-11-08

### Added

- `compression.maxDecodedBytes` sets the serialized payload ceiling for writes and decoded reads, defaulting to 64 MiB. Plain, marked, legacy, synchronous, and asynchronous codec paths share the limit.
- `redis.maxTagCleanupKeys` limits aggregate key memberships processed by one tag invalidation, defaulting to 10000.
- `bootstrapClusteredLru()` initializes cache IPC and atomic lease release in a Node cluster primary. Standalone use initializes automatically; L1 Redis continues to delegate leases to Redis.

### Changed

- Refresh the Vite tooling override to 8.3.5 under the seven-day release-age policy.
- Refresh eligible same-major development dependencies and transitive resolutions under the seven-day release-age policy: Node types 26.6.6, TypeScript ESLint parser/plugin 8.72.1, Vitest and its coverage provider 5.0.5, ESLint 10.14.0, Express 5.3.0, Prettier 3.9.10, and Testcontainers 12.2.1.
- Align the package-manager pin and all CI workflows on pnpm 10.34.9. Retain TypeScript 6.0.3 for parser compatibility and tsup 8.5.1 within the supported major.
- Remove the expired clustered-LRU release-age exception and apply scoped development-tool overrides for the glob cancellation and minimatch pattern-amplification advisories.

### Fixed

- Bound base64 allocation and gzip output before decoding oversized cache payloads.
- Bound L1 invalidation message size, key counts, pending work, and delete batches. Chunk outgoing messages, report drain failures, and release shared per-prefix state when its last backend closes.
- Apply the same tag validation to writes and invalidation: at most 1024 non-empty tags, 4096 UTF-8 bytes per tag, and 256 KiB for the encoded tag list. Deduplicate accepted tags and count overlapping cleanup memberships against the aggregate limit.
- Include key bytes in clustered-LRU entry accounting, validate size settings, verify retained invalidation state and leases, and bound failed lock acquisition.
- Compare clustered lease ownership, optionally record completion, and delete the lock in one synchronous primary operation so an old owner cannot remove a successor's lease. Bound worker IPC waits and clean up pending requests after errors or disconnects.
- Pass loader cancellation signals through the Express and Fastify adapters, and keep adapter lock-expiration settings instance-local.
- Exclude only scalar `refresh=true` from default HTTP cache identity. Keep other refresh values in the key and hash request paths larger than 1024 UTF-8 bytes.
- Reject invalid lock lifetimes, remove lease values from logs, and require a live matching lease before recording refresh completion.
- Scope coverage workflow permissions and Codecov credentials to the jobs and steps that use them, and bind the local Compose Redis port to loopback.

### Compatibility notes

Cluster primaries using clustered leases must call `bootstrapClusteredLru()` before forking workers. Payload and tag operations now enforce resource limits, and default HTTP identity retains non-control refresh values. See [upgrading to 0.4.0](docs/releases.md#upgrading-to-040) for rollout considerations.

## 0.3.0 - 2026-10-23

This release changes Fastify response storage and refresh behavior to enforce final response privacy. Follow the [0.3.0 upgrade instructions](docs/releases.md#upgrading-to-030) before deploying.

### Fixed

- Update Fastify to 5.12.7 to address header-name validation bypass ([GHSA-389g-gv7q-r4x8](https://github.com/fastify/fastify/security/advisories/GHSA-389g-gv7q-r4x8)). Regression tests cover forbidden headers before both cold and warm handler/loader cache access.
- Fingerprint and store the same serialized payload, including when getters or `toJSON()` change between calls. Apply `ignoreFields` to that snapshot without mutating the input.
- Reject empty `setMany()` and `clearMany()` calls after shutdown, consistently with other cache operations.
- Keep policy-rejected HTTP loader bodies private to each caller, clone shared JSON bodies before framework hooks, and honor request `no-store`/`no-cache` and response `no-cache`.
- Bound ordinary middleware cache reads and write-token waits by the HTTP load deadline.
- Validate Fastify storage and sharing against final response policy, including late hooks, and replay raw responses so send transformations run once.
- Preserve custom JSON redaction, getter behavior, handler-installed Fastify serializers, and framework handling of circular bodies by bypassing unsafe raw representations.
- Keep L1 Redis reads available while its invalidation subscriber is connecting. Preserve revision validation on every L1 hit.
- Reset every LRU TTL policy on namespace invalidation and preserve fractional adaptive TTLs in Redis results.
- Expire FakeRedis metadata and other stored types naturally, with regression contracts against real Redis.

### Changed

- Serialize payloads once per write, removing duplicate JSON work from the default fingerprint path.
- Batch LRU tag-index cleanup, removing quadratic rewrites when invalidating large tags.
- Make HTTP deadline regressions deterministic while retaining real Express and Fastify requests. Exercise batched reads in the generated cache-state invariant checks.

### Compatibility notes

- Fastify 5 consumers require version 5.12.6 or later for the header-name validation fix. Fastify 4 remains supported.
- Fastify loader refreshes now run in the foreground even when `staleWhileRevalidate` is configured. A timed-out origin cannot approve its result for sharing; surviving waiters call their own loaders. `staleIfError` and direct-cache background refresh remain supported. See [HTTP identity and ownership](docs/cache-features.md#http-identity-and-ownership).
- Clear existing Fastify response entries or select a new middleware namespace on upgrade. Older entries may contain bodies that already passed send hooks; new entries retain the raw representation and separate final policy metadata.

## 0.2.1 - 2026-10-21

### Fixed

- Finish Redis and L1 cleanup when graceful shutdown rejects. Disconnect owned Redis connections, preserve caller-owned clients and the original shutdown error, and force teardown after an early close failure.
- Preserve clear failures when temporary-helper cleanup also fails, and detach helper observers without flushing or closing borrowed custom backends.
- Release allocated clustered caches after failed or stalled initialization, and prevent initialization from resuming cache operations after closure.
- Disconnect owned Redis clients if backend initialization throws before the cache instance can be returned.

### Added

- Seeded fuzz and invariant tests for cache operation sequences, write fencing, shutdown faults, connection ownership, and temporary-helper observer cleanup. Run them with `pnpm run test:fuzz`; replay failures with `FUZZ_SEED` and `FUZZ_PATH`.

### Upgrade notes

- No additional cache-format migration from 0.2.0. When upgrading from 0.1.1 or earlier, also follow the [0.2.0 upgrade instructions](docs/releases.md#upgrading-to-020).
- Continue handling rejected `close()` and `quit()` calls. Cleanup now proceeds after graceful shutdown fails, while callers retain the original error. Custom backend teardown should tolerate a subsequent forced call.

## 0.2.0 - 2026-10-17

This release adds bounded loader and shutdown lifetimes and changes HTTP cache identity and Fastify registration behavior. Review the upgrade notes before deploying.

### Fixed

- Include request authority and port in default HTTP keys. Let `clearAdaptiveCache` accept authority as an optional fifth argument, and keep adapter `.clear(request)` aligned with lookup.
- Run Fastify cache lookups and explicit loaders after validation and authorization hooks. Wrap routes declared after awaited adapter registration, respecting scope and registration prefix.
- Run explicit HTTP loaders once when caching fails and propagate source errors. Normalize binary views to buffers and give each caller an independent unsupported or consumable source result without storage.
- Give default adapters owned caches and connections. Preserve caller-owned injected caches and Redis clients during shutdown.
- Validate durable entry revisions on L1 hits so ordinary writes invalidate stale payloads even if Pub/Sub publication is lost or a fingerprint ignores a changed field.
- Replace unbounded Redis tag sets with expiry-aware indexes and bounded cleanup after atomic epoch invalidation. Continue reading and clearing legacy tag sets.

### Added

- Per-caller `getOrSet` signals and configurable execution deadlines, defaulting to 30000ms. Loaders receive a typed shared `AbortSignal`; detached results cannot start later writes.
- Bounded `close({ timeoutMs })`, defaulting to 5000ms, with `TimeoutError` on expiry and optional forced backend teardown.
- Packed CJS/ESM and package-name declaration consumers without optional peers, plus Express 4/5 and Fastify 4/5 runtime/type compatibility checks in PR CI on Node 22 and 24.

### Changed

- Require optional clustered-LRU peer `^2.1.2` and verify development against `2.1.2`. Upstream fixes cover IPC failures, L1 invalidation and fill races, and namespace cleanup. Clustered adapter write and lock-release limits remain unchanged.
- Refresh eligible development dependencies under the configured release-age policy. Scoped Vite and esbuild overrides remove development-tool advisories.
- Simplify the README, put usage examples before internals, and leave release history in the changelog and upgrade guide.
- Keep raw benchmark evidence outside Git; retain the measurement summaries and reproduction commands in the documentation.

### Upgrade notes

- Use a new key prefix when overlapping older writers. New revisions and tag indexes cannot make older processes enforce the new guarantees. Default HTTP keys also change, leaving older keys to expire.
- Await Fastify adapter installation before declaring cached routes. Review long-running loaders and shutdown handlers for the new finite deadlines.
- Use adapter `.clear(request)` and `.cache.invalidateTags()` for its owned cache. Process-wide helpers operate on the separate default cache.
- See [rollout instructions](docs/releases.md#upgrading-to-020) for details.

## 0.1.1 - 2026-09-11

### Added

- Optional backend `fetchMany()` support, with results aligned to each input, including duplicate keys. Existing custom backends continue to work without changes.
- `bench:lru` worker benchmarks with IPC counts and checks for primary-side replacement, tag and namespace invalidation, and IPC backpressure. See the [dependency evaluation](docs/lru-cache-clustered-2.1.1.md).

### Changed

- Batch clustered-LRU `getMany()` payload and primary epoch reads through upstream `mGet()`, preserving result order, duplicate-key events, decoding, and shutdown draining. Redis and L1-plus-Redis keep their existing read paths.
- Reduce worker-to-primary requests for a 32-key batch from 96 to 2 without L1, and from 64 to 1 with warm L1. Local paired benchmarks measured median batch throughput gains of 51% and 133%, respectively; results vary by workload. See the [batch-read verification and performance report](docs/batched-reads-0.1.1.md).
- Update the optional `@0xdoublesharp/lru-cache-clustered` peer and development dependency to `^2.1.1`, incorporating IPC backpressure fixes and reduced local-L1 hydration traffic.

### Fixed

- Recheck clustered-LRU entry retention after primary epoch validation so scalar and batch reads cannot return expired entries, even with `allowStale`.
- Reject empty `getMany()` calls after closure, consistently with other reads.

### Upgrade notes

- Clustered-LRU users must install `@0xdoublesharp/lru-cache-clustered@^2.1.1`. The cache wire format is unchanged from 0.1.0.
- Batch reads preserve the existing clustered-LRU consistency limits and are not atomic multi-key transactions.

## 0.1.0 - 2026-09-10

This version adds loader and cache-policy APIs and changes the Redis format and HTTP caching defaults. Review the upgrade notes before deploying.

### Added

- Opt-in AIMD and time-aware EWMA TTL policies across Redis, L1 Redis, and clustered LRU, with validated settings, persisted learning state, and TTL caps. The existing adaptive policy remains the default.
- `getOrSet<T>` with per-instance request coalescing, Redis loader locks, bounded lock waits, and explicit force refresh.
- Independent stale-while-revalidate and stale-if-error windows, explicit stale reads, and short negative caching for missing values. HTTP 404 caching is opt-in.
- Typed hits and bulk `getMany`, `setMany`, and `clearMany` helpers.
- Namespace invalidation, write tokens, and Redis atomic checks that reject writes after invalidation or loader lease loss.
- Configurable content fingerprints and dotted `ignoreFields` paths, preserving the full cached payload.
- Selective compression with a byte threshold, asynchronous gzip, compressed-buffer detection, and an only-if-smaller policy. New codec markers identify how entries should be decoded.
- TTL jitter, per-instance statistics, cache events, serving-layer metrics, and LRU eviction reporting.
- `close()` and middleware `.cache`, `.flush()`, and `.close()` handles, with caller ownership preserved for injected caches and Redis clients.
- Express and Fastify custom keys, declared header variations, cache predicates, injected cache instances, and explicit loader routes for stale refresh.
- Request-aware `.clear(request)` on Express middleware and Fastify plugins, using the configured custom key, header variations, query rules, and cache namespace.
- A seven-day minimum package release age in `pnpm-workspace.yaml`, without exclusions.

### Changed

- Middleware caches GET responses only. Authorization and Cookie requests bypass caching by default. Explicit opt-ins also require caller-defined identity isolation.
- Responses with `private`, `no-store`, `Set-Cookie`, `Vary: *`, or undeclared `Vary` headers are excluded from storage. See the [HTTP policy guide](docs/cache-features.md#http-identity-and-ownership).
- Redis stores freshness and generation information with each payload. L1 hits validate against Redis even if a Pub/Sub invalidation was missed; this adds a Redis round trip to hot reads.
- Loader, middleware, and asynchronous compression writes wait for write-token acceptance. Ordinary synchronous L1 `set()` retains its optimistic write path.
- Updated dependencies within the release-age policy, including ioredis 6, Vitest 5, Testcontainers 12, Fastify 5.12, ESLint 10.9, and lru-cache 11.5. Kept TypeScript at 6.0.3 for parser compatibility and removed unused `c8`.
- Split loader coordination and LRU envelope calculations into focused internal modules, and organized large test suites by backend and behavior.
- Replaced weak mock/log assertions with stored-state, real TTL, concurrency, and HTTP regression checks. Tests must contain assertions.

### Fixed

- Express request types accept array-valued route parameters, matching Express 5 and allowing typed calls to `.clear(request)`.
- Range and If-Range requests bypass caching, and partial `206` responses are not stored under full-resource keys.
- Request-policy failures bypass caching while still running configured loaders, avoiding accidental 404 responses on loader-only routes.
- Fractional `metaTTL` values are rejected before backend initialization, preventing partial Redis writes that leave metadata without expiry.
- Loader lock cleanup errors emit a `lock-release` error event without replacing a successful result or the original loader error.
- Public lock operations reject new work after close and participate in shutdown draining; previously accepted loaders can complete their internal lock operations.

- Invalidated or expired-lease loaders cannot repopulate Redis with old results. Evicted control/tag-index keys cause misses instead of reviving invalidated entries.
- Retagging removes obsolete memberships. Tag epochs expire, and loader lock release no longer leaves permanent last-refresh marker keys.
- Stale fallback is checked again when a loader fails. Negative entries have no stale retention. Background refresh contention avoids redundant polling.
- Forced refreshes across instances run their own loaders after acquiring the lock instead of accepting an old fresh hit.
- Middleware preserves response status, headers, JSON-looking text, and binary bodies. Fastify hit detection works with diagnostic headers disabled, and streams bypass storage.
- Express response compression no longer pairs plaintext cached bodies with post-compression headers. Already-compressed HTTP buffers are detected by the compression policy.
- Invalid custom keys bypass caching. Response-policy exceptions do not break successful responses, and background refresh uses a snapshot of response headers.
- Middleware respects an injected cache's TTL limit; initial, adaptive, and negative TTLs respect the effective maximum.
- Clear helpers preserve unrelated LRU entries and resource ownership, respect ignored query parameters and custom prefixes, and retain own `__proto__` query fields in key normalization.
- Clustered LRU retains adaptive metadata after payload expiry, removes old data on oversized replacement, and acquires locks atomically through the cluster primary.
- Observer errors are contained, and closed middleware bypasses caching.

### Upgrade notes

- Use a new key prefix when deploying alongside older readers. The new Redis envelope is not readable by older versions. See [upgrading from 0.0.6](docs/releases.md#upgrading-from-006).
- Strict distributed write and lease guarantees require Redis. Clustered LRU remains host-local and lacks an atomic cross-worker compare-and-store operation.
- Bulk helpers are concurrent convenience APIs, not multi-key transactions. Targeted invalidation can reject unrelated in-flight writes within the same namespace.

## 0.0.6 - 2026-05-15

[Changes since 0.0.5](https://github.com/0xdoublesharp/adaptive-cache/compare/v0.0.5...v0.0.6)

### Added

- Versioned payload envelopes for JSON values, strings, buffers, and `undefined`.
- `ignoreQueryParams`, defaulting to `['refresh']`, with sorted query normalization for middleware keys.
- `l1Redis.writeMode` with `async` and `await-redis` modes, and `AdaptiveCache.flush()` for pending backend work.
- Redis/Testcontainers end-to-end coverage for adaptive TTLs, Express responses, L1 hydration/invalidation, and standalone LRU behavior.

### Changed

- Declared Node.js `>=22` and made Express/Fastify optional peers supporting major versions 4 and 5.
- Removed the runtime dependency on `fastify-plugin` and framework-specific imports from the adapters.
- Coverage now runs the full test suite rather than the selected deterministic files used in 0.0.5.
- Simplified README badges and documented payloads, Redis TLS, lifecycle draining, and write modes.

### Fixed

- Refresh bypass updates the normal cache key instead of a separate refresh-specific key.
- Plain strings and buffers round-trip through the direct API; middleware recognizes falsy cached values.
- `cacheResult` caches `false`, `0`, and empty strings and awaits the Redis write.
- Redis TLS is enabled only for TLS URLs, with certificate verification enabled by default.
- Key/tag clears remove adaptive metadata as well as data; Redis tag sets receive an expiry.
- Initialized clustered LRU backends call the dependency's `destroy()` hook on shutdown.

## 0.0.5 - 2026-05-12

[Changes since 0.0.4](https://github.com/0xdoublesharp/adaptive-cache/compare/f28211e770fd9f4c6484c0a2c39bf1cf81a47cea...v0.0.5)

### Added

- Pluggable `AdaptiveCacheBackend` support with built-in `redis`, `l1-redis`, and standalone `clustered-lru` modes.
- Bounded LRU payload envelopes, memory and entry-size limits, namespace/timeouts/failsafe settings, and optional per-worker local L1 options through `@0xdoublesharp/lru-cache-clustered` 2.1.
- Redis Pub/Sub invalidation for server-local L1 caches and optimistic L1 writes reconciled with Redis adaptive TTL metadata.
- `keyPrefix` as a backend-neutral alias and backend options for `clearAdaptiveCache`.
- Backend, singleton, LRU middleware, and Redis-free tests; configuration benchmarks; ESLint and quality scripts.
- CI, coverage, and npm trusted-publishing workflows, package metadata/file allowlist, MIT license, and an architecture diagram.

### Changed

- Moved Redis behavior into its own backend and appended adaptive metadata to Lua fetch/update tuples for L1 hydration.
- LRU-only middleware no longer creates the default Redis singleton. LRU dependencies are optional peers.
- Refreshed development dependencies and expanded backend/configuration documentation.

### Fixed

- Missing Redis metadata no longer appears as `"null"` in debug headers.
- L1 hydration waits for invalidation subscription readiness.
- Refresh lock expiry converts public seconds to Lua milliseconds.

## 0.0.4 - 2025-11-23

[Version commit](https://github.com/0xdoublesharp/adaptive-cache/commit/f28211e770fd9f4c6484c0a2c39bf1cf81a47cea)

- Package version bump only. No source, test, or dependency changes from 0.0.3.

## 0.0.3 - 2025-11-23

[Changes since 0.0.2](https://github.com/0xdoublesharp/adaptive-cache/compare/98c7f112394a711e373f3ed5b58c65821c488294...9a60da6980fa9c6cf010c42555bf58281f02e850)

### Changed

- Exported the Express factory as `adaptiveExpressCache`, replacing the public `adaptiveCache` alias.
- Changed `cache(duration)` from middleware creation to an options helper returning `{ initialTTL }`, for use as `adaptiveExpressCache(cache('5 seconds'))`.
- Removed the `cacheSuccess` export and duplicate utility files; updated tests for the new API.

## 0.0.2 - 2025-11-23

[Changes since 0.0.1](https://github.com/0xdoublesharp/adaptive-cache/compare/a4a3261e7209c80967097f9485bb2bc585cac008...98c7f112394a711e373f3ed5b58c65821c488294)

- Renamed the internal Express factory to `adaptiveExpressCache`, while retaining `adaptiveCache` as its package export alias.
- Updated the `cache` and `cacheSuccess` wrappers to call the renamed factory and added standalone duration/key utility files.

## 0.0.1 - 2025-11-23

[Initial version commit](https://github.com/0xdoublesharp/adaptive-cache/commit/a4a3261e7209c80967097f9485bb2bc585cac008)

- Initial Redis-backed adaptive cache with response hashing, TTL growth/reset, gzip payloads, tag invalidation, and Lua refresh locks.
- Express and Fastify integrations, shared Redis/cache helpers, fixed-duration `cacheResult`, and diagnostic headers.
- TypeScript declarations, CommonJS/ESM builds, Vitest tests, and a local Redis Compose configuration.
