import { afterEach, describe, expect, test } from "bun:test";
import { type MockServer, mockServer, runCli } from "./helpers";

// API-key ids (not secrets) used as filter fixtures; obviously synthetic
// so secret scanners have nothing to match.
const FILTER_ID_A = "11111111-1111-4111-8111-111111111111";
const FILTER_ID_B = "22222222-2222-4222-8222-222222222222";

const sampleUsageResponse = {
  range: {
    from: "2026-06-23T00:00:00.000Z",
    to: "2026-07-23T00:00:00.000Z",
    interval: "day",
    timezone: "UTC",
  },
  headline: {
    requests: 48712,
    errors: 231,
    error_rate: 0.0047,
    avg_duration_ms: 164,
    p95_duration_ms: 588,
    spend_cents: 6120.4,
  },
  series: [
    { bucket: "2026-06-23T00:00:00.000Z", group_id: null, group_label: null, requests: 20000, errors: 100 },
    { bucket: "2026-06-24T00:00:00.000Z", group_id: null, group_label: null, requests: 28712, errors: 131 },
  ],
  latency_series: [{ bucket: "2026-06-23T00:00:00.000Z", avg_duration_ms: 160, p95_duration_ms: 570 }],
  keys: [
    {
      api_key_id: FILTER_ID_A,
      name: "prod-backend",
      key_prefix: "csk_Ab3",
      status: "active",
      requests: 39377,
      errors: 160,
      p95_duration_ms: 571,
      last_used_at: "2026-07-22T12:00:00.000Z",
      spend_cents: 4990,
    },
  ],
  endpoints: [
    { route: "/v1/search", label: "Search", requests: 31204, errors: 118, p95_duration_ms: 540 },
    { route: "/v1/document", label: "Document", requests: 6402, errors: 31, p95_duration_ms: 402 },
  ],
  products: [
    { product: "web_search", label: "Web search", requests: 30988, spend_cents: 3098.8 },
    { product: "research", label: "Research", requests: 2195, spend_cents: 2195 },
  ],
};

describe("usage", () => {
  const servers: MockServer[] = [];
  const track = (server: MockServer): MockServer => {
    servers.push(server);
    return server;
  };
  afterEach(() => {
    for (const server of servers.splice(0)) server.stop();
  });

  test("renders headline, tables, and sparkline in human mode", async () => {
    const api = track(mockServer(() => ({ body: sampleUsageResponse })));
    const result = await runCli(["usage"], {
      env: { CAESAR_BASE_URL: api.url, CAESAR_API_KEY: "csk_test" },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("requests 48,712");
    expect(result.stdout).toContain("errors 231 (0.47%)");
    expect(result.stdout).toContain("spend $61.20");
    expect(result.stdout).toContain("/v1/search");
    expect(result.stdout).toContain("prod-backend (csk_Ab3…)");
    expect(result.stdout).toContain("Web search");
    expect(result.stdout).toContain("total");
    expect(result.stdout).toContain("▆█");
    expect(result.stdout).toContain("2026-06-23 2026-06-24");
  });

  test("--json passes the response through untouched", async () => {
    const api = track(mockServer(() => ({ body: sampleUsageResponse })));
    const result = await runCli(["usage", "--json"], {
      env: { CAESAR_BASE_URL: api.url, CAESAR_API_KEY: "csk_test" },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(sampleUsageResponse);
  });

  test("forwards range, interval, and key filters as query params", async () => {
    const api = track(mockServer(() => ({ body: sampleUsageResponse })));
    const result = await runCli(
      [
        "usage",
        "--from",
        "2026-07-01T00:00:00Z",
        "--to",
        "2026-07-08T00:00:00Z",
        "--interval",
        "hour",
        "--key-id",
        FILTER_ID_A,
        "--key-id",
        FILTER_ID_B,
        "--json",
      ],
      { env: { CAESAR_BASE_URL: api.url, CAESAR_API_KEY: "csk_test" } },
    );
    expect(result.code).toBe(0);
    expect(api.calls.length).toBe(1);
    const call = api.calls[0]!;
    expect(call.path).toBe("/v1/usage");
    expect(call.query.from).toBe("2026-07-01T00:00:00Z");
    expect(call.query.to).toBe("2026-07-08T00:00:00Z");
    expect(call.query.interval).toBe("hour");
    expect(call.query.api_key_ids).toBe(`${FILTER_ID_A},${FILTER_ID_B}`);
  });

  test("omits unset params entirely", async () => {
    const api = track(mockServer(() => ({ body: sampleUsageResponse })));
    await runCli(["usage", "--json"], {
      env: { CAESAR_BASE_URL: api.url, CAESAR_API_KEY: "csk_test" },
    });
    expect(api.calls[0]!.path).toBe("/v1/usage");
    expect(Object.keys(api.calls[0]!.query)).toEqual([]);
  });

  test("rejects a bad interval before any HTTP call", async () => {
    const api = track(mockServer(() => ({ body: sampleUsageResponse })));
    const result = await runCli(["usage", "--interval", "weekly"], {
      env: { CAESAR_BASE_URL: api.url, CAESAR_API_KEY: "csk_test" },
    });
    expect(result.code).toBe(2);
    expect(api.calls.length).toBe(0);
  });

  test("rejects a non-uuid --key-id before any HTTP call", async () => {
    const api = track(mockServer(() => ({ body: sampleUsageResponse })));
    const result = await runCli(["usage", "--key-id", "prod-backend"], {
      env: { CAESAR_BASE_URL: api.url, CAESAR_API_KEY: "csk_test" },
    });
    expect(result.code).toBe(2);
    expect(api.calls.length).toBe(0);
  });

  test("renders the empty-range message when there are no requests", async () => {
    const empty = {
      ...sampleUsageResponse,
      headline: { ...sampleUsageResponse.headline, requests: 0, errors: 0, spend_cents: 0 },
    };
    const api = track(mockServer(() => ({ body: empty })));
    const result = await runCli(["usage"], {
      env: { CAESAR_BASE_URL: api.url, CAESAR_API_KEY: "csk_test" },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no usage in this range");
  });

  test("upstream errors surface as exit 4 with the API code", async () => {
    const api = track(
      mockServer(() => ({
        status: 400,
        body: { error: { code: "invalid_range", message: "from must be before to" } },
      })),
    );
    const result = await runCli(["usage", "--json"], {
      env: { CAESAR_BASE_URL: api.url, CAESAR_API_KEY: "csk_test" },
    });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("invalid_range");
  });

  test("missing key on the public base URL exits 3", async () => {
    const result = await runCli(["usage"], { env: {} });
    expect(result.code).toBe(3);
  });
});
