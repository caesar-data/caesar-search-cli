import { spawnSync } from "node:child_process";
import { deleteConfigKey, readConfig, writeConfig } from "../config";

// OS-keychain storage for the stored API key, with the existing 0600 config
// file as the fallback (matching gh/supabase behavior). macOS uses the
// `security` CLI against the login keychain; Linux uses `secret-tool`
// (libsecret) when present. Windows and anything else fall back to the file.
//
// The secret is always passed over stdin, never argv, so it cannot leak
// through process listings.

const KEYCHAIN_SERVICE = "caesar-search-cli";
const KEYCHAIN_ACCOUNT = "api_key";

export type KeyStorage = "keychain" | "file";

function keystoreMode(): KeyStorage | "auto" {
  const raw = (process.env.CAESAR_KEYSTORE ?? "auto").toLowerCase();
  if (raw === "keychain" || raw === "file") return raw;
  return "auto";
}

function hasCommand(command: string): boolean {
  const probe = spawnSync(command, ["--help"], { stdio: "ignore" });
  return probe.error === undefined;
}

function keychainBackend(): "security" | "secret-tool" | undefined {
  if (process.platform === "darwin") return "security";
  if (process.platform === "linux" && hasCommand("secret-tool")) return "secret-tool";
  return undefined;
}

// keychainAvailable reports whether an OS keychain backend can be used under
// the current CAESAR_KEYSTORE mode (auto prefers the keychain when present).
export function keychainAvailable(): boolean {
  const mode = keystoreMode();
  if (mode === "file") return false;
  return keychainBackend() !== undefined;
}

function runSecurity(args: string[], input?: string): { ok: boolean; stdout: string } {
  const result = spawnSync("security", args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
  });
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

function runSecretTool(args: string[], input?: string): { ok: boolean; stdout: string } {
  const result = spawnSync("secret-tool", args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
  });
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

function keychainGet(): string | undefined {
  switch (keychainBackend()) {
    case "security": {
      const result = runSecurity([
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
        "-w",
      ]);
      const value = result.stdout.trim();
      return result.ok && value.length > 0 ? value : undefined;
    }
    case "secret-tool": {
      const result = runSecretTool(["lookup", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT]);
      const value = result.stdout.trim();
      return result.ok && value.length > 0 ? value : undefined;
    }
    default:
      return undefined;
  }
}

function keychainSet(secret: string): boolean {
  switch (keychainBackend()) {
    case "security": {
      // `security -i` reads commands from stdin, so the secret never
      // appears in argv. -U updates an existing item in place.
      const command = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w ${JSON.stringify(secret)}\n`;
      return runSecurity(["-i"], command).ok;
    }
    case "secret-tool": {
      return runSecretTool(
        ["store", "--label", "Caesar Search CLI", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT],
        secret,
      ).ok;
    }
    default:
      return false;
  }
}

function keychainDelete(): void {
  switch (keychainBackend()) {
    case "security":
      runSecurity(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]);
      return;
    case "secret-tool":
      runSecretTool(["clear", "service", KEYCHAIN_SERVICE, "account", KEYCHAIN_ACCOUNT]);
      return;
    default:
      return;
  }
}

// storedKeyFromKeychain returns the key held in the OS keychain, if any.
// Distinct from the config-file key so `auth status` can name the source.
export function storedKeyFromKeychain(): string | undefined {
  if (!keychainAvailable()) return undefined;
  return keychainGet();
}

// storeKey persists a key in the OS keychain when available (unless
// forceFile), else in the 0600 config file, and reports where it landed.
// Storing in the keychain clears any stale config-file copy and vice versa,
// so exactly one stored credential exists afterwards.
export function storeKey(secret: string, options: { forceFile?: boolean } = {}): KeyStorage {
  if (!options.forceFile && keychainAvailable() && keychainSet(secret)) {
    deleteConfigKey("api_key");
    return "keychain";
  }
  const config = readConfig();
  config.api_key = secret;
  writeConfig(config);
  if (keychainAvailable()) keychainDelete();
  return "file";
}

// removeStoredKey clears the stored credential from every location.
export function removeStoredKey(): void {
  if (keychainAvailable()) keychainDelete();
  deleteConfigKey("api_key");
}
