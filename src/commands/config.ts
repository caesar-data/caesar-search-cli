import type { Command } from "commander";
import { type CliConfig, configPath, deleteConfigKey, maskKey, readConfig, writeConfig } from "../config";
import { badInput } from "../output/exit";
import { emitData } from "../output/render";
import { outputOptions } from "./common";

const KEYS: (keyof CliConfig)[] = ["api_key", "base_url"];

function assertKey(key: string): keyof CliConfig {
  if (!KEYS.includes(key as keyof CliConfig)) {
    throw badInput(`unknown config key "${key}"; valid keys: ${KEYS.join(", ")}`);
  }
  return key as keyof CliConfig;
}

function display(key: keyof CliConfig, value: string | undefined): string | null {
  if (value === undefined) return null;
  return key === "api_key" ? maskKey(value) : value;
}

export function registerConfig(program: Command): void {
  const config = program.command("config").description("Read and write CLI configuration.");

  config
    .command("get")
    .argument("<key>", `one of: ${KEYS.join(", ")}`)
    .action(async (rawKey: string, _options, command: Command) => {
      const key = assertKey(rawKey);
      const value = readConfig()[key];
      emitData(
        { key, value: display(key, value) },
        outputOptions(command),
        () => display(key, value) ?? "(unset)",
      );
    });

  config
    .command("set")
    .argument("<key>", `one of: ${KEYS.join(", ")}`)
    .argument("<value>")
    .action(async (rawKey: string, value: string, _options, command: Command) => {
      const key = assertKey(rawKey);
      const current = readConfig();
      current[key] = value;
      writeConfig(current);
      emitData({ key, stored: true }, outputOptions(command), () => `set ${key}`);
    });

  config
    .command("unset")
    .argument("<key>", `one of: ${KEYS.join(", ")}`)
    .action(async (rawKey: string, _options, command: Command) => {
      const key = assertKey(rawKey);
      deleteConfigKey(key);
      emitData({ key, removed: true }, outputOptions(command), () => `unset ${key}`);
    });

  config.command("list").action(async (_options, command: Command) => {
    const current = readConfig();
    const entries = Object.fromEntries(KEYS.map((key) => [key, display(key, current[key])]));
    emitData(entries, outputOptions(command), () =>
      KEYS.map((key) => `${key} = ${display(key, current[key]) ?? "(unset)"}`).join("\n"),
    );
  });

  config.command("path").action(async (_options, command: Command) => {
    emitData({ path: configPath() }, outputOptions(command), () => configPath());
  });
}
