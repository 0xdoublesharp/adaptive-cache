------------------------ MODULE AdaptiveCacheFencingTrace ------------------------
(*
 * Trace validation harness that checks a concrete execution trace recorded from
 * real Redis + TypeScript (@0xdoublesharp/adaptive-cache) against the formal
 * specification AdaptiveCacheFencing.tla.
 *
 * The companion TraceData module is generated per run with:
 *   Trace == << [op |-> "...", ...], ... >>
 *
 * If the implementation ever accepts/rejects a fenced write or returns a read
 * value inconsistent with AdaptiveCacheFencing, TraceNext stalls before reaching
 * Len(Trace) + 1 and TLC reports a violation of TraceComplete.
 *)

EXTENDS TraceData

VARIABLE pc

traceVars == <<vars, pc>>

TraceInit ==
    /\ Init
    /\ pc = 1

Step(ev) ==
    \/ /\ ev.op = "CaptureToken"
       /\ CaptureToken(ev.writer, ev.key, ev.tags)
    \/ /\ ev.op = "CommitWrite"
       /\ LET st == writer[ev.writer]
              tokenValid ==
                  /\ legacyBarrier # 0
                  /\ prefixBarrier # 0
                  /\ namespaceGen # 0
                  /\ st.tokLegacy = legacyBarrier
                  /\ st.tokPrefix = prefixBarrier
                  /\ st.tokNs = namespaceGen
          IN
          /\ ev.accepted = tokenValid
          /\ CommitWrite(ev.writer)
    \/ /\ ev.op = "ClearKey"
       /\ ClearKey(ev.key)
    \/ /\ ev.op = "InvalidateTag"
       /\ InvalidateTag(ev.tag)
    \/ /\ ev.op = "CleanupAll"
       /\ IF detached = {} THEN
              UNCHANGED vars
          ELSE
              \E snap \in detached : \E k \in snap.keys : CleanupStep(snap, k)
    \/ /\ ev.op = "InvalidateNamespace"
       /\ InvalidateNamespace
    \/ /\ ev.op = "HydrateL1"
       /\ HydrateL1(ev.node, ev.key)
    \/ /\ ev.op = "AssertRedisRead"
       /\ IF ev.present THEN
              /\ RedisReadable(ev.key)
              /\ redisData[ev.key].val = ev.val
          ELSE
              ~RedisReadable(ev.key)
       /\ UNCHANGED vars
    \/ /\ ev.op = "AssertL1Read"
       /\ IF ev.present THEN
              /\ L1Readable(ev.node, ev.key)
              /\ l1[ev.node][ev.key].val = ev.val
          ELSE
              ~L1Readable(ev.node, ev.key)
       /\ UNCHANGED vars

TraceNext ==
    /\ pc <= Len(Trace)
    /\ Step(Trace[pc])
    /\ pc' = IF Trace[pc].op = "CleanupAll" /\ detached' # {} THEN pc ELSE pc + 1

TraceSpec ==
    /\ TraceInit
    /\ [][TraceNext]_traceVars
    /\ WF_traceVars(TraceNext)

TraceComplete ==
    <>(pc = Len(Trace) + 1)

=============================================================================
