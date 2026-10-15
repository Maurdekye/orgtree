---
name: orgtree-tool-org-logo
description: Set or remove your organization's Logo from a permitted local image, with immediate publication and undo history.
---
Up: [orgtree-team](../SKILL.md)

# orgtree_org_logo

Use this tool to change the picture representing your own organization. Requires
the `logo` Orgtree tool group, on by default. An explicit denial on you or any
ancestor disables the tool and also refuses remembered calls. Any enabled agent
may use it, including a subordinate without a user or org-inbox audience. There
is no top-level-only restriction and no org selector: the engine gets your
identity from the calling process.

Changes apply immediately. They are logged with your identity, time and set/remove
action and enter the user's existing durable undo/redo history. Ask for missing
scope through your superior when needed; permission modes or a charter cannot
restore a denied Logo tool. The switch lives in the agent Tools settings and org
hire defaults; see `orgtree-agent-tools-tab` (orgtree-app › agent-settings).

## Set

`action: "set"` requires `path`, an image in your working folder or a folder you
hold. Relative paths start in your working folder. Read-only folder grants work;
this tool reads the source and writes the engine's own picture store. Org/team
shared folders follow their normal position-based grants. URLs are not supported.

Static PNG, JPEG and WebP are accepted, up to **5 MiB** and **16 megapixels**.
Native decoding applies orientation, strips metadata and normalizes to a square
PNG at most **512 × 512** and **256 KiB**. SVG, animation, invalid images and
oversized inputs are refused without changing the Logo or history.

The default crop is the largest centred square. Optional `crop` requires all
three numbers: `x` and `y` in **0..1** are fractions of the available top-left
travel; `size` in **0.1..1** is a fraction of the shorter image side. For example,
`x: 0` selects the leftmost allowed square and `x: 1` the rightmost. Invalid crops
are refused. Your current identity, inherited tool grant and source folder
authority are checked again before the atomic picture/history commit.

```json
{"action":"set","path":"art/logo.png"}
```

```json
{"action":"set","path":"art/logo.png","crop":{"x":0.5,"y":0.5,"size":0.8}}
```

## Remove

```json
{"action":"remove"}
```

Removal takes no path or crop. It publishes a versioned removal and restores the
orange org-colour letter fallback. It does not delete mail or other org history.
Unknown actions or extra fields, including an org identity, are refused.

## Result, publication and undo

Success returns the picture revision, digest, dimensions, byte count, `removed`
and a `history_entry` (id, kind `logo`, label). No image bytes are returned.
The same native storage and hub publisher as the human Logo editor update every
surface. A disconnected or unsupported hub does not make a local edit fail;
enabled supported hubs converge later. Outside-inbox isolation blocks publishing
while retaining the local change for re-enable.

The user undoes/redoes through existing history. Restoration mints a fresh
revision, so a cached remote removal cannot beat it. Several consecutive Logo
undos/redos work. A later independent local or remote edit causes a conflict;
undo refuses that entry and leaves the newer Logo intact. A new recorded action
clears redo and the existing 100-entry bound applies. Undo is a user history
action, not another agent tool.

## See also

- [orgtree-scope-and-permissions](../scope-and-permissions/SKILL.md)
- [orgtree-tool-retool](../tool-retool/SKILL.md)
- [orgtree-shared-folders](../../workspace/shared-folders/SKILL.md)
