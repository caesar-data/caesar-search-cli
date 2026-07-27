# caesar-search

CLI for the [Caesar](https://github.com/caesar-data) search API — web search with provenance, built for agents and scripts.

## Quickstart

```sh
npm install -g caesar-search-cli        # or: brew install caesar-data/tap/caesar-search
caesar-search auth login                # browser login (or: export CAESAR_API_KEY=...)
caesar-search search "rust async runtime comparison" --json | jq -r '.results[0].doc_id'
caesar-search read <doc_id-or-url> --query "what changed"
caesar-search feedback --event-type result_helpful --doc-id <doc_id>
```

## Install

| Channel | Command |
|---|---|
| npm | `npm install -g caesar-search-cli` (no postinstall scripts; works with `--ignore-scripts`) |
| Homebrew | `brew install caesar-data/tap/caesar-search` |
| curl | `curl -fsSL https://raw.githubusercontent.com/caesar-data/caesar-search-cli/main/install.sh \| bash` |
| Binaries | [GitHub Releases](https://github.com/caesar-data/caesar-search-cli/releases) (darwin/linux/windows, x64+arm64, checksums) |

## Commands

```
caesar-search search <query|->     web search; --max-results --format
caesar-search read <url|doc_id|->  read a page as markdown; --query --max-chars --start-char (aliases: fetch, extract)
caesar-search feedback             send result feedback; --event-type --search-id --doc-id
caesar-search files upload <path...>  upload to your files knowledge base; --no-index --content-type
caesar-search files list|delete|index|status  manage uploads and indexing runs
caesar-search usage                org usage: requests, errors, latency, spend; --from --to --interval --key-id
caesar-search auth status|login|logout  login opens a browser; --device for SSH; --key for direct entry
caesar-search config get|set|unset|list|path
caesar-search api <method> <path>  authenticated raw API call (escape hatch)
caesar-search completion bash|zsh|fish
caesar-search update               self-update; --check reports without installing
caesar-search version
```

Every command supports `--json` (data on stdout, JSON error envelopes on stderr), `-o/--output <file>` (write data to a file and suppress stdout), `--key`, `--base-url`, `--no-retry`, and `--timeout <seconds>`.

`update` detects how the CLI was installed — npm global, Homebrew, or the curl
installer — and runs the matching upgrade (standalone installs replace the
binary in place after sha256 verification). `update --check --json` reports
`{current, latest, update_available, channel}` without changing anything.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 2 | bad input |
| 3 | auth error |
| 4 | API error |
| 5 | timeout |

## Configuration

Key resolution order: `--key` flag → `CAESAR_API_KEY` → OS keychain → `~/.config/caesar/config.json` (0600). Base URL: `--base-url` → `CAESAR_BASE_URL` → config → default. Keys are never logged and are masked in output.

### Authentication

`caesar-search auth login` opens your browser, completes an OAuth (PKCE) login, and stores a named, revocable API key in the OS keychain (macOS Keychain / libsecret; 0600 config-file fallback, or `--insecure-storage` to force the file). The key is visible and revocable in the console. Variants:

- `auth login --device` — SSH/containers/headless: shows a short code to approve on any device.
- `auth login --key -` — pipe a key from a secret manager (stores to the config file, unchanged from 0.2).
- `CAESAR_API_KEY` — no stored state; ideal for CI.

Browser login uses the production endpoints out of the box; override with `CAESAR_OAUTH_ISSUER`, `CAESAR_OAUTH_CLIENT_ID`, `CAESAR_CONSOLE_URL`, or the matching `config set` keys. Setting any of those env vars to an empty string disables browser login, and `auth login` falls back to the hidden paste prompt.

## For agents

See [AGENTS.md](AGENTS.md) — including the common-mistakes table. Truncated reads return the next offset: continue with `--start-char`.

## License

[MIT](LICENSE)
