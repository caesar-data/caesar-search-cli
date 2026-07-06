import { describe, expect, test } from "bun:test";
import { mockServer, runCli, sampleSearchResponse } from "./helpers";

describe("json output contract", () => {
  test("search --json passes the API response through verbatim, provenance intact", async () => {
    const server = mockServer(() => ({ body: sampleSearchResponse }));
    const result = await runCli(["search", "test query", "--json"], { env: { CAESAR_BASE_URL: server.url } });
    server.stop();
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toEqual(sampleSearchResponse);
    // Provenance invariants the CLI must never drop or rename.
    expect(payload.results[0].doc_id).toBe("44444444-4444-4444-8444-444444444444");
    expect(payload.results[0].canonical_url).toBe("https://example.com/one");
    expect(payload.results[0].source_url).toBe("https://example.com/one?utm=x");
    expect(payload.search_id).toBe(sampleSearchResponse.search_id);
  });

  test("search request body maps flags to the public contract", async () => {
    const server = mockServer(() => ({ body: sampleSearchResponse }));
    await runCli(
      ["search", "test query", "--json", "--mode", "fast", "--max-results", "7", "--format", "compact"],
      { env: { CAESAR_BASE_URL: server.url } },
    );
    server.stop();
    const body = server.calls[0]?.body as Record<string, unknown>;
    expect(body.query).toBe("test query");
    expect(body.mode).toBe("fast");
    expect(body.max_results).toBe(7);
    expect(body.response).toEqual({ verbosity: "compact" });
    expect(body.client_model).toBe("cli");
  });

  test("read maps url vs doc_id and start_char to content.range", async () => {
    const server = mockServer(() => ({ body: { doc: { doc_id: "x" }, content: { text: "hi" } } }));
    await runCli(
      ["read", "44444444-4444-4444-8444-444444444444", "--json", "--start-char", "100", "--max-chars", "500"],
      { env: { CAESAR_BASE_URL: server.url } },
    );
    await runCli(["read", "https://example.com/page", "--json", "--query", "what is it"], {
      env: { CAESAR_BASE_URL: server.url },
    });
    server.stop();
    const byDocID = server.calls[0]?.body as Record<string, unknown>;
    expect(byDocID.doc_id).toBe("44444444-4444-4444-8444-444444444444");
    expect((byDocID.content as Record<string, unknown>).range).toEqual({ start_char: 100 });
    expect((byDocID.content as Record<string, unknown>).selection).toBe("full_document");
    const byURL = server.calls[1]?.body as Record<string, unknown>;
    expect(byURL.canonical_url).toBe("https://example.com/page");
    expect(byURL.query).toBe("what is it");
    expect((byURL.content as Record<string, unknown>).selection).toBe("full_document");
    expect((byURL.content as Record<string, unknown>).max_chars).toBeUndefined();
  });

  test("feedback maps flags and validates event type", async () => {
    const server = mockServer(() => ({ body: { accepted: true } }));
    await runCli(
      [
        "feedback",
        "--json",
        "--event-type",
        "result_helpful",
        "--doc-id",
        "d1",
        "--search-id",
        "s1",
        "--rank",
        "2",
      ],
      { env: { CAESAR_BASE_URL: server.url } },
    );
    server.stop();
    const body = server.calls[0]?.body as Record<string, unknown>;
    expect(body.event_type).toBe("result_helpful");
    expect(body.doc_id).toBe("d1");
    expect(body.search_id).toBe("s1");
    expect(body.rank).toBe(2);

    const bad = await runCli(["feedback", "--event-type", "loved_it"]);
    expect(bad.code).toBe(2);
  });

  test("stdin - works for the search query", async () => {
    const server = mockServer(() => ({ body: sampleSearchResponse }));
    const result = await runCli(["search", "-", "--json"], {
      env: { CAESAR_BASE_URL: server.url },
      stdin: "piped query\n",
    });
    server.stop();
    expect(result.code).toBe(0);
    expect((server.calls[0]?.body as Record<string, unknown>).query).toBe("piped query");
  });

  test("api escape hatch performs raw calls", async () => {
    const server = mockServer(() => ({ body: { ok: true } }));
    const result = await runCli(["api", "GET", "/up"], { env: { CAESAR_BASE_URL: server.url } });
    server.stop();
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    expect(server.calls[0]?.method).toBe("GET");
    expect(server.calls[0]?.path).toBe("/up");
  });

  test("human mode renders results without color when NO_COLOR", async () => {
    const server = mockServer(() => ({ body: sampleSearchResponse }));
    const result = await runCli(["search", "test"], { env: { CAESAR_BASE_URL: server.url } });
    server.stop();
    expect(result.stdout).toContain("1. Example One");
    expect(result.stdout).toContain("https://example.com/one");
    expect(result.stdout).toContain("doc_id=44444444-4444-4444-8444-444444444444");
    expect(result.stdout).not.toContain("\x1b[");
  });
});

describe("auth and attribution headers", () => {
  test("sends Authorization and X-Caesar-Client", async () => {
    const server = mockServer(() => ({ body: sampleSearchResponse }));
    await runCli(["search", "x", "--json", "--key", "demo-key-abc123-not-a-secret"], {
      env: { CAESAR_BASE_URL: server.url },
    });
    server.stop();
    const headers = server.calls[0]?.headers ?? {};
    expect(headers.authorization).toBe("Bearer demo-key-abc123-not-a-secret");
    expect(headers["x-caesar-client"]).toMatch(/^cli\//);
  });

  test("key precedence: flag > env > config", async () => {
    const server = mockServer(() => ({ body: sampleSearchResponse }));
    await runCli(["search", "x", "--json", "--key", "flag-key-123456"], {
      env: { CAESAR_BASE_URL: server.url, CAESAR_API_KEY: "env-key-123456" },
    });
    server.stop();
    expect(server.calls[0]?.headers.authorization).toBe("Bearer flag-key-123456");
  });
});

describe("retries", () => {
  test("retries 429 honoring Retry-After, then succeeds", async () => {
    const server = mockServer((_call, index) =>
      index === 0
        ? {
            status: 429,
            headers: { "Retry-After": "0" },
            body: { error: { code: "rate_limited", message: "slow down" } },
          }
        : { body: sampleSearchResponse },
    );
    const start = Date.now();
    const result = await runCli(["search", "x", "--json"], { env: { CAESAR_BASE_URL: server.url } });
    server.stop();
    expect(result.code).toBe(0);
    expect(server.calls.length).toBe(2);
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  test("--no-retry disables retries", async () => {
    const server = mockServer(() => ({
      status: 429,
      body: { error: { code: "rate_limited", message: "slow down" } },
    }));
    const result = await runCli(["search", "x", "--json", "--no-retry"], {
      env: { CAESAR_BASE_URL: server.url },
    });
    server.stop();
    expect(result.code).toBe(4);
    expect(server.calls.length).toBe(1);
  });
});

describe("config and auth login", () => {
  test("config set/get/list and auth login/logout respect XDG_CONFIG_HOME", async () => {
    const env = { CAESAR_BASE_URL: "http://127.0.0.1:1" };
    const home = `/tmp/caesar-cli-cfg-${Date.now()}`;
    const withHome = { ...env, XDG_CONFIG_HOME: home };

    const set = await runCli(["config", "set", "base_url", "https://example.test"], { env: withHome });
    expect(set.code).toBe(0);
    const get = await runCli(["config", "get", "base_url", "--json"], { env: withHome });
    expect(JSON.parse(get.stdout).value).toBe("https://example.test");

    const login = await runCli(["auth", "login", "--key", "-"], {
      env: withHome,
      stdin: "demo-key-xyz789-not-a-secret\n",
    });
    expect(login.code).toBe(0);
    expect(login.stdout).not.toContain("demo-key-xyz789-not-a-secret");

    const status = await runCli(["auth", "status", "--json"], { env: withHome });
    const payload = JSON.parse(status.stdout);
    expect(payload.key_present).toBe(true);
    expect(payload.key_source).toBe("config");
    expect(payload.key_masked).not.toContain("xyz789-not-a-secret");

    const logout = await runCli(["auth", "logout"], { env: withHome });
    expect(logout.code).toBe(0);
    const after = await runCli(["auth", "status", "--json"], { env: withHome });
    expect(JSON.parse(after.stdout).key_present).toBe(false);
  });

  test("unknown config key exits 2", async () => {
    const result = await runCli(["config", "get", "favourite_color"]);
    expect(result.code).toBe(2);
  });
});
