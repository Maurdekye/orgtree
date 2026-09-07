# Orgtree 2 desktop

Electron + React/TypeScript with a separately bundled Python organization engine.
This repository is a new foundation; the seed is not a parity-complete application.

## Development

`npm ci`, `npm run typecheck`, `npm run build`, then `npm start`.
The engine is initially a placeholder. No provider is dispatched by this seed.
Desktop main/preload and root build/lock files belong to the bootstrap owner.
Engine and renderer workers branch from the common seed commit and own separate paths.

## Safety and scope

Use an explicitly separate v2 data directory. No live v1 migration or provider setup is automatic.
User decisions are in docs/supplied-design-decisions.md; newest dated ruling wins.
The parity inventory is planning evidence, not a claim of shipped functionality.
Kiosk/public exposure, Git management, all multi-account management/fallback and mobile development/integration are out of prototype scope.

Existing source copyright/license notices are retained in LICENSE and THIRD_PARTY_NOTICES.md.
