import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCli(
  args: string[],
  options: { env?: Record<string, string>; stdin?: string } = {},
): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "src/index.ts", ...args], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      CAESAR_API_KEY: "",
      CAESAR_BASE_URL: "",
      XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "caesar-cli-test-")),
      NO_COLOR: "1",
      // Tests must never touch the developer's real OS keychain.
      CAESAR_KEYSTORE: "file",
      CAESAR_OAUTH_ISSUER: "",
      CAESAR_OAUTH_CLIENT_ID: "",
      CAESAR_CONSOLE_URL: "",
      ...options.env,
    },
    stdin: options.stdin !== undefined ? new TextEncoder().encode(options.stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export interface MockCall {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockServer {
  url: string;
  calls: MockCall[];
  stop: () => void;
}

export function mockServer(
  handler: (
    call: MockCall,
    callIndex: number,
  ) => { status?: number; headers?: Record<string, string>; body: unknown },
): MockServer {
  const calls: MockCall[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const text = await request.text();
      let body: unknown;
      try {
        body = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      const call: MockCall = {
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: Object.fromEntries(request.headers.entries()),
        body,
      };
      calls.push(call);
      const result = handler(call, calls.length - 1);
      return new Response(JSON.stringify(result.body), {
        status: result.status ?? 200,
        headers: { "Content-Type": "application/json", ...(result.headers ?? {}) },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    stop: () => server.stop(true),
  };
}

export const sampleSearchResponse = {
  request_id: "11111111-1111-4111-8111-111111111111",
  search_id: "22222222-2222-4222-8222-222222222222",
  session_id: "33333333-3333-4333-8333-333333333333",
  access: {
    rate_limit: { limit_rps: 100, remaining: 99, reset_at: "2026-06-12T00:00:00Z" },
  },
  ranking: { ranker_version: "reranked_v1", score_scope: "response_local" },
  results: [
    {
      rank: 1,
      doc_id: "44444444-4444-4444-8444-444444444444",
      canonical_url: "https://example.com/one",
      source_url: "https://example.com/one?utm=x",
      title: "Example One",
      snippet: "First snippet.",
      score: { value: 0.91 },
      metadata: { published_at: "2026-06-01T00:00:00Z", last_crawled_at: "2026-06-12T00:00:00Z" },
      passages: [
        {
          passage_id: "55555555-5555-4555-8555-555555555555",
          doc_id: "44444444-4444-4444-8444-444444444444",
          ordinal: 1,
          text: "Passage text.",
        },
      ],
    },
  ],
  usage: { requests: 1, bytes_returned: 1000 },
};
