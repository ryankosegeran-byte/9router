/**
 * Cloudflare Workers AI usage — synthetic "Daily neurons" row.
 *
 * CF exposes no REST endpoint for the remaining free-neuron balance, so we
 * derive it from the account-wide modelLock___all written when upstream error
 * 3036 (daily free allocation exhausted) hits: locked => 0 remaining until
 * reset, otherwise a full 10,000 is assumed.
 */

import {
  MODEL_LOCK_ALL,
  CLOUDFLARE_DAILY_NEURON_LIMIT,
  nextUtcMidnightMs,
} from "../accountFallback.js";

/**
 * @param {object} connection - Provider connection (flat modelLock_* fields present)
 */
export function getCloudflareUsage(connection = {}) {
  const now = Date.now();
  const lockMs = connection?.[MODEL_LOCK_ALL]
    ? new Date(connection[MODEL_LOCK_ALL]).getTime()
    : 0;
  const locked = lockMs > now;
  const used = locked ? CLOUDFLARE_DAILY_NEURON_LIMIT : 0;

  return {
    plan: "Workers AI (Free)",
    quotas: {
      daily: {
        name: "Daily neurons",
        used,
        total: CLOUDFLARE_DAILY_NEURON_LIMIT,
        remainingPercentage: locked ? 0 : 100,
        // Locked accounts show the lock expiry; otherwise the next UTC midnight.
        resetAt: new Date(Math.max(lockMs, nextUtcMidnightMs(now))).toISOString(),
      },
    },
  };
}
