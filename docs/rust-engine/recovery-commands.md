# Commands and current work across fresh sessions

The fresh-session export used to read only the ordinary transcript body. Tool
descriptions therefore replaced the Bash/PowerShell inputs already retained
separately in `ot.convo.tool_inputs`. Both the Markdown history and recent digest
now read the retained inputs, preferring already cached native inputs. They keep
8,192 UTF-8 bytes per shell command with a boundary-safe explicit truncation
marker. Array commands stay JSON arrays so their argument boundaries survive.
The visible transcript and on-demand full-input API keep their existing behavior.

Recovery begins with live docket items and their bounded current scope, blocker
reason and declared dependencies. Backlog cannot displace live items at the
30-item cutoff. The last recorded explicit shell directory follows, with its
evidence limits; no checkout or source SHA is invented from prose. The latest
three messages from the agent's current superior follow before earlier status
and conversation. References provide full docket/mail content where excerpts
are insufficient. This is a one-time dynamic snapshot, outside startup identity
and cache fingerprints.

Write any command you'll re-run into breadcrumbs.md or a script file the first
time you run it. Input retention is not proof of command completion. A missing
legacy input, a missing working directory or an unavailable source SHA stays
explicitly unknown. A provider's within-session compaction is controlled by its
CLI; this change covers Orgtree's saved-history and fresh-session recovery paths.

Defaults: coordinator-opus, 2026-10-16, ma67dfed0accb, on docket
`compaction-keeps-the-actual-commands-and-the-rec`; both 4.3.2 and 4.4.0.
