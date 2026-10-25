import { describe, expect, it } from "vitest";
import {
  findInUsePools,
  getQuotaPoolKey,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const future = new Date(Date.now() + 60 * 60_000).toISOString();
const past = new Date(Date.now() - 60_000).toISOString();

const conn = (id, priority, extra = {}) => ({
  id,
  provider: "antigravity",
  priority,
  isActive: true,
  name: `${id}@mail.com`,
  ...extra,
});

const row = (modelKey, remainingPercentage, resetAt = future) => ({
  name: modelKey,
  modelKey,
  total: 1000,
  used: 1000,
  remainingPercentage,
  resetAt,
});

const quotaData = (entries) => entries;

describe("getQuotaPoolKey", () => {
  it("splits antigravity rows into model families", () => {
    expect(getQuotaPoolKey("antigravity", { modelKey: "gemini_session" })).toBe("gemini");
    expect(getQuotaPoolKey("antigravity", { modelKey: "gemini_weekly" })).toBe("gemini");
    expect(getQuotaPoolKey("antigravity", { modelKey: "claude_gpt_session" })).toBe("claude_gpt");
    expect(getQuotaPoolKey("antigravity", { modelKey: "claude" })).toBe("claude_gpt");
    expect(getQuotaPoolKey("antigravity", { modelKey: "gpt-oss" })).toBe("claude_gpt");
  });

  it("gives each image model its own pool", () => {
    expect(getQuotaPoolKey("antigravity", { modelKey: "gemini-3.1-flash-image" })).toBe(
      "gemini-3.1-flash-image",
    );
  });

  it("collapses every other provider onto one pool", () => {
    expect(getQuotaPoolKey("codex", { modelKey: "session" })).toBe("*");
    expect(getQuotaPoolKey("github", { name: "chat" })).toBe("*");
  });
});

describe("findInUsePools", () => {
  it("hands only the dry family to the next account", () => {
    const { poolsByConnection, poolOwnersByProvider } = findInUsePools(
      [conn("a1", 1), conn("a2", 2)],
      quotaData({
        a1: { quotas: [row("gemini_session", 98), row("claude_gpt_session", 0)] },
        a2: { quotas: [row("gemini_session", 100), row("claude_gpt_session", 40)] },
      }),
    );

    expect([...poolsByConnection.get("a1")]).toEqual(["gemini"]);
    expect([...poolsByConnection.get("a2")]).toEqual(["claude_gpt"]);
    expect(poolOwnersByProvider.get("antigravity").get("claude_gpt")).toBe("a2");
  });

  it("keeps the account when any bucket of the family is dry", () => {
    const { poolsByConnection } = findInUsePools(
      [conn("a1", 1), conn("a2", 2)],
      quotaData({
        a1: { quotas: [row("gemini_session", 90), row("gemini_weekly", 0)] },
        a2: { quotas: [row("gemini_session", 100), row("gemini_weekly", 100)] },
      }),
    );

    expect([...poolsByConnection.get("a2")]).toEqual(["gemini"]);
    expect(poolsByConnection.has("a1")).toBe(false);
  });

  it("retries a dry pool whose reset already passed", () => {
    const { poolsByConnection } = findInUsePools(
      [conn("a1", 1), conn("a2", 2)],
      quotaData({
        a1: { quotas: [row("gemini_session", 0, past)] },
        a2: { quotas: [row("gemini_session", 100)] },
      }),
    );

    expect([...poolsByConnection.get("a1")]).toEqual(["gemini"]);
  });

  it("skips inactive accounts", () => {
    const { poolsByConnection } = findInUsePools(
      [conn("a1", 1, { isActive: false }), conn("a2", 2)],
      quotaData({
        a1: { quotas: [row("gemini_session", 100)] },
        a2: { quotas: [row("gemini_session", 100)] },
      }),
    );

    expect([...poolsByConnection.get("a2")]).toEqual(["gemini"]);
  });

  it("treats unloaded quota as available (fill-first)", () => {
    const { poolsByConnection } = findInUsePools(
      [conn("a1", 1), conn("a2", 2)],
      quotaData({ a2: { quotas: [row("gemini_session", 100)] } }),
    );

    expect([...poolsByConnection.get("a1")]).toEqual(["gemini"]);
  });

  it("leaves a pool ownerless when every account is dry", () => {
    const { poolOwnersByProvider } = findInUsePools(
      [conn("a1", 1), conn("a2", 2)],
      quotaData({
        a1: { quotas: [row("claude_gpt_session", 0)] },
        a2: { quotas: [row("claude_gpt_session", 0)] },
      }),
    );

    expect(poolOwnersByProvider.get("antigravity").has("claude_gpt")).toBe(false);
  });

  it("orders by priority, not array order", () => {
    const { poolsByConnection } = findInUsePools(
      [conn("a2", 2), conn("a1", 1)],
      quotaData({
        a1: { quotas: [row("gemini_session", 50)] },
        a2: { quotas: [row("gemini_session", 100)] },
      }),
    );

    expect([...poolsByConnection.get("a1")]).toEqual(["gemini"]);
    expect(poolsByConnection.has("a2")).toBe(false);
  });

  it("keeps a single pool for non-antigravity providers", () => {
    const { poolsByConnection, poolKeysByProvider } = findInUsePools(
      [
        conn("c1", 1, { provider: "codex" }),
        conn("c2", 2, { provider: "codex" }),
      ],
      quotaData({
        c1: { quotas: [row("session", 0), row("weekly", 80)] },
        c2: { quotas: [row("session", 70), row("weekly", 80)] },
      }),
    );

    expect([...poolKeysByProvider.get("codex")]).toEqual(["*"]);
    expect([...poolsByConnection.get("c2")]).toEqual(["*"]);
    expect(poolsByConnection.has("c1")).toBe(false);
  });

  it("returns nothing without quota rows", () => {
    const { poolsByConnection, poolKeysByProvider } = findInUsePools(
      [conn("a1", 1)],
      quotaData({ a1: { quotas: [] } }),
    );

    expect(poolsByConnection.size).toBe(0);
    expect(poolKeysByProvider.size).toBe(0);
  });
});
