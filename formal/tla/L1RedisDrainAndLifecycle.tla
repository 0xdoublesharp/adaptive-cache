----------------------- MODULE L1RedisDrainAndLifecycle -----------------------
(*
 * Formal TLA+ specification of L1RedisAdaptiveCacheBackend's subscriber
 * invalidation queue, single-retry flush(), two-phase clear() with concurrent
 * hydrations and Redis revision validation, and clear() independence from
 * unrelated local L1 subscriber drain failures.
 *
 * Models:
 *   - src/backends/L1RedisAdaptiveCacheBackend.ts
 *     (fetch hydration + Redis revision check, two-phase clear(), flush() retry,
 *      handleInvalidation, scheduleInvalidationDrain)
 *)

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    Keys,       \* Keys in the namespace (e.g. {k1, k2})
    NoKey,      \* Sentinel for no active explicit clear
    MaxGen      \* Bound on generation counter for finite state space

VARIABLES
    redisPresent,       \* [Keys -> BOOLEAN]: authoritative Redis presence
    l1Present,          \* [Keys -> BOOLEAN]: local L1 presence
    l1Valid,            \* [Keys -> BOOLEAN]: whether L1 revision still matches live Redis
    generation,         \* 0..MaxGen: state.generation
    hydrationPhase,     \* [Keys -> "idle" | "fetching" | "writing"]: hydration lifecycle
    hydrationGen,       \* [Keys -> 0..MaxGen]: captured generation before redis.fetch()
    pendingInv,         \* SUBSET Keys: pendingInvalidationKeys queue
    drainActive,        \* BOOLEAN: invalidationDrain currently running
    drainBatch,         \* SUBSET Keys: snapshot of keys currently being deleted by drain
    drainWaitHydrations,\* SUBSET Keys: snapshot [...this.state.hydrations] awaited by drain
    clearKey,           \* Keys \cup {NoKey}: active two-phase clear() target
    clearWaitHydrations,\* SUBSET Keys: snapshot [...this.state.hydrations] awaited by clear()
    invFailure,         \* BOOLEAN: invalidationFailure latched after failed drain
    flushState,         \* "idle" | "waiting_drain" | "retrying" | "done_ok" | "done_err"
    flushRetries,       \* 0..1: retries performed by current flush()
    staleServedFromL1   \* Ghost: TRUE iff an L1 read served a key after Redis deleted it

vars == <<
    redisPresent, l1Present, l1Valid, generation, hydrationPhase, hydrationGen,
    pendingInv, drainActive, drainBatch, drainWaitHydrations,
    clearKey, clearWaitHydrations, invFailure,
    flushState, flushRetries, staleServedFromL1
>>

FlushStates == {"idle", "waiting_drain", "retrying", "done_ok", "done_err"}
HydrationPhases == {"idle", "fetching", "writing"}

WritingHydrations == {k \in Keys : hydrationPhase[k] = "writing"}

Init ==
    /\ redisPresent = [k \in Keys |-> TRUE]
    /\ l1Present = [k \in Keys |-> TRUE]
    /\ l1Valid = [k \in Keys |-> TRUE]
    /\ generation = 0
    /\ hydrationPhase = [k \in Keys |-> "idle"]
    /\ hydrationGen = [k \in Keys |-> 0]
    /\ pendingInv = {}
    /\ drainActive = FALSE
    /\ drainBatch = {}
    /\ drainWaitHydrations = {}
    /\ clearKey = NoKey
    /\ clearWaitHydrations = {}
    /\ invFailure = FALSE
    /\ flushState = "idle"
    /\ flushRetries = 0
    /\ staleServedFromL1 = FALSE

-----------------------------------------------------------------------------
(* Actions *)

\* Fetch step 1: capture generation and read live entry from Redis
StartFetch(k) ==
    /\ hydrationPhase[k] = "idle"
    /\ redisPresent[k]
    /\ hydrationPhase' = [hydrationPhase EXCEPT ![k] = "fetching"]
    /\ hydrationGen' = [hydrationGen EXCEPT ![k] = generation]
    /\ UNCHANGED <<
        redisPresent, l1Present, l1Valid, generation, pendingInv,
        drainActive, drainBatch, drainWaitHydrations,
        clearKey, clearWaitHydrations, invFailure, flushState, flushRetries,
        staleServedFromL1
       >>

\* Fetch step 2: if generation unchanged, enqueue hydration into state.hydrations
StartHydrationWrite(k) ==
    /\ hydrationPhase[k] = "fetching"
    /\ IF hydrationGen[k] = generation THEN
           hydrationPhase' = [hydrationPhase EXCEPT ![k] = "writing"]
       ELSE
           \* Generation advanced before hydrateFromFetch started -> skip L1 write
           hydrationPhase' = [hydrationPhase EXCEPT ![k] = "idle"]
    /\ UNCHANGED <<
        redisPresent, l1Present, l1Valid, generation, hydrationGen, pendingInv,
        drainActive, drainBatch, drainWaitHydrations,
        clearKey, clearWaitHydrations, invFailure, flushState, flushRetries,
        staleServedFromL1
       >>

\* Fetch step 3: already-started hydration completes its write into L1 even if clear()
\* deleted Redis concurrently (models real L1RedisAdaptiveCacheBackend.ts lines 104-112).
FinishHydrationWrite(k) ==
    /\ hydrationPhase[k] = "writing"
    /\ hydrationPhase' = [hydrationPhase EXCEPT ![k] = "idle"]
    /\ l1Present' = [l1Present EXCEPT ![k] = TRUE]
    /\ l1Valid' = [l1Valid EXCEPT ![k] = redisPresent[k]]
    /\ drainWaitHydrations' = drainWaitHydrations \ {k}
    /\ clearWaitHydrations' = clearWaitHydrations \ {k}
    /\ UNCHANGED <<
        redisPresent, generation, hydrationGen, pendingInv,
        drainActive, drainBatch, clearKey, invFailure, flushState, flushRetries,
        staleServedFromL1
       >>

\* L1 read path: checks local L1 AND validates revision against live Redis before serving.
L1Read(k) ==
    /\ l1Present[k]
    /\ IF l1Valid[k] /\ redisPresent[k] THEN
           \* Valid L1 hit; record ghost violation if Redis was already cleared
           /\ staleServedFromL1' = (staleServedFromL1 \/ ~redisPresent[k])
           /\ UNCHANGED <<l1Present, l1Valid>>
       ELSE
           \* Revision validation fails -> delete stale L1 entry instead of serving it
           /\ l1Present' = [l1Present EXCEPT ![k] = FALSE]
           /\ l1Valid' = [l1Valid EXCEPT ![k] = FALSE]
           /\ UNCHANGED staleServedFromL1
    /\ UNCHANGED <<
        redisPresent, generation, hydrationPhase, hydrationGen, pendingInv,
        drainActive, drainBatch, drainWaitHydrations,
        clearKey, clearWaitHydrations, invFailure, flushState, flushRetries
       >>

\* Subscriber receives external invalidation message (models handleInvalidation)
ReceiveInvalidation(k) ==
    /\ generation < MaxGen
    /\ k \notin pendingInv
    /\ redisPresent' = [redisPresent EXCEPT ![k] = FALSE]
    /\ l1Valid' = [l1Valid EXCEPT ![k] = FALSE]
    /\ pendingInv' = pendingInv \cup {k}
    /\ generation' = generation + 1
    /\ IF ~drainActive THEN
           /\ drainActive' = TRUE
           /\ drainBatch' = pendingInv \cup {k}
           /\ drainWaitHydrations' = WritingHydrations
       ELSE
           /\ UNCHANGED <<drainActive, drainBatch, drainWaitHydrations>>
    /\ UNCHANGED <<
        l1Present, hydrationPhase, hydrationGen, clearKey, clearWaitHydrations,
        invFailure, flushState, flushRetries, staleServedFromL1
       >>

\* Drain completes current batch successfully (after awaited hydration snapshot settles)
DrainSucceed ==
    /\ drainActive
    /\ drainWaitHydrations = {}
    /\ l1Present' = [k \in Keys |-> IF k \in drainBatch THEN FALSE ELSE l1Present[k]]
    /\ l1Valid' = [k \in Keys |-> IF k \in drainBatch THEN FALSE ELSE l1Valid[k]]
    /\ LET remaining == pendingInv \ drainBatch IN
       /\ pendingInv' = remaining
       /\ invFailure' = FALSE
       /\ IF remaining # {} THEN
              /\ drainActive' = TRUE
              /\ drainBatch' = remaining
              /\ drainWaitHydrations' = WritingHydrations
          ELSE
              /\ drainActive' = FALSE
              /\ drainBatch' = {}
              /\ drainWaitHydrations' = {}
    /\ UNCHANGED <<
        redisPresent, generation, hydrationPhase, hydrationGen,
        clearKey, clearWaitHydrations, flushState, flushRetries, staleServedFromL1
       >>

\* Drain fails: keeps keys in pendingInv so retry can still delete them, sets invFailure
DrainFail ==
    /\ drainActive
    /\ drainWaitHydrations = {}
    /\ drainActive' = FALSE
    /\ drainBatch' = {}
    /\ drainWaitHydrations' = {}
    /\ invFailure' = TRUE
    /\ UNCHANGED <<
        redisPresent, l1Present, l1Valid, generation, hydrationPhase, hydrationGen,
        pendingInv, clearKey, clearWaitHydrations, flushState, flushRetries, staleServedFromL1
       >>

\* Explicit clear(k) phase 1: runs regardless of invFailure (uses drainPendingUpdates(),
\* not flush()), clears Redis first, advances generation, snapshots [...this.state.hydrations].
BeginClearRedis(k) ==
    /\ clearKey = NoKey
    /\ generation < MaxGen
    /\ redisPresent[k]
    /\ redisPresent' = [redisPresent EXCEPT ![k] = FALSE]
    /\ l1Valid' = [l1Valid EXCEPT ![k] = FALSE]
    /\ generation' = generation + 1
    /\ clearKey' = k
    /\ clearWaitHydrations' = WritingHydrations
    /\ UNCHANGED <<
        l1Present, hydrationPhase, hydrationGen, pendingInv,
        drainActive, drainBatch, drainWaitHydrations,
        invFailure, flushState, flushRetries, staleServedFromL1
       >>

\* Explicit clear(k) phase 2: once snapshotted hydrations finish, evict k from L1.
FinishClearL1 ==
    /\ clearKey # NoKey
    /\ clearWaitHydrations = {}
    /\ l1Present' = [l1Present EXCEPT ![clearKey] = FALSE]
    /\ l1Valid' = [l1Valid EXCEPT ![clearKey] = FALSE]
    /\ clearKey' = NoKey
    /\ UNCHANGED <<
        redisPresent, generation, hydrationPhase, hydrationGen, pendingInv,
        drainActive, drainBatch, drainWaitHydrations, clearWaitHydrations,
        invFailure, flushState, flushRetries, staleServedFromL1
       >>

\* Start flush(): enters waiting_drain
StartFlush ==
    /\ flushState = "idle"
    /\ flushState' = "waiting_drain"
    /\ flushRetries' = 0
    /\ UNCHANGED <<
        redisPresent, l1Present, l1Valid, generation, hydrationPhase, hydrationGen,
        pendingInv, drainActive, drainBatch, drainWaitHydrations,
        clearKey, clearWaitHydrations, invFailure, staleServedFromL1
       >>

\* Step flush() when drain is idle: succeed, retry ONCE if failed with pending keys, or fail
StepFlush ==
    /\ flushState \in {"waiting_drain", "retrying"}
    /\ ~drainActive
    /\ IF ~invFailure THEN
           /\ flushState' = "done_ok"
           /\ UNCHANGED <<drainActive, drainBatch, drainWaitHydrations, invFailure, flushRetries>>
       ELSE IF flushRetries = 0 /\ pendingInv # {} THEN
           \* Single bounded retry
           /\ flushState' = "retrying"
           /\ flushRetries' = 1
           /\ invFailure' = FALSE
           /\ drainActive' = TRUE
           /\ drainBatch' = pendingInv
           /\ drainWaitHydrations' = WritingHydrations
       ELSE
           \* Second failure or no pending keys: reject flush()
           /\ flushState' = "done_err"
           /\ UNCHANGED <<drainActive, drainBatch, drainWaitHydrations, invFailure, flushRetries>>
    /\ UNCHANGED <<
        redisPresent, l1Present, l1Valid, generation, hydrationPhase, hydrationGen,
        pendingInv, clearKey, clearWaitHydrations, staleServedFromL1
       >>

-----------------------------------------------------------------------------
(* Next-state relation & Fair Spec *)

Next ==
    \/ \E k \in Keys : StartFetch(k)
    \/ \E k \in Keys : StartHydrationWrite(k)
    \/ \E k \in Keys : FinishHydrationWrite(k)
    \/ \E k \in Keys : L1Read(k)
    \/ \E k \in Keys : ReceiveInvalidation(k)
    \/ DrainSucceed
    \/ DrainFail
    \/ \E k \in Keys : BeginClearRedis(k)
    \/ FinishClearL1
    \/ StartFlush
    \/ StepFlush

Fairness ==
    /\ \A k \in Keys : WF_vars(StartHydrationWrite(k))
    /\ \A k \in Keys : WF_vars(FinishHydrationWrite(k))
    /\ WF_vars(DrainSucceed \/ DrainFail)
    /\ WF_vars(FinishClearL1)
    /\ WF_vars(StepFlush)

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety Invariants *)

TypeOK ==
    /\ redisPresent \in [Keys -> BOOLEAN]
    /\ l1Present \in [Keys -> BOOLEAN]
    /\ l1Valid \in [Keys -> BOOLEAN]
    /\ generation \in 0..MaxGen
    /\ hydrationPhase \in [Keys -> HydrationPhases]
    /\ hydrationGen \in [Keys -> 0..MaxGen]
    /\ pendingInv \subseteq Keys
    /\ drainActive \in BOOLEAN
    /\ drainBatch \subseteq Keys
    /\ drainWaitHydrations \subseteq Keys
    /\ clearKey \in Keys \cup {NoKey}
    /\ clearWaitHydrations \subseteq Keys
    /\ invFailure \in BOOLEAN
    /\ flushState \in FlushStates
    /\ flushRetries \in 0..1
    /\ staleServedFromL1 \in BOOLEAN

\* 1. Even if an in-flight hydration finishes between Redis clear and L1 delete,
\*    L1 read revision validation never serves a cleared key.
NoStaleServeAfterRedisClear ==
    /\ ~staleServedFromL1
    /\ \A k \in Keys : l1Valid[k] => redisPresent[k]

\* 2. Once clear() finishes and no hydration/drain is running on a cleared key,
\*    no new hydration can resurrect it.
ClearedKeyNotResurrectedAfterQuiescence ==
    \A k \in Keys :
        (~redisPresent[k] /\ clearKey # k /\ hydrationPhase[k] = "idle" /\ k \notin pendingInv /\ l1Present[k])
            => ~l1Valid[k]

\* 3. flush() performs at most one retry per call.
FlushRetryBounded ==
    flushRetries <= 1

\* 4. Every batch currently being drained is a subset of pendingInv (failed keys are retained).
DrainBatchSubsetPending ==
    drainActive => (drainBatch \subseteq pendingInv)

-----------------------------------------------------------------------------
(* Liveness Properties *)

\* Every active flush() eventually terminates cleanly (either done_ok or done_err).
FlushAlwaysTerminates ==
    (flushState \in {"waiting_drain", "retrying"}) ~> (flushState \in {"done_ok", "done_err"})

\* Every started drain eventually completes or fails (never stuck behind hydrations).
DrainEventuallySettles ==
    drainActive ~> ~drainActive

\* Every explicit clear() completes both Redis deletion and L1 eviction, even when invFailure = TRUE.
ClearAlwaysCompletes ==
    (clearKey # NoKey) ~> (clearKey = NoKey)

=============================================================================
