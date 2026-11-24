----------------------- MODULE FastifyCoalescedPublication -----------------------
(*
 * Formal TLA+ specification of Fastify's coalesced loader publication protocol
 * with both safety invariants and temporal liveness properties.
 *
 * Models:
 *   - src/AdaptiveFastifyCache.ts (lines 243-317, 400-407)
 *   - src/httpLoader.ts (UNSHAREABLE_HTTP_RESULT, loadOnce, wait)
 *
 * Verifies:
 *   - No follower ever receives a response whose final onResponse hooks
 *     fail isResponseCacheable (Set-Cookie, Cache-Control: private, Vary, etc.).
 *   - No request ever sends twice (NoDoubleSend).
 *   - Origin timeout or onError cancels publication without deadlocking followers.
 *   - Every request eventually terminates (no indefinite hang on publication).
 *)

EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    Origin,      \* Model value for the originating coalesced request
    Followers    \* Set of follower requests joining the same getOrSet load

Requests == {Origin} \cup Followers

VARIABLES
    originStage,     \* "init" | "loading" | "sent_await_hook" | "done" | "timed_out" | "errored"
    pubRegistered,   \* TRUE once publications.set(origin, ...) is registered
    pubSettled,      \* TRUE once publish(...) has resolved the publication promise
    pubOutcome,      \* "pending" | "approved" | "unshareable"
    finalCacheable,  \* Non-deterministic final response cacheability determined by onSend/onResponse
    storedInCache,   \* "none" | "approved" | "private"
    reqState,        \* [Requests -> "joined" | "running_own" | "sent_shared" | "sent_own" | "timed_out" | "errored"]
    sendCount,       \* [Requests -> 0..2]
    receivedPrivate  \* Ghost: TRUE iff any follower received a non-cacheable shared response

vars == <<
    originStage, pubRegistered, pubSettled, pubOutcome,
    finalCacheable, storedInCache, reqState, sendCount, receivedPrivate
>>

OriginStages == {"init", "loading", "sent_await_hook", "done", "timed_out", "errored"}
PubOutcomes == {"pending", "approved", "unshareable"}
CacheStates == {"none", "approved", "private"}
ReqStates == {"joined", "running_own", "sent_shared", "sent_own", "timed_out", "errored"}

Init ==
    /\ originStage = "init"
    /\ pubRegistered = FALSE
    /\ pubSettled = FALSE
    /\ pubOutcome = "pending"
    /\ finalCacheable \in BOOLEAN
    /\ storedInCache = "none"
    /\ reqState = [r \in Requests |-> "joined"]
    /\ sendCount = [r \in Requests |-> 0]
    /\ receivedPrivate = FALSE

-----------------------------------------------------------------------------
(* Origin transitions *)

\* Origin starts loader execution
OriginStartLoad ==
    /\ originStage = "init"
    /\ originStage' = "loading"
    /\ UNCHANGED <<
        pubRegistered, pubSettled, pubOutcome, finalCacheable,
        storedInCache, reqState, sendCount, receivedPrivate
       >>

\* Origin source throws or produces an uncacheable/unshareable initial body
\* -> returns UNSHAREABLE_HTTP_RESULT immediately without starting send
OriginRejectBeforeSend ==
    /\ originStage = "loading"
    /\ originStage' = "done"
    /\ pubSettled' = TRUE
    /\ pubOutcome' = "unshareable"
    /\ reqState' = [reqState EXCEPT ![Origin] = "running_own"]
    /\ UNCHANGED <<
        pubRegistered, finalCacheable, storedInCache, sendCount, receivedPrivate
       >>

\* Origin calls reply.send(candidate) and registers publications.set(req, ...)
OriginSendAndRegister ==
    /\ originStage = "loading"
    /\ originStage' = "sent_await_hook"
    /\ pubRegistered' = TRUE
    /\ sendCount' = [sendCount EXCEPT ![Origin] = sendCount[Origin] + 1]
    /\ UNCHANGED <<
        pubSettled, pubOutcome, finalCacheable, storedInCache, reqState, receivedPrivate
       >>

\* Origin times out before onResponse fires -> catch block calls cancelPublication()
\* Because sendStarted.has(Origin) is TRUE, origin returns reply without re-sending.
OriginTimeoutBeforeHook ==
    /\ originStage \in {"loading", "sent_await_hook"}
    /\ ~pubSettled
    /\ originStage' = "timed_out"
    /\ pubRegistered' = FALSE
    /\ pubSettled' = TRUE
    /\ pubOutcome' = "unshareable"
    /\ reqState' = [reqState EXCEPT ![Origin] =
            IF sendCount[Origin] > 0 THEN "sent_own" ELSE "timed_out"]
    /\ UNCHANGED <<finalCacheable, storedInCache, sendCount, receivedPrivate>>

\* Fastify onError hook fires before onResponse -> publications.get(req)?.() -> UNSHAREABLE_HTTP_RESULT
OriginOnErrorHook ==
    /\ originStage = "sent_await_hook"
    /\ pubRegistered
    /\ ~pubSettled
    /\ originStage' = "errored"
    /\ pubRegistered' = FALSE
    /\ pubSettled' = TRUE
    /\ pubOutcome' = "unshareable"
    /\ reqState' = [reqState EXCEPT ![Origin] = "errored"]
    /\ UNCHANGED <<finalCacheable, storedInCache, sendCount, receivedPrivate>>

\* Fastify onResponse hook runs after all serialization & send hooks
\* Approves sharing & storage ONLY if finalCacheable is TRUE
OriginOnResponseHook ==
    /\ originStage = "sent_await_hook"
    /\ pubRegistered
    /\ ~pubSettled
    /\ originStage' = "done"
    /\ pubRegistered' = FALSE
    /\ pubSettled' = TRUE
    /\ pubOutcome' = IF finalCacheable THEN "approved" ELSE "unshareable"
    /\ storedInCache' = IF finalCacheable THEN "approved" ELSE storedInCache
    /\ reqState' = [reqState EXCEPT ![Origin] = "sent_own"]
    /\ UNCHANGED <<finalCacheable, sendCount, receivedPrivate>>

\* Origin completes its fallback own send when rejected before initial send
OriginCompleteOwnSend ==
    /\ reqState[Origin] = "running_own"
    /\ sendCount[Origin] = 0
    /\ reqState' = [reqState EXCEPT ![Origin] = "sent_own"]
    /\ sendCount' = [sendCount EXCEPT ![Origin] = sendCount[Origin] + 1]
    /\ UNCHANGED <<
        originStage, pubRegistered, pubSettled, pubOutcome,
        finalCacheable, storedInCache, receivedPrivate
       >>

-----------------------------------------------------------------------------
(* Follower transitions *)

\* Follower times out while waiting on shared publication
FollowerTimeout(f) ==
    /\ f \in Followers
    /\ reqState[f] = "joined"
    /\ reqState' = [reqState EXCEPT ![f] = "timed_out"]
    /\ UNCHANGED <<
        originStage, pubRegistered, pubSettled, pubOutcome,
        finalCacheable, storedInCache, sendCount, receivedPrivate
       >>

\* Follower observes settled publication
FollowerObservePublication(f) ==
    /\ f \in Followers
    /\ reqState[f] = "joined"
    /\ pubSettled
    /\ IF pubOutcome = "approved" THEN
           /\ reqState' = [reqState EXCEPT ![f] = "sent_shared"]
           /\ sendCount' = [sendCount EXCEPT ![f] = sendCount[f] + 1]
           /\ receivedPrivate' = (receivedPrivate \/ ~finalCacheable)
       ELSE
           \* UNSHAREABLE_HTTP_RESULT -> follower runs its own independent loadOnce
           /\ reqState' = [reqState EXCEPT ![f] = "running_own"]
           /\ UNCHANGED <<sendCount, receivedPrivate>>
    /\ UNCHANGED <<
        originStage, pubRegistered, pubSettled, pubOutcome,
        finalCacheable, storedInCache
       >>

\* Follower finishes its own independent fallback load
FollowerCompleteOwnSend(f) ==
    /\ f \in Followers
    /\ reqState[f] = "running_own"
    /\ reqState' = [reqState EXCEPT ![f] = "sent_own"]
    /\ sendCount' = [sendCount EXCEPT ![f] = sendCount[f] + 1]
    /\ UNCHANGED <<
        originStage, pubRegistered, pubSettled, pubOutcome,
        finalCacheable, storedInCache, receivedPrivate
       >>

\* Follower own fallback load times out
FollowerOwnTimeout(f) ==
    /\ f \in Followers
    /\ reqState[f] = "running_own"
    /\ reqState' = [reqState EXCEPT ![f] = "timed_out"]
    /\ UNCHANGED <<
        originStage, pubRegistered, pubSettled, pubOutcome,
        finalCacheable, storedInCache, sendCount, receivedPrivate
       >>

-----------------------------------------------------------------------------
(* Next-state relation & Fair Spec *)

Next ==
    \/ OriginStartLoad
    \/ OriginRejectBeforeSend
    \/ OriginSendAndRegister
    \/ OriginTimeoutBeforeHook
    \/ OriginOnErrorHook
    \/ OriginOnResponseHook
    \/ OriginCompleteOwnSend
    \/ \E f \in Followers : FollowerTimeout(f)
    \/ \E f \in Followers : FollowerObservePublication(f)
    \/ \E f \in Followers : FollowerCompleteOwnSend(f)
    \/ \E f \in Followers : FollowerOwnTimeout(f)

Fairness ==
    /\ WF_vars(OriginStartLoad)
    /\ WF_vars(OriginSendAndRegister \/ OriginRejectBeforeSend)
    /\ WF_vars(OriginOnResponseHook \/ OriginOnErrorHook \/ OriginTimeoutBeforeHook)
    /\ WF_vars(OriginCompleteOwnSend)
    /\ \A f \in Followers : WF_vars(FollowerObservePublication(f))
    /\ \A f \in Followers : WF_vars(FollowerCompleteOwnSend(f))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Safety Invariants *)

TypeOK ==
    /\ originStage \in OriginStages
    /\ pubRegistered \in BOOLEAN
    /\ pubSettled \in BOOLEAN
    /\ pubOutcome \in PubOutcomes
    /\ finalCacheable \in BOOLEAN
    /\ storedInCache \in CacheStates
    /\ reqState \in [Requests -> ReqStates]
    /\ sendCount \in [Requests -> 0..2]
    /\ receivedPrivate \in BOOLEAN

\* 1. No request ever invokes reply.send() more than once.
NoDoubleSend ==
    \A r \in Requests : sendCount[r] <= 1

\* 2. No follower ever receives a shared candidate whose final response was non-cacheable.
NoPrivacyLeakToFollower ==
    /\ ~receivedPrivate
    /\ \A f \in Followers :
        (reqState[f] = "sent_shared") => (finalCacheable /\ pubOutcome = "approved")

\* 3. Cache never stores a response rejected by final hooks.
NoPrivateStorage ==
    (storedInCache = "approved") => finalCacheable

\* 4. An errored or timed-out origin never publishes an approved candidate.
UnapprovedOriginNeverPublishes ==
    (originStage \in {"timed_out", "errored"}) => (pubOutcome # "approved" /\ storedInCache = "none")

-----------------------------------------------------------------------------
(* Liveness Properties *)

TerminalStates == {"sent_shared", "sent_own", "timed_out", "errored"}

\* Every request eventually terminates (no follower hangs on publication).
EveryRequestTerminates ==
    \A r \in Requests : <>(reqState[r] \in TerminalStates)

\* Every registered publication eventually settles.
PublicationAlwaysSettles ==
    pubRegistered ~> pubSettled

=============================================================================
