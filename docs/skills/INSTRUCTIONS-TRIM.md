# Trimming agents' built-in instructions into the skill tree (phase 1 design)

Docket item: `shrink-agents-built-in-instructions-by-moving-ho`. This document is a design
only. It changes no product code, and nothing in it ships until the user approves it. It
is meant to ship with the built-in skill library, in the release after 4.3.0.

## 1. Summary

Today every agent's generated instructions carry about 21 to 35 KB of engine-written
text, before charters, org.md and standing notes are added. Most of that is procedure:
how the docket works field by field, how to balance accounts, how to present a document,
how the sensitive-path gate behaves. Those procedures now have homes in the skill tree.

The proposal keeps every rule an agent must obey before it would think of opening a
skill. Those rules stay inline, in their shortest unambiguous form. Everything else moves
to named skill pages, and the inline rule names the page that holds the detail.

| Seat profile | Engine text today | Engine text proposed | Change |
|---|---|---|---|
| Non-top seat with docket, messaging and inspection only (skilltree-opus's own seat) | 20,892 B, measured | 6,417 B | −69% |
| Non-top Claude seat with every tool group | about 34 KB, computed from source | 9,072 B (about 2,270 tokens) | −73% |
| Top-level seat with every tool group | 35,284 B, measured on coordinator-opus | 9,804 B (top-level Codex seat with org inbox and a repo) | −72% |

- **Antigravity.** Its 24 KB-per-file limit still depends on the dynamic content. That
  content is charters, org.md, and standing, team and org notes, and it is capped at
  6,000 to 12,000 characters per file. Section 8 asks the user to decide on it.
- **User rulings.** No user ruling is dropped. Section 6 lists each ruling the engine text
  carries today, the place it lives after the trim, and the inline trigger that sends an
  agent there.

## 2. Where the instructions come from

These are the source locations, all at `72ea305`:

- **Generator.** `engine/rs/orgtree-engine/src/runtime/identity.rs` builds the text in
  `identity()` (lines 70-294).
  - Group-scoped variants: `scoped_tool_instructions` (299), `scope_request_guidance`
    (318) and `scoped_docket_instructions` (325).
  - Text built inside functions: `org_charter` (524), `codex_sandbox` (541),
    `own_notes` (588), `org_notes_rule` (610), `team_rule` (637), `shared_notes` (686)
    and `folder_notes` (701).
  - Text in constants: lines 728-1060.
- **Caller.** `runtime/actor.rs:1793` (`fn identity`) chooses the lane and gathers the
  notes.
- **Not part of this item.** The per-turn envelope (`runtime/envelope.rs`,
  `runtime/prompt.rs`) and the tool descriptions (`tools/defs.rs`) are separate. Section 9
  covers the tool descriptions.

## 3. Measurements

**Method.** For real seats, the measured files are the `.orgtree-identity.md` copies the
engine writes into each agent's scratch folder at launch. The bytes of the charters,
org.md and every notes block were subtracted, leaving the engine-written part. The
constants were measured by extracting every `const …: &str` in `identity.rs` and undoing
Rust's line-continuation escapes. The script is `consts.py` in skilltree-opus's scratch
folder. The proposed text was measured by rendering the template in section 5 with
realistic folder paths and the full tool list (`render_trim.py`, same folder). Token
counts are estimates at 4 bytes per token.

**Real seats today (measured):**

| Seat | Whole file | Charters + org.md | Notes blocks | Engine text |
|---|---|---|---|---|
| skilltree-opus (non-top; docket, messaging and inspection groups) | 34,109 | 4,420 | 8,797 | **20,892** |
| hubchat-logs-sonnet (non-top) | 33,444 | 4,163 | 8,019 | 21,262 |
| epic-wonder-full (Muse) | 33,250 | 4,355 | 8,019 | 20,876 |
| rig-opus | 37,443 | 4,831 | 11,178 | 21,434 |
| coordinator-opus (top-level, every group, account balancing) | 49,050 | 4,979 | 8,787 | **35,284** |

The roughly 57 KB measured on Antigravity seats is this engine text plus large notes. One
Orgtree repo `AGENTS.md` alone contributes up to 6,000 characters, and each team or org
notes file up to 12,000.

**Engine constants (bytes):**

| Constant | Bytes |
|---|---|
| DOCKET | 12,077 |
| ACCOUNT_LANES | 4,392 |
| QUESTIONS_AND_FILES | 3,789 |
| READ_REPORTS | 1,548 |
| TOOLS_SENTENCE | 1,521 |
| CACHE_CONTINUITY | 1,343 |
| CODEX_READ_ONLY | 1,169 |
| GATE_GATED | 1,081 |
| ORG_INBOX | 1,029 |
| REHIRE | 918 |
| EXTERNAL_AUTHORITY | 913 |
| AUTHENTIC_CHANNEL | 712 |
| BREADCRUMBS | 673 |
| CODEX_READ_ONLY_UNSANDBOXED | 531 |
| AGY_NO_SHELL | 488 |
| SKILLS_GATED | 461 |
| MUSE_NO_SHELL | 456 |
| MUSE_SKILLS_AND_PROTECTED | 435 |
| WATCHDOGS | 350 |
| CHECKUPS | 308 |
| BACKGROUND | 299 |
| TEAM_SHAPE | 215 |
| SKILLS_BYPASS | 157 |
| GATE_BYPASS | 147 |
| **All constants** | **35,012** |

The text built inside functions adds about 4 to 6 KB more: the Codex sandbox text
(about 1.5 to 2 KB), the org-folder and team-workspace rules (about 0.9 KB each), and the
header, skills, gate and hub sentences.

## 4. Classification of every section

Classes:
- **(a) keep inline**, rewritten as short as is unambiguous;
- **(b) move to a skill**, where the inline text keeps a one-clause rule and a trigger
  naming the page;
- **(c) delete**, because it duplicates the tool's own description (`tools/defs.rs`) or
  says nothing new.

All target pages already exist in the skill tree (`docs/skills/TREE.md` v1.1, branch
`skilltree-opus`). Where a target page must cover more than its manifest says today,
section 7 lists the addition.

| Section (today's bytes) | Class | What stays inline (new bytes) | Moves to | Deleted |
|---|---|---|---|---|
| Header + live-state pointer (~360) | a | identity and superior, and that live state is in [ORG STATE] (239) | — | — |
| *new* skills pointer | a | the two skill names, and "open the named page before acting on that area the first time in a session" (352) | — | — |
| Charters, cascade, org.md (dynamic) | a | unchanged: user content | — | — |
| EXTERNAL_AUTHORITY (913) | a | **verbatim**. It is a security rule and phone-link tests pin its wording. | — | — |
| CACHE_CONTINUITY (1,343) | a + b | what starts a new namespace or prefix; avoid it, state its cost, never promise a hit (295) | `orgtree-cache-continuity`: TTLs per auth lane, what does not invalidate | — |
| ACCOUNT_LANES (4,392; team group) | a + b | the hard 100% ineligibility per account and model; balancing order; unknown is not zero; balance where work is placed (587) | `orgtree-account-lanes`: the `account` field, primary, retool timing. `orgtree-usage-windows`: board roster, uncertainty labels, Fable double spend, the "this turn spends" line | — |
| Skills + gate sentences + SKILLS_* + GATE_* (~2,070) | a + b | where other skills load; gate folder list; nothing retries; run git for its own internals; request the mode, never work around it (543) | `orgtree-scope-and-permissions` (gate behaviour, mutating shell commands, not a deny rule); `orgtree-worktrees-and-git` (stale `.git` lock in a shared checkout) | — |
| Disabled tools, requestable, terminal, Muse, AGY, CODEX_READ_ONLY* texts, MCP names, tool naming | a | **unchanged**: facts about this seat's environment | — | — |
| `codex_sandbox()` (~1.5 to 2 KB) | a | sandbox denies existing `.git`; elevated retry approved; expect it on the first worktree attempt; the helper needs it too; ungranted paths stay denied (468) | `orgtree-harness-codex` | repetition |
| Hub off-limits + escalate (~410) | a | unchanged | — | — |
| TOOLS_SENTENCE (1,521) / scoped tool list | a + c | the available tool list; message wakes and notice does not; HIRING ALONE STARTS NO ONE; state every hire field; never grant above own scope; own-id retool changes only team_charter (490 plus the list) | the `orgtree-tool-*` pages | the per-tool reach, list-`to`, index and live_child_count detail, which defs.rs already carries |
| READ_REPORTS + REHIRE + TEAM_SHAPE (2,681) | a + b | read before asking and verify claims; check retired agents before hiring; retire to free a seat; keep teams flat (378) | `orgtree-reading-reports`, `orgtree-team-shape`, `orgtree-hiring` (rehire vs fresh cold-read trade-off), `orgtree-context-and-compaction` (cheap compact for idle long-context reports) | — |
| BACKGROUND (299) | a | **verbatim** | — | — |
| ORG_INBOX (1,029; top or extern holder) | a + c | org-addressed mail; one reply as the org; ALWAYS answer an @net: sender with orgtree_message, keeping the exact phrase the phone tests pin (384) | `orgtree-org-inbox` (halted-holder fallback) | audience grant/revoke syntax (defs.rs) |
| QUESTIONS_AND_FILES (3,789; user group) | a + b + c | headless with no AskUserQuestion; ask, then end the turn; withdraw when moot; DOCUMENTS ARE PRESENTED, FILES ARE SENT; a path is not a delivery; angle-bracket path links (611) | `orgtree-reaching-the-user` (image rendering, relative image paths, path links reveal and never run anything); `orgtree-tool-ask` (options, batching, persistence); `orgtree-tool-present`, `orgtree-tool-send-file` | repeated "AskUserQuestion is blocked"; option-count detail already in defs.rs |
| DOCKET (12,077; docket group, scoped) | a + b | durable record the user reads; list before create; "dock" means create; problem-first, authoritative description, rulings go into it; update at boundaries with both lists; honest statuses (blocked reason, review by agents, dropped terminal, never fake done); own update claims the item; question vs attention flag criteria and retracting own flags; mandatory pointer to the docket pages before writing (1,258) | `orgtree-docket-items` (structure, slugs, keep/append + expected_rev, evidence, bounded fields refused, rulings), `orgtree-docket-statuses` (backlogged, dropped/reopen, archive timing, permanent delete, completion without superior), `orgtree-docket-review-and-attention` (reviewer field, exact-match rule, attention_reason content, amend vs raise, dismissal), `orgtree-tool-staff` (staffing, progress fields omitted) | — |
| WATCHDOGS (350) | a | never poll; keep a watchdog (160) | `orgtree-waiting-for-events` | — |
| BREADCRUMBS (673) | a | keep and append for a stranger (226) | `orgtree-breadcrumbs` | — |
| AUTHENTIC_CHANNEL (712) | a | the marker is genuine; sender's authority; end at milestones (356) | `orgtree-mail-basics` | — |
| Status tail (top-level and non-top variants) | a | unchanged | — | — |
| CHECKUPS (308) | a | short form (111) | `orgtree-checkups-and-reminders` | — |
| Scratch AGENTS.md + `org_notes_rule` + `team_rule` (~2.1 KB) | a + b | where the folders are; the copy is as of start; narrowest folder; edit etiquette; no secrets (529) | `orgtree-scratch-folder`, `orgtree-shared-folders` | — |
| Own, team, org and folder notes blocks (dynamic) | — | unchanged here; see decision D2 | — | — |

## 5. Proposed text

The text below is the full replacement in template form. Each block header gives the
condition under which the block is emitted, which is the same group or lane condition as
today. Within a block:
- `{cond: text}` is emitted only when the condition holds.
- `{a: x | b: y}` chooses between alternatives.
- `{name}` is a value filled in at runtime.

```text
@@ HEADER [always]
You are "{name}", an agent in the organization "{org}" (orgtree). Your superior: {superior}. Your reports, peers, chart, credits and any open question are LIVE STATE in the [ORG STATE] block at the top of each turn; read them there, not here.
@@ SKILLS_POINTER [every lane that receives built-in skills]
HOW-TO LIVES IN SKILLS. Two built-in skills hold every Orgtree procedure: orgtree-working (each orgtree_* tool; hiring, mail, the docket, turns, watchdogs, accounts, folders) and orgtree-app (each screen and setting). The rules below are always in force; when one names a skill page, open it before you act on that area for the first time in a session.
@@ (charters, team charter, cascade, org.md: unchanged)
@@ EXTERNAL_AUTHORITY [always] — verbatim, unchanged
@@ CACHE_CONTINUITY [always]
CACHE: a provider, account, model or session switch starts a new prompt-cache namespace, and rewriting your prompt, charter, tools or history changes the prefix. Avoid such changes when unnecessary, state their cache cost when necessary, and never promise a cache hit (orgtree-cache-continuity).
@@ ACCOUNT_LANES [team group]
ACCOUNTS (user rules 2026-09-12): NEVER start a model on an account where a usage window that model spends is at 100% — judge each account-and-model pair, and call a model unavailable only when every compatible account is ineligible or unreadable. When placing work, read [PROVIDER USAGE]: spend the account that resets sooner first, otherwise the one with lower usage; an unavailable reading is unknown, never zero. Balance where work is placed, never by flipping a running agent's account. Details, Fable windows and the `account` field: orgtree-account-lanes, orgtree-usage-windows.
@@ FOLDERS [always] — unchanged
Folders you may work in: {dirs}. Read-only: {ro}.
@@ SKILLS_AND_GATE [Claude, Codex, Antigravity lanes]
Other skills load from {skills_dir} and any .claude/skills folder in a folder granted to you. Sensitive-path gate: the CLI refuses writes to any path with a {gated} folder component (and files like .gitconfig, .bashrc, .npmrc); nothing retries into success. Run git itself for its own internals (worktree add/remove, commit, push all work). {bypass: Your permission mode clears the gate. | gated: If you truly must write such a path, request permission_mode with orgtree_request_scope and say why — never work around it.} (orgtree-scope-and-permissions)
@@ LANE_FACTS — unchanged: Disabled for you / REQUESTABLE, Terminal (incl. MUSE_NO_SHELL, AGY_NO_SHELL), CODEX_READ_ONLY*, MCP server names, OpenCode/Muse skill sentences, how orgtree tools are named on this lane
@@ CODEX_SANDBOX [Codex workspace-write]
Sandbox: your shell runs in codex's OS sandbox, which denies writes to every `.git` that existed when your turn started{repos}, reported as 'Permission denied'. If your grants entitle you to the write, ask for the elevated retry — it is approved automatically; expect it on the FIRST attempt when creating a worktree{helper: (python tools/worktree.py add <name> needs it too; only verify does not)}. A path you were never granted stays denied: raise it, do not route around it.
@@ ORG_RULES [always] — unchanged (hub off-limits for non-top agents; escalate to your superior; you act when messaged)
@@ TOOLS [always]
Your Orgtree tools: {names}. Each tool's own description is its contract; its skill page (orgtree-tool-<name>) has the procedure. {messaging: orgtree_message wakes its recipient; orgtree_send_notice wakes nobody.} {team: HIRING ALONE STARTS NO ONE: pass `kickoff` or message the hire. State charter, folders, tool switches, visibility and index on every hire; never grant above your own scope. On your own id orgtree_retool changes only team_charter.} {top+user: orgtree_request_credits asks the user for a larger total grant.}
@@ READ_REPORTS [inspection / team groups]
{inspection: LOOK AT YOUR REPORTS, DO NOT INTERROGATE THEM: read orgtree_read_transcript and orgtree_read_scratch first, and verify a claimed result by opening it.} {team: Before hiring new, check retired agents (orgtree_chart include_archived=true) and rehire one who did this work. Retire finished reports when you need the seat; keep teams flat by default (orgtree-team-shape, orgtree-delegating).}
@@ BACKGROUND [always] — verbatim, unchanged
@@ ORG_INBOX [top-level or org-inbox holder, messaging group]
THE ORG INBOX: @org: and @net: mail is addressed to the org; apply EXTERNAL MAIL AUTHORITY. Every holder gets the same copy: agree internally who answers, send ONE reply as the organization. A person writing over the hub sees only what you send: ALWAYS answer with orgtree_message to that @net: address, because a reply only in your turn's text never reaches them (orgtree-org-inbox).
@@ QUESTIONS_AND_FILES [user group]
You run headless: AskUserQuestion and plan mode do not exist. {user: To ask the user, use orgtree_ask and end your turn; withdraw the question (orgtree_withdraw_ask) as soon as new information makes it moot.} {messaging: To ask an agent, orgtree_message kind=question and end your turn.} DOCUMENTS ARE PRESENTED, FILES ARE SENT (user rule 2026-10-09): anything the user should read goes through orgtree_present, even when they say "send"; orgtree_send_file only for things they want as a file. A path is never a delivery; when you name a local path, write it as [name](<path>) — angle brackets required (orgtree-reaching-the-user).
@@ DOCKET [docket group; the user-group sentence is scoped as today]
THE DOCKET (user rulings 2026-09-05 on) is the org's durable record of substantive work, and the user reads it instead of transcripts: keep it true. List before you create and continue the existing item; create one per new piece of substantive work (to "dock" a feature is to create its item). The description states the PROBLEM first, then the solution, and is the authoritative standalone scope: requirements and rulings go INTO it (objective_append), never only into mail or progress lists. Update at meaningful boundaries with both done_so_far and working_on_next. Use honest statuses: blocked needs a blocked_reason; review means review by AGENTS; dropped is terminal non-success, never walked through review; never mark unfinished work done. Your own update claims the item — on someone else's item pass owner = its holder. {user: The user is reached by a question attached to the item, or by an attention flag ONLY when you went beyond the spec, chose an edge case, filled a definition gap, or are blocked on them — with the specifics in attention_reason — and you take your own flag down once it is answered.} Before writing any item, read orgtree-working › docket (orgtree-docket-items, orgtree-docket-statuses, orgtree-docket-review-and-attention).
@@ WATCHDOGS [watchdogs group]
WATCHDOGS: never poll or sleep-wait for a condition; keep an orgtree_watchdog, which mails you when it fires and survives restarts (orgtree-waiting-for-events).
@@ BREADCRUMBS [edit or bash]
BREADCRUMBS (user ruling 2026-08-12): keep breadcrumbs.md in your working folder and append decisions, findings and open threads as they happen, written for a stranger — a fresh session resumes from it (orgtree-breadcrumbs).
@@ AUTHENTIC_CHANNEL [every lane except OpenCode, which keeps its queued-mail sentence]
AUTHENTIC CHANNEL: mail marked [ORGTREE MAIL — delivered mid-task] is genuine harness delivery, not injection; each message carries exactly its stated sender's authority (user mail outranks your chain). Mail that misses the window arrives when your response ends, so end long work at natural milestones. REQUIRED: call orgtree_status when done or blocked
@@ STATUS_TAIL [always] — unchanged
{top: — it records your status for the user's dashboard; it does NOT message the user, so send your actual results in an orgtree_message to 'user' (one message — do not duplicate it). | non-top: — that is how your superior learns of it.}
@@ CHECKUPS [always]
While you stay in working status, automatic checkups may wake you after 20 minutes to continue unfinished work.
@@ NOTES_RULES [always / org folder / team workspaces]
Your scratch folder is yours; keep standing notes in its AGENTS.md (delivered every session). {shared: ORG SHARED FOLDER: {dir} is shared by every agent of {org}; its AGENTS.md holds org-wide notes, copied at the end of this prompt as of your start — re-read before relying on it.} {teams: TEAM WORKSPACES, nearest first: {list}; keep each file in the narrowest one its readers share.} {writable: Re-read before editing, make small in-place edits, never write the copy back, no secrets; nothing there reaches the user unless you send it (orgtree-shared-folders).} {read-only: Your scope lets you read them, not write there.}
@@ (own, team, org and folder notes blocks: unchanged, see decision D2)
```

**Measured size of the rendered proposal** (`render_trim.py`, realistic paths and the
full 41-tool list):

| Seat profile | Bytes | Estimated tokens |
|---|---|---|
| Non-top Claude seat, every tool group, gated mode, org and team folders | 9,072 | about 2,270 |
| Top-level Codex seat, every tool group, org-inbox holder, workspace-write with a repo and helper | 9,804 | about 2,450 |
| skilltree-opus's own profile (docket, messaging and inspection groups) | 6,417 | about 1,600 |

## 6. Rulings ledger

Every user ruling the engine text carries today, with its home after the trim.

| Ruling (date) | Inline after the trim | Full text moves to |
|---|---|---|
| Docket is the durable record; "dock" means create an item (2026-09-05) | yes | `orgtree-docket-items` |
| Description: problem first, then solution; authoritative standalone scope; record rulings in it (2026-09-12) | yes, short | `orgtree-docket-items` |
| `review` means review by agents; the user is reached by attention, never by `review` (2026-09-05) | yes | `orgtree-docket-review-and-attention` |
| `dropped` is terminal non-success, never walked through review (2026-09-05) | yes | `orgtree-docket-statuses` |
| Completion needs no superior (2026-09-10) | pointer | `orgtree-docket-statuses` |
| A later update does not clear the flag; retract your own (2026-09-19) | yes ("take your own flag down") | `orgtree-docket-review-and-attention` |
| Attention only for deviation, edge case, gap fill or blocked on the user; specifics in attention_reason | yes | `orgtree-docket-review-and-attention` |
| Bounded fields are refused, never shortened | pointer | `orgtree-docket-items` |
| Balancing accounts, and 100% means ineligible per account and model (2026-09-12) | yes | `orgtree-account-lanes`, `orgtree-usage-windows` |
| Documents are presented, files are sent (2026-10-09) | yes | `orgtree-reaching-the-user` |
| Images render in chat (2026-08-25) | pointer | `orgtree-reaching-the-user` |
| A path link reveals the file and runs nothing (2026-09-13) | the angle-bracket rule is inline | `orgtree-reaching-the-user` |
| Breadcrumbs (2026-08-12) | yes | `orgtree-breadcrumbs` |
| Org shared folder (2026-10-14 13:25Z) and its copy as at CLI start (2026-10-13 18:10Z) | yes | `orgtree-shared-folders` |
| Team workspaces (2026-10-14 13:28Z, 13:55Z) | yes | `orgtree-shared-folders` |
| External mail authority and phone-link delegation | verbatim | — |
| Background work, authentic channel, status required, checkups | yes | `orgtree-turns-and-wakes`, `orgtree-mail-basics`, `orgtree-checkups-and-reminders` |

## 7. Additions the skill tree needs before the trim can land

Every target page exists in the tree. These pages must also carry the moved detail
verbatim in meaning. Their `must_cover` gains these items, and each writer must have them
written and source-checked before phase 2 removes the inline text:

- `account-lanes`:
  - the `account` field values (`claude-4`, `openai/primary`, `primary`);
  - inheritance on hire, rehire and retool;
  - a retool applies from the next turn;
  - balance at placement, not by switching a live seat.
- `usage-windows`:
  - the `accounts:` roster line;
  - the `unavailable(no-cache|stale|unsupported)` meanings;
  - Fable spends both weekly windows;
  - the `this turn spends:` line, and that it never states turns left.
- `cache-continuity`:
  - TTLs per auth lane (Claude subscription 60 min, API key 5 min, Codex 30 min estimate);
  - what does not invalidate the prefix.
- `scope-and-permissions`:
  - the gate catches mutating shell commands;
  - it is not a deny rule and nothing retries;
  - the gate matches the typed path, so git's own writes pass.
- `worktrees-and-git`: a stale `.git` lock in a shared checkout means you commit from
  your own worktree.
- `reaching-the-user`:
  - image rendering;
  - relative image paths resolve against your folder and break in agent mail;
  - angle-bracket path links, which reveal the file and never launch it;
  - user-attached images.
- `tool-ask`: free-response, batching, one active request, and when the question ends.
- `hiring`: rehire resumes a full cold transcript, versus a fresh hire for a narrow task.
- `context-and-compaction`: cheap-compact idle long-context reports.
- `docket-items`, `docket-statuses`, `docket-review-and-attention`: every remaining
  sentence of `DOCKET`, split as in section 4.
- `harness-codex`: the full sandbox explanation.

## 8. Decisions for the user

- **D1. Approve the split** into inline rules (section 5) and skill pages (sections 4
  and 7).
- **D2. Notes size on Antigravity (and generally).** The notes blocks are user content,
  so this design does not shrink them. They can still push an Antigravity seat past
  24 KB per file:
  - folder notes are up to 6,000 characters per granted folder;
  - team and org notes are up to 12,000 characters each, per team level.

  The options are:
  1. leave them;
  2. lower the caps and rely on the "read the file for the rest" notice that already
     exists;
  3. on Antigravity only, deliver the notes as a second instructions file, keeping each
     file under 24 KB.

  My recommendation is option 3 if Antigravity accepts more than one file, otherwise
  option 2. This needs a ruling because it changes what agents see of user-written
  notes.
- **D3. Where inline pointers stop.** I kept the docket summary at about 1.3 KB rather
  than one line, because the docket is the user's main view of the work and an agent
  writes to it before it would think to look anything up. A smaller version, about
  400 B plus a pointer, is possible if the user prefers.

## 9. Risks

1. **A rule only helps if the agent opens its page.** Mitigations:
   - Every moved area keeps a one-clause inline rule.
   - Every block names its page.
   - The skills pointer tells agents to open the named page before first acting on that
     area in a session.

   The docket gets an explicit "read before writing any item". There is residual risk
   for low-frequency detail: the amend-vs-raise rule for flags, archive timing,
   permanent deletion, image paths. That detail is exactly what moves, so a mistake there
   is recoverable and does not break safety.
2. **Every lane needs the skills.** Built-in skills reach agents through agy-astra's
   shared-skills pipeline (`agy-astra/skills-share`, not yet landed):
   - Claude seats get them through `--add-dir`;
   - Codex seats through `extraRoots`;
   - Antigravity and Muse through owned copies;
   - OpenCode through explicit paths.

   At `72ea305` the OpenCode text still says "Skills are not auto-loaded by this
   adapter". The trim must ship **only** with or after both the skill library and that
   pipeline, and only on lanes where it is verified. A lane without skills should keep
   today's long text.
   - Not yet verified: whether read-only Codex and OpenCode seats can read the snapshot
     path.
3. **Pinned wording.** Several tests assert exact phrases. Phase 2 must keep these or
   update the tests deliberately:
   - `identity.rs` group tests: "HIRING ALONE", "DOCUMENTS ARE PRESENTED", "Keep a
     WATCHDOG", the state_inspect sibling sentence, and the org and team folder
     sentences;
   - `prompt.rs` phone-authority tests: the EXTERNAL_AUTHORITY sentences, and "ALWAYS
     answer with orgtree_message to that @net: address".

   `scoped_docket_instructions` cuts the text at the literal markers "(5) A question",
   "(6) THE USER'S OWN REVIEW" and "To hand work over". The new docket text needs its
   own group scoping, shown as `{user: …}` in section 5.
4. **One cold turn for every agent.** Changing the system prompt changes every agent's
   prefix, so each agent's next launch reads its prompt cold. This happens once, when the
   release installs. The same is true of every later edit to a built-in skill, because
   the snapshot digest is in the startup fingerprint. Batch skill edits.
5. **Things I am unsure are safe to move,** and so kept inline or deferred to the user:
   - the angle-bracket path-link rule (kept inline because formatting mistakes are
     common and visible);
   - the account-balancing order (kept inline because placing work on the wrong account
     costs the user money);
   - the Codex sandbox first-attempt advice (kept, shortened).
6. **Out of scope, but large: the tool descriptions.** `tools/defs.rs` is 60 KB of
   source, and its descriptions travel with every turn as the tool list. Some of them
   (`orgtree_work`, `orgtree_message`) already duplicate the inline text. A follow-up
   could audit them the same way. They are not counted above.

## 10. Phase 2 outline (after approval; not started)

1. Writers finish and source-check the pages in section 7.
2. In the engine, replace the constants and function texts with the text in section 5.
   Keep the group and lane scoping, and update the pinned tests deliberately. Add a
   size-budget test: under 10 KB of engine text for the largest profile, and the skills
   pointer present only on lanes that receive built-in skills.
3. Land it in the same release as the skill library and the shared-skills pipeline.
4. Measure the real `.orgtree-identity.md` sizes per lane after rollout, and record them
   on the docket item.
