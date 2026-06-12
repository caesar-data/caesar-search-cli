# Distribution snapshot

Last updated: 2026-06-12 (v0.1.0)

| Channel | Artifact | Mechanism |
|---|---|---|
| GitHub Releases | binaries (darwin/linux/windows, x64+arm64), checksums.txt, SBOMs | GoReleaser (Bun builder) on `v*` tags |
| Homebrew | `brew install caesar-data/tap/caesar-search` | **Formula** in caesar-data/homebrew-tap (not a cask: un-notarized cask binaries are quarantined and Gatekeeper-killed on modern macOS; revisit cask + notarization with an Apple Developer account) |
| npm | `npm install -g caesar-search-cli` | plain package, `dist/index.js` bundle, no postinstall, Node ≥ 20 |
| curl | `install.sh` (checksum-verified, installs to `~/.local/bin`) | GitHub raw |

Deferred: Docker image, Scoop/winget, pip wrapper, `.mcpb`, cosign signatures (configured for CI releases via OIDC), official MCP registry entry (belongs to the MCP server).

Release flow: tag `v*` → `release.yml` runs GoReleaser (binaries, archives, checksums, SBOM, formula push) then `npm publish --provenance`. npm uses trusted publishing (OIDC, no token; configured on npmjs.com against release.yml). The only optional secret is `HOMEBREW_TAP_GITHUB_TOKEN` (fine-grained PAT, contents:write on caesar-data/homebrew-tap); without it CI skips the formula push and the tap is updated manually.
