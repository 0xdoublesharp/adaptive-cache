# Releases and maintenance

The [README](../README.md), [feature guide](cache-features.md), and [TTL policy guide](ttl-policies.md) describe the current API and behavior. The [changelog](../CHANGELOG.md) records changes awaiting release and version history. Keep current-use documentation evergreen; retain version-specific changes in the upgrade reference below.

A local version bump does not publish the package. Publication follows the release process here.

## Preparing a release

1. Review changes since the last tag and keep user-visible additions, fixes, dependency changes, and migration notes under Unreleased throughout development.
2. Install using the configured pnpm version and `pnpm install --frozen-lockfile`. Dependency updates must honor `minimumReleaseAge: 10080` and peer compatibility. Apply only the version-specific exceptions declared in workspace policy; keep other updates under the age floor. The policy governs this repository's resolution; consumers resolve package ranges under their own package-manager policy.
3. Choose the next version based on compatibility impact, update `package.json`, and move the completed Unreleased notes into a new dated section. Retain all historical sections. Add an Unreleased section when development resumes. Keep the README and feature guide focused on current behavior, and put version-specific rollout instructions in the upgrade reference below.
4. Run `pnpm run quality`, exercise the full suite on supported Node versions, run `pnpm run test:compat`, and inspect `npm pack --dry-run`. The suite requires Docker for Redis/Testcontainers tests. Inspect that the archive includes the built entry points, Lua scripts, README, changelog, license, and linked documentation.
5. Record the commands and results for the actual release candidate; distinguish checks that passed from checks that did not run. Coverage measures exercised code, not correctness; retain the concurrency, invalidation, HTTP, and stored-TTL regression checks.
6. Commit the release candidate and create a matching `v<version>` tag when ready to publish. Pushing a matching tag triggers [the publishing workflow](../.github/workflows/publish.yml), which checks the package version, installs, runs quality/tests, inspects the package, and publishes with provenance. After npm publishing succeeds, a separate job creates a GitHub release for the existing tag with automatically generated release notes. Tags with a prerelease suffix are marked as GitHub prereleases. The workflow does not generate changelog entries.
7. If GitHub release creation fails after npm publishing succeeds, rerun only the failed jobs so npm publishing is not repeated. The release job skips tags that already have a GitHub release.

## Deployment compatibility

Clustered-LRU applications call `bootstrapClusteredLru()` in the Node cluster primary before forking workers. It initializes the peer's cache IPC and adaptive-cache's atomic release handler. Standalone use initializes automatically. Worker lock acquisition rejects if the handler is unavailable, while L1 Redis continues to use Redis for leases. See the [clustered-LRU setup](../README.md#clustered-lru).

Payload writes and decoded reads accept up to 64 MiB by default, including existing encoded payloads. Set `compression.maxDecodedBytes` consistently across writers and readers when another ceiling is required. The limit applies to the serialized envelope, including base64 representation of buffers.

Writes and invalidation accept at most 1024 non-empty tags, 4096 UTF-8 bytes per tag, and 256 KiB for the encoded list. Redis invalidation processes at most `redis.maxTagCleanupKeys` memberships per call, defaulting to 10000. Invalidating a larger snapshot rejects after its epoch has advanced; modern entries stay fenced, but physical cleanup is incomplete. Handle that rejection and choose a limit appropriate for the application's tag cardinality. See [invalidation behavior](cache-features.md#invalidate-without-resurrecting-old-work).

Default HTTP identity excludes only scalar `refresh=true`. Other refresh values remain application inputs in the key; an explicit `ignoreQueryParams` list removes each named parameter regardless of value. Old default entries may stop matching when refresh values or long request paths are present. Let those entries expire or clear their namespace when adopting the current identity policy.

## Upgrade reference

These version-specific notes describe changes from earlier releases. Use the current feature documentation for a new installation.

### Upgrading to 0.3.0

Version 0.3.0 fixes HTTP response privacy and replay, backend TTL parity, and cache-write serialization. The minor version marks changes to Fastify refresh behavior and stored response representations. See the [0.3.0 changelog](../CHANGELOG.md#030---2026-10-23).

1. Upgrade Fastify 5 to at least 5.12.6 for the header-name validation fix. Fastify 4 remains supported, as do Express 4/5 and Node.js 22 or newer.
2. Clear existing Fastify response entries or select a fresh middleware `keyPrefix`. Use a distinct prefix while old and new application instances overlap; older entries can contain bodies that already passed send hooks. New entries retain the raw body and separate final policy metadata. Align an injected cache's `keyPrefix` with the middleware prefix, and use a distinct `lru.namespace` when isolating LRU-backed instances.
3. Account for foreground Fastify loader refreshes even when `staleWhileRevalidate` is configured. The originating request must finish its response hooks before a candidate can be shared or stored. If that request times out before approval, surviving waiters call their own loaders within their remaining deadlines. `staleIfError`, Express background refresh, and direct `cache.getOrSet()` background refresh remain available.
4. Expect custom serializers and raw bodies with getters, custom `toJSON`, hidden metadata, cycles, or nested binary values to bypass caching when replay cannot preserve their behavior. Each request still receives the framework's original response. See [HTTP identity and ownership](cache-features.md#http-identity-and-ownership) for the full eligibility rules and final-policy checks.

There is no additional direct-cache payload migration from 0.2.1. Applications upgrading from 0.1.1 or earlier must also follow the 0.2.0 instructions below.

### Upgrading to 0.2.1

Version 0.2.1 fixes cleanup after graceful Redis shutdown failures, failed or stalled clustered-cache initialization, and temporary invalidation-helper failures. It also adds fuzz and invariant tests. There is no additional cache-format migration from the prepared 0.2.0 source. Applications upgrading from the published 0.1.1 release or earlier must also follow the 0.2.0 instructions below.

Continue awaiting and handling errors from `close()` and `quit()`. Cleanup now proceeds after graceful shutdown fails, preserving the original error. Owned Redis clients and internal subscribers are disconnected; injected clients remain caller-owned. Custom backend teardown should tolerate a graceful attempt followed by `quit(preserveSharedCache, true)` and release resources without waiting for stalled work.

Temporary clear helpers detach their observers without flushing or closing borrowed custom backends. Clustered backends cannot resume operations after closure, even if initialization finishes later. See [shutdown behavior](cache-features.md#observe-and-drain-work) and the [0.2.1 changelog](../CHANGELOG.md#021---2026-10-21).

### Upgrading to 0.2.0

These steps cover the HTTP identity, loader lifetime, ownership, and invalidation changes. They apply in addition to the older upgrade instructions below.

1. Choose a fresh `keyPrefix` for Redis deployments that overlap older writers, and update complete direct API keys to match. Use a distinct `lru.namespace` when isolating LRU-backed processes. New revisions and tag epochs cannot make older writers enforce the new guarantees. Let the previous namespace expire under its original retention policy.
2. Account for the new default HTTP key format, which includes trimmed, lowercased request authority and port. Old keys naturally stop matching. Use adapter `.clear(request)` with the same Host header, custom key inputs, and `varyBy` headers. The optional fifth argument to `clearAdaptiveCache` supplies authority for default keys; omitting it retains legacy-key invalidation.
3. Await Fastify adapter registration before declaring routes to cache. Lookup and loaders now run after validation and authorization hooks. Existing routes stay uncached. Prefix registrations restrict which later route paths are wrapped; they do not relocate routes. Keep custom key functions responsible for host and tenant isolation.
4. Move adapter invalidation to its own `.cache` or `.clear(request)`. Adapters without an injected `cache` now own separate instances and Redis connections instead of sharing `getDefaultCache()`. Express callers close their adapters; Fastify uses `onClose`. Injected caches and Redis clients stay caller-owned, including on forced shutdown.
5. Review loads that can exceed the new 30000ms per-caller deadline. Configure `loadTimeoutMs` and pass `signal` where needed; direct loaders can pass their shared context signal to cancellable I/O. A caller timeout rejects with `TimeoutError`, and explicit cancellation preserves the abort reason. Successful work still needed by another caller continues, including when the initiating HTTP caller times out. HTTP deadlines also cover bypassed loaders, preliminary reads, and cache-outage fallback. Deadline values must be finite milliseconds from `0` through `2147483647`; per-call options override instance defaults. HTTP adapters inherit an injected cache's deadline through `resolveLoadTimeoutMs()`.
6. Handle rejection from `close()` and `quit()` on deadline expiry. The default is 5000ms, configurable through `closeTimeoutMs` or `close({ timeoutMs })`. Expiry aborts loader work and requests immediate owned-resource teardown; custom backend `quit(preserveSharedCache?, force?)` should honor forced teardown without waiting for stalled work. Standalone `flush()` remains a graceful drain. Backend observer unsubscribe errors emit `backend-unsubscribe` events and cannot block shutdown.
7. Do not inspect Redis tag indexes as sets. New indexes use expiry-scored sorted sets at `<prefix>__adaptive:tag-index:<tag>`. Invalidation detaches the index and advances epochs atomically before bounded physical cleanup. New code supports legacy `<prefix>tag:<tag>` sets, but overlapping old writers still require the fresh namespace. Each write stores a revision, independent of content fingerprints, which L1 validates even after lost Pub/Sub messages. A legacy overwrite that cannot prove the stored revision forces an L1 miss and Redis fallback. Active detached indexes renew their 60-second TTL every 10 seconds. Cleanup checks exact snapshot cardinality and removal counts; missing snapshots, failed renewal, or incomplete cleanup reject explicitly. Modern entries remain epoch-fenced, but legacy raw payloads may survive until their original expiry if a snapshot is lost. Treat a rejected invalidation as incomplete.
8. Review explicit HTTP loaders that return native objects. JSON-compatible plain values and binary views are supported; views normalize to buffers. Streams, native responses, Blob, ArrayBuffer, Date, and unsupported non-plain objects bypass storage and result sharing. Each caller obtains its own source result, so loaders must create an independent consumable object per invocation. Cache failures still run the source loader once; source failures propagate.

LRU-backed modes require optional peer `@0xdoublesharp/lru-cache-clustered@^2.1.2` and `lru-cache@^11`; Redis-only consumers do not need them. Node.js >=22, Express 4/5, and Fastify 4/5 remain supported. PR CI adds Node 22/24 packed framework consumers and checks declaration resolution through the package name. These are local and CI verification targets, not deployment evidence.

### Version 0.1.1

Version 0.1.1 optimizes clustered-LRU bulk reads. LRU-backed modes require the optional peer `@0xdoublesharp/lru-cache-clustered@^2.1.1`; Redis-only users do not need it. Existing `getMany()` callers use the optimized path automatically on clustered LRU. Redis and L1 Redis retain their existing read behavior. There is no additional wire-format migration from 0.1.0. Empty `getMany()` calls now reject after closure. See the [release notes](../CHANGELOG.md#011---2026-09-11) and [verification report](batched-reads-0.1.1.md).

### Version 0.1.0

Version 0.1.0 includes changes after `v0.0.6`. The minor version marks the new loader and policy APIs, Redis wire-format change, and stricter HTTP caching defaults. See the [release notes](../CHANGELOG.md#010---2026-09-10) and [verification report](features-verification-2026-09-10.md).

### Historical sources

Git history records six prior package versions. Versions 0.0.1 through 0.0.4 have version commits but no local release tags. Versions 0.0.5 and 0.0.6 have tags. Dates below are UTC commit dates, not npm publication timestamps.

| Version | Date       | Source revision                                                                                              | Scope                                                                  |
| ------- | ---------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 0.0.1   | 2025-11-23 | [`a4a3261`](https://github.com/0xdoublesharp/adaptive-cache/commit/a4a3261e7209c80967097f9485bb2bc585cac008) | Initial repository and package.                                        |
| 0.0.2   | 2025-11-23 | [`98c7f11`](https://github.com/0xdoublesharp/adaptive-cache/commit/98c7f112394a711e373f3ed5b58c65821c488294) | Diff after 0.0.1.                                                      |
| 0.0.3   | 2025-11-23 | [`9a60da6`](https://github.com/0xdoublesharp/adaptive-cache/commit/9a60da6980fa9c6cf010c42555bf58281f02e850) | Diff after 0.0.2, including export changes.                            |
| 0.0.4   | 2025-11-23 | [`f28211e`](https://github.com/0xdoublesharp/adaptive-cache/commit/f28211e770fd9f4c6484c0a2c39bf1cf81a47cea) | Package version bump only.                                             |
| 0.0.5   | 2026-05-12 | [`v0.0.5`](https://github.com/0xdoublesharp/adaptive-cache/tree/v0.0.5), `5b92262`                           | Changes after 0.0.4 through the tag; package version set in `35cfe63`. |
| 0.0.6   | 2026-05-15 | [`v0.0.6`](https://github.com/0xdoublesharp/adaptive-cache/tree/v0.0.6), `1adee3a`                           | Changes after v0.0.5, including the intervening README badge cleanup.  |

The 0.0.6 commit changed the existing 0.0.5 changelog heading and expanded its contents instead of retaining both entries. The reconstructed changelog separates the changes using the tagged diffs. It does not infer additional npm releases from commit messages.

### Upgrading from 0.0.6

These steps apply when moving from 0.0.6 to 0.1.0 or 0.1.1.

1. Select a new namespace, such as `catalog:v2:`, for a rollout that overlaps older readers. Set middleware `keyPrefix` and the injected cache's `keyPrefix` consistently. Direct API keys are complete strings, so update their prefixes too. For LRU-backed deployments, use a distinct `lru.namespace` to isolate old and new processes.
2. Let old entries expire under their original prefixes. New Redis envelopes are unreadable by old code. New readers can read legacy entries, but legacy entries do not gain the new invalidation guarantees. Selective compression also writes a new codec marker; legacy compressed entries still require their matching `compress` setting.
3. Review routes that previously cached non-GET, authenticated, cookie-bearing, private, or partial responses. Range and If-Range requests and `206` responses bypass storage. They now bypass caching by default. Enable authenticated/cookie caching only with a key or variation that actually isolates the caller. Declare response `Vary` headers using `varyBy`, including `Accept-Encoding` when HTTP compression adds it.
4. Use an explicit `loader(request)` for middleware stale refresh. Normal response interception cannot safely rerun a completed route handler. Keep loaders consistent for a given key; the first caller controls shared work within an instance.
5. Allow for a Redis validation round trip on every L1 hit. Choose Redis-backed modes for atomic lease and write fencing. Clustered LRU has weaker cross-worker write/release guarantees. Bulk methods are not transactions.
6. Stop accepting requests before shutdown and call the adapter's `close()` or the direct cache's `close()`. Fastify closes owned adapter caches through `onClose`. Injected caches and Redis clients remain caller-owned.
7. For custom backends, implement and enforce `captureWriteToken` before using `getOrSet`. Implement `invalidateNamespace` to support namespace invalidation. `supportsWriteFencing()` checks method availability, not the backend's consistency guarantees.

`getOrSet` defaults to not storing `null` or `undefined`; set `negativeTTL` to cache missing values briefly. This loader policy does not remove direct `set()` support for those values. Negative results have no stale retention. A caller awaiting a loader may receive its result after invalidation, but an obsolete write token prevents Redis from retaining it.

New TTL policies are opt-in. Existing configurations retain the adaptive algorithm. Custom backends must implement and declare `supportsTtlPolicies` before selecting AIMD or EWMA. See [TTL policies](ttl-policies.md).

The `metaTTL` option accepts positive integer seconds. Fractional values now throw during construction instead of failing after a partial Redis write. Use adapter `.clear(request)` when invalidating custom or varied response keys.
