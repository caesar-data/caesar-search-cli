import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MockServer, mockServer, runCli } from "./helpers";

// Browser (loopback + PKCE) and device login flows against a mock
// authorization server and a mock console API. The "browser" is the test
// itself: it reads the authorize URL off stderr and drives the CLI's
// localhost callback directly.

const TEST_SECRET = "csk_0123456789abcdefghijklmnopqrstuvwxyzABCD";
const ACCESS_TOKEN = "test-access-token-not-a-secret";

function form(body: unknown): URLSearchParams {
  return new URLSearchParams(typeof body === "string" ? body : "");
}

// Mock WorkOS-Connect-shaped AS: metadata discovery, token endpoint
// (auth-code + device grants), device authorization endpoint.
function mockAS(options: { pendingPolls?: number } = {}): MockServer & { seenVerifiers: string[] } {
  let polls = 0;
  const seenVerifiers: string[] = [];
  const server = mockServer((call) => {
    if (call.method === "GET" && call.path === "/.well-known/oauth-authorization-server") {
      return {
        body: {
          issuer: server.url,
          authorization_endpoint: `${server.url}/oauth2/authorize`,
          token_endpoint: `${server.url}/oauth2/token`,
          device_authorization_endpoint: `${server.url}/oauth2/device_authorization`,
          code_challenge_methods_supported: ["S256"],
        },
      };
    }
    if (call.method === "POST" && call.path === "/oauth2/device_authorization") {
      return {
        body: {
          device_code: "test-device-code",
          user_code: "ABCD-1234",
          verification_uri: `${server.url}/activate`,
          verification_uri_complete: `${server.url}/activate?user_code=ABCD-1234`,
          expires_in: 60,
          interval: 1,
        },
      };
    }
    if (call.method === "POST" && call.path === "/oauth2/token") {
      const params = form(call.body);
      if (params.get("grant_type") === "authorization_code") {
        if (params.get("code") !== "test-authcode" || !params.get("code_verifier")) {
          return { status: 400, body: { error: "invalid_grant" } };
        }
        seenVerifiers.push(params.get("code_verifier") ?? "");
        return { body: { access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 300 } };
      }
      if (params.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
        if (params.get("device_code") !== "test-device-code") {
          return { status: 400, body: { error: "invalid_grant" } };
        }
        polls += 1;
        if (polls <= (options.pendingPolls ?? 1)) {
          return { status: 400, body: { error: "authorization_pending" } };
        }
        return { body: { access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 300 } };
      }
      return { status: 400, body: { error: "unsupported_grant_type" } };
    }
    return { status: 404, body: { error: "not_found" } };
  }) as MockServer & { seenVerifiers: string[] };
  server.seenVerifiers = seenVerifiers;
  return server;
}

function mockConsole(options: { status?: number } = {}): MockServer {
  return mockServer((call) => {
    if (call.method === "POST" && call.path === "/v1/organization/api-keys") {
      if (call.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
        return { status: 401, body: { error: "invalid bearer token" } };
      }
      if (options.status === 403) {
        return { status: 403, body: { error: "organization is required" } };
      }
      return {
        status: options.status ?? 201,
        body: { key: { id: "11111111-1111-4111-8111-111111111111" }, secret: TEST_SECRET },
      };
    }
    return { status: 404, body: { error: "not_found" } };
  });
}

function loginEnv(as: MockServer, consoleApi: MockServer, configHome: string): Record<string, string> {
  return {
    CAESAR_OAUTH_ISSUER: as.url,
    CAESAR_OAUTH_CLIENT_ID: "client_test_cli",
    CAESAR_CONSOLE_URL: consoleApi.url,
    CAESAR_NO_BROWSER: "1",
    XDG_CONFIG_HOME: configHome,
  };
}

interface SpawnedCli {
  proc: ReturnType<typeof Bun.spawn>;
  stdout: () => string;
  stderr: () => string;
  waitForStderr: (predicate: (text: string) => boolean) => Promise<void>;
}

function spawnCli(args: string[], env: Record<string, string>): SpawnedCli {
  const proc = Bun.spawn(["bun", "src/index.ts", ...args], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      CAESAR_API_KEY: "",
      CAESAR_BASE_URL: "",
      NO_COLOR: "1",
      CAESAR_KEYSTORE: "file",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let stdoutText = "";
  let stderrText = "";
  const decoder = new TextDecoder();
  (async () => {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      stdoutText += decoder.decode(chunk);
    }
  })();
  (async () => {
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      stderrText += decoder.decode(chunk);
    }
  })();
  return {
    proc,
    stdout: () => stdoutText,
    stderr: () => stderrText,
    waitForStderr: async (predicate) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (predicate(stderrText)) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`timed out waiting for stderr; got:\n${stderrText}`);
    },
  };
}

function authorizeUrlFrom(stderr: string): URL {
  const match = stderr.match(/https?:\/\/\S+\/oauth2\/authorize\S*/);
  if (!match) throw new Error(`no authorize URL in stderr:\n${stderr}`);
  return new URL(match[0]);
}

describe("auth login (browser flow)", () => {
  test("completes loopback PKCE login and stores a minted key", async () => {
    const as = mockAS();
    const consoleApi = mockConsole();
    const configHome = mkdtempSync(join(tmpdir(), "caesar-cli-oauth-"));
    try {
      const cli = spawnCli(["auth", "login", "--json"], loginEnv(as, consoleApi, configHome));
      await cli.waitForStderr((text) => text.includes("/oauth2/authorize"));

      const authorizeUrl = authorizeUrlFrom(cli.stderr());
      expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
      expect(authorizeUrl.searchParams.get("client_id")).toBe("client_test_cli");
      expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
      const challenge = authorizeUrl.searchParams.get("code_challenge");
      const state = authorizeUrl.searchParams.get("state");
      const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
      expect(challenge).toBeTruthy();
      expect(state).toBeTruthy();
      expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

      // Play the browser: hit the CLI's loopback callback with the code.
      const callback = await fetch(`${redirectUri}?code=test-authcode&state=${state}`);
      expect(callback.status).toBe(200);
      expect(await callback.text()).toContain("Logged in");

      expect(await cli.proc.exited).toBe(0);

      // PKCE: the verifier sent to the token endpoint hashes to the
      // challenge from the authorize URL.
      expect(as.seenVerifiers.length).toBe(1);
      const hashed = createHash("sha256")
        .update(as.seenVerifiers[0] ?? "")
        .digest("base64url");
      expect(hashed).toBe(challenge ?? "");

      // The minted key landed in the config file (CAESAR_KEYSTORE=file).
      const payload = JSON.parse(cli.stdout()) as {
        stored: boolean;
        storage: string;
        key_masked: string;
        key_name: string;
      };
      expect(payload.stored).toBe(true);
      expect(payload.storage).toBe("file");
      expect(payload.key_name).toContain("CLI ·");
      expect(payload.key_masked).not.toContain(TEST_SECRET.slice(10, 30));
      const config = JSON.parse(readFileSync(join(configHome, "caesar", "config.json"), "utf8")) as {
        api_key?: string;
      };
      expect(config.api_key).toBe(TEST_SECRET);

      // The console saw exactly one mint request, named for this machine.
      const mint = consoleApi.calls.find((call) => call.path === "/v1/organization/api-keys");
      expect(mint).toBeDefined();
      expect((mint?.body as { name?: string }).name).toContain("CLI ·");
      expect((mint?.body as { scope?: string }).scope).toBe("member");

      // The raw secret is never echoed to either stream.
      expect(cli.stdout()).not.toContain(TEST_SECRET);
      expect(cli.stderr()).not.toContain(TEST_SECRET);
    } finally {
      as.stop();
      consoleApi.stop();
    }
  }, 30_000);

  test("rejects a callback whose state does not match", async () => {
    const as = mockAS();
    const consoleApi = mockConsole();
    const configHome = mkdtempSync(join(tmpdir(), "caesar-cli-oauth-"));
    try {
      const cli = spawnCli(["auth", "login", "--json"], loginEnv(as, consoleApi, configHome));
      await cli.waitForStderr((text) => text.includes("/oauth2/authorize"));
      const authorizeUrl = authorizeUrlFrom(cli.stderr());
      const redirectUri = authorizeUrl.searchParams.get("redirect_uri");

      const callback = await fetch(`${redirectUri}?code=test-authcode&state=WRONG`);
      expect(await callback.text()).toContain("failed");
      expect(await cli.proc.exited).toBe(3);
      expect(cli.stderr()).toContain("oauth_state_mismatch");
    } finally {
      as.stop();
      consoleApi.stop();
    }
  }, 30_000);

  test("surfaces a missing organization as an auth error", async () => {
    const as = mockAS();
    const consoleApi = mockConsole({ status: 403 });
    const configHome = mkdtempSync(join(tmpdir(), "caesar-cli-oauth-"));
    try {
      const cli = spawnCli(["auth", "login", "--json"], loginEnv(as, consoleApi, configHome));
      await cli.waitForStderr((text) => text.includes("/oauth2/authorize"));
      const authorizeUrl = authorizeUrlFrom(cli.stderr());
      const state = authorizeUrl.searchParams.get("state");
      const redirectUri = authorizeUrl.searchParams.get("redirect_uri");

      await fetch(`${redirectUri}?code=test-authcode&state=${state}`);
      expect(await cli.proc.exited).toBe(3);
      expect(cli.stderr()).toContain("no_organization");
    } finally {
      as.stop();
      consoleApi.stop();
    }
  }, 30_000);

  test("falls back to the paste prompt when browser login is not configured", async () => {
    // No OAuth env at all and no TTY: login with no --key must fail with
    // the pre-0.3 guidance, not attempt a browser flow.
    const result = await runCli(["auth", "login"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("no TTY available");
  });
});

describe("auth login --device", () => {
  test("polls the device grant to completion and stores the key", async () => {
    const as = mockAS({ pendingPolls: 1 });
    const consoleApi = mockConsole();
    const configHome = mkdtempSync(join(tmpdir(), "caesar-cli-device-"));
    try {
      const cli = spawnCli(["auth", "login", "--device", "--json"], loginEnv(as, consoleApi, configHome));
      await cli.waitForStderr((text) => text.includes("ABCD-1234"));
      expect(cli.stderr()).toContain("/activate");

      expect(await cli.proc.exited).toBe(0);
      const payload = JSON.parse(cli.stdout()) as { stored: boolean; storage: string };
      expect(payload.stored).toBe(true);

      const config = JSON.parse(readFileSync(join(configHome, "caesar", "config.json"), "utf8")) as {
        api_key?: string;
      };
      expect(config.api_key).toBe(TEST_SECRET);

      // The device flow really polled: at least one pending answer first.
      const tokenCalls = as.calls.filter((call) => call.path === "/oauth2/token");
      expect(tokenCalls.length).toBeGreaterThanOrEqual(2);
    } finally {
      as.stop();
      consoleApi.stop();
    }
  }, 30_000);
});
