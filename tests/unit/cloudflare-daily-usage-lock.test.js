import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");
const { getCloudflareUsage } = await import("../../open-sse/services/usage/cloudflare.js");

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getProviderConnections.mockResolvedValue([{
    id: "cf-a",
    provider: "cloudflare-ai",
    name: "cf-a",
    backoffLevel: 4,
  }]);
});

describe("Cloudflare daily neuron exhaustion", () => {
  it("locks the whole account until the next UTC midnight on error 3036", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T19:30:00.000Z"));

    try {
      await markAccountUnavailable(
        "cf-a",
        429,
        '{"errors":[{"code":3036,"message":"you have used up your daily free allocation of 10,000 neurons"}]}',
        "cloudflare-ai",
        "@cf/meta/llama-3.2-3b-instruct",
      );

      expect(dbMocks.updateProviderConnection).toHaveBeenCalledWith(
        "cf-a",
        expect.objectContaining({
          modelLock___all: "2026-08-05T00:00:00.000Z",
          testStatus: "unavailable",
          backoffLevel: 0,
        }),
      );
      expect(dbMocks.updateProviderConnection.mock.calls[0][1])
        .not.toHaveProperty("modelLock_@cf/meta/llama-3.2-3b-instruct");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps unrelated Cloudflare errors model-scoped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T19:30:00.000Z"));

    try {
      await markAccountUnavailable(
        "cf-a",
        429,
        "rate limit",
        "cloudflare-ai",
        "@cf/meta/llama-3.2-3b-instruct",
      );

      const update = dbMocks.updateProviderConnection.mock.calls[0][1];
      expect(update).not.toHaveProperty("modelLock___all");
      expect(update["modelLock_@cf/meta/llama-3.2-3b-instruct"]).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getCloudflareUsage", () => {
  it("reports full quota when the account is not locked", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T19:30:00.000Z"));
    try {
      const usage = getCloudflareUsage({});
      const row = usage.quotas.daily;
      expect(row.total).toBe(10_000);
      expect(row.used).toBe(0);
      expect(row.remainingPercentage).toBe(100);
      expect(row.resetAt).toBe("2026-08-05T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports exhausted quota while modelLock___all is in the future", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T19:30:00.000Z"));
    try {
      const usage = getCloudflareUsage({ modelLock___all: "2026-08-05T00:00:00.000Z" });
      const row = usage.quotas.daily;
      expect(row.used).toBe(10_000);
      expect(row.remainingPercentage).toBe(0);
      expect(row.resetAt).toBe("2026-08-05T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores an expired lock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T19:30:00.000Z"));
    try {
      const usage = getCloudflareUsage({ modelLock___all: "2026-08-04T00:00:00.000Z" });
      expect(usage.quotas.daily.used).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
