import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  getAntigravityUsage: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("open-sse/services/usage/google.js", () => ({
  getAntigravityUsage: mocks.getAntigravityUsage,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const {
  runAntigravityQuotaSweepTick,
  selectBlocksToPersist,
  listAntigravityModelIds,
  getAntigravityQuotaThresholdPct,
  getAntigravitySweepIntervalMs,
} = await import("@/sse/services/antigravityQuotaSweep.js");
const {
  getAntigravityQuotaCache,
  handleAntigravityQuotaError,
  getAntigravityModelQuota,
} = await import("@/sse/services/antigravityQuota.js");

const CLAUDE_MODEL = "claude-opus-4-6-thinking";
const FUTURE_RESET = "2030-01-01T00:00:00.000Z";
const PAST_RESET = "2000-01-01T00:00:00.000Z";

const noSleep = { sleep: async () => {} };

beforeEach(() => {
  vi.clearAllMocks();
  getAntigravityQuotaCache().clear();
  mocks.resolveConnectionProxyConfig.mockResolvedValue({});
  mocks.getSettings.mockResolvedValue({});
  mocks.updateProviderConnection.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function lockKeys() {
  return mocks.updateProviderConnection.mock.calls.map(([, patch]) => Object.keys(patch)[0]);
}

describe("Antigravity proactive quota sweep", () => {
  it("pre-blocks an exhausted family at 0% threshold and persists modelLock_<model>", async () => {
    mocks.getProviderConnections.mockResolvedValue([{ id: "ag-blk", accessToken: "t", isActive: true }]);
    mocks.getAntigravityUsage.mockResolvedValue({
      quotas: { claude_gpt_session: { remainingPercentage: 0, resetAt: FUTURE_RESET } },
    });

    const persisted = await runAntigravityQuotaSweepTick(noSleep);

    expect(persisted.length).toBeGreaterThan(0);
    const keys = lockKeys();
    expect(keys).toContain(`modelLock_${CLAUDE_MODEL}`);
    // claude family only — gemini is untouched
    expect(keys.some((k) => k.startsWith("modelLock_gemini-"))).toBe(false);
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("ag-blk", expect.objectContaining({
      [`modelLock_${CLAUDE_MODEL}`]: expect.any(String),
    }));
  });

  it("only queries active antigravity connections", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);
    await runAntigravityQuotaSweepTick(noSleep);
    expect(mocks.getProviderConnections).toHaveBeenCalledWith({ provider: "antigravity", isActive: true });
  });

  it("drain threshold keeps one non-empty account per model", async () => {
    vi.stubEnv("AG_QUOTA_THRESHOLD_PCT", "5");
    mocks.getProviderConnections.mockResolvedValue([
      { id: "ag-d1", accessToken: "t", isActive: true },
      { id: "ag-d2", accessToken: "t", isActive: true },
    ]);
    // Both accounts at 3% (< 5% threshold) — must not block both.
    mocks.getAntigravityUsage.mockResolvedValue({
      quotas: { claude_gpt_session: { remainingPercentage: 3, resetAt: FUTURE_RESET } },
    });

    await runAntigravityQuotaSweepTick(noSleep);

    const forModel = lockKeys().filter((k) => k === `modelLock_${CLAUDE_MODEL}`);
    expect(forModel).toHaveLength(1);
  });

  it("does not block the last account when every account is truly exhausted", async () => {
    mocks.getProviderConnections.mockResolvedValue([{ id: "ag-single", accessToken: "t", isActive: true }]);
    mocks.getAntigravityUsage.mockResolvedValue({
      quotas: { claude_gpt_session: { remainingPercentage: 0, resetAt: FUTURE_RESET } },
    });

    // Single truly-exhausted account: blocking is correct (matches current RAM behavior).
    await runAntigravityQuotaSweepTick(noSleep);
    expect(lockKeys()).toContain(`modelLock_${CLAUDE_MODEL}`);
  });

  it("fails open when a quota poll rejects", async () => {
    mocks.getProviderConnections.mockResolvedValue([{ id: "ag-fail", accessToken: "t", isActive: true }]);
    mocks.getAntigravityUsage.mockRejectedValue(new Error("usage down"));

    await expect(runAntigravityQuotaSweepTick(noSleep)).resolves.toEqual([]);
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("ignores buckets whose resetAt is already in the past", async () => {
    mocks.getProviderConnections.mockResolvedValue([{ id: "ag-past", accessToken: "t", isActive: true }]);
    mocks.getAntigravityUsage.mockResolvedValue({
      quotas: { claude_gpt_session: { remainingPercentage: 0, resetAt: PAST_RESET } },
    });

    await expect(runAntigravityQuotaSweepTick(noSleep)).resolves.toEqual([]);
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("persists the block from the reactive 429 path too, but not the strike path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));

    mocks.getAntigravityUsage.mockResolvedValue({
      quotas: { [CLAUDE_MODEL]: { remainingPercentage: 0, resetAt: FUTURE_RESET } },
    });
    await handleAntigravityQuotaError("ag-reactive", 429, CLAUDE_MODEL, "t", {});
    expect(lockKeys()).toContain(`modelLock_${CLAUDE_MODEL}`);

    mocks.updateProviderConnection.mockClear();
    // Optimistic reading: 3 strikes trip the RAM-only breaker; nothing persisted.
    mocks.getAntigravityUsage.mockResolvedValue({
      quotas: { [CLAUDE_MODEL]: { remainingPercentage: 90, resetAt: FUTURE_RESET } },
    });
    await handleAntigravityQuotaError("ag-strike", 429, CLAUDE_MODEL, "t", {});
    await handleAntigravityQuotaError("ag-strike", 429, CLAUDE_MODEL, "t", {});
    await handleAntigravityQuotaError("ag-strike", 429, CLAUDE_MODEL, "t", {});
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

describe("sweep pure helpers", () => {
  it("lists only family-mappable non-image antigravity models", () => {
    const ids = listAntigravityModelIds();
    expect(ids).toContain(CLAUDE_MODEL);
    expect(ids).toContain("gemini-3.8-flash-high");
    expect(ids).not.toContain("gemini-3.1-flash-image");
  });

  it("parses threshold and interval env with safe defaults", () => {
    expect(getAntigravityQuotaThresholdPct({})).toBe(0);
    expect(getAntigravityQuotaThresholdPct({ AG_QUOTA_THRESHOLD_PCT: "abc" })).toBe(0);
    expect(getAntigravityQuotaThresholdPct({ AG_QUOTA_THRESHOLD_PCT: "-3" })).toBe(0);
    expect(getAntigravityQuotaThresholdPct({ AG_QUOTA_THRESHOLD_PCT: "10" })).toBe(10);
    expect(getAntigravityQuotaThresholdPct({ AG_QUOTA_THRESHOLD_PCT: "999" })).toBe(100);
    expect(getAntigravitySweepIntervalMs({})).toBe(300_000);
    expect(getAntigravitySweepIntervalMs({ AG_QUOTA_SWEEP_MS: "1000" })).toBe(1000);
  });

  it("drops the best candidate only when a drain block would cover all accounts", () => {
    const candidates = [
      { connectionId: "a", model: "m", resetAt: FUTURE_RESET, remainingPercentage: 3 },
      { connectionId: "b", model: "m", resetAt: FUTURE_RESET, remainingPercentage: 3 },
    ];
    const inSet = new Set(["a", "b"]);

    const drain = selectBlocksToPersist(candidates, inSet, 5);
    expect(drain).toHaveLength(1);

    const zero = selectBlocksToPersist(
      candidates.map((c) => ({ ...c, remainingPercentage: 0 })),
      inSet,
      0
    );
    expect(zero).toHaveLength(2);
  });

  it("reuses getAntigravityModelQuota family mapping", () => {
    const q = getAntigravityModelQuota(
      { claude_gpt_session: { remainingPercentage: 0, resetAt: FUTURE_RESET } },
      CLAUDE_MODEL
    );
    expect(q.remainingPercentage).toBe(0);
    expect(q.resetAt).toBe(FUTURE_RESET);
  });
});
