import { createInterface } from "node:readline";
import type { Command } from "commander";
import { removeStoredKey, storeKey } from "../auth/keystore";
import { browserLogin, deviceLogin, mintApiKey } from "../auth/oauth";
import { configPath, maskKey, readConfig, resolveKey, resolveOAuthConfig, writeConfig } from "../config";
import { badInput } from "../output/exit";
import { emitData } from "../output/render";
import { argOrStdin, clientFromCommand, outputOptions } from "./common";

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

function statusLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function registerAuth(program: Command): void {
  const auth = program.command("auth").description("Inspect or manage API key authentication.");

  auth
    .command("status")
    .description("Show key source, masked key, and API reachability.")
    .action(async (_options, command: Command) => {
      const resolved = resolveKey(command.optsWithGlobals<{ key?: string }>().key);
      const client = clientFromCommand(command, { requireKey: false });
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
      emitData(payload, outputOptions(command), () =>
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
    .description(
      "Log in via the browser and store a revocable API key (OS keychain, config-file fallback). " +
        "Use --device on SSH/headless machines, or --key to store a key directly.",
    )
    .option("--key <key>", "API key; use - to read from stdin")
    .option("--device", "device login: approve on any browser, for SSH/headless machines")
    .option("--no-open", "print the login URL instead of opening the browser")
    .option("--insecure-storage", "store the key in the 0600 config file instead of the OS keychain")
    .action(async (options, command: Command) => {
      // --key may be captured by the global option of the same name.
      const provided: string | undefined = options.key ?? command.optsWithGlobals<{ key?: string }>().key;
      const forceFile = options.insecureStorage === true;

      // Paste path (unchanged 0.2 contract): --key <key> / --key - / prompt
      // stores to the 0600 config file. The keychain is used for
      // browser/device-minted credentials below.
      if (provided) {
        const key = await argOrStdin(provided, "API key");
        storePastedKey(key, command);
        return;
      }

      const oauth = resolveOAuthConfig();
      if (!oauth) {
        // Browser login is not configured for this install; keep the
        // pre-0.3 hidden prompt so `auth login` never dead-ends.
        const key = await promptHidden("Paste your Caesar API key: ");
        storePastedKey(key, command);
        return;
      }

      const accessToken = options.device
        ? await deviceLogin(oauth, statusLine)
        : await browserLogin(oauth, statusLine, { openBrowser: options.open !== false });
      statusLine("Login approved. Creating your CLI API key…");
      const minted = await mintApiKey(oauth, accessToken);
      // The access token is short-lived and now out of scope — only the
      // named, revocable csk_ key is stored.
      const storage = storeKey(minted.secret, { forceFile });
      emitData(
        {
          stored: true,
          key_name: minted.name,
          key_masked: maskKey(minted.secret),
          storage,
          config_path: storage === "file" ? configPath() : undefined,
        },
        outputOptions(command),
        () =>
          [
            `Logged in. Created API key "${minted.name}" and stored it in the ${storage === "keychain" ? "OS keychain" : `config file (${configPath()})`}.`,
            `Manage or revoke it any time in the console.`,
          ].join("\n"),
      );
    });

  auth
    .command("logout")
    .description("Remove the stored API key (keychain and config file).")
    .action(async (_options, command: Command) => {
      removeStoredKey();
      emitData({ removed: true }, outputOptions(command), () => "removed stored API key");
    });

  function storePastedKey(key: string, command: Command): void {
    if (key.length < 8) throw badInput("that does not look like an API key");
    const config = readConfig();
    config.api_key = key;
    writeConfig(config);
    emitData(
      { stored: true, config_path: configPath(), key_masked: maskKey(key) },
      outputOptions(command),
      () => `stored key ${maskKey(key)} in ${configPath()}`,
    );
  }
}
