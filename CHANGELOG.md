# Changelog

## 0.3.0

- `auth login` now opens the browser: an OAuth (PKCE, RFC 8252 loopback) login that mints a named, revocable API key ("CLI · hostname · date", visible in the console) and stores it in the OS keychain (macOS Keychain / libsecret), falling back to the 0600 config file. `--insecure-storage` forces the file.
- `auth login --device` (RFC 8628) for SSH/containers/headless machines: approve with a short code on any browser.
- The paste paths are unchanged: `--key <key>`, `--key -` from a secret manager, and the hidden prompt (used automatically when browser login is not configured). `CAESAR_API_KEY` and `--key` precedence are unchanged; the keychain slots in between env and config file.
- `auth logout` clears the stored key from the keychain and the config file.
- New config keys `oauth_issuer`, `oauth_client_id`, `console_url` (env: `CAESAR_OAUTH_ISSUER`, `CAESAR_OAUTH_CLIENT_ID`, `CAESAR_CONSOLE_URL`) configure browser login.

## 0.2.0

- The public Caesar API now requires an API key. Commands without a key now exit `3` with `missing_api_key` locally instead of sending an anonymous request.
- Refreshed the vendored OpenAPI spec from the required-auth public contract.

Releases are documented on the [GitHub releases page](https://github.com/caesar-data/caesar-search-cli/releases).
