--------------------------- MODULE AdaptiveCacheFencing ---------------------------
(*
 * Formal TLA+ specification of @0xdoublesharp/adaptive-cache's write fencing,
 * tag & namespace invalidation, asynchronous detached tag cleanup, Redis
 * control-key eviction, and multi-tier L1+Redis revision coherence without
 * relying on Pub/Sub delivery.
 *
 * Models:
 *   - src/redis-lua/adaptiveCacheUpdate.lua
 *   - src/redis-lua/adaptiveCacheFetch.lua
 *   - src/redis-lua/adaptiveCacheValidate.lua
 *   - src/redis-lua/adaptiveCacheInvalidate.lua
 *   - src/redis-lua/adaptiveCacheCleanup.lua
 *   - src/backends/RedisAdaptiveCacheBackend.ts
 *   - src/backends/L1RedisAdaptiveCacheBackend.ts
 *)

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    Keys,       \* Cache keys (e.g. {k1, k2})
    Tags,       \* Cache tags (e.g. {t1, t2})
    Writers,    \* Concurrent writers (e.g. {w1, w2})
    Nodes,      \* Independent L1+Redis nodes (e.g. {n1})
    NoVal,      \* Model value sentinel for empty fields
    MaxId,      \* Upper bound on monotonic version/barrier/epoch/revision IDs
    MaxTime     \* Upper bound on discrete Redis clock

VARIABLES
    now,                \* Authoritative Redis clock (0..MaxTime)
    nextId,             \* Monotonic ID allocator (1..MaxId+1)
    legacyBarrier,      \* __adaptive:legacy-barrier (0 = absent/evicted)
    prefixBarrier,      \* <prefix>__adaptive:barrier (0 = absent/evicted)
    namespaceGen,       \* <prefix>__adaptive:namespace (0 = absent/evicted)
    tagEpoch,           \* [Tags -> 0..MaxId]: <prefix>__adaptive:tag-epoch:<tag>
    tagIndex,           \* [Tags -> SUBSET Keys]: live sorted-set tag index
    detached,           \* SUBSET [tag: Tags, keys: SUBSET Keys]: detached snapshots
    redisData,          \* [Keys -> RedisEnvelope]
    redisRev,           \* [Keys -> 0..MaxId]: <dataKey>:revision
    writer,             \* [Writers -> WriterState]
    l1,                 \* [Nodes -> [Keys -> L1Envelope]]
    invalidationId,     \* Ghost: latest invalidation ID affecting each key
    cleanupKilledFresh  \* Ghost: TRUE iff cleanup ever deleted a post-invalidation rewrite

vars == <<
    now, nextId, legacyBarrier, prefixBarrier, namespaceGen,
    tagEpoch, tagIndex, detached, redisData, redisRev,
    writer, l1, invalidationId, cleanupKilledFresh
>>

Ids == 0..MaxId
Times == 0..MaxTime
FreshTimes == 0..(MaxTime + 1)
EmptyEpochs == [t \in Tags |-> 0]

Symmetry == Permutations(Keys) \cup Permutations(Tags) \cup Permutations(Writers)

EmptyRedisEntry == [
    present    |-> FALSE,
    val        |-> NoVal,
    rev        |-> 0,
    ns         |-> 0,
    tags       |-> {},
    epochs     |-> EmptyEpochs,
    freshUntil |-> 0,
    capId      |-> 0
]

EmptyL1Entry == [
    present    |-> FALSE,
    val        |-> NoVal,
    rev        |-> 0,
    tokLegacy  |-> 0,
    tokPrefix  |-> 0,
    tokNs      |-> 0,
    freshUntil |-> 0
]

RedisEnvelope == [
    present    : BOOLEAN,
    val        : Writers \cup {NoVal},
    rev        : Ids,
    ns         : Ids,
    tags       : SUBSET Tags,
    epochs     : [Tags -> Ids],
    freshUntil : FreshTimes,
    capId      : Ids
]

L1Envelope == [
    present    : BOOLEAN,
    val        : Writers \cup {NoVal},
    rev        : Ids,        \* 0 models unconfirmed optimistic L1 storeConservative
    tokLegacy  : Ids,
    tokPrefix  : Ids,
    tokNs      : Ids,
    freshUntil : FreshTimes
]

WriterState == [
    active    : BOOLEAN,
    key       : Keys \cup {NoVal},
    tags      : SUBSET Tags,
    tokLegacy : Ids,
    tokPrefix : Ids,
    tokNs     : Ids,
    capId     : Ids
]

DetachedSnapshot == [tag : Tags, keys : SUBSET Keys]

-----------------------------------------------------------------------------
(* Readability predicates mirroring adaptiveCacheFetch.lua & adaptiveCacheValidate.lua *)

RedisReadable(k) ==
    LET e == redisData[k] IN
    /\ e.present
    /\ namespaceGen # 0
    /\ e.ns = namespaceGen
    /\ \A t \in e.tags : tagEpoch[t] # 0 /\ e.epochs[t] = tagEpoch[t]
    /\ e.freshUntil > now

L1Readable(n, k) ==
    LET local == l1[n][k]
        e     == redisData[k]
    IN
    /\ local.present
    /\ local.rev # 0
    /\ redisRev[k] = local.rev
    /\ e.present
    /\ e.rev = local.rev
    /\ legacyBarrier # 0
    /\ prefixBarrier # 0
    /\ namespaceGen # 0
    /\ local.tokLegacy = legacyBarrier
    /\ local.tokPrefix = prefixBarrier
    /\ local.tokNs = namespaceGen
    /\ e.ns = namespaceGen
    /\ \A t \in e.tags : tagEpoch[t] # 0 /\ e.epochs[t] = tagEpoch[t]
    /\ e.freshUntil > now
    /\ local.freshUntil > now

-----------------------------------------------------------------------------
(* Initial state *)

Init ==
    /\ now = 0
    /\ nextId = 2
    /\ legacyBarrier = 1
    /\ prefixBarrier = 1
    /\ namespaceGen = 1
    /\ tagEpoch = EmptyEpochs
    /\ tagIndex = [t \in Tags |-> {}]
    /\ detached = {}
    /\ redisData = [k \in Keys |-> EmptyRedisEntry]
    /\ redisRev = [k \in Keys |-> 0]
    /\ writer = [w \in Writers |-> [
            active    |-> FALSE,
            key       |-> NoVal,
            tags      |-> {},
            tokLegacy |-> 0,
            tokPrefix |-> 0,
            tokNs     |-> 0,
            capId     |-> 0
       ]]
    /\ l1 = [n \in Nodes |-> [k \in Keys |-> EmptyL1Entry]]
    /\ invalidationId = [k \in Keys |-> 0]
    /\ cleanupKilledFresh = FALSE

-----------------------------------------------------------------------------
(* Actions *)

\* Advance Redis clock
Tick ==
    /\ now < MaxTime
    /\ now' = now + 1
    /\ UNCHANGED <<
        nextId, legacyBarrier, prefixBarrier, namespaceGen,
        tagEpoch, tagIndex, detached, redisData, redisRev,
        writer, l1, invalidationId, cleanupKilledFresh
       >>

\* Re-establish evicted barrier/namespace keys (models captureWriteToken SETNX)
RestoreControls ==
    /\ (legacyBarrier = 0 \/ prefixBarrier = 0 \/ namespaceGen = 0)
    /\ nextId <= MaxId
    /\ legacyBarrier' = IF legacyBarrier = 0 THEN nextId ELSE legacyBarrier
    /\ prefixBarrier' = IF prefixBarrier = 0 THEN nextId ELSE prefixBarrier
    /\ namespaceGen'  = IF namespaceGen  = 0 THEN nextId ELSE namespaceGen
    /\ nextId' = nextId + 1
    /\ UNCHANGED <<
        now, tagEpoch, tagIndex, detached, redisData, redisRev,
        writer, l1, invalidationId, cleanupKilledFresh
       >>

\* Writer captures a write token before executing source work / async encoding
CaptureToken(w, k, ts) ==
    /\ ~writer[w].active
    /\ legacyBarrier # 0
    /\ prefixBarrier # 0
    /\ namespaceGen # 0
    /\ writer' = [writer EXCEPT ![w] = [
            active    |-> TRUE,
            key       |-> k,
            tags      |-> ts,
            tokLegacy |-> legacyBarrier,
            tokPrefix |-> prefixBarrier,
            tokNs     |-> namespaceGen,
            capId     |-> nextId - 1
       ]]
    /\ UNCHANGED <<
        now, nextId, legacyBarrier, prefixBarrier, namespaceGen,
        tagEpoch, tagIndex, detached, redisData, redisRev,
        l1, invalidationId, cleanupKilledFresh
       >>

\* Optimistic unconfirmed L1 store (models storeConservative before Redis ack)
OptimisticL1Write(n, w) ==
    /\ writer[w].active
    /\ l1' = [l1 EXCEPT ![n][writer[w].key] = [
            present    |-> TRUE,
            val        |-> w,
            rev        |-> 0,
            tokLegacy  |-> writer[w].tokLegacy,
            tokPrefix  |-> writer[w].tokPrefix,
            tokNs      |-> writer[w].tokNs,
            freshUntil |-> now + 1
       ]]
    /\ UNCHANGED <<
        now, nextId, legacyBarrier, prefixBarrier, namespaceGen,
        tagEpoch, tagIndex, detached, redisData, redisRev,
        writer, invalidationId, cleanupKilledFresh
       >>

\* Atomic fenced Redis write (models adaptiveCacheUpdate.lua)
CommitWrite(w) ==
    /\ writer[w].active
    /\ nextId <= MaxId
    /\ LET st == writer[w]
           k  == st.key
           ts == st.tags
           tokenValid ==
               /\ legacyBarrier # 0
               /\ prefixBarrier # 0
               /\ namespaceGen # 0
               /\ st.tokLegacy = legacyBarrier
               /\ st.tokPrefix = prefixBarrier
               /\ st.tokNs = namespaceGen
           oldTags == IF redisData[k].present THEN redisData[k].tags ELSE {}
       IN
       IF ~tokenValid THEN
           \* Fenced write rejected ('INVALIDATED')
           /\ writer' = [writer EXCEPT ![w] = [
                   active    |-> FALSE,
                   key       |-> NoVal,
                   tags      |-> {},
                   tokLegacy |-> 0,
                   tokPrefix |-> 0,
                   tokNs     |-> 0,
                   capId     |-> 0
              ]]
           /\ UNCHANGED <<
                now, nextId, legacyBarrier, prefixBarrier, namespaceGen,
                tagEpoch, tagIndex, detached, redisData, redisRev,
                l1, invalidationId, cleanupKilledFresh
              >>
       ELSE
           LET newId == nextId
               newTagEpoch == [t \in Tags |->
                   IF t \in ts /\ tagEpoch[t] = 0 THEN newId ELSE tagEpoch[t]]
               newTagIndex == [t \in Tags |->
                   IF t \in ts THEN tagIndex[t] \cup {k}
                   ELSE IF t \in oldTags THEN tagIndex[t] \ {k}
                   ELSE tagIndex[t]]
               env == [
                   present    |-> TRUE,
                   val        |-> w,
                   rev        |-> newId,
                   ns         |-> namespaceGen,
                   tags       |-> ts,
                   epochs     |-> [t \in Tags |-> IF t \in ts THEN newTagEpoch[t] ELSE 0],
                   freshUntil |-> now + 1,
                   capId      |-> st.capId
               ]
           IN
           /\ nextId' = nextId + 1
           /\ tagEpoch' = newTagEpoch
           /\ tagIndex' = newTagIndex
           /\ redisData' = [redisData EXCEPT ![k] = env]
           /\ redisRev' = [redisRev EXCEPT ![k] = newId]
           /\ writer' = [writer EXCEPT ![w] = [
                   active    |-> FALSE,
                   key       |-> NoVal,
                   tags      |-> {},
                   tokLegacy |-> 0,
                   tokPrefix |-> 0,
                   tokNs     |-> 0,
                   capId     |-> 0
              ]]
           /\ UNCHANGED <<
                now, legacyBarrier, prefixBarrier, namespaceGen,
                detached, l1, invalidationId, cleanupKilledFresh
              >>

\* Node hydrates L1 from a fresh Redis read (models L1RedisAdaptiveCacheBackend.fetch)
\* Note: Pub/Sub is intentionally omitted from invalidations so L1 can hold stale data.
HydrateL1(n, k) ==
    /\ RedisReadable(k)
    /\ legacyBarrier # 0
    /\ prefixBarrier # 0
    /\ namespaceGen # 0
    /\ LET e == redisData[k] IN
       /\ redisRev[k] = e.rev
       /\ l1' = [l1 EXCEPT ![n][k] = [
               present    |-> TRUE,
               val        |-> e.val,
               rev        |-> e.rev,
               tokLegacy  |-> legacyBarrier,
               tokPrefix  |-> prefixBarrier,
               tokNs      |-> namespaceGen,
               freshUntil |-> e.freshUntil
          ]]
    /\ UNCHANGED <<
        now, nextId, legacyBarrier, prefixBarrier, namespaceGen,
        tagEpoch, tagIndex, detached, redisData, redisRev,
        writer, invalidationId, cleanupKilledFresh
       >>

\* Clear a single key (models adaptiveCacheInvalidate.lua 'clear')
ClearKey(k) ==
    /\ nextId <= MaxId
    /\ LET newId   == nextId
           oldTags == IF redisData[k].present THEN redisData[k].tags ELSE {}
       IN
       /\ prefixBarrier' = newId
       /\ nextId' = nextId + 1
       /\ tagIndex' = [t \in Tags |-> IF t \in oldTags THEN tagIndex[t] \ {k} ELSE tagIndex[t]]
       /\ redisData' = [redisData EXCEPT ![k] = EmptyRedisEntry]
       /\ redisRev' = [redisRev EXCEPT ![k] = 0]
       /\ invalidationId' = [invalidationId EXCEPT ![k] = newId]
       /\ UNCHANGED <<
            now, legacyBarrier, namespaceGen, tagEpoch,
            detached, writer, l1, cleanupKilledFresh
          >>

\* Invalidate a tag (models adaptiveCacheInvalidate.lua 'tags': O(1) epoch delete + index detach)
InvalidateTag(t) ==
    /\ nextId <= MaxId
    /\ LET newId == nextId
           affected == {k \in Keys : redisData[k].present /\ t \in redisData[k].tags}
       IN
       /\ prefixBarrier' = newId
       /\ nextId' = nextId + 1
       /\ tagEpoch' = [tagEpoch EXCEPT ![t] = 0]
       /\ tagIndex' = [tagIndex EXCEPT ![t] = {}]
       /\ detached' = IF tagIndex[t] # {}
                      THEN detached \cup {[tag |-> t, keys |-> tagIndex[t]]}
                      ELSE detached
       /\ invalidationId' = [k \in Keys |->
            IF k \in affected THEN newId ELSE invalidationId[k]]
       /\ UNCHANGED <<
            now, legacyBarrier, namespaceGen, redisData, redisRev,
            writer, l1, cleanupKilledFresh
          >>

\* Async bounded cleanup step (models adaptiveCacheCleanup.lua)
CleanupStep(snap, k) ==
    /\ snap \in detached
    /\ k \in snap.keys
    /\ LET t     == snap.tag
           e     == redisData[k]
           epoch == tagEpoch[t]
           \* Mirrors adaptiveCacheCleanup.lua line 19:
           \* remove = envelope.epochs[epochKey] ~= nil and envelope.epochs[epochKey] ~= epoch
           shouldRemove ==
               IF e.present THEN
                   (t \in e.tags) /\ (e.epochs[t] # epoch)
               ELSE
                   TRUE
           oldTags == IF e.present THEN e.tags ELSE {}
           remKeys == snap.keys \ {k}
           nextDetached == (detached \ {snap}) \cup
                           (IF remKeys = {} THEN {} ELSE {[tag |-> t, keys |-> remKeys]})
       IN
       /\ detached' = nextDetached
       /\ IF shouldRemove THEN
              /\ redisData' = [redisData EXCEPT ![k] = EmptyRedisEntry]
              /\ redisRev' = [redisRev EXCEPT ![k] = 0]
              /\ tagIndex' = [tg \in Tags |-> IF tg \in oldTags THEN tagIndex[tg] \ {k} ELSE tagIndex[tg]]
              \* Ghost check: did cleanup kill a currently-readable post-invalidation rewrite?
              /\ cleanupKilledFresh' = (cleanupKilledFresh \/ RedisReadable(k))
          ELSE
              /\ UNCHANGED <<redisData, redisRev, tagIndex, cleanupKilledFresh>>
       /\ UNCHANGED <<
            now, nextId, legacyBarrier, prefixBarrier, namespaceGen,
            tagEpoch, writer, l1, invalidationId
          >>

\* Invalidate entire namespace (models adaptiveCacheInvalidate.lua 'namespace')
InvalidateNamespace ==
    /\ nextId <= MaxId
    /\ LET newId == nextId IN
       /\ prefixBarrier' = newId
       /\ namespaceGen' = newId
       /\ nextId' = nextId + 1
       /\ invalidationId' = [k \in Keys |-> newId]
       /\ UNCHANGED <<
            now, legacyBarrier, tagEpoch, tagIndex, detached,
            redisData, redisRev, writer, l1, cleanupKilledFresh
          >>

\* Redis memory eviction of a control key (tag epoch or revision key)
EvictTagEpoch(t) ==
    /\ tagEpoch[t] # 0
    /\ tagEpoch' = [tagEpoch EXCEPT ![t] = 0]
    /\ UNCHANGED <<
        now, nextId, legacyBarrier, prefixBarrier, namespaceGen,
        tagIndex, detached, redisData, redisRev,
        writer, l1, invalidationId, cleanupKilledFresh
       >>

EvictRevision(k) ==
    /\ redisRev[k] # 0
    /\ redisRev' = [redisRev EXCEPT ![k] = 0]
    /\ UNCHANGED <<
        now, nextId, legacyBarrier, prefixBarrier, namespaceGen,
        tagEpoch, tagIndex, detached, redisData,
        writer, l1, invalidationId, cleanupKilledFresh
       >>

-----------------------------------------------------------------------------
(* Next-state relation *)

Next ==
    \/ Tick
    \/ RestoreControls
    \/ \E w \in Writers, k \in Keys, ts \in SUBSET Tags : CaptureToken(w, k, ts)
    \/ \E n \in Nodes, w \in Writers : OptimisticL1Write(n, w)
    \/ \E w \in Writers : CommitWrite(w)
    \/ \E n \in Nodes, k \in Keys : HydrateL1(n, k)
    \/ \E k \in Keys : ClearKey(k)
    \/ \E t \in Tags : InvalidateTag(t)
    \/ \E snap \in detached : \E k \in snap.keys : CleanupStep(snap, k)
    \/ InvalidateNamespace
    \/ \E t \in Tags : EvictTagEpoch(t)
    \/ \E k \in Keys : EvictRevision(k)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Safety Invariants *)

TypeOK ==
    /\ now \in Times
    /\ nextId \in 1..(MaxId + 1)
    /\ legacyBarrier \in Ids
    /\ prefixBarrier \in Ids
    /\ namespaceGen \in Ids
    /\ tagEpoch \in [Tags -> Ids]
    /\ tagIndex \in [Tags -> SUBSET Keys]
    /\ detached \subseteq DetachedSnapshot
    /\ redisData \in [Keys -> RedisEnvelope]
    /\ redisRev \in [Keys -> Ids]
    /\ writer \in [Writers -> WriterState]
    /\ l1 \in [Nodes -> [Keys -> L1Envelope]]
    /\ invalidationId \in [Keys -> Ids]
    /\ cleanupKilledFresh \in BOOLEAN

\* 1. No in-flight writer captured before clear/tag/namespace invalidation can resurrect data.
NoResurrectionAfterInvalidation ==
    \A k \in Keys :
        RedisReadable(k) => redisData[k].capId >= invalidationId[k]

\* 2. Every L1 hit is strictly coherent with live authoritative Redis state,
\*    even with 100% Pub/Sub message loss, and never extends freshness.
L1CoherenceWithoutPubSub ==
    \A n \in Nodes, k \in Keys :
        L1Readable(n, k) =>
            /\ RedisReadable(k)
            /\ l1[n][k].val = redisData[k].val
            /\ l1[n][k].rev = redisData[k].rev
            /\ l1[n][k].freshUntil <= redisData[k].freshUntil

\* 3. Unconfirmed optimistic L1 writes (rev = 0) never qualify as authoritative L1 hits.
UnconfirmedOptimisticNeverServed ==
    \A n \in Nodes, k \in Keys :
        (l1[n][k].present /\ l1[n][k].rev = 0) => ~L1Readable(n, k)

\* 4. Tag-invalidated entries become unreadable immediately before async cleanup runs.
TagInvalidatedNeverReadable ==
    \A k \in Keys :
        RedisReadable(k) =>
            \A t \in redisData[k].tags :
                tagEpoch[t] # 0 /\ redisData[k].epochs[t] = tagEpoch[t]

\* 5. Delayed tag cleanup never deletes a fresh post-invalidation rewrite.
CleanupPreservesFreshWrites ==
    ~cleanupKilledFresh

\* 6. Missing or evicted revision keys fail closed on L1 reads.
FailClosedOnEvictedRevision ==
    \A n \in Nodes, k \in Keys :
        redisRev[k] = 0 => ~L1Readable(n, k)

=============================================================================
