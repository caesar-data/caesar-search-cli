import { createInterface } from "node:readline";
import type { Command } from "commander";
import { configPath, deleteConfigKey, maskKey, readConfig, resolveKey, writeConfig } from "../config";
import { badInput } from "../output/exit";
import { emitData } from "../output/render";
import { argOrStdin, clientFromCommand, jsonMode } from "./common";

async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw badInput("no TTY available; pass --key, or pipe the key via --key -");
  }
  const readline = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  process.stderr.write(question);
  // Mask typed characters.
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (raw: boolean) => void };
  const answer = await new Promise<string>((resolve) => {
    readline.question("", (value) => resolve(value));
    stdin.setRawMode?.(false);
  });
  readline.close();
  process.stderr.write("\n");
  return answer.trim();
}

export function registerAuth(program: Command): void {
  const auth = program.command("auth").description("Inspect or manage API key authentication.");

  auth
    .command("status")
    .description("Show key source, masked key, and API reachability.")
    .action(async (_options, command: Command) => {
      const resolved = resolveKey(command.optsWithGlobals<{ key?: string }>().key);
      const client = clientFromCommand(command);
      let reachable = false;
      try {
        await client.get("/up");
        reachable = true;
      } catch {
        reachable = false;
      }
      const payload = {
        key_present: resolved.key !== undefined,
        key_source: resolved.source,
        key_masked: resolved.key ? maskKey(resolved.key) : null,
        base_url: client.baseUrl,
        api_reachable: reachable,
        config_path: configPath(),
      };
      emitData(payload, { json: jsonMode(command) }, () =>
        [
          `key:       ${resolved.key ? `${maskKey(resolved.key)} (from ${resolved.source})` : "not set"}`,
          `base url:  ${client.baseUrl}`,
          `api:       ${reachable ? "reachable" : "unreachable"}`,
          `config:    ${configPath()}`,
        ].join("\n"),
      );
    });

  auth
    .command("login")
    .description("Store an API key in the config file (0600).")
    .option("--key <key>", "API key; use - to read from stdin")
    .action(async (options, command: Command) => {
      // --key may be captured by the global option of the same name.
      const provided: string | undefined = options.key ?? command.optsWithGlobals<{ key?: string }>().key;
      let key: string;
      if (provided) {
        key = await argOrStdin(provided, "API key");
      } else {
        key = await promptHidden("Paste your Caesar API key: ");
      }
      if (key.length < 8) throw badInput("that does not look like an API key");
      const config = readConfig();
      config.api_key = key;
      writeConfig(config);
      emitData(
        { stored: true, config_path: configPath(), key_masked: maskKey(key) },
        { json: jsonMode(command) },
        () => `stored key ${maskKey(key)} in ${configPath()}`,
      );
    });

  auth
    .command("logout")
    .description("Remove the stored API key from the config file.")
    .action(async (_options, command: Command) => {
      deleteConfigKey("api_key");
      emitData({ removed: true }, { json: jsonMode(command) }, () => "removed stored API key");
    });
}
