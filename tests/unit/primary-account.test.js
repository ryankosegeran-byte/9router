import { describe, expect, it } from "vitest";
import {
  isConnectionCooling,
  findPrimaryConnectionIds,
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