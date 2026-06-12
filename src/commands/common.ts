import type { Command } from "commander";
import { ApiClient } from "../api/client";
import { badInput } from "../output/exit";

export interface GlobalOptions {
  json?: boolean;
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

export async function argOrStdin(value: string, name: string): Promise<string> {
  if (value !== "-") return value;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
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
