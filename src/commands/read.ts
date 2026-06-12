import type { Command } from "commander";
import { badInput } from "../output/exit";
import { emitData, renderDocumentHuman } from "../output/render";
import { argOrStdin, clientFromCommand, jsonMode, looksLikeDocID, parsePositiveInt } from "./common";

const INCLUDE_SECTIONS = ["metadata", "content", "passages", "capture_history"];

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
      if (looksLikeDocID(target)) {
        body.doc_id = target;
      } else {
        body.canonical_url = target;
      }
      if (options.query) body.query = options.query;

      const client = clientFromCommand(actionCommand);
      const response = await client.post("/v1/document", body);
      emitData(response, { json: jsonMode(actionCommand) }, renderDocumentHuman);
    });
  return void command;
}

export function registerRead(program: Command): void {
  registerReadLike(program, "read", ["fetch", "extract"]);
}
