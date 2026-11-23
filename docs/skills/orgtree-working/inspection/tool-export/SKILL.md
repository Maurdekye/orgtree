---
name: orgtree-tool-export
description: Export yourself or a node below you, alone or with everything under it, as one zip file that another organization can import.
---
Up: [orgtree-inspection](../SKILL.md)

# orgtree_export

Requires `inspection`. Writes one zip that holds a node whole: its settings and charters, its credits (seat and grant), its scratch folder, its transcript with every earlier row, its CLI session files, the definitions of its watchdogs, the docket items it owns and the documents it presented. With `subtree: true` the file holds the node and every live node under it, through projects, and the team folder of each. Nothing in the organization changes and nobody is interrupted: an agent that is mid-turn is exported as far as it had got.

Use it to hand a finished agent or a whole team to another organization (attach the file to mail with [orgtree_message](../../mail/tool-message/SKILL.md)), or to keep a copy before a risky change. To copy a node inside this organization use [orgtree_duplicate](../../team/tool-duplicate/SKILL.md): it needs no file. To read one file or a few rows, use [read_scratch](../tool-read-scratch/SKILL.md) or [read_transcript](../tool-read-transcript/SKILL.md).

| Parameter | Meaning |
|---|---|
| `node` | Yourself (the default) or a node below you. A peer, your superior or an unrelated node is refused: "you can only export yourself and the nodes below you". |
| `subtree` | `true` takes everything under the node too. Default `false`: the node alone; its reports and its team folder stay. |
| `include` | `{scratch, team, transcript, native_sessions, retired}`, each `true` or `false`. All default `true` except `retired`: retired nodes under the root are left out unless you ask for them. Leave a part out to make a smaller file. |
| `path` | The `.zip` to write: relative to your working folder or absolute, in a folder you hold. Default: `.orgtree-exports/<node>[-team]-<time>.orgtree.zip` in your working folder. A file that is already there is refused. |
| `job` | The id an earlier call returned. Reads that export instead of starting one. |

**Secrets.** Whether detected secrets are taken out follows the app's setting "Strip secrets from exports" (off by default); you cannot change it per call. Either way the result's `secrets` says what was detected (kinds, places, files) and what was taken out. The sealed credentials of MQTT and WebSocket watchdogs never leave in an agent's export: such a watchdog arrives marked as needing its credentials again. Provider keys, sign-ins and the engine's own launch files in a scratch folder are never exported.

**What stays behind.** Files in folders you were granted outside your scratch and team folders; links (they are named in `not_included`, never followed); mail and questions stay in the file as history only; watchdogs owned by a project.

**Size.** At most 256 GiB unpacked. A file larger than the mail hub's limit can still go to another organization of this computer.

**Result.** The call waits about 25 seconds. A finished export returns `state: "done"` with `result.path`, `result.file_bytes`, `result.counts`, `result.secrets` and `result.not_included`. A longer one returns `state: "running"` with `id`: call again with `{"job": "<id>"}`. Every export is recorded in the organization's event log.

A top-level agent and any other agent export the same way; only the user exports from the canvas menu, and only the user's own export can carry sealed watchdog credentials.

```json
{"node":"build-lead","subtree":true,"include":{"native_sessions":false}}
```

This exports `build-lead` and its team without their CLI session files into your `.orgtree-exports` folder.

## See also

- [orgtree-tool-read-scratch](../tool-read-scratch/SKILL.md)
- [orgtree-tool-read-transcript](../tool-read-transcript/SKILL.md)
- [orgtree-visibility](../visibility/SKILL.md)
