/-
  Formal Lean 4 proofs for @0xdoublesharp/adaptive-cache HTTP request/response
  cacheability, credential isolation, Vary safety, and 404 negativeTTL bounds.

  Mirrors:
    - src/httpPolicy.ts
    - src/AdaptiveExpressCache.ts
    - src/AdaptiveFastifyCache.ts
-/

namespace AdaptiveCache.HttpPolicy

inductive HttpMethod where
  | GET
  | HEAD
  | POST
  | PUT
  | DELETE
  | OTHER
  deriving DecidableEq

structure PolicyOptions where
  hasCustomKey : Bool
  hasVaryFn : Bool
  declaredVary : List String
  cacheAuthenticated : Bool
  cacheCookies : Bool
  negativeTTL : Option Nat
  shouldCacheReq : Bool
  shouldCacheRes : Bool

structure HttpRequest where
  method : HttpMethod
  hasRange : Bool
  hasIfRange : Bool
  reqCacheControl : List String
  hasAuthorization : Bool
  hasCookie : Bool

structure HttpResponse where
  statusCode : Nat
  resCacheControl : List String
  hasSetCookie : Bool
  varyHeaders : List String

def hasDirective (directives : List String) (forbidden : List String) : Bool :=
  directives.any (fun d => forbidden.contains d)

def hasCallerOwnedIsolation (opts : PolicyOptions) (sensitiveHeader : String) : Bool :=
  opts.hasCustomKey || opts.hasVaryFn || opts.declaredVary.contains sensitiveHeader

def isRequestCacheable (req : HttpRequest) (opts : PolicyOptions) : Bool :=
  (req.method == HttpMethod.GET) &&
  !req.hasRange &&
  !req.hasIfRange &&
  !hasDirective req.reqCacheControl ["no-store", "no-cache"] &&
  (!req.hasAuthorization || (opts.cacheAuthenticated && hasCallerOwnedIsolation opts "authorization")) &&
  (!req.hasCookie || (opts.cacheCookies && hasCallerOwnedIsolation opts "cookie")) &&
  opts.shouldCacheReq

def hasPositiveNegativeTTL (opts : PolicyOptions) : Bool :=
  match opts.negativeTTL with
  | some n => decide (0 < n)
  | none => false

def isResponseCacheable (res : HttpResponse) (opts : PolicyOptions) : Bool :=
  let negative := (res.statusCode == 404) && hasPositiveNegativeTTL opts
  let statusOk := (res.statusCode != 206) && ((decide (200 ≤ res.statusCode ∧ res.statusCode < 300)) || negative)
  let ccOk := !hasDirective res.resCacheControl ["private", "no-store", "no-cache"]
  let cookieOk := !res.hasSetCookie
  let varyOk :=
    !res.varyHeaders.contains "*" &&
    res.varyHeaders.all (fun h => opts.declaredVary.contains h)
  statusOk && ccOk && cookieOk && varyOk && opts.shouldCacheRes

def boundedNegativeTTL (negativeTTL : Option Nat) (maxTTL : Nat) : Option Nat :=
  match negativeTTL with
  | some n => if 0 < n then some (min n maxTTL) else none
  | none => none

-------------------------------------------------------------------------------
-- Request Policy Soundness Theorems
-------------------------------------------------------------------------------

theorem non_get_never_cacheable (req : HttpRequest) (opts : PolicyOptions)
    (h : req.method ≠ HttpMethod.GET) :
    isRequestCacheable req opts = false := by
  unfold isRequestCacheable
  cases hm : req.method <;> simp_all

theorem range_never_cacheable (req : HttpRequest) (opts : PolicyOptions)
    (h : req.hasRange = true ∨ req.hasIfRange = true) :
    isRequestCacheable req opts = false := by
  unfold isRequestCacheable
  rcases h with hr | hir
  · simp [hr]
  · simp [hir]

theorem request_no_store_or_no_cache_bypasses (req : HttpRequest) (opts : PolicyOptions)
    (h : hasDirective req.reqCacheControl ["no-store", "no-cache"] = true) :
    isRequestCacheable req opts = false := by
  unfold isRequestCacheable
  simp [h]

theorem authorization_requires_opt_in_and_isolation (req : HttpRequest) (opts : PolicyOptions)
    (hAuth : req.hasAuthorization = true)
    (hCache : isRequestCacheable req opts = true) :
    opts.cacheAuthenticated = true ∧ hasCallerOwnedIsolation opts "authorization" = true := by
  unfold isRequestCacheable at hCache
  simp only [hAuth, Bool.not_true, Bool.false_or, Bool.and_eq_true] at hCache
  exact ⟨hCache.1.1.2.1, hCache.1.1.2.2⟩

theorem cookie_requires_opt_in_and_isolation (req : HttpRequest) (opts : PolicyOptions)
    (hCookie : req.hasCookie = true)
    (hCache : isRequestCacheable req opts = true) :
    opts.cacheCookies = true ∧ hasCallerOwnedIsolation opts "cookie" = true := by
  unfold isRequestCacheable at hCache
  simp only [hCookie, Bool.not_true, Bool.false_or, Bool.and_eq_true] at hCache
  exact ⟨hCache.1.2.1, hCache.1.2.2⟩

-------------------------------------------------------------------------------
-- Response Policy Soundness Theorems
-------------------------------------------------------------------------------

theorem partial_206_never_cacheable (res : HttpResponse) (opts : PolicyOptions)
    (h : res.statusCode = 206) :
    isResponseCacheable res opts = false := by
  unfold isResponseCacheable
  simp [h]

theorem private_or_no_store_or_no_cache_never_stored (res : HttpResponse) (opts : PolicyOptions)
    (h : hasDirective res.resCacheControl ["private", "no-store", "no-cache"] = true) :
    isResponseCacheable res opts = false := by
  unfold isResponseCacheable
  simp [h]

theorem set_cookie_never_stored (res : HttpResponse) (opts : PolicyOptions)
    (h : res.hasSetCookie = true) :
    isResponseCacheable res opts = false := by
  unfold isResponseCacheable
  simp [h]

theorem vary_star_never_stored (res : HttpResponse) (opts : PolicyOptions)
    (h : res.varyHeaders.contains "*" = true) :
    isResponseCacheable res opts = false := by
  unfold isResponseCacheable
  dsimp only
  rw [h]
  simp

theorem undeclared_vary_never_stored (res : HttpResponse) (opts : PolicyOptions)
    (h : ∃ header ∈ res.varyHeaders, opts.declaredVary.contains header = false) :
    isResponseCacheable res opts = false := by
  rcases h with ⟨header, hmem, hnot⟩
  unfold isResponseCacheable
  dsimp only
  have hall : res.varyHeaders.all (fun h => opts.declaredVary.contains h) = false := by
    rw [List.all_eq_false]
    exact ⟨header, hmem, by rw [hnot]; decide⟩
  rw [hall]
  simp

theorem status_404_requires_positive_negative_ttl (res : HttpResponse) (opts : PolicyOptions)
    (h404 : res.statusCode = 404)
    (hCache : isResponseCacheable res opts = true) :
    ∃ n, opts.negativeTTL = some n ∧ 0 < n := by
  unfold isResponseCacheable at hCache
  dsimp only at hCache
  rw [h404] at hCache
  simp only [beq_self_eq_true, Bool.true_and, bne_iff_ne, ne_eq, Bool.and_eq_true] at hCache
  have hpos : hasPositiveNegativeTTL opts = true := by
    have hs := hCache.1.1.1.1.2
    simp only [Bool.or_eq_true, decide_eq_true_eq] at hs
    rcases hs with ⟨_, hlt⟩ | hneg
    · omega
    · exact hneg
  unfold hasPositiveNegativeTTL at hpos
  cases hopt : opts.negativeTTL with
  | none => simp [hopt] at hpos
  | some n =>
    simp [hopt] at hpos
    exact ⟨n, rfl, hpos⟩

theorem bounded_negative_ttl_caps_both (n maxTTL : Nat) (hPos : 0 < n) :
    ∃ eff, boundedNegativeTTL (some n) maxTTL = some eff ∧ eff ≤ n ∧ eff ≤ maxTTL := by
  unfold boundedNegativeTTL
  simp only [hPos, ↓reduceIte]
  exact ⟨min n maxTTL, rfl, Nat.min_le_left _ _, Nat.min_le_right _ _⟩

-------------------------------------------------------------------------------
-- Key Framing Injectivity (src/utils.ts:61-83 & src/httpPolicy.ts:206-233)
--
-- Default HTTP keys have the framed structure:
--   Unvaried: prefix ++ "authority:" ++ authHash ++ ":" ++ pathKey ++ ":" ++ queryHash ++ ":"
--   Varied:   prefix ++ "authority:" ++ authHash ++ ":" ++ pathKey ++ ":" ++ queryHash ++ ":vary:" ++ varyHash ++ ":"
-- where authHash, queryHash, and varyHash are fixed-length 64-char SHA-256 hex digests.
-- For a fixed suffix shape (all keys unvaried, or all keys varied under one adapter/prefix),
-- fixed-length framing from left and right makes the mapping injective even if `pathKey`
-- contains arbitrary `:` or `"vary:"` substrings (modulo SHA-256 collisions).
-- Note: mixing varied and unvaried adapters under the same `keyPrefix` is outside this
-- fixed-suffix theorem; distinct adapters with different `varyBy` shapes should use distinct prefixes.
-------------------------------------------------------------------------------

/-- List-level framing helper: concatenating a fixed-length left frame, arbitrary middle payload,
    and fixed-length right frame is injective in all three components. -/
theorem framed_key_injective {α : Type}
    (L₁ L₂ M₁ M₂ R₁ R₂ : List α)
    (hLenL : L₁.length = L₂.length)
    (hLenR : R₁.length = R₂.length)
    (hEq : L₁ ++ M₁ ++ R₁ = L₂ ++ M₂ ++ R₂) :
    L₁ = L₂ ∧ M₁ = M₂ ∧ R₁ = R₂ := by
  have hAssoc1 : L₁ ++ M₁ ++ R₁ = L₁ ++ (M₁ ++ R₁) := List.append_assoc L₁ M₁ R₁
  have hAssoc2 : L₂ ++ M₂ ++ R₂ = L₂ ++ (M₂ ++ R₂) := List.append_assoc L₂ M₂ R₂
  rw [hAssoc1, hAssoc2] at hEq
  have ⟨hL, hMR⟩ := List.append_inj hEq hLenL
  have hLenM : M₁.length = M₂.length := by
    have h1 := congrArg List.length hMR
    simp only [List.length_append] at h1
    omega
  have ⟨hM, hR⟩ := List.append_inj hMR hLenM
  exact ⟨hL, hM, hR⟩

/-- Default unvaried HTTP cache key framing with fixed-length SHA-256 authority and query digests
    is injective in `(authDigest, pathKey, queryDigest)` even when `pathKey` contains colons. -/
theorem http_key_components_unique
    (prefixChars auth1 auth2 path1 path2 query1 query2 : List Char)
    (hAuthLen : auth1.length = 64 ∧ auth2.length = 64)
    (hQueryLen : query1.length = 64 ∧ query2.length = 64)
    (hEq :
      (prefixChars ++ "authority:".toList ++ auth1 ++ [':']) ++ path1 ++ ([':'] ++ query1 ++ [':']) =
      (prefixChars ++ "authority:".toList ++ auth2 ++ [':']) ++ path2 ++ ([':'] ++ query2 ++ [':'])) :
    auth1 = auth2 ∧ path1 = path2 ∧ query1 = query2 := by
  have hLenL :
      (prefixChars ++ "authority:".toList ++ auth1 ++ [':']).length =
      (prefixChars ++ "authority:".toList ++ auth2 ++ [':']).length := by
    simp [hAuthLen.1, hAuthLen.2]
  have hLenR :
      ([':'] ++ query1 ++ [':']).length =
      ([':'] ++ query2 ++ [':']).length := by
    simp [hQueryLen.1, hQueryLen.2]
  have ⟨hL, hPath, hR⟩ := framed_key_injective _ _ _ _ _ _ hLenL hLenR hEq
  have hAuth : auth1 = auth2 := by
    have h1 := List.append_inj_left' hL rfl
    exact List.append_inj_right' h1 (hAuthLen.1.trans hAuthLen.2.symm)
  have hQuery : query1 = query2 := by
    have h1 := List.append_inj_left' hR rfl
    exact List.append_inj_right' h1 (hQueryLen.1.trans hQueryLen.2.symm)
  exact ⟨hAuth, hPath, hQuery⟩

/-- Varied HTTP cache key framing (`varyBy` configured) with fixed-length SHA-256 authority,
    query, and variation digests is injective in `(authDigest, pathKey, queryDigest, varyDigest)`. -/
theorem http_varied_key_components_unique
    (prefixChars auth1 auth2 path1 path2 query1 query2 vary1 vary2 : List Char)
    (hAuthLen : auth1.length = 64 ∧ auth2.length = 64)
    (hQueryLen : query1.length = 64 ∧ query2.length = 64)
    (hVaryLen : vary1.length = 64 ∧ vary2.length = 64)
    (hEq :
      (prefixChars ++ "authority:".toList ++ auth1 ++ [':']) ++ path1 ++
        ([':'] ++ query1 ++ ":vary:".toList ++ vary1 ++ [':']) =
      (prefixChars ++ "authority:".toList ++ auth2 ++ [':']) ++ path2 ++
        ([':'] ++ query2 ++ ":vary:".toList ++ vary2 ++ [':'])) :
    auth1 = auth2 ∧ path1 = path2 ∧ query1 = query2 ∧ vary1 = vary2 := by
  have hLenL :
      (prefixChars ++ "authority:".toList ++ auth1 ++ [':']).length =
      (prefixChars ++ "authority:".toList ++ auth2 ++ [':']).length := by
    simp [hAuthLen.1, hAuthLen.2]
  have hLenR :
      ([':'] ++ query1 ++ ":vary:".toList ++ vary1 ++ [':']).length =
      ([':'] ++ query2 ++ ":vary:".toList ++ vary2 ++ [':']).length := by
    simp [hQueryLen.1, hQueryLen.2, hVaryLen.1, hVaryLen.2]
  have ⟨hL, hPath, hR⟩ := framed_key_injective _ _ _ _ _ _ hLenL hLenR hEq
  have hAuth : auth1 = auth2 := by
    have h1 := List.append_inj_left' hL rfl
    exact List.append_inj_right' h1 (hAuthLen.1.trans hAuthLen.2.symm)
  have hR1 : [':'] ++ query1 ++ ":vary:".toList ++ vary1 = [':'] ++ query2 ++ ":vary:".toList ++ vary2 :=
    List.append_inj_left' hR rfl
  have hVary : vary1 = vary2 :=
    List.append_inj_right' hR1 (hVaryLen.1.trans hVaryLen.2.symm)
  have hR2 : [':'] ++ query1 ++ ":vary:".toList = [':'] ++ query2 ++ ":vary:".toList :=
    List.append_inj_left' hR1 (hVaryLen.1.trans hVaryLen.2.symm)
  have hR3 : [':'] ++ query1 = [':'] ++ query2 :=
    List.append_inj_left' hR2 rfl
  have hQuery : query1 = query2 :=
    List.append_inj_right' hR3 (hQueryLen.1.trans hQueryLen.2.symm)
  exact ⟨hAuth, hPath, hQuery, hVary⟩

end AdaptiveCache.HttpPolicy
