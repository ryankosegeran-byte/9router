import { describe, expect, it } from "vitest";
import {
  isConnectionCooling,
  findPrimaryConnectionIds,
  findPoolOwners,
  getInUsePoolLabels,
  getModelPoolKey,
} from "@/shared/utils/primaryAccount.js";

const future = new Date(Date.now() + 60_000).toISOString();
const past = new Date(Date.now() - 60_000).toISOString();

describe("isConnectionCooling", () => {
  it("is false with no locks", () => {
    expect(isConnectionCooling({ id: "a" })).toBe(false);
  });

  it("is true for a future model lock", () => {
    expect(isConnectionCooling({ id: "a", modelLock_claude: future })).toBe(true);
  });

  it("is false for an expired model lock", () => {
    expect(isConnectionCooling({ id: "a", modelLock_claude: past })).toBe(false);
  });

  it("honors the sanitized isRateLimited flag", () => {
    expect(isConnectionCooling({ id: "a", isRateLimited: true })).toBe(true);
  });
});

describe("findPrimaryConnectionIds", () => {
  it("picks the lowest-priority active account per provider", () => {
    const ids = findPrimaryConnectionIds([
      { id: "a2", provider: "antigravity", priority: 2, isActive: true },
      { id: "a1", provider: "antigravity", priority: 1, isActive: true },
      { id: "c1", provider: "claude", priority: 5, isActive: true },
    ]);
    expect([...ids].sort()).toEqual(["a1", "c1"]);
  });

  it("skips disabled accounts", () => {
    const ids = findPrimaryConnectionIds([
      { id: "a1", provider: "antigravity", priority: 1, isActive: false },
      { id: "a2", provider: "antigravity", priority: 2, isActive: true },
    ]);
    expect([...ids]).toEqual(["a2"]);
  });

  it("falls through to the next account when the first is cooling", () => {
    const ids = findPrimaryConnectionIds([
      { id: "a1", provider: "antigravity", priority: 1, isActive: true, modelLock_gemini: future },
      { id: "a2", provider: "antigravity", priority: 2, isActive: true },
    ]);
    expect([...ids]).toEqual(["a2"]);
  });

  it("returns nothing when every account is cooling or disabled", () => {
    const ids = findPrimaryConnectionIds([
      { id: "a1", provider: "antigravity", priority: 1, isActive: true, isRateLimited: true },
      { id: "a2", provider: "antigravity", priority: 2, isActive: false },
    ]);
    expect([...ids]).toEqual([]);
  });
});

const ag = (id, priority, locks = {}, extra = {}) => ({
  id,
  provider: "antigravity",
  priority,
  isActive: true,
  ...locks,
  ...extra,
});

describe("getModelPoolKey", () => {
  it("splits antigravity models into families", () => {
    expect(getModelPoolKey("antigravity", "gemini-2.5-pro")).toBe("gemini");
    expect(getModelPoolKey("antigravity", "claude-sonnet-4.5")).toBe("claude_gpt");
    expect(getModelPoolKey("antigravity", "gpt-oss-120b")).toBe("claude_gpt");
    expect(getModelPoolKey("antigravity", "gemini-3.1-flash-image")).toBe(
      "gemini-3.1-flash-image",
    );
  });

  it("collapses other providers onto one pool", () => {
    expect(getModelPoolKey("codex", "gpt-5")).toBe("*");
    expect(getModelPoolKey("antigravity", "")).toBe("*");
  });
});

describe("findPoolOwners", () => {
  it("hands over only the locked family", () => {
    const owners = findPoolOwners("antigravity", [
      ag("a1", 1, { "modelLock_claude-sonnet-4.5": future }),
      ag("a2", 2),
    ]);

    expect(owners.ownersByPool.get("gemini")).toBe("a1");
    expect(owners.ownersByPool.get("claude_gpt")).toBe("a2");
    expect(getInUsePoolLabels(owners, "a1")).toEqual(["Gemini"]);
    expect(getInUsePoolLabels(owners, "a2")).toEqual(["Claude / GPT"]);
  });

  it("keeps the account when it serves every family", () => {
    const owners = findPoolOwners("antigravity", [
      ag("a1", 1),
      ag("a2", 2),
    ]);

    expect(owners.pools.size).toBe(2);
    expect(owners.ownersByPool.get("gemini")).toBe("a1");
    expect(getInUsePoolLabels(owners, "a1")).toEqual([null]);
    expect(getInUsePoolLabels(owners, "a2")).toEqual([]);
  });

  it("drops an account that is dry on every family", () => {
    const owners = findPoolOwners("antigravity", [
      ag("a1", 1, {
        "modelLock_gemini-2.5-pro": future,
        "modelLock_claude-sonnet-4.5": future,
      }),
      ag("a2", 2),
    ]);

    expect(getInUsePoolLabels(owners, "a1")).toEqual([]);
    expect(getInUsePoolLabels(owners, "a2")).toEqual([null]);
  });

  it("honors the account-wide lock", () => {
    const owners = findPoolOwners("antigravity", [
      ag("a1", 1, { modelLock___all: future }),
      ag("a2", 2),
    ]);

    expect(owners.ownersByPool.get("gemini")).toBe("a2");
    expect(getInUsePoolLabels(owners, "a1")).toEqual([]);
  });

  it("ignores expired locks and disabled accounts", () => {
    const owners = findPoolOwners("antigravity", [
      ag("a1", 1, { "modelLock_gemini-2.5-pro": past }),
      ag("a2", 2, {}, { isActive: false }),
      ag("a3", 3),
    ]);

    expect(owners.ownersByPool.get("gemini")).toBe("a1");
    expect(owners.primaryId).toBe("a1");
  });

  it("tracks a locked image model as its own pool", () => {
    const owners = findPoolOwners("antigravity", [
      ag("a1", 1, { "modelLock_gemini-3.1-flash-image": future }),
      ag("a2", 2),
    ]);

    expect(owners.pools.has("gemini-3.1-flash-image")).toBe(true);
    expect(owners.ownersByPool.get("gemini-3.1-flash-image")).toBe("a2");
  });

  it("keeps one pool for other providers", () => {
    const owners = findPoolOwners("codex", [
      { id: "c1", provider: "codex", priority: 1, isActive: true, "modelLock_gpt-5": future },
      { id: "c2", provider: "codex", priority: 2, isActive: true },
    ]);

    expect([...owners.pools]).toEqual(["*"]);
    expect(owners.ownersByPool.get("*")).toBe("c2");
    expect(getInUsePoolLabels(owners, "c2")).toEqual([null]);
  });
});