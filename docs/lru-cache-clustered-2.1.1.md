# lru-cache-clustered 2.1.1 evaluation

Evaluated on 2026-09-11 against adaptive-cache commit `37657ef`. The published upstream package records commit `9347fa820c71d452f27438de293beb81a88567b4`. Its CommonJS and ESM runtime files are byte-identical to the clean committed candidate used in the paired benchmarks.

## Dependency update and validation

- Development and optional peer ranges now require `@0xdoublesharp/lru-cache-clustered@^2.1.1`; the lockfile resolves 2.1.1.
- The user authorized a one-time exception to the seven-day release age. Resolution used a command-line override. An unrelated nanoid resolution was removed before testing. The final lockfile changes only the clustered-cache package; `minimumReleaseAge: 10080` remains unchanged, with no persistent exclusions.
- A normal frozen offline install succeeds with the updated lockfile.
- `pnpm run quality` passes: 417 tests, 100% statements/branches/functions/lines, lint, type checks, CJS/ESM builds, and the built-declaration consumer check.
- All 417 tests also pass on Node 22.19.0. CJS and ESM smoke checks pass on Node 22.19.0 and Node 24.16.0, covering coalesced loaders, async codecs, bulk reads, namespace invalidation, metrics, and TTL policies.
- The worker benchmark checks the same retained worker cache after primary-side replacement and namespace invalidation. These checks pass on both versions. The 2.1.1 worker checks also pass on Node 22.
- When the IPC send wrapper delivers a read request but returns `false`, 2.1.0 rejects it with `IPC backpressure`; 2.1.1 waits for the response and returns the exact expected value. Every such check asserts that IPC actually occurred. No mutation retry is involved.

## Paired benchmark

Apple M2 Max, Node 24.16.0, identical adaptive-cache build and runtime peers, including lru-cache 11.5.2. Each sample uses a fresh process. A primary owns the shared cache; worker scenarios use one actual Node cluster worker. The primary seeds 300 keys. Payloads contain a 2 KiB string and an ID, with compression disabled to expose IPC costs. TTLs exceed the run duration. Local L1 uses a 60-second sliding TTL and a 2,000-entry limit.

Seven trials per version alternate execution order. Each trial measures 300 initially cold reads, 3,000 warm reads, 100 batches of 32 reads, and 100 writes. Every read validates the returned payload. Missing-key reads warm the runtime before measurement. Tests and dependency installation do not run concurrently with timing samples. Results are medians; they are local measurements, not throughput guarantees. Cold phases and writes are short enough to retain timing noise.

| Mode                | Operation      | 2.1.0 ops/s | 2.1.1 ops/s | Change |
| ------------------- | -------------- | ----------: | ----------: | -----: |
| Primary process     | Cold reads     |     159,401 |     152,294 |  -4.5% |
| Primary process     | Warm reads     |     235,240 |     233,263 |  -0.8% |
| Primary process     | 32-key batches |       7,892 |       7,816 |  -1.0% |
| Primary process     | Writes         |      46,801 |      48,990 |  +4.7% |
| Worker, L1 disabled | Cold reads     |       9,150 |       9,326 |  +1.9% |
| Worker, L1 disabled | Warm reads     |      12,585 |      12,939 |  +2.8% |
| Worker, L1 disabled | 32-key batches |       1,690 |       1,612 |  -4.6% |
| Worker, L1 disabled | Writes         |       3,155 |       3,388 |  +7.4% |
| Worker, L1 enabled  | Cold reads     |       7,440 |       8,676 | +16.6% |
| Worker, L1 enabled  | Warm reads     |      19,234 |      19,458 |  +1.2% |
| Worker, L1 enabled  | 32-key batches |       2,576 |       2,608 |  +1.3% |
| Worker, L1 enabled  | Writes         |       2,835 |       3,061 |  +8.0% |

Batch rates count complete 32-key batches, not individual keys. IPC counts provide stronger evidence than small timing differences:

| Worker operation               | 2.1.0 IPC messages | 2.1.1 IPC messages |
| ------------------------------ | -----------------: | -----------------: |
| Cold read, L1 enabled          |                  4 |                  3 |
| Warm read, L1 enabled          |                  2 |                  2 |
| Write, L1 enabled              |                 13 |                 11 |
| Read, L1 disabled              |                  3 |                  3 |
| Write, L1 disabled             |                 11 |                 11 |
| Warm 32-key batch, L1 enabled  |                 64 |                 64 |
| Warm 32-key batch, L1 disabled |                 96 |                 96 |

### Longer non-L1 check

The initial non-L1 batch result was slower, so eight further paired trials used 10,000 warm reads and 2,000 batches each. Other settings were unchanged. Median results and full observed ranges:

| Operation      | 2.1.0 median ops/s (range) | 2.1.1 median ops/s (range) | Change |
| -------------- | -------------------------: | -------------------------: | -----: |
| Cold reads     |        8,967 (8,400–9,597) |       8,804 (8,285–10,302) |  -1.8% |
| Warm reads     |     13,851 (13,039–14,064) |     13,710 (13,142–13,971) |  -1.0% |
| 32-key batches |        1,847 (1,797–1,866) |        1,806 (1,689–1,822) |  -2.2% |
| Writes         |        3,290 (2,544–3,495) |        3,112 (2,450–3,373) |  -5.4% |

This is a mixed performance result. Local-L1 cold hydration and writes show reduced message counts and higher throughput. Warm paths are broadly similar. Non-L1 batches remain about 2% slower in the longer trial, with overlapping ranges; this is a small possible performance regression, not evidence of a universal speedup. Write timings change direction between cohorts and have broad ranges. No functional regression was found in the checks above. Redis-backed integration tests passed, but these timing measurements cover the clustered-LRU backend, not Redis round trips.

## Upstream changes and follow-up

The subsequent [0.1.1 batch-read implementation](batched-reads-0.1.1.md) adopts the `mGet()` opportunity below. The measurements in this document describe the dependency-only update.

The public `index.d.ts` declaration is unchanged between 2.1.0 and 2.1.1. There are no new public methods to adopt.

- **Automatic benefit:** cold L1 `get()` and `set(..., { updateL1: true })` receive remaining TTL with the value/acknowledgement. This removes follow-up TTL requests in the paths already used by our backend.
- **Automatic correctness benefit:** delivered IPC requests are no longer rejected merely because `send()` returned false. Upstream also bounds L1 freshness by the primary expiration and corrects stale `setIfAbsent`, counter, `peek`, and `has` behavior. Our envelope freshness checks remain in place.
- **Useful future integration:** upstream `mGet()` now hydrates a cold batch in one IPC request and supports very large arrays. At the evaluated commit, `getMany()` runs individual reads, so it does not gain that optimization. A backend batch-fetch method could help, provided it preserves namespace/tag checks, TTLs, stale handling, ordering, and per-key events.
- **Not a direct replacement:** upstream `fetch()` reduces cold/follower coordination traffic, but our loader has separate lease, write-fencing, stale, negative-cache, and Redis behavior. Replacing it would need its own design and regressions.
- **Still missing:** no atomic compare-and-store/release API was added. The documented cross-worker fencing limits of clustered LRU remain.

## Reproduce

Build first, then run the benchmark against a package root whose `dist/index.js` and `node_modules` contain the selected dependency version:

```sh
pnpm run build
pnpm run bench:lru
node --expose-gc scripts/benchmark-lru-upgrade.mjs /absolute/path/to/comparison/root
BENCH_MODES=worker BENCH_READS=10000 BENCH_BATCHES=2000 pnpm run bench:lru
```

Keep adaptive-cache and all other runtime dependencies identical, use separate roots for 2.1.0 and 2.1.1, and alternate runs sequentially. The benchmark emits JSON including exact IPC counts and correctness results. The original run recorded thirty samples, including the backpressure failure on 2.1.0. Raw run evidence is kept outside the repository. The benchmark intentionally reports that diagnostic result without aborting baseline timing runs; compare its `backpressure.passed` fields explicitly.

Sources: [upstream changes](https://github.com/0xdoublesharp/lru-cache-clustered/compare/v2.1.0...v2.1.1), [2.1.1 publication](https://github.com/0xdoublesharp/lru-cache-clustered/actions/runs/34627235700).
