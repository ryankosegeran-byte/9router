// Proactive Antigravity quota sweep — pre-blocks accounts below a threshold
// BEFORE they 409/429, and persists the block so it survives a restart.
// Fail-open everywhere: tick errors and per-connection failures never kill the interval.

import antigravityRegistry from "open-sse/providers/registry/antigravity.js";
import { getProviderConnections } from "@/lib/localDb";
import {
  getAntigravityModelQuota,
  getAntigravityModelFamily,
  refreshAntigravityQuota,
  persistAntigravityQuotaBlock,
} from "./antigravityQuota.js";
import * as log from "../utils/logger.js";

const DEFAULT_SWEEP_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 60 * 1000;
// Google (Cloud Code) is sensitive: stagger polls between accounts.
const STAGGER_BASE_MS = 4_000;
const STAGGER_JITTER_MS = 3_000;

let started = false;
let intervalHandle = null;
let initialTimeoutHandle = null;
let tickRunning = false;

/** Switch threshold: 0 = only when fully exhausted (current behavior). */
export function getAntigravityQuotaThresholdPct(env = process.env) {
  const raw = Number(env.AG_QUOTA_THRESHOLD_PCT);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 100) : 0;
}

export function getAntigravitySweepIntervalMs(env = process.env) {
  const raw = Number(env.AG_QUOTA_SWEEP_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SWEEP_MS;
}

/** Antigravity model ids that map to a quota family (skips image models). */
export function listAntigravityModelIds() {
  return antigravityRegistry.models
    .filter((m) => !(m.kind === "image" || m.imageGen))
    .map((m) => m.id)
    .filter((id) => getAntigravityModelFamily(id) !== null);
}

/**
 * Fairness guard: never let a drain/threshold block remove the last non-empty
 * account. At threshold 0 every candidate is truly 0%, so nothing is dropped
 * (blocking all matches the current RAM-cache behavior).
 * @param {Array<{connectionId:string, model:string, resetAt:string, remainingPercentage:number}>} candidates
 * @param {Set<string>} allConnectionIds
 * @param {number} thresholdPct
 */
export function selectBlocksToPersist(candidates, allConnectionIds, thresholdPct) {
  if (candidates.length === 0) return [];
  const byModel = new Map();
  for (const c of candidates) {
    if (!byModel.has(c.model)) byModel.set(c.model, []);
    byModel.get(c.model).push(c);
  }
  const out = [];
  for (const group of byModel.values()) {
    const covered = new Set(group.map((c) => c.connectionId));
    const coversAll = allConnectionIds.size > 0 && [...allConnectionIds].every((id) => covered.has(id));
    if (thresholdPct > 0 && coversAll) {
      const best = group.reduce((a, b) => (b.remainingPercentage > a.remainingPercentage ? b : a));
      if (best.remainingPercentage > 0) {
        out.push(...group.filter((c) => c !== best));
        continue;
      }
    }
    out.push(...group);
  }
  return out;
}

/**
 * One sweep tick. Fail-open at top level and per connection.
 * @param {{ loadConnections?: Function, refreshQuota?: Function, persistBlock?: Function, sleep?: Function }} [deps]
 */
export async function runAntigravityQuotaSweepTick(deps = {}) {
  if (tickRunning) return [];
  tickRunning = true;
  try {
    const load = deps.loadConnections
      || (() => getProviderConnections({ provider: "antigravity", isActive: true }));
    const refresh = deps.refreshQuota || refreshAntigravityQuota;
    const persist = deps.persistBlock || persistAntigravityQuotaBlock;
    const sleep = deps.sleep || ((ms) => new Promise((res) => setTimeout(res, ms)));
    const thresholdPct = getAntigravityQuotaThresholdPct();

    const connections = await load();
    if (!Array.isArray(connections) || connections.length === 0) return [];
    const allIds = new Set(connections.map((c) => c.id));
    const modelIds = listAntigravityModelIds();
    const candidates = [];

    for (let i = 0; i < connections.length; i++) {
      const conn = connections[i];
      try {
        const quotas = await refresh(conn.id, conn.accessToken, conn.providerSpecificData || {});
        if (quotas) {
          for (const model of modelIds) {
            const quota = getAntigravityModelQuota(quotas, model);
            if (!quota || typeof quota.remainingPercentage !== "number") continue;
            if (quota.remainingPercentage > thresholdPct) continue;
            if (!quota.resetAt) continue;
            const resetMs = new Date(quota.resetAt).getTime();
            if (!Number.isFinite(resetMs) || resetMs <= Date.now()) continue;
            candidates.push({
              connectionId: conn.id,
              model,
              resetAt: quota.resetAt,
              remainingPercentage: quota.remainingPercentage,
            });
          }
        }
      } catch (err) {
        log.warn("AG_QUOTA_SWEEP", `${(conn.id || "").slice(0, 8)} | poll failed (swallowed): ${err?.message ?? err}`);
      }

      if (i < connections.length - 1) {
        await sleep(STAGGER_BASE_MS + Math.floor(Math.random() * STAGGER_JITTER_MS));
      }
    }

    const toPersist = selectBlocksToPersist(candidates, allIds, thresholdPct);
    for (const c of toPersist) {
      try {
        await persist(c.connectionId, c.model, c.resetAt);
      } catch (err) {
        log.warn("AG_QUOTA_SWEEP", `${(c.connectionId || "").slice(0, 8)} | persist failed (swallowed): ${err?.message ?? err}`);
      }
    }
    if (toPersist.length > 0) {
      log.info("AG_QUOTA_SWEEP", `blocked ${toPersist.length} pair(s) across ${connections.length} connection(s)`);
    }
    return toPersist;
  } catch (err) {
    log.warn("AG_QUOTA_SWEEP", `tick failed (swallowed): ${err?.message ?? err}`);
    return [];
  } finally {
    tickRunning = false;
  }
}

function isTruthyEnv(value) {
  if (value == null || value === "") return false;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

/**
 * Start the sweep interval. Safe to call multiple times (no-op if already started).
 * @param {{ intervalMs?: number }} [opts]
 * @returns {boolean} true if started this call
 */
export function startAntigravityQuotaSweep({ intervalMs } = {}) {
  if (started) return false;
  if (isTruthyEnv(process.env.DISABLE_AG_QUOTA_SWEEP)) return false;
  if (typeof window !== "undefined") return false;

  started = true;
  const period = getAntigravitySweepIntervalMs({ ...process.env, ...(intervalMs ? { AG_QUOTA_SWEEP_MS: intervalMs } : {}) });

  const safeTick = () => {
    runAntigravityQuotaSweepTick().catch((err) => {
      log.warn("AG_QUOTA_SWEEP", `unhandled tick rejection (swallowed): ${err?.message ?? err}`);
    });
  };

  initialTimeoutHandle = setTimeout(safeTick, INITIAL_DELAY_MS);
  if (initialTimeoutHandle.unref) initialTimeoutHandle.unref();

  intervalHandle = setInterval(safeTick, period);
  if (intervalHandle.unref) intervalHandle.unref();

  return true;
}

export function stopAntigravityQuotaSweep() {
  if (initialTimeoutHandle) {
    clearTimeout(initialTimeoutHandle);
    initialTimeoutHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  started = false;
}
