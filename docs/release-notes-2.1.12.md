# Orgtree 2.1.12

Sol and Luna are again one tier each. GPT-6 is the default model version for
both, while GPT-5.6 remains selectable in each agent's model-version menu.
GPT-6 no longer appears as an additional tier in the hire or switch menus.
The managed Codex CLI pin is updated to 0.155.1, the version observed on this
host with GPT-6 available.

Existing agents on the short-lived `gpt-6-sol` and `gpt-6-luna` tier IDs are
folded into the Sol and Luna tiers with version 6 selected. Their names,
accounts, grants and provider sessions are retained. Agents explicitly pinned
to version 5.6 keep that choice; unpinned agents follow the new GPT-6 default.
The Sol and Luna seats remain two and 0.1 credits respectively. Existing custom
Sol/Luna tier prices remain unchanged; a separately customized GPT-6 alias
price cannot survive the consolidation into one shared tier price.

Turn accounting uses the selected model's API rates, including when an agent
selects GPT-5.6. GPT-6 Luna uses the direct plan route; the reserve preference
and reserve fallback apply only to GPT-5.6 Luna because the reserve service's
GPT-6 support has not been established. This stable patch contains no private
v3 prototype work and does not change the installed application's data until
the user updates it.
