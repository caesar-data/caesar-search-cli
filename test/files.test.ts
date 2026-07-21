import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MockServer, mockServer, runCli } from "./helpers";

const KEY = "csk_0123456789abcdefghijklmnopqrstuvwxyzABCD";

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "caesar-files-test-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

let servers: MockServer[] = [];

function track(server: MockServer): MockServer {
  servers.push(server);
  return server;
}

afterEach(() => {
  for (const server of servers) server.stop();
  servers = [];
});

/** Fake storage endpoint; records the PUT like the API mock records calls. */
function storageServer(status = 200): MockServer {
  return track(mockServer(() => ({ status, body: status === 200 ? "" : "denied" })));
}

function apiServer(storageUrl: string): MockServer {
  return track(
    mockServer((call) => {
      if (call.path === "/v1/files/presign") {
        return {
          body: {
            url: `${storageUrl}/bucket/org/notes.txt`,
            name: "notes.txt",
            expires_in_seconds: 900,
            max_object_bytes: 104857600,
          },
        };
      }
      if (call.path === "/v1/files/index" && call.method === "POST") {
        return { status: 202, body: { sync_id: "sync-1", state: "queued" } };
      }
      if (call.path === "/v1/files" && call.method === "GET") {
        return {
          body: {
            files: [{ name: "notes.txt", size: 20, last_modified: "2026-01-01T00:00:00Z" }],
          },
        };
      }
      if (call.method === "DELETE") {
        return { body: { deleted: true } };
      }
      if (call.path.startsWith("/v1/files/index/")) {
        return {
          body: {
            sync_id: "sync-1",
            state: "completed",
            stats: {
              enumerated: 1,
              fetched: 1,
              indexed: 1,
              failed: 0,
              skipped_unsupported: 0,
              deleted: 0,
              bytes: 20,
            },
            error: null,
          },
        };
      }
      return { status: 500, body: { error: { code: "unexpected", message: call.path } } };
    }),
  );
}

describe("files upload", () => {
  test("presigns, PUTs the bytes without auth, indexes, and reports", async () => {
    const storage = storageServer();
    const api = apiServer(storage.url);
    const path = tempFile("notes.txt", "hello knowledge base");

    const result = await runCli(["files", "upload", path, "--content-type", "text/plain", "--json"], {
      env: { CAESAR_API_KEY: KEY, CAESAR_BASE_URL: api.url },
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      uploaded: [{ name: "notes.txt", size: 20 }],
      sync_id: "sync-1",
      state: "queued",
    });

    const presign = api.calls[0];
    expect(presign?.path).toBe("/v1/files/presign");
    expect(presign?.body).toEqual({ filename: "notes.txt", size: 20, content_type: "text/plain" });
    expect(presign?.headers.authorization).toBe(`Bearer ${KEY}`);

    const put = storage.calls[0];
    expect(put?.method).toBe("PUT");
    expect(put?.body).toBe("hello knowledge base");
    expect(put?.headers["content-type"]).toBe("text/plain");
    // The presigned URL is pre-authorized; the API key must never reach storage.
    expect(put?.headers.authorization).toBeUndefined();

    expect(api.calls[1]?.path).toBe("/v1/files/index");
    expect(api.calls[1]?.body).toEqual({ mode: "incremental" });
  });

  test("--no-index skips the indexing run and prints human output", async () => {
    const storage = storageServer();
    const api = apiServer(storage.url);
    const path = tempFile("notes.txt", "hello knowledge base");

    const result = await runCli(["files", "upload", path, "--no-index"], {
      env: { CAESAR_API_KEY: KEY, CAESAR_BASE_URL: api.url },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("uploaded notes.txt");
    expect(result.stdout).toContain("indexing skipped");
    expect(api.calls.map((call) => call.path)).toEqual(["/v1/files/presign"]);
  });

  test("missing local file exits 2 without any API call", async () => {
    const api = apiServer("http://127.0.0.1:9");
    const result = await runCli(["files", "upload", "/nonexistent/nope.txt"], {
      env: { CAESAR_API_KEY: KEY, CAESAR_BASE_URL: api.url },
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("cannot read");
    expect(api.calls).toHaveLength(0);
  });

  test("a rejected storage PUT exits 4 with upload_failed", async () => {
    const storage = storageServer(403);
    const api = apiServer(storage.url);
    const path = tempFile("notes.txt", "hello knowledge base");

    const result = await runCli(["files", "upload", path, "--json"], {
      env: { CAESAR_API_KEY: KEY, CAESAR_BASE_URL: api.url },
    });
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stderr).error.code).toBe("upload_failed");
  });

  test("missing key exits 3", async () => {
    const result = await runCli(["files", "list"], {});
    expect(result.code).toBe(3);
  });

  test("duplicate basenames exit 2 before any API call", async () => {
    const api = apiServer("http://127.0.0.1:9");
    const first = tempFile("file.txt", "one");
    const second = tempFile("file.txt", "two");

    const result = await runCli(["files", "upload", first, second, "--json"], {
      env: { CAESAR_API_KEY: KEY, CAESAR_BASE_URL: api.url },
    });

    expect(result.code).toBe(2);
    expect(JSON.parse(result.stderr).error.message).toContain("file.txt");
    expect(api.calls).toHaveLength(0);
  });

  test("a mid-batch failure still indexes and reports the earlier uploads", async () => {
    let puts = 0;
    const storage = track(
      mockServer(() => {
        puts += 1;
        return puts === 1 ? { status: 200, body: "" } : { status: 403, body: "denied" };
      }),
    );
    const api = track(
      mockServer((call) => {
        if (call.path === "/v1/files/presign") {
          const filename = (call.body as { filename: string }).filename;
          return {
            body: {
              url: `${storage.url}/bucket/org/${filename}`,
              name: filename,
              expires_in_seconds: 900,
              max_object_bytes: 104857600,
            },
          };
        }
        if (call.path === "/v1/files/index") {
          return { status: 202, body: { sync_id: "sync-1", state: "queued" } };
        }
        return { status: 500, body: { error: { code: "unexpected", message: call.path } } };
      }),
    );
    const first = tempFile("a.txt", "one");
    const second = tempFile("b.txt", "two");

    const result = await runCli(["files", "upload", first, second, "--json"], {
      env: { CAESAR_API_KEY: KEY, CAESAR_BASE_URL: api.url },
    });

    expect(result.code).toBe(4);
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBe("upload_failed");
    // The successful first upload is indexed and named in the hint.
    expect(error.hint).toContain("1 earlier file(s) uploaded");
    expect(error.hint).toContain("a.txt");
    expect(error.hint).toContain("sync-1");
    expect(api.calls.map((call) => call.path)).toEqual([
      "/v1/files/presign",
      "/v1/files/presign",
      "/v1/files/index",
    ]);
  });

  test("a hung storage PUT exits 5 with timeout", async () => {
    const hang = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    const api = track(
      mockServer(() => ({
        body: {
          url: `http://127.0.0.1:${hang.port}/obj`,
          name: "notes.txt",
          expires_in_seconds: 900,
          max_object_bytes: 104857600,
        },
      })),
    );
    const path = tempFile("notes.txt", "hello");

    try {
      const result = await runCli(["files", "upload", path, "--json"], {
        env: { CAESAR_API_KEY: KEY, CAESAR_BASE_URL: api.url, CAESAR_UPLOAD_TIMEOUT_MS: "150" },
      });
      expect(result.code).toBe(5);
      expect(JSON.parse(result.stderr).error.code).toBe("timeout");
    } finally {
      hang.stop(true);
    }
  });
});

describe("files management", () => {
  test("list renders names and count, and --json emits the payload", async () => {
    const api = apiServer("http://127.0.0.1:9");
    const human = await runCli(["files", "list"], {
      env: { CAESAR_API_KEY: KEY, CAESAR_BASE_URL: api.url },
    });
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("notes.txt");
    expect(human.stdout).toContain("1 file(s)");

    const json = await runCli(["files", "list", "--json"], {
      env: { CAESAR_API_KEY: KEY, CAESAR_BASE_URL: api.url },
    });
    expect(JSON.parse(json.stdout).files[0].name).toBe("notes.txt");
  });

  test("delete URL-encodes the name", async () => {
    const api = apiServer("http://127.0.0.1:9");
    const result = await runCli(["files", "delete", "My Report.pdf"], {
      env: { CAESAR_API_KEY: KEY, CAESAR_BASE_URL: api.url },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("deleted My Report.pdf");
    expect(api.calls[0]?.method).toBe("DELETE");
    expect(api.calls[0]?.path).toBe("/v1/files/My%20Report.pdf");
  });

  test("delete renders the API's deleted flag truthfully", async () => {
    const api = track(mockServer(() => ({ body: { deleted: false } })));
    const result = await runCli(["files", "delete", "ghost.pdf"], {
      env: { CAESAR_API_KEY: KEY, CAESAR_BASE_URL: api.url },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("ghost.pdf was not deleted");
    expect(result.stdout).not.toContain("deleted ghost.pdf");
  });

  test("index validates --mode and posts it", async () => {
    const api = apiServer("http://127.0.0.1:9");
    const bad = await runCli(["files", "index", "--mode", "sideways"], {
      env: { CAESAR_API_KEY: KEY, CAESAR_BASE_URL: api.url },
    });
    expect(bad.code).toBe(2);

    const ok = await runCli(["files", "index", "--mode", "full"], {
      env: { CAESAR_API_KEY: KEY, CAESAR_BASE_URL: api.url },
    });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("sync-1");
    expect(api.calls[0]?.body).toEqual({ mode: "full" });
  });

  test("status renders run counters", async () => {
    const api = apiServer("http://127.0.0.1:9");
    const result = await runCli(["files", "status", "sync-1"], {
      env: { CAESAR_API_KEY: KEY, CAESAR_BASE_URL: api.url },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("sync-1: completed");
    expect(result.stdout).toContain("indexed 1");
  });
});
