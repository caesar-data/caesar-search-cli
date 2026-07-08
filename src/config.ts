import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CliConfig {
  api_key?: string;
  base_url?: string;
  // Browser/device login (OAuth) settings. Unset means browser login is
  // not configured and `auth login` falls back to the paste prompt.
  oauth_issuer?: string;
  oauth_client_id?: string;
  console_url?: string;
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

export type KeySource = "flag" | "env" | "keychain" | "config" | "none";

export interface ResolvedAuth {
  key: string | undefined;
  source: KeySource;
}

// Precedence: --key flag > CAESAR_API_KEY > stored credential (OS keychain,
// then config file). The keychain lookup shells out, so cache it per process.
let keychainLookup: (() => string | undefined) | undefined;
let keychainCached: { value: string | undefined } | undefined;

// setKeychainLookup wires the keystore module in (avoids a config<->keystore
// import cycle); cleared cache keeps `auth login` output honest in-process.
export function setKeychainLookup(lookup: () => string | undefined): void {
  keychainLookup = lookup;
  keychainCached = undefined;
}

function keychainKey(): string | undefined {
  if (!keychainLookup) return undefined;
  keychainCached ??= { value: keychainLookup() };
  return keychainCached.value;
}

export function resolveKey(flagKey?: string): ResolvedAuth {
  if (flagKey && flagKey.length > 0) return { key: flagKey, source: "flag" };
  const env = process.env.CAESAR_API_KEY;
  if (env && env.length > 0) return { key: env, source: "env" };
  const keychain = keychainKey();
  if (keychain && keychain.length > 0) return { key: keychain, source: "keychain" };
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

export interface OAuthLoginConfig {
  issuer: string;
  clientId: string;
  consoleUrl: string;
  // Optional RFC 8707 resource indicator sent on authorize/token; defaults
  // to the console URL (the audience the minted access token is used at).
  resource?: string;
}

// Production browser-login endpoints, baked so `auth login` works out of the
// box: the WorkOS Connect issuer (AuthKit domain), the CLI's public OAuth
// client, and the console API that mints keys.
export const DEFAULT_OAUTH_ISSUER = "https://ui.auth.trycaesar.com";
export const DEFAULT_OAUTH_CLIENT_ID = "client_01KX1GGQVTQF42N91HENAXZEE2";
export const DEFAULT_CONSOLE_URL = "https://api.app.trycaesar.com";

// resolveOAuthConfig returns the browser/device-login settings: env over
// config file over baked production defaults. Setting any of the env vars
// to an empty string explicitly disables browser login (undefined return),
// and `auth login` falls back to the paste prompt.
export function resolveOAuthConfig(): OAuthLoginConfig | undefined {
  const config = readConfig();
  const issuer = oauthSetting("CAESAR_OAUTH_ISSUER", config.oauth_issuer, DEFAULT_OAUTH_ISSUER);
  const clientId = oauthSetting("CAESAR_OAUTH_CLIENT_ID", config.oauth_client_id, DEFAULT_OAUTH_CLIENT_ID);
  const consoleUrl = oauthSetting("CAESAR_CONSOLE_URL", config.console_url, DEFAULT_CONSOLE_URL);
  if (!issuer || !clientId || !consoleUrl) return undefined;
  const resource = process.env.CAESAR_OAUTH_RESOURCE;
  return {
    issuer: issuer.replace(/\/+$/, ""),
    clientId,
    consoleUrl: consoleUrl.replace(/\/+$/, ""),
    resource: resource && resource.length > 0 ? resource : undefined,
  };
}

// Env set (even empty) wins — empty meaning "off"; else config; else default.
function oauthSetting(
  envName: string,
  configValue: string | undefined,
  fallback: string,
): string | undefined {
  const env = process.env[envName];
  if (env !== undefined) return env.length > 0 ? env : undefined;
  if (configValue && configValue.length > 0) return configValue;
  return fallback;
}
