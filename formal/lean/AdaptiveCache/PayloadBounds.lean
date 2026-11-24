/-
  Formal Lean 4 proofs for @0xdoublesharp/adaptive-cache payload allocation
  bounds, UTF-8/UTF-16 pre-check soundness, and Lua 5th-order Taylor series
  truncation error bounds for EWMA.

  Mirrors:
    - src/payload.ts (sliceBoundedRaw, decodeBoundedBase64)
    - src/redis-lua/adaptiveCacheUpdate.lua (lines 66, 81, 92)
-/

import AdaptiveCache.TtlPolicies

namespace AdaptiveCache.PayloadBounds

open AdaptiveCache.TtlPolicies (ceilDiv ceilDiv_ge ceilDiv_le_of_mul_le ceilDiv_mono)

-------------------------------------------------------------------------------
-- 1. Base64 & Gzip Stored-Block Allocation Bounds (src/payload.ts:22-31)
--
--   maxCompressedBytes(M) = M + ceil(M / 16383) * 5 + 64
--   maxEncodedChars(M)    = ceil(maxCompressedBytes(M) / 3) * 4
-------------------------------------------------------------------------------

/-- Maximum gzip compressed byte length admitted by `decodeBoundedBase64`. -/
def maxCompressedBytes (maxDecodedBytes : Nat) : Nat :=
  maxDecodedBytes + ceilDiv maxDecodedBytes 16383 * 5 + 64

/-- Maximum base64 character length admitted by `decodeBoundedBase64`. -/
def maxEncodedChars (maxDecodedBytes : Nat) : Nat :=
  ceilDiv (maxCompressedBytes maxDecodedBytes) 3 * 4

/-- Exact worst-case gzip stored-block output size (18-byte gzip header/trailer + 5 bytes per 16,383-byte block). -/
def worstCaseGzipBytes (inputBytes : Nat) : Nat :=
  inputBytes + ceilDiv inputBytes 16383 * 5 + 18

/-- Base64 encoded character count for `b` bytes is `ceil(b / 3) * 4`. -/
def base64Chars (bytes : Nat) : Nat :=
  ceilDiv bytes 3 * 4

/-- Every valid gzip output for an input `≤ maxDecodedBytes` is admitted by `decodeBoundedBase64`. -/
theorem bounded_base64_admits_all_valid_gzip (inputBytes maxDecodedBytes : Nat)
    (hLen : inputBytes ≤ maxDecodedBytes) :
    base64Chars (worstCaseGzipBytes inputBytes) ≤ maxEncodedChars maxDecodedBytes := by
  unfold base64Chars maxEncodedChars worstCaseGzipBytes maxCompressedBytes
  have hblocks : ceilDiv inputBytes 16383 ≤ ceilDiv maxDecodedBytes 16383 :=
    ceilDiv_mono inputBytes maxDecodedBytes 16383 hLen
  have hcomp :
      inputBytes + ceilDiv inputBytes 16383 * 5 + 18 ≤
      maxDecodedBytes + ceilDiv maxDecodedBytes 16383 * 5 + 64 := by
    omega
  have hceil :
      ceilDiv (inputBytes + ceilDiv inputBytes 16383 * 5 + 18) 3 ≤
      ceilDiv (maxDecodedBytes + ceilDiv maxDecodedBytes 16383 * 5 + 64) 3 :=
    ceilDiv_mono _ _ 3 hcomp
  exact Nat.mul_le_mul_right 4 hceil

/-- `maxEncodedChars` is strictly linearly bounded: `≤ 2 * maxDecodedBytes + 128`,
    preventing super-linear memory allocation before `zlib.gunzip` `maxOutputLength`. -/
theorem bounded_base64_linear_cap (maxDecodedBytes : Nat) :
    maxEncodedChars maxDecodedBytes ≤ 2 * maxDecodedBytes + 128 := by
  unfold maxEncodedChars maxCompressedBytes
  have hblocks : ceilDiv maxDecodedBytes 16383 ≤ maxDecodedBytes / 16383 + 1 := by
    unfold ceilDiv
    omega
  have hcomp :
      maxDecodedBytes + ceilDiv maxDecodedBytes 16383 * 5 + 64 ≤
      maxDecodedBytes + (maxDecodedBytes / 16383 + 1) * 5 + 64 := by
    omega
  have hdiv : (maxDecodedBytes / 16383) * 5 ≤ maxDecodedBytes / 3200 := by
    omega
  have hcomp2 :
      maxDecodedBytes + ceilDiv maxDecodedBytes 16383 * 5 + 64 ≤
      (3 * (maxDecodedBytes / 2 + 32)) + 3 * (maxDecodedBytes - maxDecodedBytes / 2) := by
    omega
  have htarget :
      maxDecodedBytes + ceilDiv maxDecodedBytes 16383 * 5 + 64 ≤
      (maxDecodedBytes / 2 + 32) * 3 + (maxDecodedBytes - maxDecodedBytes / 2) * 3 := by
    omega
  have h3 :
      ceilDiv (maxDecodedBytes + ceilDiv maxDecodedBytes 16383 * 5 + 64) 3 ≤
      maxDecodedBytes / 2 + 32 + (maxDecodedBytes - maxDecodedBytes / 2) := by
    apply ceilDiv_le_of_mul_le _ 3 _ (by decide)
    omega
  have h4 : maxDecodedBytes / 2 + 32 + (maxDecodedBytes - maxDecodedBytes / 2) = maxDecodedBytes + 32 := by
    omega
  have h5 : ceilDiv (maxDecodedBytes + ceilDiv maxDecodedBytes 16383 * 5 + 64) 3 ≤ maxDecodedBytes + 32 := by
    omega
  -- Tighter factor: 4/3 * comp <= 2 * M + 128
  have htight :
      maxDecodedBytes + ceilDiv maxDecodedBytes 16383 * 5 + 64 ≤ (maxDecodedBytes / 2 + 32) * 3 := by
    -- Wait: for M = 1, M + 1*5 + 64 = 70 <= 32 * 3 = 96!
    -- For general M: M + (M/16383 + 1)*5 + 64 = M + 5*(M/16383) + 69 <= (3/2)*M + 96
    omega
  have hceilTight :
      ceilDiv (maxDecodedBytes + ceilDiv maxDecodedBytes 16383 * 5 + 64) 3 ≤ maxDecodedBytes / 2 + 32 := by
    exact ceilDiv_le_of_mul_le _ 3 _ (by decide) htight
  omega

-------------------------------------------------------------------------------
-- 2. UTF-16 Fast Pre-Check Soundness (src/payload.ts:16-20)
--
-- Every UTF-16 code unit encodes to 1, 2, or 3 UTF-8 bytes (a valid surrogate
-- pair of 2 UTF-16 code units encodes to 4 UTF-8 bytes, i.e., 2 per unit).
-- Therefore utf8ByteLength >= utf16Length always holds.
-------------------------------------------------------------------------------

/-- If every code unit contributes at least 1 UTF-8 byte, then any slice exceeding
    `maxDecodedBytes` in UTF-16 length necessarily exceeds `maxDecodedBytes` in UTF-8 bytes. -/
theorem utf16_precheck_sound (utf16Len utf8Len maxDecodedBytes : Nat)
    (hGe : utf16Len ≤ utf8Len)
    (hExceed : maxDecodedBytes < utf16Len) :
    maxDecodedBytes < utf8Len := by
  omega

-------------------------------------------------------------------------------
-- 3. Lua 5th-Order Taylor Truncation Error Bounds (adaptiveCacheUpdate.lua:66,81)
--
-- For 0 < p <= 10^-4:
--   -log(1 - p) - (p + p^2/2 + p^3/3 + p^4/4 + p^5/5)
--     = sum_{k>=6} p^k / k <= (p^6 / 6) * (1 / (1 - p))
-- For 0 < x <= 10^-4:
--   |(1 - exp(-x)) - (x - x^2/2 + x^3/6 - x^4/24 + x^5/120)| <= x^6 / 720
--
-- We prove exact integer cross-multiplied inequalities showing both remainders
-- are strictly below 10^-24 (more than 12 orders of magnitude smaller than
-- EWMA's 1e-12 cjson tolerance).
-------------------------------------------------------------------------------

/-- For `p = pNum / 10^k` with `p ≤ 1 / 10000`, the tail bound
    `(p^6 / 6) / (1 - p)` is strictly below `10^-24`.
    Exact cross-multiplied form for `p = num / den` with `0 < den` and `10000 * num ≤ den`:
    `10^24 * num^6 < 6 * (den - num) * den^5`. -/
theorem lua_log1p_taylor5_remainder_lt_1e24 (num den : Nat)
    (hDen : 0 < den) (hSmall : 10000 * num ≤ den) :
    10 ^ 24 * num ^ 6 < 6 * (den - num) * den ^ 5 := by
  have h1 : (10000 * num) ^ 6 ≤ den ^ 6 := Nat.pow_le_pow_left hSmall 6
  have hpow : (10000 * num) ^ 6 = 10 ^ 24 * num ^ 6 := by
    rw [Nat.mul_pow]
  rw [hpow] at h1
  have hden6 : den ^ 6 = den * den ^ 5 := by
    rw [Nat.pow_succ, Nat.mul_comm]
  have hden5pos : 0 < den ^ 5 := Nat.pow_pos hDen
  have hlt : den < 6 * (den - num) := by omega
  have hmul : den * den ^ 5 < 6 * (den - num) * den ^ 5 :=
    Nat.mul_lt_mul_of_pos_right hlt hden5pos
  omega

/-- For `x = num / den` with `0 < den` and `10000 * num ≤ den`, the alternating
    5th-order Taylor remainder `x^6 / 720` for `1 - exp(-x)` is strictly `< 10^-26`:
    `10^26 * num^6 < 720 * den^6`. -/
theorem lua_expm1_taylor5_remainder_lt_1e26 (num den : Nat)
    (hDen : 0 < den) (hSmall : 10000 * num ≤ den) :
    10 ^ 26 * num ^ 6 < 720 * den ^ 6 := by
  have h1 : (10000 * num) ^ 6 ≤ den ^ 6 := Nat.pow_le_pow_left hSmall 6
  have hpow : (10000 * num) ^ 6 = 10 ^ 24 * num ^ 6 := by
    rw [Nat.mul_pow]
  rw [hpow] at h1
  have hden6pos : 0 < den ^ 6 := Nat.pow_pos hDen
  have hmul : 100 * (10 ^ 24 * num ^ 6) ≤ 100 * den ^ 6 := Nat.mul_le_mul_left 100 h1
  have h100 : 100 * (10 ^ 24 * num ^ 6) = 10 ^ 26 * num ^ 6 := by
    rw [← Nat.mul_assoc]
  omega

end AdaptiveCache.PayloadBounds
