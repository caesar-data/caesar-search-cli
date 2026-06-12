// Build metadata. The compiled binary bakes these via `bun build --define`;
// the npm package falls back to its package.json version at runtime.
declare const CAESAR_CLI_VERSION: string | undefined;
declare const CAESAR_CLI_COMMIT: string | undefined;
declare const CAESAR_CLI_BUILD_DATE: string | undefined;

function fromDefine(value: string | undefined, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function packageVersion(): string {
  try {
    // Resolved relative to the bundled entry; present in the npm package.
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

export const VERSION = fromDefine(
  typeof CAESAR_CLI_VERSION === "undefined" ? undefined : CAESAR_CLI_VERSION,
  packageVersion(),
);
export const COMMIT = fromDefine(
  typeof CAESAR_CLI_COMMIT === "undefined" ? undefined : CAESAR_CLI_COMMIT,
  "unknown",
);
export const BUILD_DATE = fromDefine(
  typeof CAESAR_CLI_BUILD_DATE === "undefined" ? undefined : CAESAR_CLI_BUILD_DATE,
  "unknown",
);
