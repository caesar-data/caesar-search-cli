import type { Command } from "commander";
import { z } from "zod";
import { badInput } from "../output/exit";
import { emitData, renderSearchHuman } from "../output/render";
import { argOrStdin, clientFromCommand, outputOptions, parsePositiveInt } from "./common";

const modeSchema = z.enum(["standard", "research"]);
const formatSchema = z.enum(["ids_only", "compact", "standard", "full"]);

export function registerSearch(program: Command): void {
  program
    .command("search")
    .description(
      "Search the web. Returns ranked results with provenance handles (doc_id, URLs, crawl dates).",
    )
    .argument("<query>", "search query, or - to read it from stdin")
    .option("--mode <mode>", "retrieval mode: standard | research", "standard")
    .option("--max-results <n>", "number of results, 1-50", "10")
    .option("--format <format>", "response detail: ids_only | compact | standard | full", "standard")
    .addHelpText(
      "after",
      `
Examples:
  caesar-search search "rust async runtime comparison"
  caesar-search search "kubernetes operators" --max-results 5 --format compact --json
  echo "model context protocol spec" | caesar-search search - --json | jq -r '.results[0].doc_id'`,
    )
    .action(async (queryArg: string, options, command: Command) => {
      const query = await argOrStdin(queryArg, "query");
      const mode = modeSchema.safeParse(options.mode);
      if (!mode.success) throw badInput("--mode must be standard or research");
      const format = formatSchema.safeParse(options.format);
      if (!format.success) throw badInput("--format must be ids_only, compact, standard, or full");
      const maxResults = parsePositiveInt("--max-results", options.maxResults, 1, 50);

      const body: Record<string, unknown> = {
        query,
        mode: mode.data,
        max_results: maxResults,
        client_model: "cli",
        response: { verbosity: format.data },
      };

      const client = clientFromCommand(command);
      const response = await client.post("/v1/search", body);
      emitData(response, outputOptions(command), renderSearchHuman);
    });
}
