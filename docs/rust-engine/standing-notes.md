# Standing memories in AGENTS.md

Agents are now told to keep new standing memories in their scratch `AGENTS.md`. Existing `CLAUDE.md` files remain readable and untouched. No files are renamed or migrated automatically.

The engine includes both names from scratch and granted folders, except files already loaded by the selected CLI. Canonical paths prevent repeated grants and Claude imports from duplicating delivery. Existing engine limits remain: 12,000 characters per scratch file and 6,000 per granted file, with explicit truncation text. Native CLI limits are unchanged.

## Installed CLI behavior (measured)

Claude Code loads project AGENTS.md files when no nonempty project CLAUDE.md or CLAUDE.local.md is present. A project legacy file suppresses that fallback across the ancestor chain. A user-config CLAUDE.md does not suppress it; an empty project CLAUDE.md does not either. An explicit `@AGENTS.md` import is loaded natively. Granted folders passed with `--add-dir` load neither name with the engine's environment, so the engine supplies them.

Codex reads AGENTS.md natively; when AGENTS.override.md wins, the engine supplies the otherwise omitted AGENTS.md. Legacy CLAUDE.md and non-native granted notes are supplied by the engine. Other runtimes receive both through the engine; Antigravity delivery is unit-tested rather than checked with a real Antigravity request.

## Verification

- Cargo check passed; workspace tests 73/73 passed; renderer typecheck passed.
- `standing-native`: 9/9 installed Claude Code native-loading cases passed.
- `standing-notes`: 24/24 checks passed across eight agents using installed Claude Code and Codex language-server lanes: canonical only, legacy only, both, imports and overrides. Captured first requests contain every own and granted marker exactly once; original files remain intact.
- `startup-context`: 9/9 checks passed. Edits change the startup fingerprint, leave an active turn alone, and restart the parked CLI while retaining its conversation/session identity.

All request captures used isolated rig state and a fake inference endpoint. No live model inference, credentials or user files were used. Evidence is under `D:\orgtree-work\rig\agy-astra\evidence`: `standing-native-20261011T105138`, `standing-notes-20261011T105300`, and `startup-context-20261011T105206`. Build logs are under `D:\orgtree-work\standing-notes`.

This intentionally changes startup instructions and, for affected agents, delivered notes. Deployment therefore changes their prompt prefix and can cause a cold provider-cache read. A local session being resumed does not guarantee provider cache reuse.
