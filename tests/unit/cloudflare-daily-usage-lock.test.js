import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));
const fetchMock = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));

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
vi.mock("../../open-sse/utils/proxyFetch.js", () => fetchMock);

const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");
const { getCloudflareUsage, fetchCloudflareNeuronsToday } = await import("../../open-sse/services/usage/cloudflare.js");

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.proxyAwareFetch.mockReset();
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

describe("getCloudflareUsage (Tier 1 fallback)", () => {
  it("reports full quota when the account is not locked", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T19:30:00.000Z"));
    try {
      const usage = await getCloudflareUsage({});
      const row = usage.quotas.daily;
      expect(row.total).toBe(10_000);
      expect(row.used).toBe(0);
      expect(row.remainingPercentage).toBe(100);
      expect(row.resetAt).toBe("2026-08-05T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports exhausted quota while modelLock___all is in the future", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T19:30:00.000Z"));
    try {
      const usage = await getCloudflareUsage({ modelLock___all: "2026-08-05T00:00:00.000Z" });
      const row = usage.quotas.daily;
      expect(row.used).toBe(10_000);
      expect(row.remainingPercentage).toBe(0);
      expect(row.resetAt).toBe("2026-08-05T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores an expired lock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T19:30:00.000Z"));
    try {
      const usage = await getCloudflareUsage({ modelLock___all: "2026-08-04T00:00:00.000Z" });
      expect(usage.quotas.daily.used).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("fetchCloudflareNeuronsToday (Tier 2)", () => {
  it("sums totalNeurons and groups by model", async () => {
    fetchMock.proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          viewer: {
            accounts: [{
              aiInferenceAdaptiveGroups: [
                { count: 2, sum: { totalNeurons: 4000 }, dimensions: { modelId: "@cf/a" } },
                { count: 1, sum: { totalNeurons: 1000 }, dimensions: { modelId: "@cf/b" } },
              ],
            }],
          },
        },
      }),
    });

    const res = await fetchCloudflareNeuronsToday({
      accountId: "acc-1",
      token: "tok",
      now: new Date("2026-08-04T19:30:00.000Z").getTime(),
    });

    expect(res.totalNeurons).toBe(5000);
    expect(res.byModel).toEqual({ "@cf/a": 4000, "@cf/b": 1000 });
    expect(res.date).toBe("2026-08-04");

    const body = JSON.parse(fetchMock.proxyAwareFetch.mock.calls[0][1].body);
    expect(body.variables).toEqual({ a: "acc-1", d: "2026-08-04" });
    expect(body.query).toContain("totalNeurons");
  });

  it("returns null on GraphQL errors (permission denied)", async () => {
    fetchMock.proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ errors: [{ message: "not authorized" }] }),
    });
    const res = await fetchCloudflareNeuronsToday({ accountId: "acc", token: "tok" });
    expect(res).toBeNull();
  });

  it("returns null without credentials and never calls the network", async () => {
    const res = await fetchCloudflareNeuronsToday({ accountId: "", token: "" });
    expect(res).toBeNull();
    expect(fetchMock.proxyAwareFetch).not.toHaveBeenCalled();
  });
});

describe("getCloudflareUsage (Tier 2 analytics)", () => {
  it("uses measured neurons when analytics is available", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T19:30:00.000Z"));
    try {
      fetchMock.proxyAwareFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [
            { sum: { totalNeurons: 2500 }, dimensions: { modelId: "@cf/a" } },
          ] }] } },
        }),
      });

      const usage = await getCloudflareUsage({
        id: "cf-analytics-1",
        apiKey: "tok",
        providerSpecificData: { accountId: "acc-1" },
      });

      const row = usage.quotas.daily;
      expect(row.used).toBe(2500);
      expect(row.remainingPercentage).toBe(75);
      expect(row.byModel).toEqual({ "@cf/a": 2500 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the full allowance when analytics says more than the daily limit", async () => {
    fetchMock.proxyAwareFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [
          { sum: { totalNeurons: 12345 }, dimensions: { modelId: "@cf/a" } },
        ] }] } },
      }),
    });

    const usage = await getCloudflareUsage({
      id: "cf-analytics-over",
      apiKey: "tok",
      providerSpecificData: { accountId: "acc" },
    });
    expect(usage.quotas.daily.used).toBe(10_000);
    expect(usage.quotas.daily.remainingPercentage).toBe(0);
  });
});
