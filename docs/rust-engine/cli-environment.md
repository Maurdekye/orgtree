# The Claude CLI's environment: essential traffic, PowerShell, cached flags

Report: the neoja org, 2026-10-08. After an engine restart, an agent's session
had lost the PowerShell tool. Decision 53 records the ruling.

## What the engine sets

Every Claude CLI launch (`Actor::claude_spec`, a cache keepalive included)
gets these:

| Variable | Value | Why |
|---|---|---|
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` | Agents share the user's global CLI. This stops each of them from checking for or applying an update mid-run, and stops telemetry and error reports. 3.x never set it: it ran its own pinned CLI copy. |
| `CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF` | `1` | The switch above turns off the CLI's server-side feature flags. With this set, the CLI reads the account's cached flags from its global config (`.claude.json` in `CLAUDE_CONFIG_DIR` or the home folder). Those are the flags the user's own CLI runs with, and the ones 3.x agents saw. |
| `CLAUDE_CODE_USE_POWERSHELL_TOOL` | `1`, only with the terminal switch on | The identity promises "Bash and PowerShell", as 3.x's did. Without the flags, the CLI offers PowerShell beside Git Bash only when asked. |

With the terminal switch off, the launch keeps `--disallowed-tools` with Bash and
PowerShell and does not ask for PowerShell.

The cached flags also bring back Monitor (a standing background watcher) and
PushNotification (a mobile push to the user's Claude app, unless that is off in
the CLI's /config). 3.x agents had both. As in 3.x, only top-level agents are
allowed Monitor and TaskStop up front (`--allowedTools`), following the user's
ruling that standing listeners are for top-level agents. Other agents see the
tool but cannot get approval for it. PushNotification is not denied, as in 3.x
(coordinator 2026-10-08 19:26Z).

Every lane (Claude, Codex, Antigravity) also gets `ORGTREE_NODE`, the agent's
name, beside `ORGTREE_AGENT`. 3.x set it, and hooks and tools that run inside an
agent's CLI use it to tell an orgtree agent. The mail hub's SessionStart hook
(`claude-orgtree/hub/session-start.sh`) exits at once when it is set. Without it,
every 4.0 agent session was told to register on the hub, which agents must not
use.

## How the CLI decides (measured in the binary)

Claude Code 2.1.292 on this machine and 2.1.280 on nick-pc use the same gate:

```js
function cv(){let e=a.CLAUDE_CODE_USE_POWERSHELL_TOOL;if(M()!=="windows")return e===!0;
  if(e!==void 0)return e;if(wz()===null)return!0;return x("tengu_cobalt_ridge",!1)}
```

The environment variable wins when it is set. Without Git Bash, PowerShell is
on. Otherwise the flag `tengu_cobalt_ridge` decides, and it defaults to off. The
flags are fetched only when telemetry is on. Telemetry counts as off under
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY` or `DO_NOT_TRACK`.
With telemetry off, only `CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF` lets the
CLI read the cached copy, and only on the first-party API. Both machines cache
`tengu_cobalt_ridge: true` for their accounts. So 3.x agents had PowerShell and
4.0.0/4.0.1 agents did not.

The three orgtree tools the same report named (`orgtree_preview`,
`orgtree_reservation`, `orgtree_self_relaunch`) were removed by the user's
decision (PLAN §P, decision 27). A session that began on 3.x does not get them
back.

## Proof

- Rig: `node tools/rig/rig.mjs run tools/rig/proofs/cli-environment.mjs`. The fake
  CLI models the gate above, and the rig home caches the flag as on. It reports
  each launch's tool list and these variables in its `start` log line.
- Real CLI: `tools/measure_cli_tools.py` starts claude.exe per environment and
  reads the tool list from the init event, cutting the request before the model
  answers. Measured on 2.1.292, 2026-10-08:
  - 4.0.1's environment: 28 tools, Bash only, and the hub hook's registration
    instructions injected.
  - The fixed environment: 31 tools, adding PowerShell, Monitor and
    PushNotification, and the hook stands down.
  - The cached flags alone, without asking for PowerShell: the same 31.
