## Orgtree 2.0.9

This patch release makes the two actions on a popped-out desk's placeholder card work, keeps a ticket that still needs attention out of the archive, lets a new hire be given a provider account before it starts, and repairs turns that stopped silently part-way through.

- The "Show desk" and "Return here" buttons on the card that stands in for a popped-out desk now work. The click was being taken by the canvas behind the card, so neither button was ever reached.
- "Show desk" now raises and restores the popped-out window itself, including one that had been minimized. Before, it asked the window to take focus, which cannot bring a native window back. The "Show window" action on the same notice in the HUD was dead for the same reason and now works too.
- "Return here" brings the desk back to the slot that was clicked, so when one desk has two possible hosts it returns where it was asked for rather than where it left.
- A ticket that still needs attention stays on the main list instead of being archived out from under its own badge. The attention count could point at a row the list no longer held, and the only way to reach it was to open the archive and hunt for it.
- Attention now outranks every status and outranks the list a row physically sits in, so a ticket stranded while that was broken reads as unarchived and is served again straight away; when its attention clears it is already where it belongs.
- Asking to archive such a ticket now refuses and says why, instead of answering that it was already archived.
- Deleting a ticket still removes the row and its count in one act; that is now pinned by a test, so a later change to archiving cannot quietly change what deleting does.
- A new hire can be given a provider account before it has started. Hire Defaults lists the accounts registered for the selected tier's provider, pre-fills the organization's default when the provider matches, and allows an explicit unbound choice that uses the machine default.
- A turn that stopped silently is fixed at its source. An agent could stop producing output after a completed tool call once its diagnostic output filled a pipe nobody was reading; the turn then never finished, interrupting it reported success without doing anything, and retiring it warned that settlement had not completed.
- The engine now reads a turn's diagnostic output as it arrives, can stop waiting when the process is gone, and ends the whole process tree rather than only the launcher that started it — so a turn can no longer be left alive holding its pipes open.
- Interrupting a turn whose process is already known to have exited now reports that honestly instead of reporting success.
