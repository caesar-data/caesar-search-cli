import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { badInput } from "../output/exit";
import { emitData } from "../output/render";
import { clientFromCommand, outputOptions } from "./common";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

async function readBody(input: string | undefined): Promise<unknown> {
  if (input === undefined) return undefined;
  const raw = input === "-" ? readFileSync(0, "utf8") : readFileSync(input, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw badInput("--input must contain valid JSON");
  }
}

export function registerApi(program: Command): void {
  program
    .command("api")
    .description("Authenticated raw API call (escape hatch). Prints the JSON response.")
    .argument("<method>", `HTTP method: ${METHODS.join(", ")}`)
    .argument("<path>", "API path, e.g. /v1/search")
    .option("--input <file>", "JSON request body from a file, or - for stdin")
    .addHelpText(
      "after",
      `
Examples:
  caesar-search api GET /up
  echo '{"query":"hello","max_results":3}' | caesar-search api POST /v1/search --input -`,
    )
    .action(async (methodArg: string, path: string, options, command: Command) => {
      const method = methodArg.toUpperCase();
      if (!METHODS.includes(method)) throw badInput(`method must be one of: ${METHODS.join(", ")}`);
      if (!path.startsWith("/")) throw badInput("path must start with /");
      const body = await readBody(options.input);
      const client = clientFromCommand(command);
      const { body: response } = await client.request(method, path, body);
      // Raw API output is always JSON, with or without --json.
      emitData(response, { ...outputOptions(command), json: true }, () => "");
    });
}
