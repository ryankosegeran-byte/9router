# Antigravity Proactive Quota Failover — Design

Date: 2026-10-24
Branch: `feat/antigravity-proactive-quota-failover`

## Problem

Antigravity multi-account rotation on exhaustion already works. Three gaps remain:

1. **Lazy cache** — `quotaCache` (RAM) is populated only after a request hits 409/429
   (`src/sse/handlers/chat.js:366`). An account at 5% keeps serving until it fails.
2. **RAM-only** — the block lives in a module-level `Map`. Container restart clears it;
   every account looks available again → 429 burst.
3. **Unintentional reactivation** — nothing clears a block when `resetAt` passes; it only
   works because `getProviderCredentials` re-checks the timestamp (`auth.js:96`).

## Non-goals

- Rewriting existing rotation / fallback logic.
- Touching non-antigravity providers.
- Changing `modelLock_*` semantics or the strike-breaker logic
  (`antigravityQuota.js:20-50, 253-284`).
- New dependencies.

## Decisions

- **Persistence shape: reuse `modelLock_<model>` as-is.** The auth pre-filter already reads
  it through `isModelLockActive`, so `auth.js` needs no change. Survives restart for free
  (flat field in the connection `data` blob), auto-unblocks for free (timestamp expiry).
- **Threshold + interval: env vars only.**
  `AG_QUOTA_THRESHOLD_PCT` (default `0` = current behavior), `AG_QUOTA_SWEEP_MS`
  (default `300000`). `DISABLE_AG_QUOTA_SWEEP` disables the scheduler.
- **Auto-unblock (gap C) is lazy expiry, no explicit clear.** Because the block is
  indistinguishable from a strike/backoff `modelLock_`, an explicit clear in the sweep
  would clobber those locks — violating the "do not change `modelLock_*` semantics"
  constraint. `isModelLockActive` already unblocks once the timestamp passes.

## Components

### 1. `src/sse/services/antigravityQuota.js` (extended)

Add `persistAntigravityQuotaBlock(connectionId, model, resetAt)`:

- Fail-open: no-op on missing args, non-finite/past `resetAt`, or DB error.
- Writes `buildModelLockUpdate(model, resetMs - Date.now())` from
  `open-sse/services/accountFallback.js` via `updateProviderConnection`.
- Called from **two** places: the sweep, and `handleAntigravityQuotaError` on the genuine
  exhausted path (`remainingPercentage <= 0`, future `resetAt`). The strike-breaker path is
  **not** persisted (keeps strike semantics RAM-only).

### 2. `src/sse/services/antigravityQuotaSweep.js` (new)

Timer module mirroring `backgroundTokenRefresh.js` (idempotent start, `unref`, fail-open
tick, in-flight guard).

- Loads `getProviderConnections({ provider: "antigravity", isActive: true })`.
- Sequentially, per connection: `refreshAntigravityQuota(id, token, providerSpecificData)`
  (reuses existing 30s throttle + in-flight dedup), then for each model id from
  `open-sse/providers/registry/antigravity.js` (non-image, family-mappable) reads
  `getAntigravityModelQuota` and collects a candidate when
  `remainingPercentage <= threshold` and `resetAt` is in the future.
- Stagger delay + jitter between connections (Google is sensitive).
- Collects **all** candidates first, then persists — so the fairness guard runs per model.

Pure helpers (unit-tested without timers):

- `getAntigravityQuotaThresholdPct()` / `getAntigravitySweepIntervalMs()` — env parsing.
- `listAntigravityModelIds()` — registry non-image, family-mappable ids.
- `selectBlocksToPersist(candidates, allConnectionIds, thresholdPct)` — fairness guard:
  if a model's candidates cover **every** loaded connection and the best candidate still has
  `remainingPercentage > 0` (a drain/high-threshold situation), drop that best candidate so
  the last non-empty account keeps serving. At `threshold = 0` every candidate is truly 0%,
  so no drop happens — blocking all matches current behavior.

### 3. `src/shared/services/initializeApp.js`

Start the sweep from `runHeavyStartup`, next to `startBackgroundTokenRefresh`, dynamic
import + `.catch`. `custom-server.js` untouched (`initializeApp` always runs in the Next
process).

## Data flow

```
initializeApp → startAntigravityQuotaSweep (interval)
  tick → getProviderConnections(antigravity, active)
       → per conn: refreshAntigravityQuota → getAntigravityModelQuota
       → collect candidates (<= threshold, future resetAt)
       → selectBlocksToPersist (fairness guard)
       → persistAntigravityQuotaBlock → updateProviderConnection(modelLock_<model>)
next request → getProviderCredentials → isModelLockActive skips blocked pairs
restart      → modelLock_ survives → still skipped
resetAt pass → isModelLockActive false → account back in rotation
```

## Error handling

- Sweep tick: top-level try/catch and per-connection try/catch; a failed poll never throws.
- Persist: swallowed DB errors.
- `refreshAntigravityQuota` already fail-opens (returns `null` on failure).

## Testing

`tests/unit/antigravity-quota-sweep.test.js` (vitest, mirrors
`tests/unit/antigravity-quota-routing.test.js` mocks):

- threshold 0: exhausted family bucket → persists `modelLock_<model>` for the family models.
- threshold > 0 drain: two connections both below threshold → fairness guard keeps one.
- failed poll → no persist, tick resolves (fail-open).
- past/absent `resetAt` → no persist.
- only antigravity connections queried (`provider: "antigravity"`).
- `handleAntigravityQuotaError` exhausted path persists; strike path does not.
- env parsing defaults.

## Deliberate simplifications

- `ponytail:` a `threshold > 0` block on a weekly bucket blocks for ~1 week — aggressive.
  Default `0` avoids it.
- `ponytail:` the sweep does not refresh OAuth tokens; it relies on the existing token
  refresh job. A poll with a stale token fail-opens to no-op.
- `ponytail:` block and backoff share `modelLock_`; if both later need independent clearing,
  introduce a distinct key namespace.

## Unverified / out of scope

- No dashboard UI for the threshold (env only).
- No RAM-cache rehydration at boot (not needed — `modelLock_` is the persisted channel).
- No live upstream verification (unit tests only).
