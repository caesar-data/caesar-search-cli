import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { badInput, CliError, EXIT_API } from "../output/exit";
import { emitData } from "../output/render";
import { VERSION } from "../version";
import { outputOptions } from "./common";

const REPO = "caesar-data/caesar-search-cli";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;

export type Channel = "npm" | "brew" | "standalone" | "dev";

export const UPGRADE_COMMANDS: Record<Exclude<Channel, "dev">, string> = {
  npm: "npm install -g caesar-search-cli@latest",
  brew: "brew upgrade caesar-data/tap/caesar-search",
  standalone: "caesar-search update",
};

export function detectChannel(): Channel {
  const override = process.env.CAESAR_UPDATE_CHANNEL;
  if (override === "npm" || override === "brew" || override === "standalone" || override === "dev") {
    return override;
  }
  const script = process.argv[1] ?? "";
  if (script.includes("node_modules")) return "npm";
  // Compiled Bun binaries surface a virtual $bunfs entry path and execute as
  // themselves; anything else (bun src/index.ts, test runs) is a dev build.
  if (!script.includes("$bunfs") && !script.includes("~BUN")) return "dev";
  try {
    const real = realpathSync(process.execPath);
    if (real.includes("/Cellar/") || real.includes("/homebrew/") || real.includes("/linuxbrew/")) {
      return "brew";
    }
  } catch {
    // Fall through: an unresolvable path still gets standalone treatment.
  }
  return "standalone";
}

export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [a, b] = [parse(latest), parse(current)];
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return latest !== current;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

async function fetchLatestTag(): Promise<string> {
  const url = process.env.CAESAR_UPDATE_API ?? RELEASES_API;
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  } catch (error) {
    throw new CliError(
      "update_check_failed",
      `could not reach the release API: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_API,
    );
  }
  if (!response.ok) {
    throw new CliError("update_check_failed", `release API returned ${response.status}`, EXIT_API);
  }
  const release = (await response.json()) as { tag_name?: string };
  if (!release.tag_name) {
    throw new CliError("update_check_failed", "release API response had no tag_name", EXIT_API);
  }
  return release.tag_name;
}

function platformPair(): { platform: string; cpu: string } {
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "";
  const cpu = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : "";
  if (!platform || !cpu) {
    throw new CliError(
      "update_unsupported",
      `no prebuilt binary for ${process.platform}/${process.arch}`,
      EXIT_API,
      `download manually from https://github.com/${REPO}/releases`,
    );
  }
  return { platform, cpu };
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new CliError("update_download_failed", `${url} returned ${response.status}`, EXIT_API);
  }
  return new Uint8Array(await response.arrayBuffer());
}

// Replaces the running binary in place, mirroring install.sh: fetch the
// release archive, verify its sha256 against checksums.txt, swap atomically.
async function selfReplace(tag: string): Promise<string> {
  const { platform, cpu } = platformPair();
  const version = tag.replace(/^v/, "");
  const archive = `caesar-search_${version}_${platform}_${cpu}.tar.gz`;
  const base =
    process.env.CAESAR_UPDATE_DOWNLOAD_BASE ?? `https://github.com/${REPO}/releases/download/${tag}`;

  const tmp = mkdtempSync(join(tmpdir(), "caesar-search-update-"));
  try {
    const [archiveBytes, checksums] = await Promise.all([
      download(`${base}/${archive}`),
      download(`${base}/checksums.txt`),
    ]);
    const digest = createHash("sha256").update(archiveBytes).digest("hex");
    const expected = new TextDecoder()
      .decode(checksums)
      .split("\n")
      .find((line) => line.endsWith(archive))
      ?.split(/\s+/)[0];
    if (!expected || expected !== digest) {
      throw new CliError("update_checksum_mismatch", `checksum verification failed for ${archive}`, EXIT_API);
    }

    const archivePath = join(tmp, archive);
    writeFileSync(archivePath, archiveBytes);
    const untar = Bun.spawnSync(["tar", "-xzf", archivePath, "-C", tmp]);
    if (untar.exitCode !== 0) {
      throw new CliError("update_extract_failed", untar.stderr.toString().trim(), EXIT_API);
    }

    const target = realpathSync(process.execPath);
    const staged = join(tmp, "caesar-search");
    chmodSync(staged, 0o755);
    // rename() over the live binary is atomic on POSIX; the running process
    // keeps its already-mapped image.
    renameSync(staged, target);
    return target;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function runUpgradeCommand(commandLine: string, json: boolean): Promise<void> {
  // In --json mode the package manager's chatter must not pollute the
  // machine-readable streams.
  const proc = Bun.spawn(["sh", "-c", commandLine], {
    stdout: json ? "ignore" : "inherit",
    stderr: json ? "ignore" : "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new CliError(
      "update_failed",
      `\`${commandLine}\` exited with code ${code}`,
      EXIT_API,
      "run it manually to see the full output",
    );
  }
}

export function registerUpdate(program: Command): void {
  program
    .command("update")
    .description(
      "Update caesar-search to the latest release (detects npm, Homebrew, or standalone installs).",
    )
    .option("--check", "only report whether an update is available; do not install")
    .addHelpText(
      "after",
      `
Examples:
  caesar-search update --check --json
  caesar-search update`,
    )
    .action(async (options, command: Command) => {
      const channel = detectChannel();
      const tag = await fetchLatestTag();
      const latest = tag.replace(/^v/, "");
      const updateAvailable = isNewer(latest, VERSION);
      const out = outputOptions(command);

      if (options.check === true || !updateAvailable) {
        emitData({ current: VERSION, latest, update_available: updateAvailable, channel }, out, () =>
          updateAvailable
            ? `update available: ${VERSION} -> ${latest} (run: ${channel === "dev" ? "git pull" : UPGRADE_COMMANDS[channel]})`
            : `caesar-search ${VERSION} is up to date`,
        );
        return;
      }

      if (channel === "dev") {
        throw badInput("this is a development build; update from source instead", "git pull && bun install");
      }

      if (channel === "standalone") {
        const target = await selfReplace(tag);
        emitData(
          { current: VERSION, latest, updated: true, channel, path: target },
          out,
          () => `updated caesar-search ${VERSION} -> ${latest} (${target})`,
        );
        return;
      }

      const commandLine = UPGRADE_COMMANDS[channel];
      if (!out.json) process.stderr.write(`running: ${commandLine}\n`);
      await runUpgradeCommand(commandLine, out.json);
      emitData(
        { current: VERSION, latest, updated: true, channel },
        out,
        () => `updated caesar-search ${VERSION} -> ${latest} via ${channel}`,
      );
    });
}
