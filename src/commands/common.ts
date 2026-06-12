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
