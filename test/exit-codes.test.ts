import { describe, expect, test } from "bun:test";
import { mockServer, runCli, sampleSearchResponse } from "./helpers";

describe("exit codes", () => {
  test("0 on success", async () => {
    const server = mockServer(() => ({ body: sampleSearchResponse }));
    const result = await runCli(["search", "ok", "--json"], { env: { CAESAR_BASE_URL: server.url } });
    server.stop();
    expect(result.code).toBe(0);
  });

  test("2 on bad input (invalid mode)", async () => {
    const result = await runCli(["search", "x", "--mode", "warp"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--mode");
  });

  test("2 on unknown flag", async () => {
    const result = await runCli(["search", "x", "--frobnicate"]);
    expect(result.code).toBe(2);
  });

  test("3 on 401 auth error", async () => {
    const server = mockServer(() => ({
      status: 401,
      body: { type: "error", error: { code: "missing_api_key", message: "missing API key" } },
    }));
    const result = await runCli(["search", "x", "--json"], { env: { CAESAR_BASE_URL: server.url } });
    server.stop();
    expect(result.code).toBe(3);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.error.code).toBe("missing_api_key");
    expect(envelope.error.hint).toContain("auth login");
  });

  test("4 on API 5xx after retries", async () => {
    const server = mockServer(() => ({
      status: 500,
      body: { type: "error", error: { code: "internal_error", message: "boom" } },
    }));
    const result = await runCli(["search", "x", "--json", "--no-retry"], {
      env: { CAESAR_BASE_URL: server.url },
    });
    server.stop();
    expect(result.code).toBe(4);
    expect(server.calls.length).toBe(1);
  });

  test("4 on insufficient balance with top-up hint", async () => {
    const server = mockServer(() => ({
      status: 402,
      body: {
        type: "error",
        error: {
          code: "insufficient_balance",
          message: "Your organization's balance is depleted.",
        },
      },
    }));
    const result = await runCli(["search", "x", "--json", "--no-retry"], {
      env: { CAESAR_BASE_URL: server.url },
    });
    server.stop();
    expect(result.code).toBe(4);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.error.code).toBe("insufficient_balance");
    expect(envelope.error.hint).toContain("Top up");
  });

  test("5 on timeout", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        return new Response("{}");
      },
    });
    const result = await runCli(["search", "x", "--json", "--timeout", "1"], {
      env: { CAESAR_BASE_URL: `http://127.0.0.1:${server.port}` },
    });
    server.stop(true);
    expect(result.code).toBe(5);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.error.code).toBe("timeout");
  }, 10_000);
});
