# Orgtree 4.5.8

Orgtree 4.5.8 renames the org inbox to the org mailbox, lets a custom app's panel read video pixels from the app's media route, and delivers changed standing instructions to long-running Claude agents. It still bundles Mail hub 2.4.0.

## The org mailbox

- **The org inbox is now the org mailbox, everywhere you or an agent read it.** The canvas tile and its labels, the desk and window titles, the settings group and its option (**Closed off mailbox**), tooltips, toasts, empty states, the tool descriptions and Guides, the prompts and notices agents receive, and the built-in help and glossary all say "org mailbox". Only the name changed; the feature behaves as before.
- **Old names still work where a name is typed.** `orgtree_audience` accepts `org-mailbox` and `org_mailbox` in addition to `org-inbox`, `org_inbox` and `extern`. Internal identifiers keep their old spelling so nothing stored or scripted breaks: the database table and settings keys, the `orgtree_inbox` tool and its `org_inbox=true` argument, and the `@org-inbox` upload folder. Hubchat's own wording is unchanged.

## Apps

- **A custom app's panel can read video pixels.** An app's media link answered without the header a browser needs before it lets a page draw a `crossOrigin` video onto a canvas, so the video app's colour bar failed (media error 4) and fell back to reading the file in small chunks, about an hour for a 300 MB cut. The media route now answers the app's sandboxed panel (whose origin the browser reports as `null`) with an allow-origin header for that origin only, on normal, range and out-of-range responses. Any other origin gets no allow-origin header, the link's ticket stays the only credential, and authorization is unchanged.

## Agents

- **Changed standing instructions now reach long-running Claude agents.** A Claude agent keeps the system prompt it started its session with; Claude Code restores that copy whenever the session resumes, so an edit to the instructions for all orgs (including the Connect your phone note), to org.md, to an agent's charter or team charter, to its folders' AGENTS.md files, or a change to the rule text in a new Orgtree version never reached an agent whose session was older than the change. The agent now receives the changed text on its next turn, as one block that lists only the sections that changed, gives their full current text and says it supersedes the earlier text. Text that did not change adds nothing, and a second turn adds nothing.
- **Cache cost:** a text-only change no longer restarts an agent's Claude CLI, so it causes no prompt cache rebuild; the changed text is one extra block on that agent's next turn. The first turn after you update to this version delivers every section once to each Claude agent whose session started before it, because the engine has no record of what those sessions were started with. That one-time block is about the size of the agent's whole system prompt (typically tens of thousands of characters), and it is what repairs agents that were holding outdated text. A change to anything else (tools, folders, model, account) restarts the CLI as before.

## Untested

- The org mailbox rename was checked by automated tests and by muted captures of the canvas tile, the desk and the settings group in a test session, not by using every screen in a live organization.
- The media fix has been tested by automated tests of the route's headers, not by the video app loading a real 300 MB cut.
- Delivery to a resumed session has been tested by automated tests of the section comparison, not by watching a live Claude agent act on the block.
- Codex, Muse and Antigravity agents are unchanged: Orgtree passes them fresh instructions at every launch, but it has not measured whether those tools apply them when a session resumes.

## Notes

- There are no database changes and no installer changes in this release.
- Windows builds remain unsigned. macOS and Linux builds remain prototypes. Downloads include `SHA256SUMS.txt`.
