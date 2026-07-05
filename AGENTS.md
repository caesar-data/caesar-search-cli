# AGENTS.md

Guidance for AI agents using and maintaining `caesar-search`.

## Using the CLI

- Always pass `--json` for machine-readable output. Data goes to stdout; errors are a JSON envelope `{"error":{"code","message","hint"}}` on stderr.
- Exit codes: `0` ok, `2` bad input, `3` auth, `4` API error, `5` timeout. Branch on these, not on output parsing.
- The standard loop: `search` → pick a `doc_id` → `read` it → optionally `feedback`.
- For big results, write to a file instead of stdout: `-o /tmp/results.json` suppresses stdout entirely, so harness output limits can't truncate the JSON mid-parse. Read the file afterwards.
- If a flag errors as unknown, the installed CLI is outdated: run `caesar-search update`, then retry. `caesar-search update --check --json` reports `{current, latest, update_available, channel}` without installing.

```sh
caesar-search search "kubernetes operator patterns" --max-results 5 --format compact --json
caesar-search read 0c944fa8-4c8f-4f48-9b08-0fb2fd3438ec --query "reconciliation loop" --json
caesar-search feedback --event-type result_helpful --search-id $SID --doc-id $DID
```

- `--format compact` is the token-efficient default choice for search-then-read loops; use `standard` when you need quotable passages and `full` when you need capture provenance.
- A truncated `read` reports `content.truncated: true` and `content.start_char`/`char_count`; continue with `--start-char <start+count>` instead of retrying with a bigger `--max-chars`.
- Keys: set `CAESAR_API_KEY`. Never paste literal keys into config files or shell history; use `caesar-search auth login --key -` fed from a secret manager. Anonymous access works at a lower rate limit when the deployment allows it.
- Provenance fields (`doc_id`, `search_id`, `capture_id`, `canonical_url` vs `source_url`, crawl/freshness dates) are stable handles — thread them between commands and cite them.
- `read <url>` may render the page with your own local browser and return it directly, marked by a `local_render` warning. A local render is not a server capture, so it has **no `doc_id`** — re-read by URL, or use `--no-local-render` for a server read with a `doc_id`. It is a reduced envelope: it honors `--include` for `metadata`/`content`, but `--include passages`/`capture_history` (like `--query` and a `doc_id` argument) always go to the server, and `request_id`/`session_id`/`access` are absent because no server request was made.
- A `--start-char` continuation of a URL read stays local: it re-renders and slices the same extraction, so offsets are consistent with the read that reported `truncated: true`. Offsets only cross to a server extraction if the continuation itself falls back — the `local_render_fallback` warning says so explicitly.
- A `bot_wall_skipped` warning means the page is behind a bot/CAPTCHA wall: `read` exits `0` with **empty content** and does NOT fall back to the server. Treat it as a skip, not a successful read — branch on the warning `code`, not the exit code alone, and try a different source.
- `caesar-search doctor --json` diagnoses the local-first read path: browser detection (`CHROME_PATH` override respected), a sample local render with timing/strategy, and server reachability. If reads keep falling back to the server, run this first; `local_first: true` means a plain `read <url>` will use the local browser.

## Common mistakes

| Mistake | Correction |
|---|---|
| `--results`, `--limit`, `-n` | The flag is `--max-results` |
| `--response-format` | The flag is `--format` (values: ids_only, compact, standard, full) |
| `--mode deep` / `--mode quick` | Modes are exactly `fast`, `standard`, `research` |
| Passing a bare domain to `read` | `read` needs a full URL (`https://…`) or a `doc_id` UUID |
| Retrying a truncated read with bigger `--max-chars` | Use `--start-char` to continue from where it stopped |
| Parsing human output | Use `--json`; human output is not a stable interface |
| Shell-redirecting and also reading stdout | Use `-o <file>`; it suppresses stdout so nothing competes with the file |
| `npm update -g` / `brew upgrade` by hand | `caesar-search update` picks the right channel itself |
| Expecting camelCase JSON | All fields are snake_case, exactly as the API returns them |
| `caesar search` | The binary is `caesar-search` |

## Maintaining this repo

- Source of truth for request/response shapes: `spec/openapi-public.json` → `bun run generate:types`. Never hand-model API types.
- `bun test` must pass; tests are hermetic (mock server) except `test/contract` which is gated behind `CAESAR_CONTRACT=1`.
- `bun run lint` (Biome) and `bun run typecheck` gate CI.
- Never add postinstall scripts to package.json. Never log or echo API keys. Never name or leak upstream search/inference providers in code, output, or errors.
- Releases: tag `v*` → GoReleaser builds bun binaries, archives, checksums, SBOM, Homebrew cask; npm publish follows in the same workflow.
