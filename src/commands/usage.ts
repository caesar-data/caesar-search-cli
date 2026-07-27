import type { Command } from "commander";
import { z } from "zod";
import { badInput } from "../output/exit";
import { emitData, renderUsageHuman } from "../output/render";
import { clientFromCommand, looksLikeDocID, outputOptions } from "./common";

const intervalSchema = z.enum(["hour", "day"]);

export function registerUsage(program: Command): void {
  program
    .command("usage")
    .description(
      "Show API usage for your organization: requests, errors, latency, per-key and per-endpoint breakdowns, and billable spend.",
    )
    .option("--from <iso>", "window start (ISO 8601); default 30 days before the end")
    .option("--to <iso>", "window end (ISO 8601); default now")
    .option("--interval <interval>", "series bucket size: hour | day (hour needs a range of 8 days or less)")
    .option(
      "--key-id <uuid>",
      "only count traffic from this API key id; repeat for several keys",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .addHelpText(
      "after",
      `
Examples:
  caesar-search usage
  caesar-search usage --from 2026-07-16 --interval hour
  caesar-search usage --key-id 1dce3790-f8c4-4224-9670-4e868174ab00 --json | jq .headline`,
    )
    .action(async (options, command: Command) => {
      const params = new URLSearchParams();
      if (options.from) {
        if (Number.isNaN(Date.parse(options.from))) {
          throw badInput("--from must be an ISO 8601 timestamp or date");
        }
        params.set("from", options.from);
      }
      if (options.to) {
        if (Number.isNaN(Date.parse(options.to))) {
          throw badInput("--to must be an ISO 8601 timestamp or date");
        }
        params.set("to", options.to);
      }
      if (options.interval !== undefined) {
        const interval = intervalSchema.safeParse(options.interval);
        if (!interval.success) throw badInput("--interval must be hour or day");
        params.set("interval", interval.data);
      }
      const keyIds: string[] = options.keyId ?? [];
      for (const id of keyIds) {
        if (!looksLikeDocID(id)) {
          throw badInput(`--key-id must be an API key uuid (got ${id})`);
        }
      }
      if (keyIds.length > 0) params.set("api_key_ids", keyIds.join(","));

      const client = clientFromCommand(command);
      const query = params.size > 0 ? `?${params.toString()}` : "";
      const response = await client.get(`/v1/usage${query}`);
      emitData(response, outputOptions(command), renderUsageHuman);
    });
}
