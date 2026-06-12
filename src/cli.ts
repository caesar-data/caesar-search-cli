import { Command } from "commander";
import { registerApi } from "./commands/api";
import { registerAuth } from "./commands/auth";
import { registerCompletion } from "./commands/completion";
import { registerConfig } from "./commands/config";
import { registerFeedback } from "./commands/feedback";
import { registerRead } from "./commands/read";
import { registerSearch } from "./commands/search";
import { EXIT_BAD_INPUT } from "./output/exit";
import { emitData, emitError } from "./output/render";
import { BUILD_DATE, COMMIT, VERSION } from "./version";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("caesar-search")
    .description("CLI for the Caesar search API: web search with provenance, built for agents and scripts.")
    .version(VERSION, "-v, --version")
    .option("--json", "machine output: data on stdout, JSON error envelopes on stderr")
    .option("--key <key>", "API key (overrides CAESAR_API_KEY and the config file)")
    .option("--base-url <url>", "API base URL (overrides CAESAR_BASE_URL)")
    .option("--no-retry", "disable rate-limit/5xx retries")
    .option("--timeout <seconds>", "request timeout in seconds (default 30)")
    .exitOverride()
    .configureOutput({
      writeErr: (text) => process.stderr.write(text),
    })
    .addHelpText(
      "after",
      `
Exit codes:
  0 success   2 bad input   3 auth error   4 API error   5 timeout

Environment:
  CAESAR_API_KEY    API key (or use: caesar-search auth login)
  CAESAR_BASE_URL   API base URL
  NO_COLOR          disable color output`,
    );

  registerSearch(program);
  registerRead(program);
  registerFeedback(program);
  registerAuth(program);
  registerConfig(program);
  registerApi(program);
  registerCompletion(program);

  program
    .command("version")
    .description("Print version, commit, and build date.")
    .action(async (_options, command: Command) => {
      const json = command.optsWithGlobals<{ json?: boolean }>().json === true;
      emitData(
        { version: VERSION, commit: COMMIT, build_date: BUILD_DATE },
        { json },
        () => `caesar-search ${VERSION} (${COMMIT}, ${BUILD_DATE})`,
      );
    });

  return program;
}

export async function run(argv: string[]): Promise<number> {
  const program = buildProgram();
  const json = argv.includes("--json");
  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (error) {
    // commander's own exits (help, version, usage errors).
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as { code: string }).code;
      if (code === "commander.helpDisplayed" || code === "commander.version" || code === "commander.help") {
        return 0;
      }
      if (code.startsWith("commander.")) {
        return EXIT_BAD_INPUT;
      }
    }
    return emitError(error, json);
  }
}
