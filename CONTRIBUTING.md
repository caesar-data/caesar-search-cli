# Contributing

- Toolchain: [Bun](https://bun.com) ≥ 1.3. `bun install`, then `bun test`, `bun run lint`, `bun run typecheck`.
- API types are generated from `spec/openapi-public.json` via `bun run generate:types` — do not hand-edit `src/api/schema.d.ts`.
- Conventional commits; CI enforces lint/typecheck/tests on PRs.
- Releases are cut by tagging `v*`; see `.goreleaser.yaml` and `.github/workflows/release.yml`.
