import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import { badInput, CliError, EXIT_API } from "../output/exit";
import { emitData } from "../output/render";
import { clientFromCommand, outputOptions } from "./common";

const modeSchema = z.enum(["full", "incremental"]);

/** Presigned uploads can be large; give the storage PUT more room than API calls. */
const UPLOAD_TIMEOUT_MS = 120_000;

interface PresignResponse {
  url: string;
  name: string;
  max_object_bytes: number;
}

interface IndexResponse {
  sync_id: string;
  state: string;
}

interface FileEntry {
  name?: string;
  size?: number;
  last_modified?: string;
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function readLocalFile(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw badInput(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * PUT bytes to the presigned storage URL. Deliberately a bare fetch: the URL
 * is pre-authorized by its signature, so the API key must never be attached,
 * and the body must be exactly the presigned size.
 */
async function putToStorage(url: string, bytes: Buffer, contentType: string | undefined): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "PUT",
      body: new Uint8Array(bytes),
      headers: contentType ? { "Content-Type": contentType } : {},
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CliError(
      "upload_failed",
      `storage upload failed: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_API,
      "Check connectivity; the presigned URL expires after a few minutes.",
    );
  }
  if (!response.ok) {
    throw new CliError(
      "upload_failed",
      `storage rejected the upload with status ${response.status}`,
      EXIT_API,
      "The upload must match the exact size given at presign time.",
    );
  }
}

export function registerFiles(program: Command): void {
  const files = program
    .command("files")
    .description("Upload and manage your organization's files knowledge base.");

  files
    .command("upload")
    .description("Upload one or more local files and index them for workspace search.")
    .argument("<path...>", "local file paths to upload")
    .option("--content-type <type>", "MIME type recorded on the uploads")
    .option("--no-index", "skip the automatic indexing run after uploading")
    .addHelpText(
      "after",
      `
Examples:
  caesar-search files upload ./report.pdf
  caesar-search files upload notes.md data.csv --no-index
  caesar-search files upload ./scan.pdf --content-type application/pdf --json`,
    )
    .action(async (paths: string[], options: { contentType?: string; index: boolean }, command: Command) => {
      const client = clientFromCommand(command);
      const uploaded: { name: string; size: number }[] = [];
      for (const path of paths) {
        const bytes = readLocalFile(path);
        const presigned = (await client.post("/v1/files/presign", {
          filename: basename(path),
          size: bytes.byteLength,
          ...(options.contentType ? { content_type: options.contentType } : {}),
        })) as PresignResponse;
        await putToStorage(presigned.url, bytes, options.contentType);
        uploaded.push({ name: presigned.name, size: bytes.byteLength });
      }

      let index: IndexResponse | undefined;
      if (options.index) {
        index = (await client.post("/v1/files/index", { mode: "incremental" })) as IndexResponse;
      }

      const payload = {
        uploaded,
        ...(index ? { sync_id: index.sync_id, state: index.state } : {}),
      };
      emitData(payload, outputOptions(command), () => {
        const lines = uploaded.map((file) => `uploaded ${file.name} (${formatSize(file.size)})`);
        if (index) {
          lines.push(`indexing started: ${index.sync_id} (${index.state})`);
          lines.push(`check progress with: caesar-search files status ${index.sync_id}`);
        } else {
          lines.push("indexing skipped; run: caesar-search files index");
        }
        return lines.join("\n");
      });
    });

  files
    .command("list")
    .description("List uploaded files.")
    .action(async (_options, command: Command) => {
      const client = clientFromCommand(command);
      const response = (await client.get("/v1/files")) as { files?: FileEntry[] };
      emitData(response, outputOptions(command), () => {
        const entries = response.files ?? [];
        if (entries.length === 0) return "no files uploaded";
        const lines = entries.map((file) =>
          [file.name, formatSize(file.size), file.last_modified ?? ""].filter(Boolean).join("  "),
        );
        lines.push(`${entries.length} file(s)`);
        return lines.join("\n");
      });
    });

  files
    .command("delete")
    .description("Delete one uploaded file by name (as shown by files list).")
    .argument("<name>", "filename to delete")
    .action(async (name: string, _options, command: Command) => {
      const client = clientFromCommand(command);
      const response = await client.request("DELETE", `/v1/files/${encodeURIComponent(name)}`);
      emitData(response.body, outputOptions(command), () => `deleted ${name}`);
    });

  files
    .command("index")
    .description("Start an indexing run so uploaded files become searchable.")
    .option("--mode <mode>", "full | incremental", "incremental")
    .action(async (options: { mode: string }, command: Command) => {
      const mode = modeSchema.safeParse(options.mode);
      if (!mode.success) throw badInput("--mode must be full or incremental");
      const client = clientFromCommand(command);
      const response = (await client.post("/v1/files/index", { mode: mode.data })) as IndexResponse;
      emitData(response, outputOptions(command), () =>
        [
          `indexing started: ${response.sync_id} (${response.state})`,
          `check progress with: caesar-search files status ${response.sync_id}`,
        ].join("\n"),
      );
    });

  files
    .command("status")
    .description("Show progress and outcome of an indexing run.")
    .argument("<sync-id>", "indexing run id from files upload or files index")
    .action(async (syncId: string, _options, command: Command) => {
      const client = clientFromCommand(command);
      const response = (await client.get(`/v1/files/index/${encodeURIComponent(syncId)}`)) as {
        sync_id?: string;
        state?: string;
        stats?: Record<string, number>;
        error?: string | null;
      };
      emitData(response, outputOptions(command), () => {
        const stats = response.stats ?? {};
        const lines = [
          `${response.sync_id}: ${response.state}`,
          `enumerated ${stats.enumerated ?? 0} · fetched ${stats.fetched ?? 0} · indexed ${stats.indexed ?? 0} · failed ${stats.failed ?? 0} · skipped ${stats.skipped_unsupported ?? 0} · deleted ${stats.deleted ?? 0}`,
        ];
        if (response.error) lines.push(`error: ${response.error}`);
        return lines.join("\n");
      });
    });
}
