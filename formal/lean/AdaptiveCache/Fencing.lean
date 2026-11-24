/-
  Unbounded algebraic Lean 4 proofs for @0xdoublesharp/adaptive-cache's
  write-barrier fencing, tag-epoch invalidation, async tag cleanup safety,
  and atomic refresh-lock release.

  Complements the bounded exhaustive TLC state-space exploration in
  formal/tla/AdaptiveCacheFencing.tla and formal/tla/CacheLoaderCoordination.tla
  with universal theorems valid for all unbounded generations, epochs, and keys.
-/

namespace AdaptiveCache.Fencing

/-- Barrier tuple captured by `captureWriteToken()`. -/
structure WriteToken where
  legacyBarrier : Nat
  prefixBarrier : Nat
  namespaceGen : Nat
  deriving DecidableEq

/-- A write is accepted iff its captured token still matches the live barriers. -/
def tokenMatches (captured live : WriteToken) : Bool :=
  captured == live

/-- Advancing any barrier strictly increases its monotonic counter. -/
def advancePrefixBarrier (live : WriteToken) (nextId : Nat) : WriteToken :=
  { live with prefixBarrier := nextId }

def advanceLegacyBarrier (live : WriteToken) (nextId : Nat) : WriteToken :=
  { live with legacyBarrier := nextId }

def advanceNamespace (live : WriteToken) (nextId : Nat) : WriteToken :=
  { live with prefixBarrier := nextId, namespaceGen := nextId }

/-- Any strictly newer prefix barrier (clear / tag invalidation) rejects all earlier write tokens. -/
theorem prefix_invalidation_rejects_earlier_token
    (captured live : WriteToken) (nextId : Nat)
    (hMono : captured.prefixBarrier < nextId) :
    tokenMatches captured (advancePrefixBarrier live nextId) = false := by
  unfold tokenMatches advancePrefixBarrier
  simp only [beq_eq_false_iff_ne, ne_eq]
  intro heq
  have hbar : captured.prefixBarrier = nextId := congrArg WriteToken.prefixBarrier heq
  omega

/-- Any strictly newer legacy barrier (unprefixed clear) rejects all earlier write tokens. -/
theorem legacy_invalidation_rejects_earlier_token
    (captured live : WriteToken) (nextId : Nat)
    (hMono : captured.legacyBarrier < nextId) :
    tokenMatches captured (advanceLegacyBarrier live nextId) = false := by
  unfold tokenMatches advanceLegacyBarrier
  simp only [beq_eq_false_iff_ne, ne_eq]
  intro heq
  have hbar : captured.legacyBarrier = nextId := congrArg WriteToken.legacyBarrier heq
  omega

/-- Any strictly newer namespace generation rejects all earlier write tokens. -/
theorem namespace_invalidation_rejects_earlier_token
    (captured live : WriteToken) (nextId : Nat)
    (hMono : captured.namespaceGen < nextId) :
    tokenMatches captured (advanceNamespace live nextId) = false := by
  unfold tokenMatches advanceNamespace
  simp only [beq_eq_false_iff_ne, ne_eq]
  intro heq
  have hns : captured.namespaceGen = nextId := congrArg WriteToken.namespaceGen heq
  omega

-------------------------------------------------------------------------------
-- Tag Epoch Isolation & Async Cleanup Safety (adaptiveCacheCleanup.lua)
-------------------------------------------------------------------------------

/-- Tag-epoch map stored inside a versioned Redis/LRU envelope. -/
abbrev EpochMap := String → Option Nat

/-- Entry readability with respect to live tag epochs. -/
def epochsMatch (entryEpochs liveEpochs : EpochMap) (tags : List String) : Prop :=
  ∀ t ∈ tags, ∃ e, entryEpochs t = some e ∧ liveEpochs t = some e

/-- Deleting a tag's epoch (`liveEpochs t = none`) immediately makes every entry
    carrying `t` unreadable, regardless of physical cleanup or Pub/Sub. -/
theorem deleted_tag_epoch_immediately_unreadable
    (entryEpochs liveEpochs : EpochMap) (tags : List String) (t : String)
    (hTag : t ∈ tags) (hDel : liveEpochs t = none) :
    ¬ epochsMatch entryEpochs liveEpochs tags := by
  intro hmatch
  rcases hmatch t hTag with ⟨e, _, hlive⟩
  rw [hDel] at hlive
  cases hlive

/-- Advancing a tag's epoch to `some newE` with `newE ≠ oldE` keeps old entries unreadable. -/
theorem advanced_tag_epoch_keeps_old_unreadable
    (entryEpochs liveEpochs : EpochMap) (tags : List String) (t : String) (oldE newE : Nat)
    (hTag : t ∈ tags) (hEntry : entryEpochs t = some oldE) (hLive : liveEpochs t = some newE)
    (hNe : oldE ≠ newE) :
    ¬ epochsMatch entryEpochs liveEpochs tags := by
  intro hmatch
  rcases hmatch t hTag with ⟨e, he1, he2⟩
  rw [hEntry] at he1
  rw [hLive] at he2
  injection he1 with h1
  injection he2 with h2
  exact hNe (h1.trans h2.symm)

/-- Cleanup decision predicate mirroring `adaptiveCacheCleanup.lua` line 19:
    `remove = envelope.epochs[epochKey] ~= nil and envelope.epochs[epochKey] ~= epoch`. -/
def cleanupShouldRemove (entryTagEpoch liveTagEpoch : Option Nat) : Bool :=
  match entryTagEpoch with
  | none => false
  | some e => liveTagEpoch != some e

/-- Case 1: A rewrite that removed tag `t` (`entryTagEpoch = none`) ALWAYS survives cleanup. -/
theorem cleanup_preserves_retagged_entry (liveTagEpoch : Option Nat) :
    cleanupShouldRemove none liveTagEpoch = false := by
  rfl

/-- Case 2: A rewrite that joined the new live epoch `some e` ALWAYS survives cleanup. -/
theorem cleanup_preserves_new_epoch_rewrite (e : Nat) :
    cleanupShouldRemove (some e) (some e) = false := by
  unfold cleanupShouldRemove
  simp

/-- Case 3: An old entry from an invalidated epoch (either deleted `none` or replaced `some e'`)
    is ALWAYS removed by cleanup. -/
theorem cleanup_removes_stale_epoch_entry (oldE : Nat) (liveTagEpoch : Option Nat)
    (hNe : liveTagEpoch ≠ some oldE) :
    cleanupShouldRemove (some oldE) liveTagEpoch = true := by
  unfold cleanupShouldRemove
  simp [hNe]

-------------------------------------------------------------------------------
-- Atomic Refresh-Lock Release Safety (releaseCacheRefreshLock.lua / clusteredLruLocks.ts)
-------------------------------------------------------------------------------

structure LockState where
  liveLock : Option String
  lastUpdate : Nat
  deriving DecidableEq

inductive ReleaseOutcome where
  | updated
  | lockMismatch (actual : String)
  deriving DecidableEq

def atomicReleaseLock
    (st : LockState) (callerOwner : String) (currentTime : Nat) (recordRefresh : Bool) :
    ReleaseOutcome × LockState :=
  match st.liveLock with
  | some existing =>
      if existing == callerOwner then
        let nextLast := if recordRefresh then currentTime else st.lastUpdate
        (ReleaseOutcome.updated, { liveLock := none, lastUpdate := nextLast })
      else
        (ReleaseOutcome.lockMismatch existing, st)
  | none =>
      (ReleaseOutcome.lockMismatch "", st)

/-- An expired/stale owner calling release NEVER deletes a successor's live lock
    and NEVER modifies `lastUpdate`. -/
theorem atomic_release_preserves_successor
    (st : LockState) (successor oldOwner : String) (currentTime : Nat) (recordRefresh : Bool)
    (hLive : st.liveLock = some successor) (hNe : successor ≠ oldOwner) :
    atomicReleaseLock st oldOwner currentTime recordRefresh =
      (ReleaseOutcome.lockMismatch successor, st) := by
  unfold atomicReleaseLock
  simp [hLive, hNe]

/-- A loader release with `recordRefresh = false` clears the owner's lock without
    modifying `lastUpdate`. -/
theorem loader_release_preserves_last_update
    (st : LockState) (owner : String) (currentTime : Nat)
    (hLive : st.liveLock = some owner) :
    atomicReleaseLock st owner currentTime false =
      (ReleaseOutcome.updated, { liveLock := none, lastUpdate := st.lastUpdate }) := by
  unfold atomicReleaseLock
  simp [hLive]

end AdaptiveCache.Fencing
