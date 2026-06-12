import type { Command } from "commander";
import { z } from "zod";
import { badInput } from "../output/exit";
import { emitData } from "../output/render";
import { clientFromCommand, outputOptions } from "./common";

const EVENT_TYPES = [
  "result_helpful",
  "result_not_helpful",
  "passage_used",
  "read_abandoned",
  "duplicate_result",
  "stale_result",
  "spam_or_low_quality",
  "missing_expected_source",
  "unsafe_or_policy_issue",
] as const;

const eventSchema = z.enum(EVENT_TYPES);

export function registerFeedback(program: Command): void {
  program
    .command("feedback")
    .description("Send a feedback event about a search result or document.")
    .requiredOption("--event-type <type>", `one of: ${EVENT_TYPES.join(", ")}`)
    .option("--search-id <id>", "search_id from a /v1/search response")
    .option("--doc-id <id>", "doc_id the feedback refers to")
    .option("--passage-id <id>", "passage_id the feedback refers to")
    .option("--query <text>", "query associated with the event")
    .option("--rank <n>", "one-based rank of the result")
    .option("--notes <text>", "free-form notes")
    .addHelpText(
      "after",
      `
Examples:
  caesar-search feedback --event-type result_helpful --search-id $SEARCH_ID --doc-id $DOC_ID --query "original query"
  caesar-search feedback --event-type stale_result --doc-id $DOC_ID --notes "page changed since capture"`,
    )
    .action(async (options, command: Command) => {
      const eventType = eventSchema.safeParse(options.eventType);
      if (!eventType.success) {
        throw badInput(`--event-type must be one of: ${EVENT_TYPES.join(", ")}`);
      }
      const body: Record<string, unknown> = {
        event_type: eventType.data,
        agent_context: { client_model: "cli" },
      };
      if (options.searchId) body.search_id = options.searchId;
      if (options.docId) body.doc_id = options.docId;
      if (options.passageId) body.passage_id = options.passageId;
      if (options.query) body.query = options.query;
      if (options.notes) body.notes = options.notes;
      if (options.rank !== undefined) {
        const rank = Number(options.rank);
        if (!Number.isInteger(rank) || rank < 1) throw badInput("--rank must be a positive integer");
        body.rank = rank;
      }

      const client = clientFromCommand(command);
      const response = await client.post("/v1/feedback", body);
      emitData(response, outputOptions(command), (payload) => {
        const accepted = (payload as { accepted?: boolean }).accepted === true;
        return accepted ? "feedback accepted" : "feedback not accepted";
      });
    });
}
