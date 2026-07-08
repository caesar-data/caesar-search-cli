import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CliConfig {
  api_key?: string;
  base_url?: string;
}

export const DEFAULT_BASE_URL = "https://alpha.api.trycaesar.com";

export function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "caesar", "config.json");
}

export function readConfig(): CliConfig {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as CliConfig;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function writeConfig(config: CliConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function deleteConfigKey(key: keyof CliConfig): void {
  const config = readConfig();
  delete config[key];
  if (Object.keys(config).length === 0 && existsSync(configPath())) {
    unlinkSync(configPath());
    return;
  }
  writeConfig(config);
}

export type KeySource = "flag" | "env" | "config" | "none";

export interface ResolvedAuth {
  key: string | undefined;
  source: KeySource;
}

// Precedence: --key flag > CAESAR_API_KEY > config file.
export function resolveKey(flagKey?: string): ResolvedAuth {
  if (flagKey && flagKey.length > 0) return { key: flagKey, source: "flag" };
  const env = process.env.CAESAR_API_KEY;
  if (env && env.length > 0) return { key: env, source: "env" };
  const config = readConfig();
  if (config.api_key && config.api_key.length > 0) return { key: config.api_key, source: "config" };
  return { key: undefined, source: "none" };
}

// Precedence: --base-url flag > CAESAR_BASE_URL > config file > default.
export function resolveBaseUrl(flagUrl?: string): string {
  if (flagUrl && flagUrl.length > 0) return flagUrl.replace(/\/+$/, "");
  const env = process.env.CAESAR_BASE_URL;
  if (env && env.length > 0) return env.replace(/\/+$/, "");
  const config = readConfig();
  if (config.base_url && config.base_url.length > 0) return config.base_url.replace(/\/+$/, "");
  return DEFAULT_BASE_URL;
}

export function isPublicBaseUrl(baseUrl: string): boolean {
  return baseUrl.replace(/\/+$/, "") === DEFAULT_BASE_URL;
}

export function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}
