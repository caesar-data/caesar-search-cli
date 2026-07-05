import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { ApiClient } from "../api/client";
import { badInput } from "../output/exit";

import type { OutputOptions } from "../output/render";

export interface GlobalOptions {
  json?: boolean;
  output?: string;
  key?: string;
  baseUrl?: string;
  retry?: boolean;
  timeout?: string;
  verbose?: boolean;
}

// Diagnostics to stderr are on when --verbose is passed or CAESAR_DEBUG is set
// to anything other than an explicit off value.
export function isVerbose(command: Command): boolean {
  if (command.optsWithGlobals<GlobalOptions>().verbose === true) return true;
  const env = process.env.CAESAR_DEBUG;
  return env !== undefined && env !== "" && env !== "0" && env.toLowerCase() !== "false";
}

// Dev mode unlocks operator-only escape hatches (currently: rendering local/
// private addresses via --allow-local-addresses). It is env-driven on purpose —
// an agent that only controls command arguments cannot enable it, so a flag
// alone can never reach the user's own network unless the human running the CLI
// opted the environment in with CAESAR_DEV_MODE.
export function isDevMode(): boolean {
  const env = process.env.CAESAR_DEV_MODE;
  return env !== undefined && env !== "" && env !== "0" && env.toLowerCase() !== "false";
}

// Whether unsandboxed local rendering is permitted. Gated behind an env var (not
// just the --allow-unsandboxed-render flag) so an agent that only controls CLI
// arguments can't opt into rendering a hostile page without the Chrome sandbox on
// hosts where the sandbox can't launch; the operator must set the environment.
export function isUnsandboxedRenderAllowed(): boolean {
  const env = process.env.CAESAR_ALLOW_UNSANDBOXED_RENDER;
  return env !== undefined && env !== "" && env !== "0" && env.toLowerCase() !== "false";
}

export function clientFromCommand(command: Command): ApiClient {
  const options = command.optsWithGlobals<GlobalOptions>();
  const timeoutMs = options.timeout ? Number(options.timeout) * 1000 : undefined;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw badInput("--timeout must be a positive number of seconds");
  }
  return new ApiClient({
    key: options.key,
    baseUrl: options.baseUrl,
    retries: options.retry !== false,
    timeoutMs,
  });
}

export function jsonMode(command: Command): boolean {
  return command.optsWithGlobals<GlobalOptions>().json === true;
}

export function outputOptions(command: Command): OutputOptions {
  const options = command.optsWithGlobals<GlobalOptions>();
  return { json: options.json === true, output: options.output };
}

export async function argOrStdin(value: string, name: string): Promise<string> {
  if (value !== "-") return value;
  // readFileSync(0) reads fd 0 to EOF and behaves identically under Node and
  // Bun on every platform; async-iterating process.stdin does not.
  const text = readFileSync(0, "utf8").trim();
  if (text.length === 0) throw badInput(`stdin was empty; pass a ${name} or pipe one in`);
  return text;
}

export function parsePositiveInt(name: string, raw: string, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw badInput(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeDocID(value: string): boolean {
  return UUID_PATTERN.test(value);
}
