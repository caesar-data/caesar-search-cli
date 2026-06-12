import { CliError } from "./exit";

export interface OutputOptions {
  json: boolean;
}

function colorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  return process.stdout.isTTY === true;
}

function bold(text: string): string {
  return colorEnabled() ? `\x1b[1m${text}\x1b[0m` : text;
}

function dim(text: string): string {
  return colorEnabled() ? `\x1b[2m${text}\x1b[0m` : text;
}

// Data goes to stdout; diagnostics go to stderr.
export function emitData(
  payload: unknown,
  options: OutputOptions,
  human: (payload: unknown) => string,
): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  process.stdout.write(`${human(payload)}\n`);
}

export function emitError(error: unknown, json: boolean): number {
  const cliError =
    error instanceof CliError
      ? error
      : new CliError("internal_error", error instanceof Error ? error.message : String(error), 4);
  const envelope = {
    error: {
      code: cliError.code,
      message: cliError.message,
      ...(cliError.hint ? { hint: cliError.hint } : {}),
    },
  };
  if (json) {
    process.stderr.write(`${JSON.stringify(envelope)}\n`);
  } else {
    process.stderr.write(`error (${cliError.code}): ${cliError.message}\n`);
    if (cliError.hint) process.stderr.write(`hint: ${cliError.hint}\n`);
  }
  return cliError.exitCode;
}

interface SearchResultLike {
  rank?: number;
  title?: string;
  canonical_url?: string;
  snippet?: string;
  doc_id?: string;
  score?: { value?: number };
  metadata?: { published_at?: string; last_crawled_at?: string };
}

interface SearchResponseLike {
  search_id?: string;
  ranking?: { ranker_version?: string };
  results?: SearchResultLike[];
  truncated?: boolean;
  warnings?: { code?: string; message?: string }[];
  usage?: { approx_tokens?: number };
}

export function renderSearchHuman(payload: unknown): string {
  const response = payload as SearchResponseLike;
  const lines: string[] = [];
  for (const result of response.results ?? []) {
    const date = result.metadata?.published_at ?? result.metadata?.last_crawled_at ?? "";
    lines.push(`${bold(`${result.rank}. ${result.title ?? "(untitled)"}`)}`);
    lines.push(`   ${result.canonical_url ?? ""}`);
    if (result.snippet) lines.push(`   ${result.snippet}`);
    lines.push(`   ${dim(`doc_id=${result.doc_id ?? ""}${date ? `  ${date}` : ""}`)}`);
    lines.push("");
  }
  if ((response.results ?? []).length === 0) lines.push("no results");
  for (const warning of response.warnings ?? []) {
    lines.push(dim(`warning (${warning.code}): ${warning.message}`));
  }
  if (response.search_id) lines.push(dim(`search_id=${response.search_id}`));
  return lines.join("\n").trimEnd();
}

interface DocumentResponseLike {
  doc?: { doc_id?: string; canonical_url?: string; title?: string; published_at?: string };
  content?: { text?: string; truncated?: boolean; start_char?: number; char_count?: number };
  warnings?: { code?: string; message?: string }[];
}

export function renderDocumentHuman(payload: unknown): string {
  const response = payload as DocumentResponseLike;
  const lines: string[] = [];
  if (response.doc?.title) lines.push(bold(response.doc.title));
  if (response.doc?.canonical_url) lines.push(dim(response.doc.canonical_url));
  lines.push(dim(`doc_id=${response.doc?.doc_id ?? ""}`));
  lines.push("");
  if (response.content?.text) lines.push(response.content.text);
  if (response.content?.truncated) {
    const next = (response.content.start_char ?? 0) + (response.content.char_count ?? 0);
    lines.push("");
    lines.push(dim(`truncated; continue with --start-char ${next}`));
  }
  for (const warning of response.warnings ?? []) {
    lines.push(dim(`warning (${warning.code}): ${warning.message}`));
  }
  return lines.join("\n").trimEnd();
}
