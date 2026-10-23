# Development and contributions

[Documentation](../README.md#documentation) · [Operating and troubleshooting](operating-orgtree.md) · [Maintenance source map](documentation-map.md)

## Development

The desktop app uses **Electron, React and TypeScript**. The background engine is written in **Rust** (`engine/rs`) and talks to a bundled PostgreSQL database; the mail hub lives in the pinned [orgtree-mailhub](https://github.com/Maurdekye/orgtree-mailhub) submodule at `engine/mailhub`, so clone with `--recurse-submodules` (or run `git submodule update --init`).

```powershell
git submodule update --init
npm ci
npm run typecheck
npm run build
cargo check --manifest-path engine/rs/Cargo.toml
```

Read the [repository's contributor instructions](../AGENTS.md) before working on the code. The commands above check source and build the desktop; `cargo check` does not produce the engine executable. Before `npm start`, build the Rust workspace and provision the bundled runtime inputs required by the desktop. Keep development separate from your installed app and its organizations by pointing it at its own profile and data folder (`ORGTREE_V2_PROFILE`, `ORGTREE_V2_DATA`). Renderer checks run with `npm run test:renderer`.

Packaging also requires release builds of the Rust engine and credential broker, the pinned mail hub binary, and the provisioned bundled runtimes. `cargo check` and the desktop build alone do not prepare those inputs; the packaging preflight refuses missing or development engine binaries.

With those prerequisites ready, build a Windows installer with `npm run package:win`. For the documented Windows release workflow, use `npm run release:windows -- <version>`; publication is a separate explicit `--publish` phase. See [the Windows release workflow](windows-release.md). For the separate development packaging workflow, see [local development builds](dev-builds.md).

Current Rust-engine notes: [plan](rust-engine/PLAN.md), [decisions](rust-engine/DECISIONS.md), [event watchdogs](rust-engine/event-watchdogs.md) and [credential bridge](rust-engine/credential-bridge.md). Earlier design references remain available for the [engine boundary](engine-contract.md), [onboarding and charter presets](v2-onboarding.md), [themes](v2-visual-themes.md) and [history retention](v2-history-retention.md); check current source before applying their older implementation details. Consult the [release notes](https://github.com/Maurdekye/orgtree/releases) for published changes.

## Feedback and contributions

[Open an issue](https://github.com/Maurdekye/orgtree/issues) for a bug or feature request. For a bug, include your Orgtree version, Windows version, the steps that reproduce it and the error text or a screenshot. Remove tokens, authorization codes and other private information before posting.

## License and notices

The project uses the [MIT license](../LICENSE). See [third-party notices](../THIRD_PARTY_NOTICES.md) for bundled components.
