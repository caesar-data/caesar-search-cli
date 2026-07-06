import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockServer, runCli, sampleSearchResponse } from "./helpers";

function tmpFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "caesar-cli-output-")), name);
}

describe("-o / --output", () => {
  test("writes JSON to the file and suppresses stdout", async () => {
    const server = mockServer(() => ({ body: sampleSearchResponse }));
    const path = tmpFile("results.json");
    const result = await runCli(["search", "ok", "--json", "-o", path], {
      env: { CAESAR_BASE_URL: server.url },
    });
    server.stop();

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written.search_id).toBe(sampleSearchResponse.search_id);
  });

  test("in --json mode stderr stays empty (machine contract)", async () => {
    const server = mockServer(() => ({ body: sampleSearchResponse }));
    const path = tmpFile("results.json");
    const result = await runCli(["search", "ok", "--json", "--output", path], {
      env: { CAESAR_BASE_URL: server.url },
    });
    server.stop();
    expect(result.stderr).toBe("");
  });

  test("human mode writes the rendering to the file and notes the path on stderr", async () => {
    const server = mockServer(() => ({ body: sampleSearchResponse }));
    const path = tmpFile("results.txt");
    const result = await runCli(["search", "ok", "-o", path], {
      env: { CAESAR_BASE_URL: server.url },
    });
    server.stop();

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`wrote ${path}`);
    expect(readFileSync(path, "utf8")).toContain("Example One");
  });

  test("works on read", async () => {
    const server = mockServer(() => ({
      body: { doc: { doc_id: "x", title: "Doc" }, content: { text: "Body text." } },
    }));
    const path = tmpFile("doc.json");
    const result = await runCli(
      ["read", "https://example.com/post", "--json", "--no-local-render", "-o", path],
      {
        env: { CAESAR_BASE_URL: server.url },
      },
    );
    server.stop();
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(readFileSync(path, "utf8")).content.text).toBe("Body text.");
  });

  test("unwritable path exits 2 with a bad_input envelope", async () => {
    const server = mockServer(() => ({ body: sampleSearchResponse }));
    const result = await runCli(["search", "ok", "--json", "-o", "/nonexistent-dir/results.json"], {
      env: { CAESAR_BASE_URL: server.url },
    });
    server.stop();
    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.error.code).toBe("bad_input");
    expect(envelope.error.message).toContain("/nonexistent-dir/results.json");
  });

  test("errors still reach stderr, and no file is involved", async () => {
    const server = mockServer(() => ({
      status: 401,
      body: { type: "error", error: { code: "missing_api_key", message: "missing API key" } },
    }));
    const path = tmpFile("never.json");
    const result = await runCli(["search", "ok", "--json", "-o", path], {
      env: { CAESAR_BASE_URL: server.url },
    });
    server.stop();
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stderr).error.code).toBe("missing_api_key");
  });
});
