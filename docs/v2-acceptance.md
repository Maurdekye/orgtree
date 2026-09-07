# Orgtree v2 integrated acceptance

Updated 2026-09-07 21:32 UTC. This is an independent evidence record, not a declaration of MVP completion. Binding scope is `v2-user-decisions.md` (newest decision wins), the retained requirements in `v2-original-design-brief.md`, and `v1-parity-inventory.md`. Technical wiring is described in `engine-contract.md`.

## Evidence levels and commands

- **Source** means inspected code only; presence does not establish functioning behavior.
- **Fixture** means a deliberately restricted test double or seeded state; it is not a provider success or full interaction demonstration.
- **Real application** means the actual compiled main entrypoint, preload, copied renderer and Python engine run together with isolated data. The acceptance driver instruments Electron to observe windows and drive its DOM. It acknowledges native message boxes and reports error dialogs as failures.
- **Installer** requires running the distributed executable through installation and launch. A development Electron pass is not installer evidence.
- **INERT** means prerequisites were unavailable and no behavioral verdict was possible. It exits 2; FAIL exits 1 and PASS exits 0.

Run the acceptance instrument's positive/negative controls with `node --test tests/acceptance/harness.test.mjs`. Run the assembled app with `node tests/acceptance/run.mjs`. Optional absolute environment variables select `ORGTREE_ACCEPTANCE_APP`, `ORGTREE_ACCEPTANCE_ELECTRON`, and `ORGTREE_ACCEPTANCE_PYTHON`; defaults select the current checkout and its bundled dependencies/runtime. Build the chosen app first using its normal build command.

The runner creates a fresh `orgtree-v2-acceptance-*` directory under the OS temporary directory, outside the live v1 tree. It sets both data selectors and an isolated Electron profile **before any application import**. The inherited `ORGTREE_DATA` points to a separate empty `inherited-v1` fixture, which the shell treats as forbidden; the shell must replace it with the intended `ORGTREE_V2_DATA` root in the child. Both launches use that same fresh data/profile. It retains the data and structured `report.json`; it does not recursively delete anything. Raw application output is not printed. No acceptance case attaches to an existing engine or port 7360. The driver stops before UI mutation if the real root/PID/port handshake fails, and reports whether its observed child processes exited.

## Current results

At baseline `696c160`, engine launcher/backend/runtime and build artifacts were absent. The real application runner returned **INERT** with every missing component named. Both acceptance-instrument tests passed: an empty fixture finds all seven missing prerequisites, a complete fixture enables the preflight, removing Python disables it, and separate runs get fresh empty roots. This establishes only that the instrument can reject missing prerequisites, not that the app works.

The first real startup exposed the bundled interpreter's Windows `_pth` path `../..` resolving to `engine` rather than the package root. Shell owner independently reproduced and fixed it with `../../`; engine owner also added explicit package-root insertion. This startup objection is resolved in the tested later build.

The basic whole-app run against assembled shell `2342c2e` passed two launches: exact engine root/PID/port, nonempty real React renderer, bridge/default preferences, authenticated API and unauthenticated rejection, close-to-tray with live engine and reopen, and seeded draft text/attachment/reply storage across a full engine restart. Both observed Python children exited. Retained evidence: `C:/Users/ncola_k8bx/AppData/Local/Temp/orgtree-v2-acceptance-5VSQ00/report.json`. This proves storage transport with seeded values, not an actual composer send/reply workflow.

The expanded real UI run on the same build found a **blocking integration defect**. Creating `Acceptance Runtime` through the visible form succeeds durably, then selection pushes the URL to `/o/acceptance-runtime`. The shell's `trustedUiUrl` accepts only `/` and `/index.html`, so it strips engine credentials and rejects native IPC on the selected-org route. Subsequent Chromium API requests return 401, WebSocket fails, and Settings cannot open. A fresh launch at the home route restores access and shows the created organization; actual Settings modal popout/redock and keeping that child open when the main closes pass from that home route. Evidence: `C:/Users/ncola_k8bx/AppData/Local/Temp/orgtree-v2-acceptance-rgGW6V/report.json`. Shell owner and coordinator received the route mismatch and exact reproduction. The runner now includes an explicit selected-org route check on both launches; this defect remains open pending an updated build.

## Whole-app feature matrix

| Requirement | Acceptance boundary | Current evidence / remaining case |
|---|---|---|
| Fresh first launch, separate v2 root, copied Python source and real interpreter | Main spawns actual bundled interpreter; readiness root/PID/port must match; nonempty renderer must mount | Real application PASS on both launches of `2342c2e` |
| HTTP assets, REST, WebSocket and native bridge share the engine | Actual renderer loads; authenticated API succeeds and unauthenticated request fails | Home-route real app PASS including WS; selected-org route FAIL loses authorization |
| Organization create/select/settings/default project folder | Create isolated organization from visible UI, reload and verify persistence/default grant | Actual create + restart persistence PASS; selection authorization FAIL; default folder interaction pending |
| Graph, desks, eye switchboard, capacity and lifecycle | Actual isolated org/agent graph and live conversation | Copied source only; real agent pending |
| Main close leaves engine and popouts; explicit Exit closes everything | Close real main, prove engine API still responds, reopen; repeat with actual desk/modal popout | Real home-route main close/reopen and actual Settings modal retention/redock PASS; runner quit leaves no observed Python child; tray/toolbar Exit interaction pending |
| Popout transfer, redock, reload and monitor layout | Same actual composer node/text/attachments/reply; restored windows on manual reopen | Renderer source only; shell's portal primitive fixture is not whole-renderer evidence |
| Draft and event reply persistence | Draft text/attachment/reply storage survives two full engine launches; actual source identity/preview/send receipt survives reload/compaction | Actual two-launch storage transport PASS with explicitly seeded values; real composer/source/send/compaction still pending |
| Pinned overlap fading, opacity/toggle and contextual actions | Open overlapping real pinned surfaces; exercise toggle, slider and right-click operations | Retained requirement; real interaction pending |
| Mail, questions, credits/scope requests, docket | Exact identities, reply target, successful submission and durable refresh | Copied source only; integrated cases pending |
| Documents, HTML and ZIP downloads | Actual Download action saves usable source/filename; ZIP includes local assets; downloaded content has no bridge | Source inventory only; artifact/download runtime pending |
| Peer Connections and existing Mail views | Pair two isolated installations; send/acknowledge local fixture correspondence and reconnect | Embedded hub source landed; UI + whole-app transport pending; no external correspondence authorized |
| Provider/harness setup, auth and usage | Missing harness visible, detect-only links; configured connection identity and honest availability | Shell detection fixture previously reported by owner; real UI/provider evidence pending |
| Real agent turn + MCP identity | ONE isolated Codex Luna/Astra arithmetic task and read-only chart, verifying MCP targets same test engine | Authorized 21:14 UTC, explicitly put on HOLD 21:23 UTC until exact MCP port and scoped credential/forged-actor rejection are verified; no real provider run |
| Interrupt/resume and crash recovery | Preserve existing session; active agents resume; idle queued agents stay idle; uncertain tool receipts reconcile | One interrupt/resume authorized only after successful real first turn; crash/import/provider continuity unverified |
| Copy-only import and enabled automation recovery | Import a synthetic v1 root; prove source bytes unchanged; active/idle/automation distinctions | Retained requirement; pending engine feature/integration evidence |
| Retained authority, generations, storage, diagnostics and automation | UI and agent tools reach same ledger; no generation/draft reuse; SQLite/history survives restart | Copied source only; no parity certification from copied files |
| Needs-attention notifications | Defaults only question/urgent mail/ticket attention; open exact target; optional routine notifications | Shell implementation in progress; actual OS notification navigation unverified |
| Tray statistics, quiet login, no sleep prevention | Actual count changes and quiet startup; close/reopen; installed login setting | Source/default fixture evidence only; packaged behavior pending |
| Automatic prerelease update at safe idle point | Active work blocks install; unavailable/stale status blocks install; real downloaded update applies when idle | Source only; no actual update execution evidence |
| Current-user/default or all-users Windows installer, uninstall retains data | Install packaged artifact, launch bundled engine, uninstall and verify preserved org/history | No installer exercised; unsigned prototype accepted by user and must be disclosed at distribution |
| Provider-neutral themes and honest capability differences | Theme changes preserve authority/routing; status remains identifiable without color; two materially different adapters | Copied source only; whole-app/provider breadth pending |

## Deliberate exclusions and boundaries

MVP excludes kiosk/public browser access, mobile, all agent execution sandbox/isolation, Git management/verification, and all multi-account registration/balancing/reassignment/fallback. Renderer isolation and folder/tool authority remain required. These exclusions override older inventory rows; they are not failures. If MVP completes early, the authorized conditional sequence is Git integration then symmetric multi-account support, within the same hard stop.

The acceptance harness never uses a real provider by default. Coordinator authorization permits one Codex Luna/Astra agent in a fresh isolated test organization to perform arithmetic and read-only chart inspection after the readiness root and MCP target are verified. That case is currently on the coordinator's explicit HOLD until scoped MCP authentication and forged-actor/operator rejection are verified as well as the exact isolated port. One interrupt/resume test is permitted only after the first succeeds. No existing harness credentials/configuration are changed. Fixtures cannot establish actual provider execution, session continuity or uncertain mutation recovery.

Hard stop: 2026-09-08 01:00 UTC or usage exhaustion, whichever comes first. Incomplete rows remain incomplete at the checkpoint.
