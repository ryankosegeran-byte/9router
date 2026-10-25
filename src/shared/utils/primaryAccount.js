const MODEL_LOCK_PREFIX = "modelLock_";

/**
 * True when a connection is temporarily unavailable because one of its
 * model locks holds a future timestamp (rate limit / quota cooldown).
 * `isRateLimited` is honored too so sanitized API responses can carry the
 * flag without exposing the raw modelLock_* keys.
 */
export function isConnectionCooling(connection) {
  if (!connection) return false;
  if (connection.isRateLimited === true) return true;
  const now = Date.now();
  return Object.entries(connection).some(
    ([key, value]) =>
      key.startsWith(MODEL_LOCK_PREFIX) && value && new Date(value).getTime() > now,
  );
}

/**
 * Under the default fill-first strategy the "primary" account a request will
 * use is the first active, non-cooling account in priority order. Returns a
 * Set of connection ids (one per provider) so callers can flag each row.
 * ponytail: fill-first only; round-robin rotation is not reflected here.
 */
export function findPrimaryConnectionIds(connections) {
  const byProvider = new Map();
  for (const c of connections || []) {
    const list = byProvider.get(c.provider);
    if (list) list.push(c);
    else byProvider.set(c.provider, [c]);
  }
  const ids = new Set();
  for (const list of byProvider.values()) {
    const pool = list
      .filter((c) => c.isActive !== false && !isConnectionCooling(c))
      .sort((a, b) => (a.priority || 999) - (b.priority || 999));
    if (pool[0]) ids.add(pool[0].id);
  }
  return ids;
}

// ─── Pool ownership ──────────────────────────────────────────────────────────

// Model families Antigravity splits its quota across (see
// getAntigravityModelFamily). Locks naming a model outside these lists (image
// models) form their own pool.
const ANTIGRAVITY_POOLS = ["gemini", "claude_gpt"];

const POOL_LABELS = { gemini: "Gemini", claude_gpt: "Claude / GPT" };

/**
 * Pool a model draws from. Every provider except Antigravity shares one pool.
 */
export function getModelPoolKey(provider, modelKey) {
  const key = modelKey ? String(modelKey) : "";
  if (!key || String(provider || "").toLowerCase() !== "antigravity") return "*";
  if (key.includes("image")) return key;
  if (key.startsWith("gemini")) return "gemini";
  if (key.startsWith("claude") || key.startsWith("gpt")) return "claude_gpt";
  return key;
}

function getPoolLabel(poolKey) {
  return POOL_LABELS[poolKey] || null;
}

function poolCandidates(connections) {
  return (connections || [])
    .map((conn, index) => ({ conn, index }))
    .filter(({ conn }) => conn.isActive !== false)
    .sort(
      (a, b) =>
        (a.conn.priority || 999) - (b.conn.priority || 999) || a.index - b.index,
    );
}

function activeLockPools(provider, connection) {
  const locked = new Set();
  let accountWide = false;
  const now = Date.now();
  for (const [key, value] of Object.entries(connection || {})) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !value) continue;
    if (new Date(value).getTime() <= now) continue;
    const model = key.slice(MODEL_LOCK_PREFIX.length);
    if (model === "__all") accountWide = true;
    else locked.add(getModelPoolKey(provider, model));
  }
  return { locked, accountWide };
}

/**
 * Same fill-first pick as the router's pre-filter (auth.js
 * getProviderCredentials), sourced from persisted model locks instead of live
 * quota rows — for surfaces that only have `/api/providers` data. A pool is
 * served by the first active account that holds no future lock for it, so one
 * dry family no longer marks the whole account as handed over.
 *
 * @returns {{ pools: Set<string>, ownersByPool: Map<string, string>,
 *             poolsByConnection: Map<string, Set<string>>, primaryId: string|null }}
 * ponytail: fill-first only; locks naming a family the account never serves are
 * indistinguishable from locks on a served model. Locks only refresh on refetch.
 */
export function findPoolOwners(provider, connections = []) {
  const pools = new Set(
    String(provider || "").toLowerCase() === "antigravity" ? ANTIGRAVITY_POOLS : [],
  );
  const locks = new Map();
  for (const conn of connections || []) {
    const state = activeLockPools(provider, conn);
    locks.set(conn.id, state);
    for (const pool of state.locked) pools.add(pool);
  }

  const candidates = poolCandidates(connections);
  const ownersByPool = new Map();
  const poolsByConnection = new Map();
  for (const pool of pools) {
    const owner = candidates.find(({ conn }) => {
      const state = locks.get(conn.id);
      return state && !state.accountWide && !state.locked.has(pool);
    });
    if (!owner) continue;
    ownersByPool.set(pool, owner.conn.id);
    const owned = poolsByConnection.get(owner.conn.id) || new Set();
    owned.add(pool);
    poolsByConnection.set(owner.conn.id, owned);
  }

  return {
    pools,
    ownersByPool,
    poolsByConnection,
    primaryId: candidates[0]?.conn.id || null,
  };
}

/**
 * Labels to render on a connection row: one entry per pool the account serves,
 * or a single null when it serves every pool (plain "In use"). A null inside a
 * multi-pool list means the pool has no short label.
 */
export function getInUsePoolLabels(owners, connectionId) {
  const { pools, poolsByConnection, primaryId } = owners || {};
  if (!pools || pools.size === 0) {
    return connectionId && connectionId === primaryId ? [null] : [];
  }
  const owned = poolsByConnection?.get(connectionId);
  if (!owned || owned.size === 0) return [];
  if (owned.size >= pools.size) return [null];
  return [...owned].map(getPoolLabel);
}