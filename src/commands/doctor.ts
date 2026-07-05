import { spawn } from "node:child_process";
import type { Command } from "commander";
import { emitData } from "../output/render";
import { detectChrome, renderLocally } from "../render/index";
import { clientFromCommand, isUnsandboxedRenderAllowed, outputOptions } from "./common";

// A stable, tiny, public page. Small on purpose: it also proves the
// "small-but-complete static page" acceptance path works end to end.
const CANARY_URL = "https://example.com/";

interface BrowserReport {
  found: boolean;
  path?: string;
  version?: string;
  hint?: string;
}

interface RenderReport {
  ok: boolean;
  url: string;
  strategy?: string;
  elapsed_ms?: number;
  chars?: number;
  reason?: string;
  hint?: string;
}

interface ServerReport {
  base_url: string;
  reachable: boolean;
  status?: number;
  error?: string;
}

interface DoctorReport {
  browser: BrowserReport;
  local_render: RenderReport;
  server: ServerReport;
  // The headline: will a plain `read <url>` use the local browser?
  local_first: boolean;
}

// `<browser> --version` prints a one-line version and exits without opening a
// window on every Chromium-family browser. Bounded so a wedged binary cannot
// hang the diagnosis; version is cosmetic, so any failure is just "unknown".
function browserVersion(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(path, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let done = false;
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
      finish(null);
    }, 3000);
    proc.stdout?.on("data", (chunk) => {
      out += String(chunk);
    });
    proc.on("error", () => finish(null));
    proc.on("close", () => finish(out.trim() || null));
  });
}

// Reachability only: ANY HTTP response (even a 404 for the bare root) proves the
// base URL resolves and answers; error mapping/auth is the read path's job.
async function checkServer(baseUrl: string): Promise<ServerReport> {
  try {
    const res = await fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
    return { base_url: baseUrl, reachable: true, status: res.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { base_url: baseUrl, reachable: false, error: message };
  }
}

function renderHint(reason: string | undefined): string | undefined {
  if (reason === "no_local_chrome") return "Install Chrome/Chromium/Edge/Brave, or set CHROME_PATH.";
  if (reason === "browser_launch_failed") {
    return "The detected browser binary could not be started; check that CHROME_PATH points at a runnable Chromium-family browser.";
  }
  if (reason === "sandbox_unavailable") {
    // The env var alone is NOT enough for a plain read: each read also needs the
    // --allow-unsandboxed-render flag, so say exactly which half is missing.
    return isUnsandboxedRenderAllowed()
      ? "The Chrome sandbox cannot launch here. CAESAR_ALLOW_UNSANDBOXED_RENDER is set, but a plain read also " +
          "needs the --allow-unsandboxed-render flag; without it every read falls back to the server."
      : "The Chrome sandbox cannot launch here (container/root?). Set CAESAR_ALLOW_UNSANDBOXED_RENDER=1 and " +
          "pass --allow-unsandboxed-render to read, or reads will use the server.";
  }
  return undefined;
}

function renderDoctorHuman(payload: unknown): string {
  const report = payload as DoctorReport;
  const lines: string[] = [];
  const mark = (ok: boolean): string => (ok ? "✓" : "✗");
  if (report.browser.found) {
    lines.push(
      `browser       ${mark(true)} ${report.browser.path}${report.browser.version ? ` (${report.browser.version})` : ""}`,
    );
  } else {
    lines.push(`browser       ${mark(false)} not found — ${report.browser.hint}`);
  }
  if (report.local_render.ok) {
    lines.push(
      `local render  ${mark(true)} ${report.local_render.strategy} in ${report.local_render.elapsed_ms}ms, ` +
        `${report.local_render.chars} chars (${report.local_render.url})`,
    );
  } else {
    const hint = report.local_render.hint ? ` — ${report.local_render.hint}` : "";
    lines.push(`local render  ${mark(false)} ${report.local_render.reason}${hint}`);
  }
  if (report.server.reachable) {
    lines.push(`server        ${mark(true)} ${report.server.base_url} (HTTP ${report.server.status})`);
  } else {
    lines.push(`server        ${mark(false)} ${report.server.base_url} — ${report.server.error}`);
  }
  lines.push(
    report.local_first
      ? "reads are local-first: pages render with your own browser, the server is only a fallback"
      : report.server.reachable
        ? "reads will use the server: fix the items above to make them local-first"
        : "reads cannot work: no local render AND the server is unreachable",
  );
  return lines.join("\n");
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description(
      "Diagnose the local-first read path: browser detection, a sample local render, and server reachability.",
    )
    .action(async (_options, actionCommand: Command) => {
      const chrome = detectChrome();
      const browser: BrowserReport = chrome
        ? { found: true, path: chrome, version: (await browserVersion(chrome)) ?? undefined }
        : { found: false, hint: "Install Chrome/Chromium/Edge/Brave, or set CHROME_PATH." };

      // Probe exactly what a plain `read <url>` does (fixture seam included): no
      // --allow-unsandboxed-render flag, so the env var alone must not make this
      // probe pass on a host where every flagless read would hit the server.
      const startedAt = Date.now();
      const rendered = await renderLocally(CANARY_URL, { maxChars: 4000 });
      const elapsedMs = Date.now() - startedAt;
      const localRender: RenderReport = rendered.ok
        ? {
            ok: true,
            url: CANARY_URL,
            strategy: rendered.strategy,
            elapsed_ms: elapsedMs,
            chars: rendered.textLength,
          }
        : { ok: false, url: CANARY_URL, reason: rendered.reason, hint: renderHint(rendered.reason) };

      const server = await checkServer(clientFromCommand(actionCommand).baseUrl);

      const report: DoctorReport = {
        browser,
        local_render: localRender,
        server,
        local_first: browser.found && localRender.ok,
      };
      emitData(report, outputOptions(actionCommand), renderDoctorHuman);
    });
}
