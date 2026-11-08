# TTL policies

Choose from three TTL policies when constructing a cache or an Express/Fastify adapter. The adaptive policy is the default; AIMD and EWMA are opt-in alternatives.

```typescript
const cache = new AdaptiveCache({
  initialTTL: 10,
  maxTTL: 300,
  ttlPolicy: { type: 'aimd', increaseSeconds: 5, decreaseFactor: 0.5 },
})
```

Policies operate on successful writes, comparing content fingerprints. Reading a hit does not update the observations. The effective maximum still comes from `maxTTL`, including dynamic and per-write limits. Negative entries retain their shorter cap. Jitter shortens the fresh lifetime after policy calculation and does not alter the learned TTL. Stale retention remains a separate setting.

## Default adaptive policy

Omit `ttlPolicy` or select `{ type: 'adaptive' }` for multiplicative growth. Unchanged content grows according to `ttlScaling`, damped by the accumulated change count. Changed content resets to `initialTTL`. The [README](../README.md#default-adaptive-ttl-formula) gives the formula.

## Additive increase, multiplicative decrease

```typescript
const cache = new AdaptiveCache({
  initialTTL: 10,
  maxTTL: 40,
  ttlPolicy: {
    type: 'aimd',
    increaseSeconds: 5,
    decreaseFactor: 0.5,
  },
})
```

The first observation uses the initial TTL. Each subsequent unchanged write adds `increaseSeconds`; a changed write multiplies the previous TTL by `decreaseFactor`. For example, the configuration above produces `10 → 15 → 20 → 10` for an initial value, two unchanged writes, and one changed write.

The result rounds up to seconds and stays between the effective initial and maximum TTLs. A factor close to one can round back to the previous TTL, so a decrease is not guaranteed to remove a whole second.

| Option            | Default | Constraint                           |
| ----------------- | ------- | ------------------------------------ |
| `increaseSeconds` | `5`     | Positive finite number.              |
| `decreaseFactor`  | `0.5`   | Greater than zero and less than one. |

This policy ignores `ttlScaling` and historical change-count damping. It is useful when gradual growth is easier to tune than multiplicative growth.

## Time-aware EWMA

```typescript
const cache = new AdaptiveCache({
  initialTTL: 10,
  maxTTL: 300,
  ttlPolicy: {
    type: 'ewma',
    halfLifeSeconds: 300,
    targetChangeProbability: 0.1,
  },
})
```

EWMA weights recent observations more heavily while reducing the influence of older observations. The cache stores an estimated rate of observed fingerprint changes, the last observation time, and its fingerprint.

For a positive elapsed interval `dt` in seconds:

```text
sampleRate = fingerprintChanged ? 1 / dt : 0
weight = 1 - exp(-ln(2) * dt / halfLifeSeconds)
changeRate = (1 - weight) * previousRate + weight * sampleRate
suggestedTTL = -ln(1 - targetChangeProbability) / changeRate
```

The first observation starts at `initialTTL` and seeds the rate to match that TTL. Settings that would make this seed zero or non-finite are rejected before writing, including when a per-write cap reduces the effective initial TTL. Later suggestions round up to seconds and stay within the TTL bounds. A zero estimated rate selects the maximum TTL. A timestamp that is equal to or earlier than the previous observation retains its rate, observation time, and observed fingerprint; it does not create a zero-duration rate sample.

Redis uses its server clock and computes updates atomically in Lua. Clustered LRU uses the process clock. Callers do not provide observation timestamps.

| Option                    | Default | Constraint                                                                   |
| ------------------------- | ------- | ---------------------------------------------------------------------------- |
| `halfLifeSeconds`         | `300`   | Positive finite number. Larger values forget older observations more slowly. |
| `targetChangeProbability` | `0.1`   | Greater than zero and less than one. Smaller values favor shorter TTLs.      |

This is a heuristic based on sampled changes, not a guarantee about the source's actual change probability. Several source updates can occur between observations, including a change and reversal that leave the same fingerprint. A change observed after a long quiet interval can still increase the suggested TTL. For example, with the settings above, an initial observation followed by an unchanged observation after 300 seconds and a changed observation another 300 seconds later produces TTLs of `10`, `20`, and `25` seconds.

EWMA uses neither `ttlScaling` nor the lifetime change count to choose TTLs. Change-count metadata remains available for diagnostics.

## State and backends

For AIMD and EWMA, learning state expires with `metaTTL`, so it can survive payload expiry. Clearing a key, invalidating its namespace, losing metadata, or changing policy configuration resets learning. Omitting a parameter and specifying its default explicitly are equivalent. Keep policy settings consistent across instances that write the same keys.

All three policies are supported by `redis`, `l1-redis`, and `clustered-lru`. In L1 Redis mode, Redis owns the policy state and authoritative TTL. Optimistic L1 writes retain a short initial lifetime until Redis reconciliation. An injected cache determines the policy used by an HTTP adapter.

Custom backends must declare `supportsTtlPolicies: true` and implement the normalized `ttlPolicy` received in update inputs. The cache rejects AIMD/EWMA on backends without that capability, instead of silently falling back. The default adaptive policy does not require that capability flag.

Policies do not change loader locks, write fencing, HTTP eligibility, eviction policy, or resource ownership. See [loading, freshness, and cache policy](cache-features.md) for those behaviors.
