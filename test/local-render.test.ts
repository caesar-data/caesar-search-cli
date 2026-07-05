import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTarget, detectChrome, isRequestPermitted, renderLocally } from "../src/render/index";
import { mockServer, runCli } from "./helpers";

const DOC_ID = "0c944fa8-4c8f-4f48-9b08-0fb2fd3438ec";
const URL = "https://example.com/x";

function writeFixture(fixture: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "caesar-render-fixture-"));
  const path = join(dir, "fixture.json");
  writeFileSync(path, JSON.stringify(fixture));
  return path;
}

// A rich body that clears the R2 MIN_CONTENT_CHARS gate.
const RICH_MARKDOWN = "# Local Heading\n\nFirst paragraph of locally rendered content.\n\n- one\n- two";

const metadataDoc = {
  doc: { doc_id: DOC_ID, canonical_url: URL, title: "T" },
};

describe("local render tier", () => {
  test("local success: no server round-trip, composed content, local_render warning", async () => {
    const server = mockServer(() => ({ body: metadataDoc }));
    const fixture = writeFixture({ markdown: RICH_MARKDOWN, title: "T", textLength: 1200 });

    const result = await runCli(["read", URL, "--json", "--base-url", server.url, "--key", "test"], {
      env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture },
    });
    server.stop();

    expect(result.code).toBe(0);
    // Local render succeeded, so the server is never contacted.
    expect(server.calls.length).toBe(0);

    const payload = JSON.parse(result.stdout);
    expect(payload.content.text).toContain(RICH_MARKDOWN);
    expect(payload.content.selection).toBe("full_document");
    // No server capture, so no doc_id; the URL stays as the handle.
    expect(payload.doc.doc_id).toBeUndefined();
    expect(payload.doc.canonical_url).toBe(URL);
    expect(payload.doc.title).toBe("T");
    const warnings = payload.warnings as { code?: string }[];
    expect(warnings.some((w) => w.code === "local_render")).toBe(true);
  });

  test("--no-local-render: requests real server content, no local_render warning", async () => {
    const server = mockServer(() => ({
      body: { doc: { doc_id: DOC_ID, title: "T" }, content: { text: "server body" } },
    }));
    const fixture = writeFixture({ markdown: RICH_MARKDOWN, title: "T", textLength: 1200 });

    const result = await runCli(
      ["read", URL, "--json", "--no-local-render", "--base-url", server.url, "--key", "test"],
      { env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture } },
    );
    server.stop();

    expect(result.code).toBe(0);
    expect(server.calls.length).toBe(1);
    const body = server.calls[0]?.body as Record<string, unknown>;
    expect((body.content as Record<string, unknown>).selection).toBe("full_document");
    expect((body.content as Record<string, unknown>).max_chars).toBe(12000);
    expect(result.stdout).not.toContain("local_render");
  });

  test("low-density fixture falls back to the full content server call", async () => {
    const server = mockServer(() => ({
      body: { doc: { doc_id: DOC_ID, title: "T" }, content: { text: "server body" } },
    }));
    const fixture = writeFixture({ markdown: "tiny", title: "T", textLength: 10 });

    const result = await runCli(["read", URL, "--json", "--base-url", server.url, "--key", "test"], {
      env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture },
    });
    server.stop();

    expect(result.code).toBe(0);
    expect(server.calls.length).toBe(1);
    const body = server.calls[0]?.body as Record<string, unknown>;
    expect((body.content as Record<string, unknown>).selection).toBe("full_document");
    // Fallback is observable in JSON: a local_render_fallback warning carrying the
    // reason, and NOT the local_render success warning.
    const warnings = JSON.parse(result.stdout).warnings as { code?: string; message?: string }[];
    const codes = warnings.map((w) => w.code);
    expect(codes).toContain("local_render_fallback");
    expect(codes).not.toContain("local_render");
    expect(warnings.find((w) => w.code === "local_render_fallback")?.message).toContain("low_density");
  });

  test("challenge-interstitial fixture is skipped, not fetched from the server", async () => {
    const server = mockServer(() => ({
      body: { doc: { doc_id: DOC_ID, title: "T" }, content: { text: "server body" } },
    }));
    const fixture = writeFixture({
      markdown: "Just a moment... checking your browser before proceeding.",
      title: "Just a moment",
      textLength: 5000,
    });

    const result = await runCli(["read", URL, "--json", "--base-url", server.url, "--key", "test"], {
      env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture },
    });
    server.stop();

    expect(result.code).toBe(0);
    // A bot wall is skipped outright: no server round-trip, empty content, and a
    // clear warning — NOT a local_render_fallback (which would have paid for the
    // server) and NOT a local_render success.
    expect(server.calls.length).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.content.text).toBe("");
    const codes = (payload.warnings as { code?: string }[]).map((w) => w.code);
    expect(codes).toContain("bot_wall_skipped");
    expect(codes).not.toContain("local_render_fallback");
    expect(codes).not.toContain("local_render");
  });

  test("an HTTP error page falls back with the status as the reason", async () => {
    const server = mockServer(() => ({
      body: { doc: { doc_id: DOC_ID, title: "T" }, content: { text: "server body" } },
    }));
    // A 404 whose body reads like a real page: rich enough to pass every density
    // check. The status gate must still bounce it to the server, which may hold a
    // good capture from when the page existed.
    const fixture = writeFixture({
      markdown: `# Page not found\n\n${RICH_MARKDOWN}`,
      title: "Page not found",
      textLength: 1200,
      httpStatus: 404,
    });

    const result = await runCli(["read", URL, "--json", "--base-url", server.url, "--key", "test"], {
      env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture },
    });
    server.stop();

    expect(result.code).toBe(0);
    expect(server.calls.length).toBe(1);
    const warnings = JSON.parse(result.stdout).warnings as { code?: string; message?: string }[];
    const codes = warnings.map((w) => w.code);
    expect(codes).toContain("local_render_fallback");
    expect(codes).not.toContain("local_render");
    expect(warnings.find((w) => w.code === "local_render_fallback")?.message).toContain("http_404");
  });

  test("a challenge interstitial served as 403 is still a bot-wall skip, not an HTTP fallback", async () => {
    const server = mockServer(() => ({
      body: { doc: { doc_id: DOC_ID, title: "T" }, content: { text: "server body" } },
    }));
    const fixture = writeFixture({
      markdown: "Just a moment... checking your browser before proceeding.",
      title: "Just a moment",
      textLength: 5000,
      httpStatus: 403,
    });

    const result = await runCli(["read", URL, "--json", "--base-url", server.url, "--key", "test"], {
      env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture },
    });
    server.stop();

    expect(result.code).toBe(0);
    // challenge outranks the HTTP error: skipped outright, no paid server call.
    expect(server.calls.length).toBe(0);
    const codes = (JSON.parse(result.stdout).warnings as { code?: string }[]).map((w) => w.code);
    expect(codes).toContain("bot_wall_skipped");
    expect(codes).not.toContain("local_render_fallback");
  });

  test("a small-but-complete static page is a local success, not a fallback", async () => {
    const server = mockServer(() => ({ body: metadataDoc }));
    // example.com-shaped: ~130 visible chars, fully captured (the rendered DOM
    // matched the raw server HTML). Falling back would pay for the same tiny
    // document again.
    const small = "# Example Domain\n\nThis domain is for use in illustrative examples in documents.";
    const fixture = writeFixture({ markdown: small, title: "Example", textLength: 127, baseline: "static" });

    const result = await runCli(["read", URL, "--json", "--base-url", server.url, "--key", "test"], {
      env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture },
    });
    server.stop();

    expect(result.code).toBe(0);
    expect(server.calls.length).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.content.text).toContain("Example Domain");
    expect((payload.warnings as { code?: string }[]).map((w) => w.code)).toContain("local_render");
  });

  test("a small page with NO baseline signal still falls back (fail closed)", async () => {
    const server = mockServer(() => ({
      body: { doc: { doc_id: DOC_ID, title: "T" }, content: { text: "server body" } },
    }));
    // Same content as above but the raw-HTML baseline fetch failed: it could be a
    // JS shell we failed to render, so the whole-document density floor applies.
    const small = "# Example Domain\n\nThis domain is for use in illustrative examples in documents.";
    const fixture = writeFixture({ markdown: small, title: "Example", textLength: 127 });

    const result = await runCli(["read", URL, "--json", "--base-url", server.url, "--key", "test"], {
      env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture },
    });
    server.stop();

    expect(result.code).toBe(0);
    expect(server.calls.length).toBe(1);
    const warnings = JSON.parse(result.stdout).warnings as { code?: string; message?: string }[];
    expect(warnings.find((w) => w.code === "local_render_fallback")?.message).toContain("low_density");
  });

  test("hydrated but empty content still falls back (no empty success)", async () => {
    const server = mockServer(() => ({
      body: { doc: { doc_id: DOC_ID, title: "T" }, content: { text: "server body" } },
    }));
    // A page whose JS mounted (hydrated) but produced no real markdown — e.g. a
    // canvas app, auth wall, or failed data fetch. The hydration signal must NOT
    // let this bypass the content floor; it has to fall back to the server.
    const fixture = writeFixture({ markdown: "", title: "T", textLength: 4000, hydrated: true });

    const result = await runCli(["read", URL, "--json", "--base-url", server.url, "--key", "test"], {
      env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture },
    });
    server.stop();

    expect(result.code).toBe(0);
    expect(server.calls.length).toBe(1);
    const warnings = JSON.parse(result.stdout).warnings as { code?: string }[];
    const codes = warnings.map((w) => w.code);
    expect(codes).toContain("local_render_fallback");
    expect(codes).not.toContain("local_render");
  });

  test("doc_id input never renders locally", async () => {
    const server = mockServer(() => ({
      body: { doc: { doc_id: DOC_ID }, content: { text: "server body" } },
    }));
    const fixture = writeFixture({ markdown: RICH_MARKDOWN, title: "T", textLength: 1200 });

    const result = await runCli(["read", DOC_ID, "--json", "--base-url", server.url, "--key", "test"], {
      env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture },
    });
    server.stop();

    expect(result.code).toBe(0);
    expect(server.calls.length).toBe(1);
    const body = server.calls[0]?.body as Record<string, unknown>;
    expect(body.doc_id).toBe(DOC_ID);
    expect((body.content as Record<string, unknown>).selection).toBe("full_document");
    expect(result.stdout).not.toContain("local_render");
  });

  test("--include passages skips local render and uses the server", async () => {
    const server = mockServer(() => ({
      body: { doc: { doc_id: DOC_ID, title: "T" }, content: { text: "server body" }, passages: [] },
    }));
    const fixture = writeFixture({ markdown: RICH_MARKDOWN, title: "T", textLength: 1200 });
    const result = await runCli(
      [
        "read",
        URL,
        "--json",
        "--include",
        "metadata,content,passages",
        "--base-url",
        server.url,
        "--key",
        "test",
      ],
      { env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture } },
    );
    server.stop();
    expect(result.code).toBe(0);
    // passages are server-side, so local render is skipped and the server is used.
    expect(server.calls.length).toBe(1);
    expect(result.stdout).not.toContain("local_render");
  });

  test("--include content: local success omits the doc section", async () => {
    const server = mockServer(() => ({ body: metadataDoc }));
    const fixture = writeFixture({ markdown: RICH_MARKDOWN, title: "T", textLength: 1200 });
    const result = await runCli(
      ["read", URL, "--json", "--include", "content", "--base-url", server.url, "--key", "test"],
      {
        env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture },
      },
    );
    server.stop();
    expect(result.code).toBe(0);
    expect(server.calls.length).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.doc).toBeUndefined();
    expect(payload.content.text).toContain(RICH_MARKDOWN);
    expect((payload.warnings as { code?: string }[]).map((w) => w.code)).toContain("local_render");
  });

  test("--include metadata: local success omits the content section", async () => {
    const server = mockServer(() => ({ body: metadataDoc }));
    const fixture = writeFixture({ markdown: RICH_MARKDOWN, title: "T", textLength: 1200 });
    const result = await runCli(
      ["read", URL, "--json", "--include", "metadata", "--base-url", server.url, "--key", "test"],
      {
        env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture },
      },
    );
    server.stop();
    expect(result.code).toBe(0);
    expect(server.calls.length).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.content).toBeUndefined();
    expect(payload.doc.canonical_url).toBe(URL);
    expect((payload.warnings as { code?: string }[]).map((w) => w.code)).toContain("local_render");
  });
});

describe("local render observability", () => {
  const serverBody = { body: { doc: { doc_id: DOC_ID }, content: { text: "server body" } } };

  test("--verbose logs USED to stderr on local success", async () => {
    const server = mockServer(() => ({ body: metadataDoc }));
    const fixture = writeFixture({ markdown: RICH_MARKDOWN, title: "T", textLength: 1200 });
    const result = await runCli(
      ["read", URL, "--json", "--verbose", "--base-url", server.url, "--key", "test"],
      { env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture } },
    );
    server.stop();
    expect(result.code).toBe(0);
    expect(server.calls.length).toBe(0);
    expect(result.stderr).toMatch(/local render.*USED/);
  });

  test("--verbose logs FALLBACK with the reason on low-density", async () => {
    const server = mockServer(() => serverBody);
    const fixture = writeFixture({ markdown: "tiny", title: "T", textLength: 10 });
    const result = await runCli(
      ["read", URL, "--json", "--verbose", "--base-url", server.url, "--key", "test"],
      { env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture } },
    );
    server.stop();
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/local render.*FALLBACK.*low_density/);
  });

  test("--verbose logs SKIPPED for --no-local-render", async () => {
    const server = mockServer(() => serverBody);
    const fixture = writeFixture({ markdown: RICH_MARKDOWN, title: "T", textLength: 1200 });
    const result = await runCli(
      ["read", URL, "--json", "--verbose", "--no-local-render", "--base-url", server.url, "--key", "test"],
      { env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture } },
    );
    server.stop();
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/local render.*SKIPPED/);
  });

  test("--verbose logs SKIPPED and makes no server call on a bot wall", async () => {
    const server = mockServer(() => serverBody);
    const fixture = writeFixture({
      markdown: "Just a moment... checking your browser before proceeding.",
      title: "Just a moment",
      textLength: 5000,
    });
    const result = await runCli(
      ["read", URL, "--json", "--verbose", "--base-url", server.url, "--key", "test"],
      { env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture } },
    );
    server.stop();
    expect(result.code).toBe(0);
    expect(server.calls.length).toBe(0);
    expect(result.stderr).toMatch(/local render.*SKIPPED.*bot wall/);
  });

  test("CAESAR_DEBUG enables the diagnostics without --verbose", async () => {
    const server = mockServer(() => ({ body: metadataDoc }));
    const fixture = writeFixture({ markdown: RICH_MARKDOWN, title: "T", textLength: 1200 });
    const result = await runCli(["read", URL, "--json", "--base-url", server.url, "--key", "test"], {
      env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture, CAESAR_DEBUG: "1" },
    });
    server.stop();
    expect(result.stderr).toMatch(/local render.*USED/);
  });

  test("quiet by default: no local-render diagnostics on stderr", async () => {
    const server = mockServer(() => ({ body: metadataDoc }));
    const fixture = writeFixture({ markdown: RICH_MARKDOWN, title: "T", textLength: 1200 });
    const result = await runCli(["read", URL, "--json", "--base-url", server.url, "--key", "test"], {
      env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture, CAESAR_DEBUG: "" },
    });
    server.stop();
    expect(result.stderr).not.toMatch(/local render/);
  });
});

describe("doctor", () => {
  test("reports browser, local render (via fixture), and server reachability", async () => {
    const server = mockServer(() => ({ body: { ok: true } }));
    const fixture = writeFixture({ markdown: RICH_MARKDOWN, title: "T", textLength: 1200 });
    // A fake CHROME_PATH keeps the browser check hermetic; version probing on a
    // non-executable file simply yields no version.
    const dir = mkdtempSync(join(tmpdir(), "caesar-doctor-"));
    const fakeChrome = join(dir, "chrome");
    writeFileSync(fakeChrome, "#!/bin/sh\n");

    const result = await runCli(["doctor", "--json", "--base-url", server.url, "--key", "test"], {
      env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture, CHROME_PATH: fakeChrome },
    });
    server.stop();

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.browser.found).toBe(true);
    expect(report.browser.path).toBe(fakeChrome);
    expect(report.local_render.ok).toBe(true);
    expect(report.local_render.strategy).toBe("fixture");
    expect(report.server.reachable).toBe(true);
    expect(report.local_first).toBe(true);
  });

  test("reports the failure reason when local render cannot be used", async () => {
    const server = mockServer(() => ({ body: { ok: true } }));
    // Low-density fixture → the render path fails exactly like a real thin shell.
    const fixture = writeFixture({ markdown: "tiny", title: "T", textLength: 10 });
    const result = await runCli(["doctor", "--json", "--base-url", server.url, "--key", "test"], {
      env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture },
    });
    server.stop();

    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.local_render.ok).toBe(false);
    expect(report.local_render.reason).toContain("low_density");
    expect(report.local_first).toBe(false);
  });
});

describe("detectChrome", () => {
  test("honors CHROME_PATH when it points at an existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "caesar-chrome-"));
    const fake = join(dir, "chrome");
    writeFileSync(fake, "#!/bin/sh\n");
    const previous = process.env.CHROME_PATH;
    try {
      process.env.CHROME_PATH = fake;
      expect(detectChrome()).toBe(fake);

      // A non-existent CHROME_PATH is ignored, never returned.
      process.env.CHROME_PATH = join(dir, "does-not-exist");
      expect(detectChrome()).not.toBe(join(dir, "does-not-exist"));
    } finally {
      if (previous === undefined) delete process.env.CHROME_PATH;
      else process.env.CHROME_PATH = previous;
    }
  });
});

// Opt-in only: exercises a real headless Chrome against a loopback HTTP server.
// Skipped by default so `bun test` stays hermetic and browserless. Uses a
// loopback origin (blocked unless allowLocalAddresses), so it also proves the
// opt-in path reaches a real render.
const RUN_REAL = process.env.CAESAR_RENDER_TEST === "1";
describe("real chrome render (opt-in)", () => {
  test.skipIf(!RUN_REAL)("renders a served page with the installed browser", async () => {
    const previousFixture = process.env.CAESAR_LOCAL_RENDER_FIXTURE;
    delete process.env.CAESAR_LOCAL_RENDER_FIXTURE;
    const paragraph = "Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(20);
    const html = `<html><head><title>Data Doc</title></head><body><main><h1>Data Doc</h1><p>${paragraph}</p></main></body></html>`;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(html, { headers: { "content-type": "text/html" } }),
    });
    try {
      // Loopback is refused without the opt-in, and permitted with it.
      const blocked = await renderLocally(`http://127.0.0.1:${server.port}/`, { maxChars: 12000 });
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.reason).toBe("blocked_address");

      const rendered = await renderLocally(`http://127.0.0.1:${server.port}/`, {
        maxChars: 12000,
        allowLocalAddresses: true,
        // Render even where the sandbox can't launch (e.g. root in a container),
        // so this opt-in test doesn't depend on the host's sandbox availability.
        allowUnsandboxed: true,
      });
      expect(rendered.ok).toBe(true);
      if (rendered.ok) {
        // Readability isolates the article: the title is lifted out of the body
        // into `title`, and the body markdown carries the prose content.
        expect(rendered.title).toBe("Data Doc");
        expect(rendered.markdown).toContain("Lorem ipsum");
        expect(rendered.strategy).toContain("readability");
      }
    } finally {
      server.stop(true);
      if (previousFixture !== undefined) process.env.CAESAR_LOCAL_RENDER_FIXTURE = previousFixture;
    }
  });

  test.skipIf(!RUN_REAL)("a live 404 with a rich body is rejected by the status gate", async () => {
    const previousFixture = process.env.CAESAR_LOCAL_RENDER_FIXTURE;
    delete process.env.CAESAR_LOCAL_RENDER_FIXTURE;
    // The body is deliberately rich enough to pass every density check — only the
    // main-document status (captured over CDP) can catch it.
    const paragraph = "This page could not be found but here is plenty of prose anyway. ".repeat(20);
    const html = `<html><head><title>Missing</title></head><body><main><h1>Missing</h1><p>${paragraph}</p></main></body></html>`;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(html, { status: 404, headers: { "content-type": "text/html" } }),
    });
    try {
      const rendered = await renderLocally(`http://127.0.0.1:${server.port}/`, {
        maxChars: 12000,
        allowLocalAddresses: true,
        allowUnsandboxed: true,
      });
      expect(rendered.ok).toBe(false);
      if (!rendered.ok) expect(rendered.reason).toBe("http_404");
    } finally {
      server.stop(true);
      if (previousFixture !== undefined) process.env.CAESAR_LOCAL_RENDER_FIXTURE = previousFixture;
    }
  });
});

describe("url trust boundary", () => {
  test("classifyTarget: schemes, hosts, and IP-encoding bypasses", () => {
    const kind = (u: string): string => classifyTarget(u).kind;

    // Public http(s) is renderable.
    expect(kind("https://example.com/post")).toBe("public");
    expect(kind("http://8.8.8.8/")).toBe("public");
    expect(kind("http://[2606:4700::1111]/")).toBe("public");
    // 172.16/12 boundaries: .15 and .32 are public, .16-.31 are private.
    expect(kind("http://172.15.0.1/")).toBe("public");
    expect(kind("http://172.32.0.1/")).toBe("public");
    expect(kind("http://172.16.0.1/")).toBe("local");
    expect(kind("http://172.31.255.255/")).toBe("local");

    // Non-http(s) schemes are never renderable — this is the file:// disclosure fix.
    expect(kind("file:///etc/passwd")).toBe("bad_scheme");
    expect(kind("data:text/html,<h1>x</h1>")).toBe("bad_scheme");
    expect(kind("javascript:alert(1)")).toBe("bad_scheme");

    // Loopback / private / link-local, incl. obfuscated IP encodings.
    for (const u of [
      "http://127.0.0.1:8080/admin",
      "http://127.1/", // short form → 127.0.0.1
      "http://2130706433/", // decimal → 127.0.0.1
      "http://0x7f000001/", // hex → 127.0.0.1
      "http://localhost:3000",
      "http://foo.localhost/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/", // cloud metadata
      "http://100.64.0.1/", // CGNAT
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/", // IPv4-mapped loopback
      "http://[::ffff:169.254.169.254]/", // IPv4-mapped metadata
      "http://[fd00::1]/", // unique-local
      "http://[fe80::1]/", // link-local
      "http://[64:ff9b::7f00:1]/", // NAT64-embedded loopback
      "http://metadata.google.internal/",
    ]) {
      expect(kind(u)).toBe("local");
    }

    // Non-URL input is left for the server to normalize.
    expect(kind("not a url")).toBe("unparseable");
  });

  test("renderLocally self-guard: refuses non-public targets before launching Chrome", async () => {
    // No fixture set, no --allow-local-addresses: these must short-circuit to
    // blocked_address without ever touching detectChrome/Chrome.
    for (const u of ["file:///etc/passwd", "http://127.0.0.1/", "http://169.254.169.254/", "http://[::1]/"]) {
      const r = await renderLocally(u, { maxChars: 1000 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("blocked_address");
    }
  });

  test("read rejects file:// with exit 2 and never contacts the server", async () => {
    const server = mockServer(() => ({ body: metadataDoc }));
    const result = await runCli(
      ["read", "file:///etc/passwd", "--json", "--base-url", server.url, "--key", "test"],
      {},
    );
    server.stop();
    expect(result.code).toBe(2);
    expect(server.calls.length).toBe(0);
    expect(result.stderr).toMatch(/not allowed|http/i);
  });

  test("read rejects a private/loopback address with exit 2 and no server call", async () => {
    const server = mockServer(() => ({ body: metadataDoc }));
    const result = await runCli(
      [
        "read",
        "http://169.254.169.254/latest/meta-data/",
        "--json",
        "--base-url",
        server.url,
        "--key",
        "test",
      ],
      {},
    );
    server.stop();
    expect(result.code).toBe(2);
    expect(server.calls.length).toBe(0);
    expect(result.stderr).toMatch(/local\/internal|blocked/i);
  });

  test("--allow-local-addresses is rejected WITHOUT dev mode (exit 2, no render)", async () => {
    // The flag alone (which an agent could pass) must not unlock local addresses;
    // it is honored only when CAESAR_DEV_MODE is set. The fixture would succeed if
    // the gate were lifted, so this proves the flag alone does not lift it.
    const server = mockServer(() => ({ body: metadataDoc }));
    const fixture = writeFixture({ markdown: RICH_MARKDOWN, title: "T", textLength: 1200 });
    const result = await runCli(
      [
        "read",
        "http://127.0.0.1:3000/",
        "--json",
        "--allow-local-addresses",
        "--base-url",
        server.url,
        "--key",
        "test",
      ],
      { env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture, CAESAR_DEV_MODE: "" } },
    );
    server.stop();
    expect(result.code).toBe(2);
    expect(server.calls.length).toBe(0);
    expect(result.stderr).toMatch(/dev mode|CAESAR_DEV_MODE/i);
  });

  test("--allow-local-addresses + CAESAR_DEV_MODE opens the gate: loopback URL renders locally", async () => {
    // Both keys present: the badInput gate is lifted and local render runs (here
    // via the fixture seam, proving the gate — not the browser — is what changed).
    const server = mockServer(() => ({ body: metadataDoc }));
    const fixture = writeFixture({ markdown: RICH_MARKDOWN, title: "T", textLength: 1200 });
    const result = await runCli(
      [
        "read",
        "http://127.0.0.1:3000/",
        "--json",
        "--allow-local-addresses",
        "--base-url",
        server.url,
        "--key",
        "test",
      ],
      { env: { CAESAR_LOCAL_RENDER_FIXTURE: fixture, CAESAR_DEV_MODE: "1" } },
    );
    server.stop();
    expect(result.code).toBe(0);
    expect(server.calls.length).toBe(0);
    const codes = (JSON.parse(result.stdout).warnings as { code?: string }[]).map((w) => w.code);
    expect(codes).toContain("local_render");
  });

  test("a local address + a server-only feature is rejected, never sent to the server", async () => {
    // Dev mode + flag permits local RENDER, but --query is a server-only feature;
    // the server can't reach the user's network, so this must error, not proxy a
    // private URL to the server.
    const server = mockServer(() => ({ body: metadataDoc }));
    const result = await runCli(
      [
        "read",
        "http://127.0.0.1:3000/",
        "--query",
        "anything",
        "--json",
        "--allow-local-addresses",
        "--base-url",
        server.url,
        "--key",
        "test",
      ],
      { env: { CAESAR_DEV_MODE: "1" } },
    );
    server.stop();
    expect(result.code).toBe(2);
    expect(server.calls.length).toBe(0);
    expect(result.stderr).toMatch(/local\/internal|cannot reach/i);
  });

  test("isRequestPermitted: schemes, literal hosts, and the local opt-in", async () => {
    const cache = () => new Map<string, Promise<boolean>>();
    // Non-network schemes never egress → always allowed.
    expect(await isRequestPermitted("data:text/html,<b>x</b>", false, cache())).toBe(true);
    expect(await isRequestPermitted("about:blank", false, cache())).toBe(true);
    // file: and other schemes are refused.
    expect(await isRequestPermitted("file:///etc/passwd", false, cache())).toBe(false);
    // Literal private/loopback hosts refused unless opted in.
    expect(await isRequestPermitted("http://169.254.169.254/", false, cache())).toBe(false);
    expect(await isRequestPermitted("http://127.0.0.1/", false, cache())).toBe(false);
    expect(await isRequestPermitted("http://127.0.0.1/", true, cache())).toBe(true);
    // A public literal IP is allowed without a DNS round-trip.
    expect(await isRequestPermitted("http://8.8.8.8/", false, cache())).toBe(true);
    // localhost (a name classifyTarget flags as local) is refused unless opted in.
    expect(await isRequestPermitted("http://localhost:3000/", false, cache())).toBe(false);
    expect(await isRequestPermitted("http://localhost:3000/", true, cache())).toBe(true);
  });
});
