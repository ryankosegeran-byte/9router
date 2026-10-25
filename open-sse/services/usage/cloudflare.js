/**
 * Cloudflare Workers AI usage — daily neurons.
 *
 * Tier 1 (always available): CF exposes no REST endpoint for the remaining
 * free-neuron balance, so we derive a synthetic row from the account-wide
 * modelLock___all written when upstream error 3036 (daily free allocation
 * exhausted) hits.
 *
 * Tier 2 (optional): if the credential carries Account Analytics: Read we read
 * the real UTC-day total from the GraphQL Analytics API
 * (aiInferenceAdaptiveGroups.sum.totalNeurons) and use that as `used`.
 * Failures fall back to Tier 1 — never throws.
 */

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import {
  MODEL_LOCK_ALL,
  CLOUDFLARE_DAILY_NEURON_LIMIT,
  nextUtcMidnightMs,
} from "../accountFallback.js";

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
// GraphQL analytics lag behind real time; a 10-min cache keeps 200 accounts
// under the 300 queries / 5 min API quota (200 queries / 10 min ≈ 100 / 5 min).
const CACHE_MS = Number(process.env.CF_NEURON_CACHE_MS) || 10 * 60 * 1000;
// Cap concurrent GraphQL calls so a 200-account page load doesn't burst-dial CF.
const MAX_CONCURRENCY = 5;

const cache = new Map(); // connectionId → { at, data }
let active = 0;
const waiters = [];

async function withSlot(fn) {
  if (active >= MAX_CONCURRENCY) await new Promise((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = waiters.shift();
    if (next) next();
  }
}

/**
 * Read the account's total neurons for a UTC day, grouped by model.
 * @returns {Promise<{totalNeurons:number, byModel:Object, date:string}|null>}
 *          null on any failure or missing credential (caller falls back).
 */
export async function fetchCloudflareNeuronsToday({ accountId, token, proxyOptions = null, now = Date.now() }) {
  if (!accountId || !token) return null;
  const date = new Date(now).toISOString().slice(0, 10);

  try {
    const res = await proxyAwareFetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `query($a: String!, $d: Date!) {
          viewer { accounts(filter: { accountTag: $a }) {
            aiInferenceAdaptiveGroups(limit: 200, filter: { date: $d }) {
              count
              sum { totalNeurons }
              dimensions { modelId }
            }
          } }
        }`,
        variables: { a: accountId, d: date },
      }),
    }, proxyOptions);

    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!body || body.errors?.length) return null;

    const groups = body.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups || [];
    let totalNeurons = 0;
    const byModel = {};
    for (const g of groups) {
      const n = Number(g?.sum?.totalNeurons) || 0;
      totalNeurons += n;
      const mid = g?.dimensions?.modelId || "unknown";
      byModel[mid] = (byModel[mid] || 0) + n;
    }
    return { totalNeurons, byModel, date };
  } catch {
    return null;
  }
}

async function neuronsFor(connection, proxyOptions, force = false) {
  const id = connection?.id;
  if (id && !force) {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  }

  const data = await withSlot(() => fetchCloudflareNeuronsToday({
    accountId: connection?.providerSpecificData?.accountId,
    // A dedicated analytics token may be supplied; otherwise reuse the
    // inference key (works when it also has Account Analytics: Read).
    token: connection?.providerSpecificData?.analyticsToken || connection?.apiKey || connection?.accessToken,
    proxyOptions,
  }));

  if (id) cache.set(id, { at: Date.now(), data });
  return data;
}

/** Drop cached analytics for a connection (called when credentials change). */
export function invalidateCloudflareNeuronCache(id) {
  if (id) cache.delete(id);
}

/**
 * @param {object} connection - Provider connection (flat modelLock_* fields present)
 * @param {object|null} proxyOptions
 * @param {{force?:boolean}} [options] - force bypasses the analytics cache
 */
export async function getCloudflareUsage(connection = {}, proxyOptions = null, options = {}) {
  const now = Date.now();
  const lockMs = connection?.[MODEL_LOCK_ALL]
    ? new Date(connection[MODEL_LOCK_ALL]).getTime()
    : 0;
  const locked = lockMs > now;

  const analytics = await neuronsFor(connection, proxyOptions, options.force === true).catch(() => null);
  const measured = analytics ? Math.min(CLOUDFLARE_DAILY_NEURON_LIMIT, Math.round(analytics.totalNeurons)) : 0;
  // A confirmed lock means the full allowance is gone regardless of analytics lag.
  const used = Math.max(locked ? CLOUDFLARE_DAILY_NEURON_LIMIT : 0, measured);

  return {
    plan: "Workers AI (Free)",
    quotas: {
      daily: {
        name: "Daily neurons",
        used,
        total: CLOUDFLARE_DAILY_NEURON_LIMIT,
        remainingPercentage: Math.max(0, Math.round(((CLOUDFLARE_DAILY_NEURON_LIMIT - used) / CLOUDFLARE_DAILY_NEURON_LIMIT) * 100)),
        // Locked accounts show the lock expiry; otherwise the next UTC midnight.
        resetAt: new Date(Math.max(lockMs, nextUtcMidnightMs(now))).toISOString(),
        // Per-model breakdown (present only when analytics is available).
        byModel: analytics?.byModel || null,
        measured: analytics ? measured : null,
      },
    },
  };
}
