/-
  Formal Lean 4 proofs for @0xdoublesharp/adaptive-cache TTL policies,
  freshness jitter, stale windows, and sub-second L1 freshness bounds.

  Mirrors:
    - src/ttlCalculation.ts
    - src/ttlPolicy.ts
    - src/backends/lruEnvelope.ts
    - src/redis-lua/adaptiveCacheUpdate.lua
    - src/redis-lua/adaptiveCacheFetch.lua
-/

namespace AdaptiveCache.TtlPolicies

/-- Rational arithmetic helpers over exact integer fractions (num / den with den > 0). -/
structure PosRat where
  num : Int
  den : Nat
  den_pos : 0 < den

/-- Exact comparison `a ≤ b` on `PosRat`. -/
def PosRat.le (a b : PosRat) : Prop :=
  a.num * (b.den : Int) ≤ b.num * (a.den : Int)

/-- Exact comparison `a < b` on `PosRat`. -/
def PosRat.lt (a b : PosRat) : Prop :=
  a.num * (b.den : Int) < b.num * (a.den : Int)

/-- Ceiling of a non-negative rational `n / d` (`d > 0`) as a `Nat`. -/
def ceilDiv (n d : Nat) : Nat :=
  (n + d - 1) / d

theorem ceilDiv_ge (n d : Nat) (hd : 0 < d) :
    n ≤ ceilDiv n d * d := by
  unfold ceilDiv
  have hmod := Nat.div_add_mod (n + d - 1) d
  have hcomm : d * ((n + d - 1) / d) = ((n + d - 1) / d) * d := Nat.mul_comm _ _
  have hlt : (n + d - 1) % d < d := Nat.mod_lt _ hd
  omega

theorem ceilDiv_le_of_mul_le (n d k : Nat) (hd : 0 < d) (h : n ≤ k * d) :
    ceilDiv n d ≤ k := by
  unfold ceilDiv
  have h1 : n + d - 1 < (k + 1) * d := by
    have : (k + 1) * d = k * d + d := by
      rw [Nat.add_mul, Nat.one_mul]
    omega
  have h2 : (n + d - 1) / d < k + 1 := (Nat.div_lt_iff_lt_mul hd).mpr h1
  omega

theorem ceilDiv_mono (a b d : Nat) (h : a ≤ b) :
    ceilDiv a d ≤ ceilDiv b d := by
  unfold ceilDiv
  exact Nat.div_le_div_right (by omega)

-------------------------------------------------------------------------------
-- 1. Default Adaptive TTL Policy
--
-- Mirrors src/backends/lruEnvelope.ts:67-77 and adaptiveCacheUpdate.lua:99-113:
--   decayFactor    = 1 - min(0.9, changeCount * 0.01) = (100 - min(90, changeCount)) / 100
--   increaseFactor = max(0, ttlScaling - 1)
--   increase       = ceil(floor(dataTTL * increaseFactor) * decayFactor)
--   nextTTL        = max(initialTTL, min(dataTTL + increase, maxTTL))
-------------------------------------------------------------------------------

/-- Exact scaled decay numerator in `[10, 100]`, representing `decayNum / 100`. -/
def decayNumerator (changeCount : Nat) : Nat :=
  100 - min 90 changeCount

theorem decayNumerator_bounds (changeCount : Nat) :
    10 ≤ decayNumerator changeCount ∧ decayNumerator changeCount ≤ 100 := by
  unfold decayNumerator
  omega

/-- Next TTL under the default adaptive policy (integer-second model). -/
def nextAdaptiveTTL
    (prevTTL initialTTL maxTTL changeCount increaseNum increaseDen : Nat)
    (changed : Bool) : Nat :=
  let effInit := min initialTTL maxTTL
  if changed then
    effInit
  else if prevTTL ≥ maxTTL then
    maxTTL
  else
    let scaledFloor := (prevTTL * increaseNum) / increaseDen
    let increase := ceilDiv (scaledFloor * decayNumerator changeCount) 100
    max effInit (min (prevTTL + increase) maxTTL)

theorem adaptive_changed_resets
    (prevTTL initialTTL maxTTL changeCount increaseNum increaseDen : Nat) :
    nextAdaptiveTTL prevTTL initialTTL maxTTL changeCount increaseNum increaseDen true =
      min initialTTL maxTTL := by
  rfl

theorem adaptive_bounds
    (prevTTL initialTTL maxTTL changeCount increaseNum increaseDen : Nat)
    (hInit : initialTTL ≤ maxTTL) :
    initialTTL ≤ nextAdaptiveTTL prevTTL initialTTL maxTTL changeCount increaseNum increaseDen false ∧
    nextAdaptiveTTL prevTTL initialTTL maxTTL changeCount increaseNum increaseDen false ≤ maxTTL := by
  unfold nextAdaptiveTTL
  dsimp only
  have heff : min initialTTL maxTTL = initialTTL := Nat.min_eq_left hInit
  rw [heff]
  split
  · omega
  · split <;> omega

theorem adaptive_bounds_any
    (prevTTL initialTTL maxTTL changeCount increaseNum increaseDen : Nat)
    (changed : Bool) :
    min initialTTL maxTTL ≤ nextAdaptiveTTL prevTTL initialTTL maxTTL changeCount increaseNum increaseDen changed ∧
    nextAdaptiveTTL prevTTL initialTTL maxTTL changeCount increaseNum increaseDen changed ≤ maxTTL := by
  unfold nextAdaptiveTTL
  dsimp only
  cases changed
  · simp only [Bool.false_eq_true, ↓reduceIte]
    split <;> omega
  · simp only [↓reduceIte]
    omega

theorem adaptive_unchanged_monotone
    (prevTTL initialTTL maxTTL changeCount increaseNum increaseDen : Nat)
    (hLo : initialTTL ≤ prevTTL) (hHi : prevTTL ≤ maxTTL) :
    prevTTL ≤ nextAdaptiveTTL prevTTL initialTTL maxTTL changeCount increaseNum increaseDen false := by
  unfold nextAdaptiveTTL
  dsimp only
  simp only [Bool.false_eq_true, ↓reduceIte]
  have heff : min initialTTL maxTTL = initialTTL := Nat.min_eq_left (Nat.le_trans hLo hHi)
  rw [heff]
  split <;> omega

-------------------------------------------------------------------------------
-- 2. AIMD TTL Policy
--
-- Mirrors src/ttlCalculation.ts:32-34 and adaptiveCacheUpdate.lua:75-76,91-94:
--   unchanged: target = prevTTL + increaseSeconds
--   changed:   target = prevTTL * decreaseFactor  (0 < decreaseFactor < 1)
--   result:    clamp(ceil(clamp(target, initialTTL, maxTTL)), initialTTL, maxTTL)
-------------------------------------------------------------------------------

/-- Bounded ceiling clamp over exact non-negative rationals `num / den`. -/
def roundedTTL (num den initialTTL maxTTL : Nat) : Nat :=
  let raw := ceilDiv num den
  max initialTTL (min maxTTL raw)

theorem roundedTTL_bounds (num den initialTTL maxTTL : Nat) (hInit : initialTTL ≤ maxTTL) :
    initialTTL ≤ roundedTTL num den initialTTL maxTTL ∧
    roundedTTL num den initialTTL maxTTL ≤ maxTTL := by
  unfold roundedTTL
  dsimp only
  omega

/-- Next TTL under AIMD with rational decrease factor `decNum / decDen` (`0 < decNum < decDen`). -/
def nextAimdTTL
    (prevTTL initialTTL maxTTL increaseSeconds decNum decDen : Nat)
    (changed : Bool) : Nat :=
  let effInit := min initialTTL maxTTL
  if changed then
    roundedTTL (prevTTL * decNum) decDen effInit maxTTL
  else
    roundedTTL (prevTTL + increaseSeconds) 1 effInit maxTTL

theorem aimd_bounds
    (prevTTL initialTTL maxTTL increaseSeconds decNum decDen : Nat)
    (changed : Bool) :
    min initialTTL maxTTL ≤ nextAimdTTL prevTTL initialTTL maxTTL increaseSeconds decNum decDen changed ∧
    nextAimdTTL prevTTL initialTTL maxTTL increaseSeconds decNum decDen changed ≤ maxTTL := by
  unfold nextAimdTTL
  dsimp only
  cases changed
  · exact roundedTTL_bounds _ _ _ _ (Nat.min_le_right _ _)
  · exact roundedTTL_bounds _ _ _ _ (Nat.min_le_right _ _)

theorem aimd_unchanged_nondecreasing
    (prevTTL initialTTL maxTTL increaseSeconds decNum decDen : Nat)
    (_hLo : initialTTL ≤ prevTTL) (hHi : prevTTL ≤ maxTTL) :
    prevTTL ≤ nextAimdTTL prevTTL initialTTL maxTTL increaseSeconds decNum decDen false := by
  unfold nextAimdTTL roundedTTL ceilDiv
  dsimp only
  simp only [Bool.false_eq_true, ↓reduceIte, Nat.add_sub_cancel, Nat.div_one]
  omega

theorem aimd_changed_nonincreasing
    (prevTTL initialTTL maxTTL increaseSeconds decNum decDen : Nat)
    (hLo : initialTTL ≤ prevTTL) (hHi : prevTTL ≤ maxTTL)
    (hDecPos : 0 < decDen) (hDecLt : decNum ≤ decDen) :
    nextAimdTTL prevTTL initialTTL maxTTL increaseSeconds decNum decDen true ≤ prevTTL := by
  unfold nextAimdTTL roundedTTL
  dsimp only
  simp only [↓reduceIte]
  have hmul : prevTTL * decNum ≤ prevTTL * decDen := Nat.mul_le_mul_left prevTTL hDecLt
  have hceil : ceilDiv (prevTTL * decNum) decDen ≤ prevTTL :=
    ceilDiv_le_of_mul_le (prevTTL * decNum) decDen prevTTL hDecPos hmul
  omega

-------------------------------------------------------------------------------
-- 3. EWMA Convex Combination & Clock Monotonicity
--
-- Mirrors src/ttlCalculation.ts:36-47 and adaptiveCacheUpdate.lua:78-89:
--   alpha in (0, 1], represented as `aNum / aDen` with `0 < aNum ≤ aDen`
--   nextRate = (1 - alpha) * prevRate + alpha * sampleRate
-------------------------------------------------------------------------------

/-- EWMA rate numerator on common denominator `aDen * rateDen`. -/
def ewmaNextRateNum (aNum aDen prevRateNum sampleRateNum : Nat) : Nat :=
  (aDen - aNum) * prevRateNum + aNum * sampleRateNum

/-- Unchanged sample (`sampleRate = 0`) strictly decreases any positive EWMA rate. -/
theorem ewma_unchanged_strictly_decreases_rate
    (aNum aDen prevRateNum : Nat)
    (haPos : 0 < aNum) (haLe : aNum ≤ aDen) (hPrevPos : 0 < prevRateNum) :
    ewmaNextRateNum aNum aDen prevRateNum 0 < aDen * prevRateNum := by
  unfold ewmaNextRateNum
  simp only [Nat.mul_zero, Nat.add_zero]
  have hlt : aDen - aNum < aDen := by omega
  exact Nat.mul_lt_mul_of_pos_right hlt hPrevPos

/-- EWMA convex combination always stays within `[min(prev, sample), max(prev, sample)]`. -/
theorem ewma_convex_bounds
    (aNum aDen prevRateNum sampleRateNum : Nat)
    (haLe : aNum ≤ aDen) :
    aDen * min prevRateNum sampleRateNum ≤ ewmaNextRateNum aNum aDen prevRateNum sampleRateNum ∧
    ewmaNextRateNum aNum aDen prevRateNum sampleRateNum ≤ aDen * max prevRateNum sampleRateNum := by
  unfold ewmaNextRateNum
  have hsplit : aDen = (aDen - aNum) + aNum := by omega
  constructor
  · have h1 : (aDen - aNum) * min prevRateNum sampleRateNum ≤ (aDen - aNum) * prevRateNum :=
      Nat.mul_le_mul_left _ (Nat.min_le_left _ _)
    have h2 : aNum * min prevRateNum sampleRateNum ≤ aNum * sampleRateNum :=
      Nat.mul_le_mul_left _ (Nat.min_le_right _ _)
    calc
      aDen * min prevRateNum sampleRateNum
          = ((aDen - aNum) + aNum) * min prevRateNum sampleRateNum := by rw [← hsplit]
      _ = (aDen - aNum) * min prevRateNum sampleRateNum + aNum * min prevRateNum sampleRateNum :=
          Nat.add_mul _ _ _
      _ ≤ (aDen - aNum) * prevRateNum + aNum * sampleRateNum := Nat.add_le_add h1 h2
  · have h1 : (aDen - aNum) * prevRateNum ≤ (aDen - aNum) * max prevRateNum sampleRateNum :=
      Nat.mul_le_mul_left _ (Nat.le_max_left _ _)
    have h2 : aNum * sampleRateNum ≤ aNum * max prevRateNum sampleRateNum :=
      Nat.mul_le_mul_left _ (Nat.le_max_right _ _)
    calc
      (aDen - aNum) * prevRateNum + aNum * sampleRateNum
          ≤ (aDen - aNum) * max prevRateNum sampleRateNum + aNum * max prevRateNum sampleRateNum :=
          Nat.add_le_add h1 h2
      _ = ((aDen - aNum) + aNum) * max prevRateNum sampleRateNum := (Nat.add_mul _ _ _).symm
      _ = aDen * max prevRateNum sampleRateNum := by rw [← hsplit]

/-- EWMA state model for clock non-positivity invariance. -/
structure EwmaState where
  observedAt : Int
  observedHash : Nat
  changeRate : Nat
  deriving DecidableEq

/-- Zero or backward clock steps preserve EWMA state and clamp TTL to `[initialTTL, maxTTL]`. -/
def ewmaZeroOrBackwardStep (prevTTL initialTTL maxTTL : Nat) (st : EwmaState) (nowMs : Int) :
    Nat × EwmaState :=
  if nowMs ≤ st.observedAt then
    (max initialTTL (min maxTTL prevTTL), st)
  else
    (prevTTL, st)

theorem ewma_nonpositive_elapsed_preserves_state
    (prevTTL initialTTL maxTTL : Nat) (st : EwmaState) (nowMs : Int)
    (hInit : initialTTL ≤ maxTTL) (hClock : nowMs ≤ st.observedAt) :
    let res := ewmaZeroOrBackwardStep prevTTL initialTTL maxTTL st nowMs
    res.2 = st ∧ initialTTL ≤ res.1 ∧ res.1 ≤ maxTTL := by
  dsimp only
  unfold ewmaZeroOrBackwardStep
  simp only [hClock, ↓reduceIte]
  exact ⟨trivial, by omega, by omega⟩

-------------------------------------------------------------------------------
-- 4. Jitter, Negative Stale Window, and Sub-Second L1 Freshness Safety
-------------------------------------------------------------------------------

/-- Jitter factor `(scale - jitterNum) / scale` with `0 ≤ jitterNum ≤ scale` never increases TTL. -/
theorem jitter_never_increases_ttl
    (dataTTL jitterNum scale : Nat) (hScale : 0 < scale) (hJit : jitterNum ≤ scale) :
    (dataTTL * (scale - jitterNum)) / scale ≤ dataTTL := by
  have h1 : dataTTL * (scale - jitterNum) ≤ dataTTL * scale :=
    Nat.mul_le_mul_left dataTTL (by omega)
  have h2 := Nat.div_le_div_right (c := scale) h1
  rwa [Nat.mul_div_cancel dataTTL hScale] at h2

/-- Negative entries with `staleTTL = 0` have an empty stale window:
    no timestamp can be simultaneously `≥ freshUntil` and `< expiresAt`. -/
theorem negative_entry_empty_stale_window (nowMs freshUntil : Nat) :
    let expiresAt := freshUntil + 0
    ¬ (freshUntil ≤ nowMs ∧ nowMs < expiresAt) := by
  omega

/-- Sub-second L1 hydration using `fetchedAt + remainingMs` (captured before Redis TIME)
    NEVER extends authoritative Redis freshness `serverFreshUntil`. -/
theorem l1_ms_hydration_never_extends_redis_freshness
    (fetchedAt redisNow serverFreshUntil : Nat)
    (hOrder : fetchedAt ≤ redisNow) (hFresh : redisNow < serverFreshUntil) :
    let remainingMs := serverFreshUntil - redisNow
    let l1FreshUntil := fetchedAt + remainingMs
    l1FreshUntil ≤ serverFreshUntil := by
  omega

end AdaptiveCache.TtlPolicies
