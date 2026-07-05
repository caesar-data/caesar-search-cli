import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
// Mozilla Readability's source, inlined as text at build time via bun's
// `with { type: "text" }` loader. We inject it into the page and call it there,
// so the CLI keeps zero runtime dependencies and no server-side DOM library.
import READABILITY_SRC from "@mozilla/readability/Readability.js" with { type: "text" };

// Cross-OS install locations for the user's own Chromium-family browser. We
// never download or bundle a browser; we drive one that is already installed.
// Ordered by how likely the launch is to actually work: native Chrome/Chromium
// first, then Edge/Brave/Vivaldi, then Flatpak exports LAST — a Flatpak's
// sandbox may hide our temp profile dir from the host, in which case the launch
// times out and the read falls back to the server.
const CHROME_CANDIDATES = [
  "/opt/google/chrome/chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/opt/microsoft/msedge/msedge",
  "/usr/bin/microsoft-edge",
  "/opt/brave.com/brave/brave-browser",
  "/usr/bin/brave-browser",
  "/opt/vivaldi/vivaldi",
  "/usr/bin/vivaldi",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

// Binary names probed on PATH after the fixed locations miss — catches distro
// layouts we did not enumerate (e.g. /usr/local/bin, Nix, Homebrew on Linux).
const PATH_BINARY_NAMES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "microsoft-edge",
  "msedge",
  "brave-browser",
  "brave",
  "vivaldi",
];

const FLATPAK_APP_IDS = [
  "com.google.Chrome",
  "org.chromium.Chromium",
  "com.microsoft.Edge",
  "com.brave.Browser",
];

function flatpakCandidates(): string[] {
  const out: string[] = [];
  for (const root of ["/var/lib/flatpak/exports/bin", join(homedir(), ".local/share/flatpak/exports/bin")]) {
    for (const app of FLATPAK_APP_IDS) out.push(join(root, app));
  }
  return out;
}

function pathCandidates(): string[] {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0);
  const suffix = process.platform === "win32" ? ".exe" : "";
  const out: string[] = [];
  for (const dir of dirs) {
    for (const name of PATH_BINARY_NAMES) out.push(join(dir, name + suffix));
  }
  return out;
}

export function detectChrome(): string | null {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const candidate of [...CHROME_CANDIDATES, ...pathCandidates(), ...flatpakCandidates()]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// --- URL trust boundary -----------------------------------------------------
// We drive the user's real browser, so the target URL is a trust boundary: a
// URL that arrives from an untrusted source (a search result, a link on a page
// an agent is following) must not be able to make us open local files or reach
// the user's own machine / internal network. Only http(s) is renderable, and
// loopback/private/link-local hosts are refused unless the caller explicitly
// opts in. Bun's URL parser normalizes decimal/hex/octal and short IPv4 forms to
// canonical dotted-quad, so the numeric range checks below also catch obfuscated
// equivalents (e.g. http://2130706433/ and http://127.1/ both become 127.0.0.1).
export type TargetClass =
  | { kind: "public"; url: URL }
  | { kind: "local"; url: URL }
  | { kind: "bad_scheme"; scheme: string }
  | { kind: "no_host" }
  | { kind: "unparseable" };

function isBlockedIPv4(a: number, b: number, c: number, d: number): boolean {
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT shared space
  if (a === 255 && b === 255 && c === 255 && d === 255) return true; // limited broadcast
  return false;
}

// Parse a canonical dotted-quad ("a.b.c.d", each 0-255) or null if it is not one.
function parseDottedQuad(s: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const [, a, b, c, d] = m;
  const nums = [a, b, c, d].map((p) => Number(p ?? Number.NaN));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0, nums[3] ?? 0];
}

function isBlockedIPv6(host: string): boolean {
  if (host === "::1" || host === "::") return true; // loopback / unspecified
  if (host.startsWith("fc") || host.startsWith("fd")) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(host)) return true; // fe80::/10 link-local
  if (host.startsWith("64:ff9b:")) return true; // 64:ff9b::/96 NAT64 well-known prefix
  const mapped = /^::ffff:(.+)$/.exec(host); // IPv4-mapped ::ffff:a.b.c.d or ::ffff:hhhh:hhhh
  if (mapped) {
    const rest = mapped[1] ?? "";
    const dotted = parseDottedQuad(rest);
    if (dotted) return isBlockedIPv4(dotted[0], dotted[1], dotted[2], dotted[3]);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hex) {
      const hi = Number.parseInt(hex[1] ?? "0", 16);
      const lo = Number.parseInt(hex[2] ?? "0", 16);
      return isBlockedIPv4((hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff);
    }
    return true; // unrecognized mapped form → refuse
  }
  return false; // other (public) IPv6 is allowed
}

function isPrivateOrLocalHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "metadata.google.internal") return true; // GCE metadata by name
  if (host.includes(":")) return isBlockedIPv6(host);
  const quad = parseDottedQuad(host);
  if (quad) return isBlockedIPv4(quad[0], quad[1], quad[2], quad[3]);
  return false; // a normal hostname; not resolved here (see classifyTarget note)
}

// Classify a read target against the local-render trust boundary. Non-http(s)
// schemes and hostless URLs are never renderable; loopback/private/link-local
// hosts are "local" (renderable only with an explicit opt-in). NOTE: hostnames
// are NOT DNS-resolved here, so a public name that resolves to a private IP
// (split-horizon DNS / DNS rebinding) is not caught — a known residual gap.
export function classifyTarget(raw: string): TargetClass {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "unparseable" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "bad_scheme", scheme: url.protocol.replace(/:$/, "") };
  }
  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (host === "") return { kind: "no_host" };
  if (isPrivateOrLocalHost(host)) return { kind: "local", url };
  return { kind: "public", url };
}

function isIpLiteral(host: string): boolean {
  if (host.includes(":")) return true; // any colon → IPv6 literal
  return parseDottedQuad(host) !== null;
}

// Resolve a hostname and decide whether connecting to it is permitted: refuse if
// ANY resolved address is private/local (unless the caller opted in). Fails
// closed on resolution error. Closes public-name → private-IP (split-horizon /
// DNS rebinding), modulo the sub-second TOCTOU where the browser re-resolves to
// a different address than this check saw — a documented residual.
async function resolveHostAllowed(host: string, allowLocal: boolean): Promise<boolean> {
  try {
    const addrs = await lookup(host, { all: true });
    if (addrs.length === 0) return false;
    for (const a of addrs) {
      if (isPrivateOrLocalHost(a.address.toLowerCase())) return allowLocal;
    }
    return true;
  } catch {
    return false;
  }
}

// Thrown when the render's navigation was aborted because a request (initial URL,
// a redirect hop, or the main document) targeted a blocked private/local address.
// Distinct from a generic render failure so the caller refuses to hand the same
// URL to the server, which would just re-follow it.
class BlockedRequestError extends Error {}

// Gate for an in-flight browser or raw request — applied to the main frame, every
// redirect hop, and every subresource via CDP Fetch interception. Non-network
// schemes (data:/blob:/about:) never egress and are always allowed; file: and
// anything else is refused. http(s) is refused for a literal private/local host
// (via classifyTarget) AND for a hostname that RESOLVES to one, which the
// literal-URL check at the CLI boundary cannot see. `dnsCache` memoizes verdicts
// so the many subresources of one host resolve only once per render.
export async function isRequestPermitted(
  reqUrl: string,
  allowLocal: boolean,
  dnsCache: Map<string, Promise<boolean>>,
): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(reqUrl);
  } catch {
    return false;
  }
  if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") return true;
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const cls = classifyTarget(reqUrl);
  if (cls.kind === "local") return allowLocal;
  if (cls.kind !== "public") return false;
  const host = u.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (isIpLiteral(host)) return true; // literal public IP already validated above
  let verdict = dnsCache.get(host);
  if (!verdict) {
    verdict = resolveHostAllowed(host, allowLocal);
    dnsCache.set(host, verdict);
  }
  return verdict;
}

// R2 gate: an HTTP 200 is not success. Below this many visible characters
// (measured across the WHOLE rendered document, not just the extracted region)
// we treat the render as a low-density shell and fall back to the server.
// Tunable via CAESAR_RENDER_MIN_CHARS while we calibrate against real traffic.
const DEFAULT_MIN_CONTENT_CHARS = 500;

function minContentChars(): number {
  const raw = process.env.CAESAR_RENDER_MIN_CHARS;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_CONTENT_CHARS;
}

// Absolute floor on the EXTRACTED markdown, applied even to hydrated renders: a
// page that ran its JS but produced no real content (canvas/WebGL app, auth
// wall, an error/empty state, a failed data fetch) must still fall back to the
// server rather than be emitted as an empty successful read.
const MIN_MARKDOWN_CHARS = 50;
// The rendered DOM must be at least this fraction larger than the raw server
// HTML to count as client-hydrated — well above HTML-parser normalization noise
// (auto-inserted html/head/body/tbody), so "mounted a framework" alone with no
// content does not, by itself, bypass the density floor.
const HYDRATION_GROWTH_RATIO = 0.25;
// After the render finishes, wait at most this long for the concurrent raw-HTML
// baseline fetch before treating the page as not-hydrated, so a slow origin
// cannot add latency to an otherwise-finished render.
const RAW_FETCH_GRACE_MS = 1500;
// A browser-like UA for the raw baseline fetch so origins that block unknown
// clients still return HTML (keeps the hydration signal available on more sites).
const RAW_FETCH_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const CHALLENGE_MARKERS = [
  "just a moment",
  "attention required",
  "checking your browser",
  "verifying you are human",
  "cf-browser-verification",
  "enable javascript and cookies",
];

// A challenge/interstitial is marker text with almost no real content. Requiring
// low content alongside the marker keeps a genuine article that merely mentions
// one of these phrases from being misclassified as a bot wall — which now matters
// because a detected bot wall is skipped outright, not fetched from the server.
const CHALLENGE_MAX_CONTENT_CHARS = 1200;

// True when the page looks like a bot-wall interstitial: a challenge marker
// appears AND the visible content is interstitial-sized. `contentChars` is the
// trimmed length of whatever region we are judging — the whole body for the fast
// post-load probe, the extracted markdown for the final R2 gate.
function isChallengeText(title: string, body: string, contentChars: number): boolean {
  if (contentChars >= CHALLENGE_MAX_CONTENT_CHARS) return false;
  const haystack = `${title} ${body}`.toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => haystack.includes(marker));
}

// Post-load probe expression, evaluated in the page: returns the title, a slice
// of visible body text, and the trimmed body length so we can spot a bot-wall
// interstitial immediately after load — before burning the full idle wait and
// extraction on a page we are only going to skip. Plain string concatenation, so
// the "\\s" survives as the regex "\s" the page evaluates.
const CHALLENGE_PROBE =
  "({title:document.title||''," +
  "body:((document.body&&document.body.innerText)||'').slice(0,4000)," +
  "len:((document.body&&document.body.innerText)||'').replace(/\\s+/g,' ').trim().length})";

export interface RenderOptions {
  maxChars: number;
  timeoutMs?: number;
  // Permit rendering a loopback/private/link-local host (e.g. a local dev
  // server). Off by default so an untrusted URL can never point the user's own
  // browser at their machine or internal network. Non-http(s) schemes are
  // refused regardless of this flag.
  allowLocalAddresses?: boolean;
  // Permit rendering WITHOUT the Chrome sandbox when the sandbox itself cannot
  // launch (e.g. root in a container without user namespaces). Off by default:
  // if the sandbox is unavailable we fall back to the server rather than render
  // an untrusted page unsandboxed. Opt in only when local render is worth the
  // weaker isolation (the URL is still restricted to public http(s)).
  allowUnsandboxed?: boolean;
}

export type RenderResult =
  | { ok: true; markdown: string; title: string; finalUrl: string; textLength: number; strategy: string }
  | { ok: false; reason: string };

// What the raw-HTML baseline fetch told us about this render, decided by
// comparing the rendered DOM's element count against the pre-JS server HTML:
//  - "hydrated": the DOM grew materially → JS built the page; the render is real
//    even when text-sparse.
//  - "static": the DOM did NOT grow → the page is what the server sent; the
//    render already captured everything a server fetch would see, however short.
//  - "none": the baseline fetch failed (blocked, redirected, erroring origin) →
//    no structural signal; fail closed and apply the full density floor.
export type BaselineSignal = "hydrated" | "static" | "none";

// Reject challenge interstitials and low-density shells so we only ever use a
// render that actually contains the page's content. The whole-document density
// floor exists to catch a JS shell we failed to render — but with a baseline in
// hand we can tell that apart structurally ("hydrated" ran its JS, "static" had
// nothing to run), so the floor applies only when the baseline is unavailable.
// A genuinely tiny page (e.g. example.com) is a complete read, not a shell;
// bouncing it to the server would pay for the same tiny document again.
function r2Validate(
  title: string,
  markdown: string,
  textLength: number,
  baseline: BaselineSignal,
): { ok: true } | { ok: false; reason: string } {
  const contentChars = markdown.replace(/\s+/g, " ").trim().length;
  if (isChallengeText(title, markdown, contentChars)) return { ok: false, reason: "challenge" };
  // Absolute floor on extracted content, enforced even with a baseline: a page
  // that produced no real markdown must still fall back, not emit empty.
  if (contentChars < MIN_MARKDOWN_CHARS) {
    return { ok: false, reason: `low_density(${contentChars})` };
  }
  // Without a baseline, also enforce the fuller whole-document floor to reject
  // static shells that carry only boilerplate.
  if (baseline === "none" && textLength < minContentChars()) {
    return { ok: false, reason: `low_density(${textLength})` };
  }
  return { ok: true };
}

// An HTTP error status on the main document means the page content is an error
// page, however plausible it reads (a 404's "Page not found" prose passes every
// density check). Status 0/undefined (no response captured) is not treated as a
// failure rather than inventing one.
function httpStatusFailure(status: number | undefined): { ok: false; reason: string } | null {
  if (typeof status !== "number" || status === 0) return null;
  if (status >= 200 && status < 300) return null;
  return { ok: false, reason: `http_${status}` };
}

// All render gates with their precedence: challenge > HTTP error > density.
// A challenge page (often served as 403/503) must be reported as "challenge" (a
// skip), not as an HTTP failure (a paid fallback); an error page that is also
// thin is more usefully reported by its status than as low_density. Returns the
// failure, or null when the render passes.
function validateRender(
  title: string,
  markdown: string,
  textLength: number,
  baseline: BaselineSignal,
  httpStatus: number | undefined,
): { ok: false; reason: string } | null {
  const validated = r2Validate(title, markdown, textLength, baseline);
  const statusFailure = httpStatusFailure(httpStatus);
  if (!validated.ok) {
    if (validated.reason !== "challenge" && statusFailure) return statusFailure;
    return { ok: false, reason: validated.reason };
  }
  return statusFailure;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Resolve with the promise's value, or `fallback` if it has not settled within
// `ms`. The grace timer is unref'd so it never keeps the process alive.
function raceValue<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    const finish = (value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    promise.then(finish, () => finish(fallback));
  });
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("render deadline exceeded")), Math.max(0, ms));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type CdpParams = Record<string, unknown>;
type CdpResult = Record<string, unknown>;

interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  error?: { message?: string };
  result?: CdpResult;
  params?: CdpParams;
}

interface CdpConnection {
  send(method: string, params?: CdpParams, sessionId?: string): Promise<CdpResult>;
  once(method: string, sessionId: string | undefined, timeoutMs: number): Promise<CdpParams>;
  on(method: string, handler: (params: CdpParams) => void): void;
  close(): void;
}

// Minimal Chrome DevTools Protocol client over the runtime's built-in global
// WebSocket. No external dependency; Node >=22 and Bun both provide WebSocket.
function connect(wsUrl: string, timeoutMs: number): Promise<CdpConnection> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const connectTimer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error("websocket connect timeout"));
    }, timeoutMs);

    let nextId = 1;
    const pending = new Map<number, { resolve: (v: CdpResult) => void; reject: (e: Error) => void }>();
    const waiters: { method: string; sessionId?: string; resolve: (v: CdpParams) => void }[] = [];
    const listeners = new Map<string, ((params: CdpParams) => void)[]>();

    ws.addEventListener("message", (event: MessageEvent) => {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      let message: CdpMessage;
      try {
        message = JSON.parse(raw) as CdpMessage;
      } catch {
        return;
      }
      if (typeof message.id === "number" && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (!entry) return;
        if (message.error) entry.reject(new Error(message.error.message ?? "CDP error"));
        else entry.resolve(message.result ?? {});
        return;
      }
      if (message.method) {
        const params = message.params ?? {};
        for (let i = waiters.length - 1; i >= 0; i--) {
          const waiter = waiters[i];
          if (!waiter) continue;
          if (
            waiter.method === message.method &&
            (!waiter.sessionId || waiter.sessionId === message.sessionId)
          ) {
            waiters.splice(i, 1);
            waiter.resolve(params);
          }
        }
        const handlers = listeners.get(message.method);
        if (handlers) for (const handler of handlers) handler(params);
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(connectTimer);
      reject(new Error("websocket error"));
    });
    ws.addEventListener("open", () => {
      clearTimeout(connectTimer);
      resolve({
        send(method, params = {}, sessionId) {
          const id = nextId++;
          const payload: Record<string, unknown> = { id, method, params };
          if (sessionId) payload.sessionId = sessionId;
          return new Promise<CdpResult>((res, rej) => {
            pending.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify(payload));
          });
        },
        once(method, sessionId, ms) {
          return new Promise<CdpParams>((res, rej) => {
            // Clear the timeout the moment the event arrives. Otherwise the
            // pending timer (ms ≈ the whole render deadline) keeps the Node
            // event loop alive long after the work is done, so a one-shot CLI
            // invocation hangs until the timer fires instead of exiting.
            let timer: ReturnType<typeof setTimeout>;
            const waiter = {
              method,
              sessionId,
              resolve: (params: CdpParams) => {
                clearTimeout(timer);
                res(params);
              },
            };
            waiters.push(waiter);
            timer = setTimeout(() => {
              const index = waiters.indexOf(waiter);
              if (index >= 0) {
                waiters.splice(index, 1);
                rej(new Error(`timeout waiting for ${method}`));
              }
            }, ms);
          });
        },
        on(method, handler) {
          const arr = listeners.get(method) ?? [];
          arr.push(handler);
          listeners.set(method, arr);
        },
        close() {
          try {
            ws.close();
          } catch {}
        },
      });
    });
  });
}

async function waitForPortFile(path: string, timeoutMs: number): Promise<{ port: number; wsPath: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf8").split("\n");
      const port = Number(lines[0]);
      const wsPath = (lines[1] ?? "").trim();
      if (Number.isFinite(port) && port > 0 && wsPath) return { port, wsPath };
    }
    await sleep(50);
  }
  throw new Error("chrome debugging port not ready");
}

// Resolve once the page has been quiet for `idleMs` with no in-flight requests,
// or after `hardCapMs` regardless. Fires after Page.loadEventFired to let SPA
// hydration and lazy fetches settle.
function waitForNetworkIdle(cdp: CdpConnection, idleMs: number, hardCapMs: number): Promise<void> {
  return new Promise((resolve) => {
    let inflight = 0;
    let done = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (idleTimer) clearTimeout(idleTimer);
      // Clear the hard-cap timer too: when we finish early via the idle path it
      // would otherwise stay pending (up to hardCapMs) and keep the process
      // alive past the point the render is actually done.
      if (hardTimer) clearTimeout(hardTimer);
      resolve();
    };
    const scheduleIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(finish, idleMs);
    };
    cdp.on("Network.requestWillBeSent", () => {
      inflight++;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    });
    const settle = (): void => {
      inflight = Math.max(0, inflight - 1);
      if (inflight === 0) scheduleIdle();
    };
    cdp.on("Network.loadingFinished", settle);
    cdp.on("Network.loadingFailed", settle);
    scheduleIdle();
    hardTimer = setTimeout(finish, hardCapMs);
  });
}

// In-page DOM -> Markdown extractor, evaluated in the page via CDP. Written with
// String.raw so backslashes in the page-side regexes survive verbatim; it uses
// String.fromCharCode(96) for backticks and string concatenation only, so the
// source contains no backticks or ${ ... } that would break the surrounding
// template literal. All DOM work happens in the page, so this process needs no
// DOM library.
//
// Density (textLength) is measured on the WHOLE document's visible innerText, not
// the extracted region: client-rendered app shells (e.g. a to-do app) keep most
// of their text OUTSIDE <main>, so measuring the region alone can read as empty
// and wrongly bounce a good render to the server.
const EXTRACTOR = String.raw`(function () {
  var BT = String.fromCharCode(96);
  var FENCE = BT + BT + BT;

  function collapse(s) {
    return (s || "").replace(/[\t\f\r ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").trim();
  }
  function visLen(s) { return (s || "").replace(/\s+/g, " ").trim().length; }
  function visibleText(el) { return el ? (el.innerText || el.textContent || "") : ""; }
  function abs(href) {
    try { return new URL(href, document.baseURI).href; } catch (e) { return href || ""; }
  }
  function inline(node) {
    var out = "";
    var kids = node.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var child = kids[i];
      if (child.nodeType === 3) { out += child.textContent || ""; continue; }
      if (child.nodeType !== 1) continue;
      var t = child.tagName.toLowerCase();
      if (t === "a") {
        var atext = inline(child).trim();
        var href = abs(child.getAttribute("href") || "");
        out += href ? "[" + atext + "](" + href + ")" : atext;
      } else if (t === "code") {
        out += BT + (child.textContent || "").trim() + BT;
      } else if (t === "br") {
        out += "\n";
      } else if (t === "strong" || t === "b") {
        out += "**" + inline(child).trim() + "**";
      } else if (t === "em" || t === "i") {
        out += "*" + inline(child).trim() + "*";
      } else {
        out += inline(child);
      }
    }
    return out;
  }
  function domToMarkdown(rootNode) {
    var blocks = [];
    function walk(node) {
      var kids = node.childNodes;
      for (var i = 0; i < kids.length; i++) {
        var child = kids[i];
        if (child.nodeType !== 1) continue;
        var t = child.tagName.toLowerCase();
        if (/^h[1-6]$/.test(t)) {
          var level = Number(t.charAt(1));
          var htext = collapse(inline(child));
          if (htext) { var hashes = ""; for (var h = 0; h < level; h++) hashes += "#"; blocks.push(hashes + " " + htext); }
        } else if (t === "p") {
          var ptext = collapse(inline(child));
          if (ptext) blocks.push(ptext);
        } else if (t === "ul" || t === "ol") {
          var ordered = t === "ol";
          var items = child.children;
          var n = 1;
          for (var j = 0; j < items.length; j++) {
            if (items[j].tagName.toLowerCase() !== "li") continue;
            var itext = collapse(inline(items[j]));
            if (itext) blocks.push((ordered ? (n++) + ". " : "- ") + itext);
          }
        } else if (t === "pre") {
          var pretext = (child.textContent || "").replace(/\s+$/, "");
          if (pretext.trim()) blocks.push(FENCE + "\n" + pretext + "\n" + FENCE);
        } else if (t === "blockquote") {
          var qtext = collapse(inline(child));
          if (qtext) {
            var qlines = qtext.split("\n");
            for (var q = 0; q < qlines.length; q++) qlines[q] = "> " + qlines[q];
            blocks.push(qlines.join("\n"));
          }
        } else {
          walk(child);
        }
      }
    }
    walk(rootNode);
    return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // Whole-document visible text and element count drive the success gate; both
  // are measured on the LIVE document regardless of which region we extract.
  var textLength = visLen(visibleText(document.body));
  var elemCount = document.getElementsByTagName("*").length;
  var title = document.title || "";
  var markdown = "";
  var strategy = "none";

  // Strategy 1: Readability scoring. On article-shaped pages it isolates the
  // true main content (dropping nav/toc/related boilerplate) far better than a
  // fixed selector. It mutates its input, so run it on a clone.
  try {
    if (typeof Readability === "function") {
      var art = new Readability(document.cloneNode(true)).parse();
      if (art && art.content) {
        var holder = document.createElement("div");
        holder.innerHTML = art.content;
        var md = domToMarkdown(holder);
        if (visLen(md) >= 200) {
          markdown = md;
          strategy = "readability";
          if (art.title) title = art.title;
        }
      }
    }
  } catch (e) {}

  // Strategy 2: structured extraction over a chosen region. App-shell pages
  // (where Readability finds no article) keep content in header/footer/divs, so
  // prefer a non-empty main region but fall through to <body>. Keep header/footer;
  // strip only scripts/styles and site navigation.
  if (!markdown) {
    var pref = document.querySelector("article, [role=main], main");
    var pick = (pref && visLen(visibleText(pref)) >= 50) ? pref : document.body;
    if (pick) {
      var root = pick.cloneNode(true);
      var dropList = root.querySelectorAll("script, style, noscript, nav, aside, [role=navigation], [aria-hidden=true]");
      for (var d = 0; d < dropList.length; d++) dropList[d].remove();
      markdown = domToMarkdown(root);
      strategy = "structured";

      // Strategy 3: relax to the region's rendered innerText when the structured
      // pass under-captured (app UIs keep text in divs/spans/buttons/inputs).
      var pickVisible = collapse(visibleText(pick));
      if (visLen(markdown) < 0.6 * visLen(pickVisible)) {
        var lines = pickVisible.split("\n");
        var paras = [];
        for (var L = 0; L < lines.length; L++) {
          var ln = lines[L].trim();
          if (ln) paras.push(ln);
        }
        var flat = paras.join("\n\n").trim();
        if (visLen(flat) > visLen(markdown)) { markdown = flat; strategy = "innertext"; }
      }
    }
  }

  return { title: title, markdown: markdown, textLength: textLength, elemCount: elemCount, strategy: strategy };
})()`;

function evaluatedValue(result: CdpResult): {
  title: string;
  markdown: string;
  textLength: number;
  elemCount: number;
  strategy: string;
} {
  const wrapper = result.result as { value?: unknown } | undefined;
  const value = wrapper?.value as
    | {
        title?: unknown;
        markdown?: unknown;
        textLength?: unknown;
        elemCount?: unknown;
        strategy?: unknown;
      }
    | undefined;
  return {
    title: String(value?.title ?? ""),
    markdown: String(value?.markdown ?? ""),
    textLength: Number(value?.textLength ?? 0),
    elemCount: Number(value?.elemCount ?? 0),
    strategy: String(value?.strategy ?? "none"),
  };
}

const BASE_ARGS = [
  "--headless=new",
  "--remote-debugging-port=0",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--disable-extensions",
  "--mute-audio",
];

interface ChromeSession {
  proc: ReturnType<typeof spawn>;
  cdp: CdpConnection;
  dir: string;
}

// Kill the browser and remove its temp profile dir. Chrome forks helper child
// processes and keeps writing to the profile, so an rmSync fired immediately
// after kill() races them and silently fails — leaking the profile dir on every
// render. We kill the whole process group (proc is a group leader because it is
// spawned detached), wait briefly and boundedly for it to exit so the dir is no
// longer in use, then remove it with a couple of retries.
async function killChromeAndClean(proc: ReturnType<typeof spawn>, dir: string): Promise<void> {
  // Attach the exit waiter BEFORE signalling: the process can die between the
  // kill and the listener attach, and a late "exit" listener never fires (node
  // does not replay it), so we would otherwise wait on an event that already
  // happened. If it has already exited, skip the wait outright.
  const exited =
    proc.exitCode !== null || proc.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          let done = false;
          let timer: ReturnType<typeof setTimeout>;
          const finish = (): void => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve();
          };
          proc.once("exit", finish);
          // Bounded fallback, deliberately NOT unref'd: cleanup must run, so the
          // process may not exit and skip rmSync while this is pending. Cleared
          // the instant "exit" fires, so it adds no latency in the common case.
          timer = setTimeout(finish, 500);
        });
  try {
    if (typeof proc.pid === "number") {
      // Negative pid targets the process group. Falls back to a plain kill if the
      // group send fails (e.g. the leader is already gone).
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    }
  } catch {}
  await exited;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      if (attempt === 2) return;
      await sleep(50);
    }
  }
}

// Spawn Chrome and establish a CDP connection. Sandboxed by default: we render
// untrusted pages, so the renderer sandbox stays on. Throws (after cleaning up
// its own process/dir) if the browser fails to launch, letting the caller retry
// unsandboxed for environments where the sandbox can't initialize.
async function connectChrome(chrome: string, sandbox: boolean, budgetMs: number): Promise<ChromeSession> {
  const dir = mkdtempSync(join(tmpdir(), "caesar-render-"));
  // Chrome 136 ignores --remote-debugging-port on the default profile, so a
  // fresh --user-data-dir is mandatory (and the right privacy call: no user
  // session is exposed to the page being rendered).
  const args = [...BASE_ARGS, `--user-data-dir=${dir}`];
  if (!sandbox) args.push("--no-sandbox");
  args.push("about:blank");
  // detached: Chrome becomes its own process-group leader so killChromeAndClean
  // can signal the whole group (parent + helper processes), not just the parent.
  const proc = spawn(chrome, args, { stdio: "ignore", detached: true });
  try {
    const { port, wsPath } = await waitForPortFile(join(dir, "DevToolsActivePort"), Math.min(8000, budgetMs));
    const cdp = await connect(`ws://127.0.0.1:${port}${wsPath}`, Math.min(8000, budgetMs));
    return { proc, cdp, dir };
  } catch (error) {
    await killChromeAndClean(proc, dir);
    throw error;
  }
}

// Thrown when the sandboxed browser cannot launch and unsandboxed rendering was
// not explicitly permitted. renderLocally maps it to a server fallback so an
// untrusted page is never rendered without the sandbox by default.
class SandboxUnavailableError extends Error {}

async function runChrome(
  chrome: string,
  url: string,
  timeoutMs: number,
  allowUnsandboxed: boolean,
  allowLocalAddresses: boolean,
): Promise<{
  title: string;
  markdown: string;
  textLength: number;
  elemCount: number;
  strategy: string;
  finalUrl: string;
  challenge?: boolean;
  unsandboxed: boolean;
  blockedPrivate: boolean;
  httpStatus?: number;
}> {
  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => Math.max(0, deadline - Date.now());

  // Prefer a sandboxed browser. If the sandbox itself cannot launch (e.g. running
  // as root, or a container without user namespaces), do NOT silently render an
  // untrusted page without it: unless the caller opted into --allow-unsandboxed-
  // render, throw so renderLocally falls back to the server. A navigation/render
  // failure (as opposed to a launch failure) is never retried here either.
  let session: ChromeSession;
  let unsandboxed = false;
  try {
    session = await connectChrome(chrome, true, remaining());
  } catch {
    if (!allowUnsandboxed) throw new SandboxUnavailableError();
    session = await connectChrome(chrome, false, remaining());
    unsandboxed = true;
  }
  const { proc, cdp, dir } = session;
  // Set when a request to a blocked private/local target is aborted. `dnsCache`
  // memoizes per-host resolution verdicts across a render's subresources.
  let blockedPrivate = false;
  const dnsCache = new Map<string, Promise<boolean>>();

  try {
    const work = (async () => {
      const target = await cdp.send("Target.createTarget", { url: "about:blank" });
      const targetId = String(target.targetId ?? "");
      const attach = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const sessionId = typeof attach.sessionId === "string" ? attach.sessionId : undefined;
      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Network.enable", {}, sessionId);
      // Contain the network at the point the browser actually connects: validate
      // the main frame, every redirect hop, and every subresource. A request to a
      // blocked private/local target is aborted; a blocked main-document request
      // marks the render so the caller won't re-issue the same URL to the server.
      // Two layers, because CDP splits the job:
      //  - Fetch request interception actively ABORTS any subresource bound for a
      //    blocked address (image/script/xhr/etc.), but it does NOT pause main-
      //    frame navigation redirects.
      //  - Network.requestWillBeSent DOES fire for every main-frame hop (initial +
      //    each redirect), so we watch it to catch a navigation that lands on a
      //    private/local address and mark the render blocked (its content is then
      //    discarded and never handed to the server).
      cdp.on("Fetch.requestPaused", (params) => {
        const requestId = String((params as { requestId?: unknown }).requestId ?? "");
        if (!requestId) return;
        const request = (params as { request?: { url?: string } }).request;
        const reqUrl = String(request?.url ?? "");
        void isRequestPermitted(reqUrl, allowLocalAddresses, dnsCache)
          .then((ok) =>
            ok
              ? cdp.send("Fetch.continueRequest", { requestId }, sessionId)
              : cdp.send("Fetch.failRequest", { requestId, errorReason: "AccessDenied" }, sessionId),
          )
          .catch(() => {
            // Never leave a paused request hanging: fail closed on handler error.
            cdp
              .send("Fetch.failRequest", { requestId, errorReason: "AccessDenied" }, sessionId)
              .catch(() => {});
          });
      });
      cdp.on("Network.requestWillBeSent", (params) => {
        if (String((params as { type?: unknown }).type ?? "") !== "Document") return;
        const navUrl = String((params as { request?: { url?: string } }).request?.url ?? "");
        void isRequestPermitted(navUrl, allowLocalAddresses, dnsCache)
          .then((ok) => {
            if (!ok) blockedPrivate = true;
          })
          .catch(() => {
            blockedPrivate = true;
          });
      });
      // Record every Document response so the main frame's final HTTP status is
      // known after load. Recording starts before navigation, so no response can
      // slip past; iframes are filtered out afterwards by frameId (Page.navigate
      // returns the main frame's id). Redirect hops never appear here — CDP
      // reports them via requestWillBeSent.redirectResponse — so the last match
      // IS the status of the document the page ended up showing.
      const docResponses: { frameId: string; status: number }[] = [];
      cdp.on("Network.responseReceived", (params) => {
        const p = params as { type?: unknown; frameId?: unknown; response?: { status?: unknown } };
        if (String(p.type ?? "") !== "Document") return;
        const status = Number(p.response?.status ?? 0);
        docResponses.push({ frameId: String(p.frameId ?? ""), status });
      });
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
      const loaded = cdp.once("Page.loadEventFired", sessionId, remaining());
      // Always consume loaded's rejection: if the render deadline fires while we
      // are still awaiting navigate (before `await loaded`), its timeout would
      // otherwise reject with no handler and surface as an unhandled rejection.
      void loaded.catch(() => {});
      const navigated = await cdp.send("Page.navigate", { url }, sessionId);
      const mainFrameId = String(navigated.frameId ?? "");
      await loaded;
      const mainDocStatus = (): number | undefined => {
        for (let i = docResponses.length - 1; i >= 0; i--) {
          const entry = docResponses[i];
          if (entry && (entry.frameId === mainFrameId || mainFrameId === "")) return entry.status;
        }
        return undefined;
      };
      // Fast bot-wall bail: a challenge interstitial paints its marker at load
      // and never goes network-idle, so detect it here and skip the full idle
      // wait + extraction on a page we are only going to reject.
      const probeResult = await cdp.send(
        "Runtime.evaluate",
        { expression: CHALLENGE_PROBE, returnByValue: true },
        sessionId,
      );
      const probe = (
        probeResult.result as { value?: { title?: unknown; body?: unknown; len?: unknown } } | undefined
      )?.value;
      if (
        probe &&
        isChallengeText(String(probe.title ?? ""), String(probe.body ?? ""), Number(probe.len ?? 0))
      ) {
        const early = await cdp.send(
          "Runtime.evaluate",
          { expression: "document.location.href", returnByValue: true },
          sessionId,
        );
        const earlyUrl = String((early.result as { value?: unknown } | undefined)?.value ?? url);
        return {
          title: String(probe.title ?? ""),
          markdown: "",
          textLength: 0,
          elemCount: 0,
          strategy: "challenge",
          finalUrl: earlyUrl,
          challenge: true,
          httpStatus: mainDocStatus(),
        };
      }
      await waitForNetworkIdle(cdp, 500, Math.min(8000, remaining()));
      // Define window.Readability in the page so the extractor can run its
      // scoring pass. The source no-ops its CommonJS export guard in a browser.
      await cdp.send("Runtime.evaluate", { expression: READABILITY_SRC }, sessionId);
      const evaluated = await cdp.send(
        "Runtime.evaluate",
        { expression: EXTRACTOR, returnByValue: true },
        sessionId,
      );
      const parsed = evaluatedValue(evaluated);
      const urlResult = await cdp.send(
        "Runtime.evaluate",
        { expression: "document.location.href", returnByValue: true },
        sessionId,
      );
      const urlWrapper = urlResult.result as { value?: unknown } | undefined;
      const finalUrl = String(urlWrapper?.value ?? url);
      return { ...parsed, finalUrl, httpStatus: mainDocStatus() };
    })();
    // Swallow any late rejection once the deadline has already returned.
    work.catch(() => {});
    const result = await withDeadline(work, remaining());
    return { ...result, unsandboxed, blockedPrivate };
  } catch (err) {
    // A blocked main-document request aborts the navigation; surface that
    // distinctly so the caller does not hand the same URL to the server.
    if (blockedPrivate) throw new BlockedRequestError();
    throw err;
  } finally {
    cdp.close();
    await killChromeAndClean(proc, dir);
  }
}

interface FixtureShape {
  markdown?: unknown;
  title?: unknown;
  textLength?: unknown;
  finalUrl?: unknown;
  hydrated?: unknown;
  baseline?: unknown;
  httpStatus?: unknown;
}

// TEST SEAM: render from a JSON fixture instead of driving Chrome, so the test
// suite stays hermetic and browserless. The fixture is still validated by the
// same gates as a live render (r2Validate + HTTP status, same precedence), so
// tests can exercise every fallback path.
function renderFromFixture(path: string, url: string): RenderResult {
  const fixture = JSON.parse(readFileSync(path, "utf8")) as FixtureShape;
  const markdown = String(fixture.markdown ?? "");
  const title = String(fixture.title ?? "");
  const textLength =
    typeof fixture.textLength === "number" ? fixture.textLength : markdown.replace(/\s+/g, " ").trim().length;
  const finalUrl = typeof fixture.finalUrl === "string" ? fixture.finalUrl : url;
  const baseline: BaselineSignal =
    fixture.baseline === "hydrated" || fixture.baseline === "static" || fixture.baseline === "none"
      ? fixture.baseline
      : fixture.hydrated === true
        ? "hydrated"
        : "none";
  const failure = validateRender(
    title,
    markdown,
    textLength,
    baseline,
    typeof fixture.httpStatus === "number" ? fixture.httpStatus : undefined,
  );
  if (failure) return failure;
  return { ok: true, markdown, title, finalUrl, textLength, strategy: "fixture" };
}

// Count opening element tags in raw HTML — a cheap element-count proxy that needs
// no DOM parser. Used as the pre-JS baseline for the hydration signal.
function countHtmlElements(html: string): number {
  const matches = html.match(/<[a-zA-Z][^>]*>/g);
  return matches ? matches.length : 0;
}

// Fetch the raw (pre-JS) server HTML and return its element count, or 0 on any
// failure. This is the baseline the rendered DOM is compared against to detect
// client-side hydration. It is a plain origin fetch, so it never touches our own
// server and costs nothing to the read pipeline's budget. The caller owns the
// AbortController and cancels it once the render is done (or fails), so a slow or
// hung origin can never hold the process open past the render.
//
// It runs outside the browser (so outside CDP interception), so it enforces the
// same trust boundary itself: the target must resolve to a public address, and
// redirects are NOT followed (redirect: "manual") so it can't be steered to a
// private/local address. A blocked or redirecting origin just yields no baseline.
async function fetchRawElementCount(url: string, allowLocal: boolean, signal: AbortSignal): Promise<number> {
  try {
    if (!(await isRequestPermitted(url, allowLocal, new Map()))) return 0;
    const res = await fetch(url, {
      signal,
      redirect: "manual",
      headers: { "user-agent": RAW_FETCH_UA },
    });
    if (!res.ok) return 0;
    return countHtmlElements(await res.text());
  } catch {
    return 0;
  }
}

// Render `url` with the user's installed Chrome and return clean Markdown, or a
// neutral failure reason the caller can fall back on. `maxChars` truncation is
// applied by the caller so it can report accurate char_count/truncated.
export async function renderLocally(url: string, opts: RenderOptions): Promise<RenderResult> {
  const timeoutMs = opts.timeoutMs ?? 15000;

  const fixturePath = process.env.CAESAR_LOCAL_RENDER_FIXTURE;
  if (fixturePath) {
    try {
      return renderFromFixture(fixturePath, url);
    } catch {
      return { ok: false, reason: "render_failed" };
    }
  }

  // Defense-in-depth: never navigate (or raw-fetch) a non-public target, even if
  // a caller reaches this without the read command's up-front check. Only public
  // http(s) URLs render; a local host renders only when explicitly opted in.
  const target = classifyTarget(url);
  if (target.kind !== "public" && !(target.kind === "local" && opts.allowLocalAddresses === true)) {
    return { ok: false, reason: "blocked_address" };
  }

  const chrome = detectChrome();
  if (!chrome) return { ok: false, reason: "no_local_chrome" };

  // Fetch the raw HTML baseline concurrently with the render. After the render we
  // wait at most a short grace for it (raceValue) so a slow origin can't add
  // latency to a finished render, and we abort it on the way out so a pending
  // fetch never holds the process open.
  const allowLocal = opts.allowLocalAddresses === true;
  const rawController = new AbortController();
  const rawCountPromise = fetchRawElementCount(url, allowLocal, rawController.signal);

  try {
    const rendered = await runChrome(chrome, url, timeoutMs, opts.allowUnsandboxed === true, allowLocal);
    // The navigation reached a blocked private/local address (a redirect hop or a
    // rebinding host). Do not fall back to the server, which would re-follow it.
    if (rendered.blockedPrivate) {
      rawController.abort();
      return { ok: false, reason: "blocked_address" };
    }
    // A bot wall was detected right after load; nothing else to compute.
    if (rendered.challenge) {
      rawController.abort();
      return { ok: false, reason: "challenge" };
    }
    const rawCount = await raceValue(rawCountPromise, RAW_FETCH_GRACE_MS, 0);
    rawController.abort();
    // A rendered DOM materially larger than the raw server HTML means JS built
    // the page ("hydrated"): trust the render even when it is text-sparse. A DOM
    // that did NOT grow means the page is static and fully captured ("static") —
    // also trustworthy, however short. No baseline → fail closed on density.
    const baseline: BaselineSignal =
      rawCount > 0
        ? (rendered.elemCount - rawCount) / rawCount > HYDRATION_GROWTH_RATIO
          ? "hydrated"
          : "static"
        : "none";
    const failure = validateRender(
      rendered.title,
      rendered.markdown,
      rendered.textLength,
      baseline,
      rendered.httpStatus,
    );
    if (failure) return failure;
    const hydrated = baseline === "hydrated";
    const strategy = `${rendered.strategy}${hydrated ? "+hydrated" : ""}${rendered.unsandboxed ? "+unsandboxed" : ""}`;
    return {
      ok: true,
      markdown: rendered.markdown,
      title: rendered.title,
      finalUrl: rendered.finalUrl,
      textLength: rendered.textLength,
      strategy,
    };
  } catch (err) {
    rawController.abort();
    // The sandbox could not launch and unsandboxed render was not opted into:
    // surface a distinct reason so the caller falls back to the server.
    if (err instanceof SandboxUnavailableError) return { ok: false, reason: "sandbox_unavailable" };
    // Navigation aborted because a request targeted a blocked private/local
    // address — do not fall back to the server (it would re-follow the URL).
    if (err instanceof BlockedRequestError) return { ok: false, reason: "blocked_address" };
    return { ok: false, reason: "render_failed" };
  }
}
