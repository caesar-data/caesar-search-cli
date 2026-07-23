import { writeFileSync } from "node:fs";
import { badInput, CliError } from "./exit";

export interface OutputOptions {
  json: boolean;
  /** Write data to this file and suppress stdout (errors still go to stderr). */
  output?: string;
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
  const text = options.json ? JSON.stringify(payload) : human(payload);
  if (options.output) {
    try {
      writeFileSync(options.output, `${text}\n`);
    } catch (error) {
      throw badInput(
        `could not write to ${options.output}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Suppress stdout so nothing competes with the file; note the path on
    // stderr for interactive use only.
    if (!options.json) process.stderr.write(`wrote ${options.output}\n`);
    return;
  }
  process.stdout.write(`${text}\n`);
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

interface UsageResponseLike {
  range?: { from?: string; to?: string; interval?: string; timezone?: string };
  headline?: {
    requests?: number;
    errors?: number;
    error_rate?: number;
    avg_duration_ms?: number;
    p95_duration_ms?: number;
    spend_cents?: number;
  };
  series?: { bucket?: string; requests?: number }[];
  keys?: {
    name?: string;
    key_prefix?: string;
    requests?: number;
    errors?: number;
    p95_duration_ms?: number;
    last_used_at?: string;
    spend_cents?: number;
  }[];
  endpoints?: {
    route?: string;
    requests?: number;
    errors?: number;
    p95_duration_ms?: number;
  }[];
  products?: { label?: string; requests?: number; spend_cents?: number }[];
}

const SPARK_LEVELS = "▁▂▃▄▅▆▇█";

function count(value: number | undefined): string {
  return (value ?? 0).toLocaleString("en-US");
}

function usd(cents: number | undefined): string {
  return `$${((cents ?? 0) / 100).toFixed(2)}`;
}

function ms(value: number | undefined): string {
  return `${Math.round(value ?? 0).toLocaleString("en-US")}ms`;
}

function day(iso: string | undefined): string {
  return (iso ?? "").slice(0, 10);
}

/** Fixed-width text table: first column left-aligned, the rest right-aligned. */
function table(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const format = (cells: string[]): string =>
    cells
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return [dim(format(headers)), ...rows.map(format)];
}

function sparkline(series: { bucket?: string; requests?: number }[]): string[] {
  // Sum per bucket: grouped series carry one row per (bucket, group).
  const byBucket = new Map<string, number>();
  for (const point of series) {
    if (!point.bucket) continue;
    byBucket.set(point.bucket, (byBucket.get(point.bucket) ?? 0) + (point.requests ?? 0));
  }
  const buckets = [...byBucket.keys()].sort();
  if (buckets.length < 2) return [];
  const values = buckets.map((bucket) => byBucket.get(bucket) ?? 0);
  const max = Math.max(...values);
  const line = values
    .map((value) => {
      if (max === 0) return SPARK_LEVELS[0];
      const level = Math.min(SPARK_LEVELS.length - 1, Math.ceil((value / max) * (SPARK_LEVELS.length - 1)));
      return SPARK_LEVELS[level];
    })
    .join("");
  const first = day(buckets[0]);
  const last = day(buckets[buckets.length - 1]);
  const gap = Math.max(1, line.length - first.length - last.length);
  return [line, dim(`${first}${" ".repeat(gap)}${last}`)];
}

export function renderUsageHuman(payload: unknown): string {
  const response = payload as UsageResponseLike;
  const headline = response.headline ?? {};
  const lines: string[] = [];

  lines.push(
    dim(
      `usage ${day(response.range?.from)} → ${day(response.range?.to)} · ${response.range?.interval ?? "day"} buckets · ${response.range?.timezone ?? "UTC"}`,
    ),
  );
  lines.push("");

  if ((headline.requests ?? 0) === 0) {
    lines.push("no usage in this range");
    return lines.join("\n").trimEnd();
  }

  const errorRate = `${((headline.error_rate ?? 0) * 100).toFixed(2)}%`;
  lines.push(
    [
      `requests ${bold(count(headline.requests))}`,
      `errors ${count(headline.errors)} (${errorRate})`,
      `avg ${ms(headline.avg_duration_ms)}`,
      `p95 ${ms(headline.p95_duration_ms)}`,
      `spend ${bold(usd(headline.spend_cents))}`,
    ].join(" · "),
  );

  const spark = sparkline(response.series ?? []);
  if (spark.length > 0) {
    lines.push("");
    lines.push(...spark);
  }

  if ((response.endpoints ?? []).length > 0) {
    lines.push("");
    lines.push(bold("endpoints"));
    lines.push(
      ...table(
        ["route", "requests", "errors", "p95"],
        (response.endpoints ?? []).map((endpoint) => [
          endpoint.route ?? "",
          count(endpoint.requests),
          count(endpoint.errors),
          ms(endpoint.p95_duration_ms),
        ]),
      ),
    );
  }

  if ((response.keys ?? []).length > 0) {
    lines.push("");
    lines.push(bold("keys"));
    lines.push(
      ...table(
        ["name", "requests", "errors", "p95", "last used", "spend"],
        (response.keys ?? []).map((key) => [
          key.key_prefix ? `${key.name} (${key.key_prefix}…)` : (key.name ?? ""),
          count(key.requests),
          count(key.errors),
          ms(key.p95_duration_ms),
          day(key.last_used_at),
          usd(key.spend_cents),
        ]),
      ),
    );
  }

  if ((response.products ?? []).length > 0) {
    const products = response.products ?? [];
    lines.push("");
    lines.push(bold("billable products"));
    const rows = products.map((product) => [
      product.label ?? "",
      count(product.requests),
      usd(product.spend_cents),
    ]);
    rows.push(["total", "", usd(products.reduce((sum, p) => sum + (p.spend_cents ?? 0), 0))]);
    lines.push(...table(["product", "requests", "spend"], rows));
  }

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
