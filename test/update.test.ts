import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isNewer } from "../src/commands/update";
import { runCli } from "./helpers";

function releaseServer(tag: string): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(JSON.stringify({ tag_name: tag }), {
        headers: { "Content-Type": "application/json" },
      }),
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

describe("isNewer", () => {
  test("orders semver correctly", () => {
    expect(isNewer("0.2.0", "0.1.9")).toBe(true);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.1.3", "0.1.3")).toBe(false);
    expect(isNewer("0.1.2", "0.1.3")).toBe(false);
    expect(isNewer("v0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("0.1.10", "0.1.9")).toBe(true);
  });
});

describe("update --check", () => {
  test("reports an available update with channel and versions", async () => {
    const api = releaseServer("v99.0.0");
    const result = await runCli(["update", "--check", "--json"], {
      env: { CAESAR_UPDATE_API: api.url, CAESAR_UPDATE_CHANNEL: "npm" },
    });
    api.stop();
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.update_available).toBe(true);
    expect(payload.latest).toBe("99.0.0");
    expect(payload.channel).toBe("npm");
    expect(typeof payload.current).toBe("string");
  });

  test("reports up to date when latest matches current", async () => {
    const api = releaseServer("v0.0.0");
    const result = await runCli(["update", "--check"], {
      env: { CAESAR_UPDATE_API: api.url, CAESAR_UPDATE_CHANNEL: "brew" },
    });
    api.stop();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("up to date");
  });

  test("exit 4 when the release API is unreachable", async () => {
    const result = await runCli(["update", "--check", "--json"], {
      env: { CAESAR_UPDATE_API: "http://127.0.0.1:9", CAESAR_UPDATE_CHANNEL: "npm" },
    });
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stderr).error.code).toBe("update_check_failed");
  });
});

describe("update", () => {
  test("up to date is a no-op success", async () => {
    const api = releaseServer("v0.0.0");
    const result = await runCli(["update"], {
      env: { CAESAR_UPDATE_API: api.url, CAESAR_UPDATE_CHANNEL: "standalone" },
    });
    api.stop();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("up to date");
  });

  test("dev channel refuses with a source hint", async () => {
    const api = releaseServer("v99.0.0");
    const result = await runCli(["update", "--json"], {
      env: { CAESAR_UPDATE_API: api.url, CAESAR_UPDATE_CHANNEL: "dev" },
    });
    api.stop();
    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stderr);
    expect(envelope.error.message).toContain("development build");
    expect(envelope.error.hint).toContain("git pull");
  });

  test("npm channel runs the package-manager upgrade", async () => {
    const api = releaseServer("v99.0.0");
    // Stub `npm` on PATH so the spawn path is exercised without touching the
    // real global install.
    const bin = mkdtempSync(join(tmpdir(), "caesar-cli-fake-npm-"));
    const log = join(bin, "invocations.log");
    writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "$@" >> ${log}\n`);
    chmodSync(join(bin, "npm"), 0o755);

    const result = await runCli(["update", "--json"], {
      env: {
        CAESAR_UPDATE_API: api.url,
        CAESAR_UPDATE_CHANNEL: "npm",
        PATH: `${bin}:${process.env.PATH}`,
      },
    });
    api.stop();
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.updated).toBe(true);
    expect(payload.channel).toBe("npm");
    expect(await Bun.file(log).text()).toContain("install -g caesar-search-cli@latest");
  });

  test("failed upgrade command exits 4 with a hint", async () => {
    const api = releaseServer("v99.0.0");
    const bin = mkdtempSync(join(tmpdir(), "caesar-cli-fake-brew-"));
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "brew"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, "brew"), 0o755);

    const result = await runCli(["update", "--json"], {
      env: {
        CAESAR_UPDATE_API: api.url,
        CAESAR_UPDATE_CHANNEL: "brew",
        PATH: `${bin}:${process.env.PATH}`,
      },
    });
    api.stop();
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stderr).error.code).toBe("update_failed");
  });

  test("standalone checksum mismatch exits 4 without touching the binary", async () => {
    const api = releaseServer("v99.0.0");
    const downloads = Bun.serve({
      port: 0,
      fetch: (request) => {
        if (request.url.endsWith("checksums.txt")) {
          return new Response("deadbeef  caesar-search_99.0.0_darwin_arm64.tar.gz\n");
        }
        return new Response("not-a-real-archive");
      },
    });
    const result = await runCli(["update", "--json"], {
      env: {
        CAESAR_UPDATE_API: api.url,
        CAESAR_UPDATE_CHANNEL: "standalone",
        CAESAR_UPDATE_DOWNLOAD_BASE: `http://127.0.0.1:${downloads.port}`,
      },
    });
    api.stop();
    downloads.stop(true);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stderr).error.code).toBe("update_checksum_mismatch");
  });
});
