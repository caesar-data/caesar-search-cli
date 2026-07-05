import type { Command } from "commander";
import { badInput } from "../output/exit";
import { emitData, renderDocumentHuman } from "../output/render";
import { classifyTarget, renderLocally } from "../render/index";
import {
  argOrStdin,
  clientFromCommand,
  isDevMode,
  isUnsandboxedRenderAllowed,
  isVerbose,
  looksLikeDocID,
  outputOptions,
  parsePositiveInt,
} from "./common";

const INCLUDE_SECTIONS = ["metadata", "content", "passages", "capture_history"];

interface RenderWarning {
  code: string;
  message: string;
}

// One-line stderr diagnostic for how the read was fetched. Off unless --verbose
// or CAESAR_DEBUG; never touches stdout, which is the data/JSON contract.
function vlog(enabled: boolean, message: string): void {
  if (enabled) process.stderr.write(`caesar: ${message}\n`);
}

// Build the response a locally-rendered read emits, honoring --include. Local
// render can satisfy `metadata` (doc) and `content` only; `passages` and
// `capture_history` are server-side, so a request for either skips local render
// entirely (see skipReason). This is a deliberately reduced envelope versus the
// server's DocumentResponse: request_id/session_id/access are absent because no
// server request was made to originate them, and there is no doc_id because a
// live render is not a server capture (re-read by URL, or use --no-local-render).
function localEnvelope(
  includeSet: Set<string>,
  doc: { canonical_url: string; title: string },
  content: Record<string, unknown>,
  warning: RenderWarning,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (includeSet.has("metadata")) out.doc = doc;
  if (includeSet.has("content")) out.content = content;
  out.warnings = [warning];
  return out;
}

// Request + emit for the server read path. Shared by the doc_id/query/start-char
// paths and by the local-render fallback. `extraWarning` lets the fallback path
// annotate the response so JSON consumers can see local render was attempted.
async function serverRead(
  actionCommand: Command,
  body: Record<string, unknown>,
  extraWarning?: RenderWarning,
): Promise<void> {
  const client = clientFromCommand(actionCommand);
  const response = (await client.post("/v1/document", body)) as Record<string, unknown>;
  if (extraWarning) {
    const warnings = Array.isArray(response.warnings) ? [...(response.warnings as unknown[])] : [];
    warnings.push(extraWarning);
    response.warnings = warnings;
  }
  emitData(response, outputOptions(actionCommand), renderDocumentHuman);
}

function registerReadLike(program: Command, name: string, aliases: string[]): void {
  const command = program
    .command(name)
    .aliases(aliases)
    .description("Read a page as clean markdown. Accepts a URL or a doc_id from search results.")
    .argument("<url|doc_id>", "URL or doc_id to read, or - to read it from stdin")
    .option("--query <text>", "focus content selection on this question")
    .option("--max-chars <n>", "content character cap", "12000")
    .option("--start-char <n>", "resume a truncated read from this offset", "0")
    .option("--include <sections>", `comma list of ${INCLUDE_SECTIONS.join(",")}`, "metadata,content")
    .option("--no-local-render", "always fetch via the server instead of rendering the page locally")
    .option(
      "--allow-local-addresses",
      "(dev mode only) local render of loopback/private/link-local hosts; requires CAESAR_DEV_MODE",
    )
    .option(
      "--allow-unsandboxed-render",
      "if the Chrome sandbox can't launch, render without it instead of the server (also requires CAESAR_ALLOW_UNSANDBOXED_RENDER)",
    )
    .addHelpText(
      "after",
      `
Examples:
  caesar-search read https://example.com/post
  caesar-search read 0c944fa8-4c8f-4f48-9b08-0fb2fd3438ec --query "what changed in v2" --json
  caesar-search read https://example.com/long --max-chars 12000 --start-char 12000`,
    )
    .action(async (targetArg: string, options, actionCommand: Command) => {
      const target = await argOrStdin(targetArg, "url or doc_id");
      const maxChars = parsePositiveInt("--max-chars", options.maxChars, 1, 50_000);
      const startChar = parsePositiveInt("--start-char", `${options.startChar}`, 0, 10_000_000);

      const include = String(options.include)
        .split(",")
        .map((section: string) => section.trim())
        .filter((section: string) => section.length > 0);
      for (const section of include) {
        if (!INCLUDE_SECTIONS.includes(section)) {
          throw badInput(`--include section "${section}" is not one of ${INCLUDE_SECTIONS.join(", ")}`);
        }
      }
      const includeSet = new Set(include);

      const content: Record<string, unknown> = {
        selection: options.query ? "query_relevant" : "full_document",
        format: "markdown",
        max_chars: maxChars,
      };
      if (startChar > 0) {
        // Continuation reads address the raw document text.
        content.selection = "full_document";
        content.range = { start_char: startChar };
      }

      const body: Record<string, unknown> = { include, content };
      const isDocID = looksLikeDocID(target);
      if (isDocID) {
        body.doc_id = target;
      } else {
        body.canonical_url = target;
      }
      if (options.query) body.query = options.query;

      const verbose = isVerbose(actionCommand);
      // --allow-local-addresses is honored only in dev mode: the flag alone (which
      // an agent could supply) must not be enough to reach the user's own network.
      const allowLocalAddresses = options.allowLocalAddresses === true && isDevMode();
      // Both the flag AND the env must be set; flag alone falls back to the server
      // (never silently renders a hostile page unsandboxed off CLI args).
      const allowUnsandboxed = options.allowUnsandboxedRender === true && isUnsandboxedRenderAllowed();

      // A URL target is a trust boundary: reject schemes and hosts we must never
      // point the user's browser at, before deciding local-vs-server. This blocks
      // file:/data:, hostless URLs, and loopback/private/link-local addresses for
      // BOTH paths — a private URL is never a valid public read, and the server
      // cannot reach the user's own network either.
      const classified = isDocID ? null : classifyTarget(target);
      // A local/internal address is renderable locally (with dev-mode opt-in) but
      // must never be sent to the server: the server can't reach the user's own
      // network, and doing so would turn the CLI into a server-side SSRF vector.
      const isLocalAddress = classified?.kind === "local";
      if (classified) {
        if (classified.kind === "bad_scheme") {
          throw badInput(
            `read only accepts http(s):// URLs or a doc_id; "${classified.scheme}:" targets are not allowed.`,
          );
        }
        if (classified.kind === "no_host") {
          throw badInput("read needs a full URL with a host, e.g. https://example.com/page");
        }
        if (classified.kind === "local" && !allowLocalAddresses) {
          // Distinguish "flag missing" from "flag present but not in dev mode" so
          // the operator knows exactly what to change.
          if (options.allowLocalAddresses === true) {
            throw badInput(
              `--allow-local-addresses is only honored in dev mode; set CAESAR_DEV_MODE=1 to read the ` +
                `local/internal address "${classified.url.hostname}".`,
            );
          }
          throw badInput(
            `refusing to read the local/internal address "${classified.url.hostname}". ` +
              "Loopback, private, and link-local targets are blocked. To read a trusted local host in " +
              "development, set CAESAR_DEV_MODE=1 and pass --allow-local-addresses.",
          );
        }
      }

      // Render with the user's own Chrome only for a plain URL read: a full
      // document, from the start, with no query-relevance selection. doc_id,
      // --query, and continuation reads all need server-side selection, so we
      // record why local render was skipped rather than silently going remote.
      // An unparseable URL can't be validated for local render either, so it
      // routes to the server (which owns URL normalization).
      let skipReason: string | null = null;
      if (isDocID) skipReason = "doc_id input";
      else if (options.query) skipReason = "query selection";
      else if (startChar > 0) skipReason = "continuation (--start-char)";
      else if (options.localRender === false) skipReason = "--no-local-render";
      else if (classified?.kind === "unparseable") skipReason = "unvalidated URL";
      // passages and capture_history are server-side artifacts a local render
      // cannot produce; if the caller asked for either, use the server so the
      // requested sections are actually present.
      else if (includeSet.has("passages") || includeSet.has("capture_history"))
        skipReason = "passages/capture_history requested";

      if (skipReason === null) {
        const startedAt = Date.now();
        const local = await renderLocally(target, { maxChars, allowLocalAddresses, allowUnsandboxed });
        const elapsedMs = Date.now() - startedAt;
        if (local.ok) {
          vlog(verbose, `local render → USED (${local.strategy}, ${elapsedMs}ms, ${local.textLength} chars)`);
          // Local render succeeded: return it directly, no server round-trip.
          const text = local.markdown.slice(0, maxChars);
          const composed = localEnvelope(
            includeSet,
            { canonical_url: local.finalUrl || target, title: local.title },
            {
              selection: "full_document",
              format: "markdown",
              text,
              char_count: text.length,
              truncated: local.markdown.length > maxChars,
              start_char: 0,
            },
            {
              code: "local_render",
              message: "Content was rendered locally from the live page; a server capture was not used.",
            },
          );
          emitData(composed, outputOptions(actionCommand), renderDocumentHuman);
          return;
        }
        // A bot wall (challenge/CAPTCHA interstitial) means the live page refuses
        // automated readers. Skip it instead of paying for a server round-trip: a
        // search-driven workflow can just read a different result. Exit 0 with a
        // clear warning and empty content so the caller sees an expected skip, not
        // a hard error.
        if (local.reason === "challenge") {
          vlog(verbose, `local render → SKIPPED: bot wall (challenge) → page not fetched`);
          const skipped = localEnvelope(
            includeSet,
            { canonical_url: target, title: "" },
            {
              selection: "full_document",
              format: "markdown",
              text: "",
              char_count: 0,
              truncated: false,
              start_char: 0,
            },
            {
              code: "bot_wall_skipped",
              message:
                "This page is behind a bot-detection wall (challenge/CAPTCHA); it was skipped and not fetched from the server. Try a different source.",
            },
          );
          emitData(skipped, outputOptions(actionCommand), renderDocumentHuman);
          return;
        }
        // The target resolved or redirected to a private/internal address mid-
        // render. Never hand it to the server, which would re-follow the same URL
        // server-side; fail closed instead.
        if (local.reason === "blocked_address") {
          throw badInput(
            `refusing to read "${target}": it resolves or redirects to a private/internal address, ` +
              "which is never fetched via the server.",
          );
        }
        // A local/internal address that could not be rendered locally has nowhere
        // to fall back to — the server cannot reach the user's own network.
        if (isLocalAddress) {
          throw badInput(
            `local render of "${classified?.url.hostname ?? target}" failed (${local.reason}); ` +
              "local/internal addresses are only read via local render and are never sent to the server.",
          );
        }
        // Local render produced nothing usable; go to the server and annotate the
        // response so the fallback (and its reason) is visible to JSON consumers.
        vlog(verbose, `local render → FALLBACK: ${local.reason} → server`);
        await serverRead(actionCommand, body, {
          code: "local_render_fallback",
          message: `local render unavailable (${local.reason}); fetched from server`,
        });
        return;
      }

      // A local/internal address reaches here only via a server-only feature
      // (--query, --start-char, --include passages/capture_history,
      // --no-local-render). The server can't reach the user's own network, so
      // rather than send it a private URL, reject with a clear reason.
      if (isLocalAddress) {
        throw badInput(
          `"${classified?.url.hostname ?? target}" is a local/internal address; ${skipReason} requires the ` +
            "server, which cannot reach it. Drop that option to read it via local render.",
        );
      }
      vlog(verbose, `local render → SKIPPED: ${skipReason} → server`);
      await serverRead(actionCommand, body);
    });
  return void command;
}

export function registerRead(program: Command): void {
  registerReadLike(program, "read", ["fetch", "extract"]);
}
