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
-- Total Key Framing Injectivity (src/utils.ts:62-84 & src/httpPolicy.ts:250-285)
--
-- HTTP cache keys have four mutually disjoint framed shapes:
--   1. Default unvaried: prefix ++ "authority:" ++ authHash ++ ":" ++ pathKey ++ ":" ++ queryHash ++ ":"
--   2. Default varied:   prefix ++ "authority:" ++ authHash ++ ":" ++ pathKey ++ ":" ++ queryHash ++ ":vary:" ++ varyHash ++ ":v"
--   3. Custom unvaried:  prefix ++ "/custom/" ++ customHash ++ ":" ++ queryHash ++ ":"
--   4. Custom varied:    prefix ++ "/custom/" ++ customHash ++ ":" ++ queryHash ++ ":vary:" ++ varyHash ++ ":v"
--
-- Unvaried keys terminate with `':'`, while varied keys terminate with `'v'`, so varied and
-- unvaried adapters can share a prefix without ever colliding. Likewise, default keys begin
-- after `prefix` with `'a'` (`"authority:"`) while custom keys begin with `'/'` (`"/custom/"`),
-- so default and custom keys are also mutually disjoint.
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

/-- Varied HTTP cache key framing (`varyBy` configured, terminated by `:v`) with fixed-length
    SHA-256 authority, query, and variation digests is injective in all four components. -/
theorem http_varied_key_components_unique
    (prefixChars auth1 auth2 path1 path2 query1 query2 vary1 vary2 : List Char)
    (hAuthLen : auth1.length = 64 ∧ auth2.length = 64)
    (hQueryLen : query1.length = 64 ∧ query2.length = 64)
    (hVaryLen : vary1.length = 64 ∧ vary2.length = 64)
    (hEq :
      (prefixChars ++ "authority:".toList ++ auth1 ++ [':']) ++ path1 ++
        ([':'] ++ query1 ++ ":vary:".toList ++ vary1 ++ [':', 'v']) =
      (prefixChars ++ "authority:".toList ++ auth2 ++ [':']) ++ path2 ++
        ([':'] ++ query2 ++ ":vary:".toList ++ vary2 ++ [':', 'v'])) :
    auth1 = auth2 ∧ path1 = path2 ∧ query1 = query2 ∧ vary1 = vary2 := by
  have hLenL :
      (prefixChars ++ "authority:".toList ++ auth1 ++ [':']).length =
      (prefixChars ++ "authority:".toList ++ auth2 ++ [':']).length := by
    simp [hAuthLen.1, hAuthLen.2]
  have hLenR :
      ([':'] ++ query1 ++ ":vary:".toList ++ vary1 ++ [':', 'v']).length =
      ([':'] ++ query2 ++ ":vary:".toList ++ vary2 ++ [':', 'v']).length := by
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

/-- An unvaried HTTP key (ending in `':'`) can NEVER collide with a varied HTTP key (ending in `'v'`),
    even when both share the same prefix and arbitrary path strings contain `":vary:"`. -/
theorem http_unvaried_ne_varied (u v : List Char) :
    u ++ [':'] ≠ v ++ [':', 'v'] := by
  intro hEq
  have hTail : u ++ [':'] = (v ++ [':']) ++ ['v'] := by
    simpa [List.append_assoc] using hEq
  have hLast := congrArg List.getLast? hTail
  simp at hLast

/-- A default HTTP key (`prefix ++ "authority:" ++ ...`) can NEVER collide with a custom HTTP key
    (`prefix ++ "/custom/" ++ ...`) sharing the same prefix. -/
theorem http_default_ne_custom (prefixChars r1 r2 : List Char) :
    prefixChars ++ "authority:".toList ++ r1 ≠ prefixChars ++ "/custom/".toList ++ r2 := by
  intro hEq
  rw [List.append_assoc, List.append_assoc] at hEq
  have hRight := List.append_inj_right hEq rfl
  have hHead := congrArg List.head? hRight
  simp at hHead

/-- Unified HTTP key identity across all 4 `(default/custom) × (unvaried/varied)` key shapes. -/
inductive HttpKeySpec where
  | defaultKey (auth path query : List Char) (vary : Option (List Char))
  | customKey (customHash query : List Char) (vary : Option (List Char))
  deriving DecidableEq

def encodeHttpKey (prefixChars : List Char) : HttpKeySpec → List Char
  | .defaultKey auth path query none =>
      (prefixChars ++ "authority:".toList ++ auth ++ [':']) ++ path ++ ([':'] ++ query ++ [':'])
  | .defaultKey auth path query (some vary) =>
      (prefixChars ++ "authority:".toList ++ auth ++ [':']) ++ path ++
        ([':'] ++ query ++ ":vary:".toList ++ vary ++ [':', 'v'])
  | .customKey customHash query none =>
      prefixChars ++ "/custom/".toList ++ customHash ++ [':'] ++ query ++ [':']
  | .customKey customHash query (some vary) =>
      prefixChars ++ "/custom/".toList ++ customHash ++ [':'] ++ query ++ ":vary:".toList ++ vary ++ [':', 'v']

def validHttpKeySpec : HttpKeySpec → Prop
  | .defaultKey auth _ query none => auth.length = 64 ∧ query.length = 64
  | .defaultKey auth _ query (some vary) => auth.length = 64 ∧ query.length = 64 ∧ vary.length = 64
  | .customKey customHash query none => customHash.length = 64 ∧ query.length = 64
  | .customKey customHash query (some vary) => customHash.length = 64 ∧ query.length = 64 ∧ vary.length = 64

/-- Total HTTP key injectivity: two valid HTTP keys under the same prefix are equal if and only if
    they have the exact same variant (default vs custom, unvaried vs varied) and identical components. -/
theorem http_key_total_injective (prefixChars : List Char) (k1 k2 : HttpKeySpec)
    (h1 : validHttpKeySpec k1) (h2 : validHttpKeySpec k2)
    (hEq : encodeHttpKey prefixChars k1 = encodeHttpKey prefixChars k2) :
    k1 = k2 := by
  cases k1 with
  | defaultKey a1 p1 q1 v1 =>
    cases k2 with
    | customKey c2 q2 v2 =>
      cases v1 <;> cases v2 <;> simp only [encodeHttpKey] at hEq
      all_goals
        have hNe := http_default_ne_custom prefixChars
        simp only [List.append_assoc] at hEq hNe
        exact absurd hEq (hNe _ _)
    | defaultKey a2 p2 q2 v2 =>
      cases v1 with
      | none =>
        cases v2 with
        | none =>
          simp only [encodeHttpKey] at hEq
          have ⟨ha, hp, hq⟩ := http_key_components_unique prefixChars a1 a2 p1 p2 q1 q2 ⟨h1.1, h2.1⟩ ⟨h1.2, h2.2⟩ hEq
          subst ha; subst hp; subst hq; rfl
        | some w2 =>
          simp only [encodeHttpKey] at hEq
          exfalso
          have hNe := http_unvaried_ne_varied
            ((prefixChars ++ "authority:".toList ++ a1 ++ [':']) ++ p1 ++ ([':'] ++ q1))
            ((prefixChars ++ "authority:".toList ++ a2 ++ [':']) ++ p2 ++ ([':'] ++ q2 ++ ":vary:".toList ++ w2))
          simp only [List.append_assoc] at hEq hNe
          exact hNe hEq
      | some w1 =>
        cases v2 with
        | none =>
          simp only [encodeHttpKey] at hEq
          exfalso
          have hNe := http_unvaried_ne_varied
            ((prefixChars ++ "authority:".toList ++ a2 ++ [':']) ++ p2 ++ ([':'] ++ q2))
            ((prefixChars ++ "authority:".toList ++ a1 ++ [':']) ++ p1 ++ ([':'] ++ q1 ++ ":vary:".toList ++ w1))
          simp only [List.append_assoc] at hEq hNe
          exact hNe hEq.symm
        | some w2 =>
          simp only [encodeHttpKey] at hEq
          have ⟨ha, hp, hq, hw⟩ := http_varied_key_components_unique prefixChars a1 a2 p1 p2 q1 q2 w1 w2
            ⟨h1.1, h2.1⟩ ⟨h1.2.1, h2.2.1⟩ ⟨h1.2.2, h2.2.2⟩ hEq
          subst ha; subst hp; subst hq; subst hw; rfl
  | customKey c1 q1 v1 =>
    cases k2 with
    | defaultKey a2 p2 q2 v2 =>
      cases v1 <;> cases v2 <;> simp only [encodeHttpKey] at hEq
      all_goals
        have hNe := http_default_ne_custom prefixChars
        simp only [List.append_assoc] at hEq hNe
        exact absurd hEq.symm (hNe _ _)
    | customKey c2 q2 v2 =>
      cases v1 with
      | none =>
        cases v2 with
        | none =>
          simp only [encodeHttpKey] at hEq
          have hRest : c1 ++ [':'] ++ q1 ++ [':'] = c2 ++ [':'] ++ q2 ++ [':'] := by
            have hL : (prefixChars ++ "/custom/".toList) ++ (c1 ++ [':'] ++ q1 ++ [':']) =
                      (prefixChars ++ "/custom/".toList) ++ (c2 ++ [':'] ++ q2 ++ [':']) := by
              simpa [List.append_assoc] using hEq
            exact List.append_inj_right hL rfl
          have hNoEnd : c1 ++ [':'] ++ q1 = c2 ++ [':'] ++ q2 := List.append_inj_left' hRest rfl
          have hq : q1 = q2 := List.append_inj_right' hNoEnd (h1.2.trans h2.2.symm)
          have hc1 : c1 ++ [':'] = c2 ++ [':'] := List.append_inj_left' hNoEnd (h1.2.trans h2.2.symm)
          have hc : c1 = c2 := List.append_inj_left' hc1 rfl
          subst hc; subst hq; rfl
        | some w2 =>
          simp only [encodeHttpKey] at hEq
          exfalso
          have hNe := http_unvaried_ne_varied
            (prefixChars ++ "/custom/".toList ++ c1 ++ [':'] ++ q1)
            (prefixChars ++ "/custom/".toList ++ c2 ++ [':'] ++ q2 ++ ":vary:".toList ++ w2)
          simp only [List.append_assoc] at hEq hNe
          exact hNe hEq
      | some w1 =>
        cases v2 with
        | none =>
          simp only [encodeHttpKey] at hEq
          exfalso
          have hNe := http_unvaried_ne_varied
            (prefixChars ++ "/custom/".toList ++ c2 ++ [':'] ++ q2)
            (prefixChars ++ "/custom/".toList ++ c1 ++ [':'] ++ q1 ++ ":vary:".toList ++ w1)
          simp only [List.append_assoc] at hEq hNe
          exact hNe hEq.symm
        | some w2 =>
          simp only [encodeHttpKey] at hEq
          have hRest : c1 ++ [':'] ++ q1 ++ ":vary:".toList ++ w1 ++ [':', 'v'] =
                       c2 ++ [':'] ++ q2 ++ ":vary:".toList ++ w2 ++ [':', 'v'] := by
            have hL : (prefixChars ++ "/custom/".toList) ++ (c1 ++ [':'] ++ q1 ++ ":vary:".toList ++ w1 ++ [':', 'v']) =
                      (prefixChars ++ "/custom/".toList) ++ (c2 ++ [':'] ++ q2 ++ ":vary:".toList ++ w2 ++ [':', 'v']) := by
              simpa [List.append_assoc] using hEq
            exact List.append_inj_right hL rfl
          have h1' : c1 ++ [':'] ++ q1 ++ ":vary:".toList ++ w1 = c2 ++ [':'] ++ q2 ++ ":vary:".toList ++ w2 :=
            List.append_inj_left' hRest rfl
          have hw : w1 = w2 := List.append_inj_right' h1' (h1.2.2.trans h2.2.2.symm)
          have h2' : c1 ++ [':'] ++ q1 ++ ":vary:".toList = c2 ++ [':'] ++ q2 ++ ":vary:".toList :=
            List.append_inj_left' h1' (h1.2.2.trans h2.2.2.symm)
          have h3' : c1 ++ [':'] ++ q1 = c2 ++ [':'] ++ q2 := List.append_inj_left' h2' rfl
          have hq : q1 = q2 := List.append_inj_right' h3' (h1.2.1.trans h2.2.1.symm)
          have h4' : c1 ++ [':'] = c2 ++ [':'] := List.append_inj_left' h3' (h1.2.1.trans h2.2.1.symm)
          have hc : c1 = c2 := List.append_inj_left' h4' rfl
          subst hc; subst hq; subst hw; rfl

end AdaptiveCache.HttpPolicy
