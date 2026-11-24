------------------------- MODULE CacheLoaderCoordination -------------------------
(*
 * Formal TLA+ specification of @0xdoublesharp/adaptive-cache's coalesced
 * CacheLoader, distributed refresh-lock leasing, atomic lock release,
 * caller deadlines/cancellation, SWR/negative retention, and bounded close().
 *
 * Models:
 *   - src/CacheLoader.ts
 *   - src/AdaptiveCache.ts (close / shutdown draining)
 *   - src/redis-lua/shouldRefreshCache.lua
 *   - src/redis-lua/adaptiveCacheUpdate.lua (atomic lease-fenced Redis writes)
 *   - src/redis-lua/releaseCacheRefreshLock.lua
 *   - src/backends/clusteredLruLocks.ts (atomic primary-side lock release;
 *     atomic cross-worker lease-fenced writes are scoped to Redis-backed modes)
 *)

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    Instances,  \* Cache instances / processes (e.g. {"i1", "i2"})
    Callers,    \* Callers across instances (e.g. {"c1", "c2", "c3"})
    MaxLease,   \* Maximum number of leases issued
    MaxTime     \* Maximum discrete clock time

VARIABLES
    now,                    \* Shared clock (0..MaxTime)
    nextLease,              \* Monotonic lease token allocator (1..MaxLease+1)
    lockOwner,              \* Current distributed lock value (0 = unlocked)
    lockExpiry,             \* Expiry timestamp of current lock
    lastUpdate,             \* Recorded refresh timestamp (public shouldRefresh helper)
    cacheVal,               \* Stored cache entry version (0 = empty)
    cacheFreshUntil,        \* Freshness deadline
    cacheExpiresAt,         \* Physical retention deadline (fresh + staleTTL)
    cacheNegative,          \* TRUE if stored entry is a negative entry
    closing,                \* [Instances -> BOOLEAN]: close() started
    sharedActive,           \* [Instances -> BOOLEAN]: in-flight SharedLoad exists
    sharedAborted,          \* [Instances -> BOOLEAN]: shared AbortController.signal.aborted
    sharedUsers,            \* [Instances -> SUBSET Callers]: joined callers
    sharedLease,            \* [Instances -> 0..MaxLease]: acquired lease token
    sharedIsBg,             \* [Instances -> BOOLEAN]: started as SWR background refresh
    abortedLeases,          \* SUBSET Leases: leases still held by replaced aborted loaders awaiting finally cleanup
    callerState,            \* [Callers -> CallerStates]
    callerInst,             \* [Callers -> Instances]
    callerAllowsSwr,        \* [Callers -> BOOLEAN]
    highestCommittedLease,  \* Ghost: highest lease that wrote to cache
    successorOverwritten,   \* Ghost: TRUE iff expired lease overwrote a successor's write
    successorLockDeleted    \* Ghost: TRUE iff old owner deleted a successor's live lock

vars == <<
    now, nextLease, lockOwner, lockExpiry, lastUpdate,
    cacheVal, cacheFreshUntil, cacheExpiresAt, cacheNegative,
    closing, sharedActive, sharedAborted, sharedUsers, sharedLease, sharedIsBg, abortedLeases,
    callerState, callerInst, callerAllowsSwr,
    highestCommittedLease, successorOverwritten, successorLockDeleted
>>

Leases == 0..MaxLease
Times == 0..MaxTime
Deadlines == 0..(MaxTime + 3)

CallerStates == {
    "idle",
    "waiting",
    "retrying",
    "done_fresh",
    "done_stale_swr",
    "done_aborted",
    "done_closed"
}

LockIsLive(lease) ==
    lease # 0 /\ lockOwner = lease /\ now < lockExpiry

CacheIsFresh ==
    cacheVal # 0 /\ now < cacheFreshUntil

CacheIsStale ==
    cacheVal # 0 /\ now >= cacheFreshUntil /\ now < cacheExpiresAt

-----------------------------------------------------------------------------
(* Initial state *)

Init ==
    /\ now = 0
    /\ nextLease = 1
    /\ lockOwner = 0
    /\ lockExpiry = 0
    /\ lastUpdate = 0
    /\ cacheVal = 0
    /\ cacheFreshUntil = 0
    /\ cacheExpiresAt = 0
    /\ cacheNegative = FALSE
    /\ closing = [i \in Instances |-> FALSE]
    /\ sharedActive = [i \in Instances |-> FALSE]
    /\ sharedAborted = [i \in Instances |-> FALSE]
    /\ sharedUsers = [i \in Instances |-> {}]
    /\ sharedLease = [i \in Instances |-> 0]
    /\ sharedIsBg = [i \in Instances |-> FALSE]
    /\ abortedLeases = {}
    /\ callerState = [c \in Callers |-> "idle"]
    /\ callerInst = [c \in Callers |-> CHOOSE i \in Instances : TRUE]
    /\ callerAllowsSwr = [c \in Callers |-> FALSE]
    /\ highestCommittedLease = 0
    /\ successorOverwritten = FALSE
    /\ successorLockDeleted = FALSE

-----------------------------------------------------------------------------
(* Actions *)

\* Advance clock; expired locks automatically become absent
Tick ==
    /\ now < MaxTime
    /\ LET nextNow == now + 1 IN
       /\ now' = nextNow
       /\ IF lockOwner # 0 /\ nextNow >= lockExpiry THEN
              /\ lockOwner' = 0
              /\ lockExpiry' = 0
          ELSE
              /\ UNCHANGED <<lockOwner, lockExpiry>>
    /\ UNCHANGED <<
        nextLease, lastUpdate, cacheVal, cacheFreshUntil, cacheExpiresAt, cacheNegative,
        closing, sharedActive, sharedAborted, sharedUsers, sharedLease, sharedIsBg, abortedLeases,
        callerState, callerInst, callerAllowsSwr,
        highestCommittedLease, successorOverwritten, successorLockDeleted
       >>

\* Caller hits closed instance -> rejected immediately (AdaptiveCache.assertOpen)
CallerRejectedClosed(c, i) ==
    /\ (callerState[c] = "idle" \/ (callerState[c] = "retrying" /\ callerInst[c] = i))
    /\ closing[i]
    /\ callerState' = [callerState EXCEPT ![c] = "done_closed"]
    /\ callerInst' = [callerInst EXCEPT ![c] = i]
    /\ UNCHANGED <<
        now, nextLease, lockOwner, lockExpiry, lastUpdate,
        cacheVal, cacheFreshUntil, cacheExpiresAt, cacheNegative,
        closing, sharedActive, sharedAborted, sharedUsers, sharedLease, sharedIsBg, abortedLeases,
        callerAllowsSwr, highestCommittedLease, successorOverwritten, successorLockDeleted
       >>

\* Caller observes a fresh hit and returns immediately
CallerFreshHit(c, i) ==
    /\ (callerState[c] = "idle" \/ (callerState[c] = "retrying" /\ callerInst[c] = i))
    /\ ~closing[i]
    /\ CacheIsFresh
    /\ callerState' = [callerState EXCEPT ![c] = "done_fresh"]
    /\ callerInst' = [callerInst EXCEPT ![c] = i]
    /\ UNCHANGED <<
        now, nextLease, lockOwner, lockExpiry, lastUpdate,
        cacheVal, cacheFreshUntil, cacheExpiresAt, cacheNegative,
        closing, sharedActive, sharedAborted, sharedUsers, sharedLease, sharedIsBg, abortedLeases,
        callerAllowsSwr, highestCommittedLease, successorOverwritten, successorLockDeleted
       >>

\* Caller starts or joins a foreground shared load (CacheLoader.getOrSet)
CallerJoinForeground(c, i) ==
    /\ (callerState[c] = "idle" \/ (callerState[c] = "retrying" /\ callerInst[c] = i))
    /\ ~closing[i]
    /\ ~CacheIsFresh
    /\ callerState' = [callerState EXCEPT ![c] = "waiting"]
    /\ callerInst' = [callerInst EXCEPT ![c] = i]
    /\ callerAllowsSwr' = [callerAllowsSwr EXCEPT ![c] = FALSE]
    /\ IF ~sharedActive[i] \/ sharedAborted[i] THEN
           /\ sharedActive' = [sharedActive EXCEPT ![i] = TRUE]
           /\ sharedAborted' = [sharedAborted EXCEPT ![i] = FALSE]
           /\ sharedUsers' = [sharedUsers EXCEPT ![i] = {c}]
           /\ sharedLease' = [sharedLease EXCEPT ![i] = 0]
           /\ sharedIsBg' = [sharedIsBg EXCEPT ![i] = FALSE]
           /\ abortedLeases' =
                IF sharedActive[i] /\ sharedAborted[i] /\ sharedLease[i] # 0
                THEN abortedLeases \cup {sharedLease[i]}
                ELSE abortedLeases
       ELSE
           /\ sharedUsers' = [sharedUsers EXCEPT ![i] = sharedUsers[i] \cup {c}]
           /\ UNCHANGED <<sharedActive, sharedAborted, sharedLease, sharedIsBg, abortedLeases>>
    /\ UNCHANGED <<
        now, nextLease, lockOwner, lockExpiry, lastUpdate,
        cacheVal, cacheFreshUntil, cacheExpiresAt, cacheNegative,
        closing, highestCommittedLease, successorOverwritten, successorLockDeleted
       >>

\* Caller eligible for SWR gets stale data immediately and spawns/joins background refresh
CallerSwrStaleHit(c, i) ==
    /\ callerState[c] = "idle"
    /\ ~closing[i]
    /\ CacheIsStale
    /\ ~cacheNegative
    /\ callerState' = [callerState EXCEPT ![c] = "done_stale_swr"]
    /\ callerInst' = [callerInst EXCEPT ![c] = i]
    /\ callerAllowsSwr' = [callerAllowsSwr EXCEPT ![c] = TRUE]
    /\ IF ~sharedActive[i] \/ sharedAborted[i] THEN
           /\ sharedActive' = [sharedActive EXCEPT ![i] = TRUE]
           /\ sharedAborted' = [sharedAborted EXCEPT ![i] = FALSE]
           /\ sharedUsers' = [sharedUsers EXCEPT ![i] = {c}]
           /\ sharedLease' = [sharedLease EXCEPT ![i] = 0]
           /\ sharedIsBg' = [sharedIsBg EXCEPT ![i] = TRUE]
           /\ abortedLeases' =
                IF sharedActive[i] /\ sharedAborted[i] /\ sharedLease[i] # 0
                THEN abortedLeases \cup {sharedLease[i]}
                ELSE abortedLeases
       ELSE
           /\ sharedUsers' = [sharedUsers EXCEPT ![i] = sharedUsers[i] \cup {c}]
           /\ UNCHANGED <<sharedActive, sharedAborted, sharedLease, sharedIsBg, abortedLeases>>
    /\ UNCHANGED <<
        now, nextLease, lockOwner, lockExpiry, lastUpdate,
        cacheVal, cacheFreshUntil, cacheExpiresAt, cacheNegative,
        closing, highestCommittedLease, successorOverwritten, successorLockDeleted
       >>

\* Active caller times out or cancels via AbortSignal; shared load aborts ONLY when last user leaves
CallerLeaveOrTimeout(c) ==
    /\ callerState[c] \in {"waiting", "done_stale_swr"}
    /\ LET i == callerInst[c] IN
       /\ sharedActive[i]
       /\ c \in sharedUsers[i]
       /\ LET remaining == sharedUsers[i] \ {c} IN
          /\ sharedUsers' = [sharedUsers EXCEPT ![i] = remaining]
          /\ IF remaining = {} THEN
                 sharedAborted' = [sharedAborted EXCEPT ![i] = TRUE]
             ELSE
                 UNCHANGED sharedAborted
          /\ IF callerState[c] = "waiting" THEN
                 callerState' = [callerState EXCEPT ![c] = "done_aborted"]
             ELSE
                 UNCHANGED callerState
    /\ UNCHANGED <<
        now, nextLease, lockOwner, lockExpiry, lastUpdate,
        cacheVal, cacheFreshUntil, cacheExpiresAt, cacheNegative,
        closing, sharedActive, sharedLease, sharedIsBg, abortedLeases,
        callerInst, callerAllowsSwr,
        highestCommittedLease, successorOverwritten, successorLockDeleted
       >>

\* Instance acquires distributed refresh lock (models shouldRefreshCache.lua)
AcquireLock(i) ==
    /\ sharedActive[i]
    /\ ~sharedAborted[i]
    /\ sharedLease[i] = 0
    /\ lockOwner = 0
    /\ nextLease <= MaxLease
    /\ LET lease == nextLease IN
       /\ lockOwner' = lease
       /\ lockExpiry' = now + 1
       /\ nextLease' = nextLease + 1
       /\ sharedLease' = [sharedLease EXCEPT ![i] = lease]
    /\ UNCHANGED <<
        now, lastUpdate, cacheVal, cacheFreshUntil, cacheExpiresAt, cacheNegative,
        closing, sharedActive, sharedAborted, sharedUsers, sharedIsBg, abortedLeases,
        callerState, callerInst, callerAllowsSwr,
        highestCommittedLease, successorOverwritten, successorLockDeleted
       >>

\* Contended background SWR load backs off (returns backgroundFallback);
\* foreground waiters MUST NOT accept backgroundFallback and instead retry.
ContendedBgBackoff(i) ==
    /\ sharedActive[i]
    /\ ~sharedAborted[i]
    /\ sharedLease[i] = 0
    /\ sharedIsBg[i]
    /\ lockOwner # 0
    /\ sharedActive' = [sharedActive EXCEPT ![i] = FALSE]
    /\ sharedAborted' = [sharedAborted EXCEPT ![i] = FALSE]
    /\ sharedUsers' = [sharedUsers EXCEPT ![i] = {}]
    /\ sharedIsBg' = [sharedIsBg EXCEPT ![i] = FALSE]
    \* Any foreground waiters (waiting) re-enter as retrying, never done_stale_swr
    /\ callerState' = [c \in Callers |->
            IF c \in sharedUsers[i] /\ callerState[c] = "waiting"
            THEN "retrying"
            ELSE callerState[c]]
    /\ UNCHANGED <<
        now, nextLease, lockOwner, lockExpiry, lastUpdate,
        cacheVal, cacheFreshUntil, cacheExpiresAt, cacheNegative,
        closing, sharedLease, abortedLeases, callerInst, callerAllowsSwr,
        highestCommittedLease, successorOverwritten, successorLockDeleted
       >>

\* Lease-fenced write commit (models CacheLoader.ts + adaptiveCacheUpdate.lua lock check)
\* Negative entries ALWAYS set staleTTL = 0 (cacheExpiresAt = cacheFreshUntil).
CommitLoaderWrite(i, isNegative) ==
    /\ sharedActive[i]
    /\ ~sharedAborted[i]
    /\ sharedLease[i] # 0
    /\ LET lease == sharedLease[i]
           leaseStillValid == LockIsLive(lease)
           staleWindow == IF isNegative THEN 0 ELSE 1
       IN
       /\ IF leaseStillValid THEN
              /\ cacheVal' = lease
              /\ cacheFreshUntil' = now + 1
              /\ cacheExpiresAt' = now + 1 + staleWindow
              /\ cacheNegative' = isNegative
              /\ highestCommittedLease' =
                    IF lease > highestCommittedLease THEN lease ELSE highestCommittedLease
              /\ successorOverwritten' =
                    (successorOverwritten \/ lease < highestCommittedLease)
          ELSE
              \* Expired lease write is rejected atomically by Redis/LRU
              /\ UNCHANGED <<
                    cacheVal, cacheFreshUntil, cacheExpiresAt, cacheNegative,
                    highestCommittedLease, successorOverwritten
                 >>
       \* Atomic lock release: only deletes if lockOwner still matches lease
       /\ IF LockIsLive(lease) THEN
              /\ lockOwner' = 0
              /\ lockExpiry' = 0
              /\ UNCHANGED successorLockDeleted
          ELSE
              /\ UNCHANGED <<lockOwner, lockExpiry>>
              /\ successorLockDeleted' = successorLockDeleted
       /\ sharedActive' = [sharedActive EXCEPT ![i] = FALSE]
       /\ sharedAborted' = [sharedAborted EXCEPT ![i] = FALSE]
       /\ sharedUsers' = [sharedUsers EXCEPT ![i] = {}]
       /\ sharedLease' = [sharedLease EXCEPT ![i] = 0]
       /\ sharedIsBg' = [sharedIsBg EXCEPT ![i] = FALSE]
       /\ callerState' = [c \in Callers |->
            IF c \in sharedUsers[i] /\ callerState[c] = "waiting"
            THEN "done_fresh"
            ELSE callerState[c]]
       /\ UNCHANGED <<
            now, nextLease, lastUpdate, closing, abortedLeases, callerInst, callerAllowsSwr
          >>

\* Aborted loader cleans up its lease atomically (models finally block + releaseCacheRefreshLock.lua)
CleanupAbortedLoader(i) ==
    /\ sharedActive[i]
    /\ sharedAborted[i]
    /\ LET lease == sharedLease[i] IN
       /\ IF lease # 0 /\ LockIsLive(lease) THEN
              /\ lockOwner' = 0
              /\ lockExpiry' = 0
              /\ UNCHANGED successorLockDeleted
          ELSE
              \* Compare-and-delete fails (LOCK_MISMATCH); successor's lock is preserved!
              /\ UNCHANGED <<lockOwner, lockExpiry, successorLockDeleted>>
       /\ sharedActive' = [sharedActive EXCEPT ![i] = FALSE]
       /\ sharedAborted' = [sharedAborted EXCEPT ![i] = FALSE]
       /\ sharedUsers' = [sharedUsers EXCEPT ![i] = {}]
       /\ sharedLease' = [sharedLease EXCEPT ![i] = 0]
       /\ sharedIsBg' = [sharedIsBg EXCEPT ![i] = FALSE]
       /\ callerState' = [c \in Callers |->
            IF c \in sharedUsers[i] /\ callerState[c] = "waiting"
            THEN "done_aborted"
            ELSE callerState[c]]
       /\ UNCHANGED <<
            now, nextLease, lastUpdate,
            cacheVal, cacheFreshUntil, cacheExpiresAt, cacheNegative,
            closing, abortedLeases, callerInst, callerAllowsSwr,
            highestCommittedLease, successorOverwritten
          >>

\* Replaced aborted loader runs its own finally-block atomic compare-and-delete release
ReleaseAbortedLease(l) ==
    /\ l \in abortedLeases
    /\ abortedLeases' = abortedLeases \ {l}
    /\ IF LockIsLive(l) THEN
           /\ lockOwner' = 0
           /\ lockExpiry' = 0
           /\ UNCHANGED successorLockDeleted
       ELSE
           \* Compare-and-delete fails (LOCK_MISMATCH); successor's lock is preserved!
           /\ UNCHANGED <<lockOwner, lockExpiry, successorLockDeleted>>
    /\ UNCHANGED <<
        now, nextLease, lastUpdate,
        cacheVal, cacheFreshUntil, cacheExpiresAt, cacheNegative,
        closing, sharedActive, sharedAborted, sharedUsers, sharedLease, sharedIsBg,
        callerState, callerInst, callerAllowsSwr,
        highestCommittedLease, successorOverwritten
       >>

\* Begin close() on instance i (rejects new operations; timeout aborts active shared load)
BeginClose(i) ==
    /\ ~closing[i]
    /\ closing' = [closing EXCEPT ![i] = TRUE]
    /\ UNCHANGED <<
        now, nextLease, lockOwner, lockExpiry, lastUpdate,
        cacheVal, cacheFreshUntil, cacheExpiresAt, cacheNegative,
        sharedActive, sharedAborted, sharedUsers, sharedLease, sharedIsBg, abortedLeases,
        callerState, callerInst, callerAllowsSwr,
        highestCommittedLease, successorOverwritten, successorLockDeleted
       >>

\* Close timeout expires: aborts any active shared load on closing instance i
CloseTimeoutAbort(i) ==
    /\ closing[i]
    /\ sharedActive[i]
    /\ ~sharedAborted[i]
    /\ sharedAborted' = [sharedAborted EXCEPT ![i] = TRUE]
    /\ UNCHANGED <<
        now, nextLease, lockOwner, lockExpiry, lastUpdate,
        cacheVal, cacheFreshUntil, cacheExpiresAt, cacheNegative,
        closing, sharedActive, sharedUsers, sharedLease, sharedIsBg, abortedLeases,
        callerState, callerInst, callerAllowsSwr,
        highestCommittedLease, successorOverwritten, successorLockDeleted
       >>

-----------------------------------------------------------------------------
(* Next-state relation *)

Next ==
    \/ Tick
    \/ \E c \in Callers, i \in Instances : CallerRejectedClosed(c, i)
    \/ \E c \in Callers, i \in Instances : CallerFreshHit(c, i)
    \/ \E c \in Callers, i \in Instances : CallerJoinForeground(c, i)
    \/ \E c \in Callers, i \in Instances : CallerSwrStaleHit(c, i)
    \/ \E c \in Callers : CallerLeaveOrTimeout(c)
    \/ \E i \in Instances : AcquireLock(i)
    \/ \E i \in Instances : ContendedBgBackoff(i)
    \/ \E i \in Instances, neg \in BOOLEAN : CommitLoaderWrite(i, neg)
    \/ \E i \in Instances : CleanupAbortedLoader(i)
    \/ \E l \in 1..MaxLease : ReleaseAbortedLease(l)
    \/ \E i \in Instances : BeginClose(i)
    \/ \E i \in Instances : CloseTimeoutAbort(i)

CallerRetry(c) ==
    /\ callerState[c] = "retrying"
    /\ LET i == callerInst[c] IN
       \/ CallerRejectedClosed(c, i)
       \/ CallerFreshHit(c, i)
       \/ CallerJoinForeground(c, i)

Fairness ==
    /\ WF_vars(Tick)
    /\ \A i \in Instances : WF_vars(AcquireLock(i))
    /\ \A i \in Instances : WF_vars(ContendedBgBackoff(i))
    /\ \A i \in Instances : WF_vars(CommitLoaderWrite(i, FALSE) \/ CommitLoaderWrite(i, TRUE))
    /\ \A i \in Instances : WF_vars(CleanupAbortedLoader(i))
    /\ \A l \in 1..MaxLease : WF_vars(ReleaseAbortedLease(l))
    /\ \A i \in Instances : WF_vars(CloseTimeoutAbort(i))
    /\ \A c \in Callers : WF_vars(CallerLeaveOrTimeout(c))
    /\ \A c \in Callers : WF_vars(CallerRetry(c))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety Invariants *)

TypeOK ==
    /\ now \in Times
    /\ nextLease \in 1..(MaxLease + 1)
    /\ lockOwner \in Leases
    /\ lockExpiry \in Deadlines
    /\ lastUpdate \in Times
    /\ cacheVal \in Leases
    /\ cacheFreshUntil \in Deadlines
    /\ cacheExpiresAt \in Deadlines
    /\ cacheNegative \in BOOLEAN
    /\ closing \in [Instances -> BOOLEAN]
    /\ sharedActive \in [Instances -> BOOLEAN]
    /\ sharedAborted \in [Instances -> BOOLEAN]
    /\ sharedUsers \in [Instances -> SUBSET Callers]
    /\ sharedLease \in [Instances -> Leases]
    /\ sharedIsBg \in [Instances -> BOOLEAN]
    /\ abortedLeases \subseteq Leases
    /\ callerState \in [Callers -> CallerStates]
    /\ callerInst \in [Callers -> Instances]
    /\ callerAllowsSwr \in [Callers -> BOOLEAN]
    /\ highestCommittedLease \in Leases
    /\ successorOverwritten \in BOOLEAN
    /\ successorLockDeleted \in BOOLEAN

\* 1. At most one instance holds a live lease at any point in time.
MutualLiveLockOwnership ==
    \A i1, i2 \in Instances :
        (LockIsLive(sharedLease[i1]) /\ LockIsLive(sharedLease[i2])) => i1 = i2

\* 2. An expired loader lease can never overwrite a successor's committed cache value.
ExpiredLeaseCannotOverwriteSuccessor ==
    /\ ~successorOverwritten
    /\ (cacheVal # 0 => cacheVal = highestCommittedLease)

\* 3. Atomic compare-and-delete release never removes a successor's live lock.
AtomicReleaseProtectsSuccessor ==
    ~successorLockDeleted

\* 4. While at least one caller remains on an open instance, shared work stays un-aborted.
CallerCancellationPreservesActiveWaiters ==
    \A i \in Instances :
        (sharedActive[i] /\ sharedUsers[i] # {} /\ ~closing[i]) => ~sharedAborted[i]

\* 5. Once the last caller leaves an active shared load, the shared signal is aborted.
LastCallerLeavesAbortsLoader ==
    \A i \in Instances :
        (sharedActive[i] /\ sharedUsers[i] = {}) => sharedAborted[i]

\* 6. Negative cache entries never have a stale retention window.
NegativeEntryNeverHasStaleWindow ==
    (cacheVal # 0 /\ cacheNegative) => (cacheExpiresAt = cacheFreshUntil)

\* 7. A foreground caller never receives a background SWR fallback.
NoForegroundBackgroundFallback ==
    \A c \in Callers :
        (~callerAllowsSwr[c]) => (callerState[c] # "done_stale_swr")

-----------------------------------------------------------------------------
(* Liveness Properties *)

\* Every waiting or retrying caller eventually completes with fresh data, aborts, or sees close().
EveryWaitingCallerEventuallyResolves ==
    \A c \in Callers :
        (callerState[c] \in {"waiting", "retrying"})
            ~> (callerState[c] \in {"done_fresh", "done_aborted", "done_closed"})

\* Every closing instance eventually drains its active shared loader.
ClosedInstanceEventuallyDrains ==
    \A i \in Instances :
        (closing[i] /\ sharedActive[i]) ~> (~sharedActive[i])

\* Every acquired distributed lock is eventually released or expires.
LockEventuallyReleased ==
    (lockOwner # 0) ~> (lockOwner = 0)

=============================================================================
