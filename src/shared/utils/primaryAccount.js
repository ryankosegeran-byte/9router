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