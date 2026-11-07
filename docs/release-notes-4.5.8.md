# Orgtree 4.5.8

## Agents

- **Changed standing instructions now reach long-running Claude agents.** A Claude agent keeps the system prompt it started its session with; Claude Code restores that copy whenever the session resumes, so an edit to the instructions for all orgs (including the Connect your phone note), to org.md, to an agent's charter or team charter, to its folders' AGENTS.md files, or a change to the rule text in a new Orgtree version never reached an agent whose session was older than the change. The agent now receives the changed text on its next turn, as one block that lists only the sections that changed, gives their full current text and says it supersedes the earlier text. Text that did not change adds nothing, and a second turn adds nothing.
- **Cache cost:** a text-only change no longer restarts an agent's Claude CLI, so it causes no prompt cache rebuild; the changed text is one extra block on that agent's next turn. The first turn after you update to this version delivers every section once to each Claude agent whose session started before it, because the engine has no record of what those sessions were started with. A change to anything else (tools, folders, model, account) restarts the CLI as before.

## Untested

- Delivery to a resumed session has been tested by automated tests of the section comparison, not by watching a live Claude agent act on the block.
- Codex, Muse and Antigravity agents are unchanged: Orgtree passes them fresh instructions at every launch, but it has not measured whether those tools apply them when a session resumes.
