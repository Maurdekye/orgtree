---
name: orgtree-desk-files
description: Explain scratch navigation, text preview and file downloads in the desk Files tab.
---
Up: [orgtree-desk](../SKILL.md)

# Desk Files tab

Files is a live browser of this agent's scratch folder. It is not a general browser over every folder the agent can access.

The “scratch” button returns to the root; folder buttons descend and “up” returns one level. The path label shows the current location. File rows show names and reported sizes, with a download link. Selecting a readable file displays its content in a copyable text preview.

Loading, empty directory and file content are separate states. The browser reads the currently selected path while mounted; a file the agent changes can update. Do not assume a preview is an immutable evidence copy or that downloading a file presents it to the user in Orgtree.

Viewing/downloading does not grant the agent another folder, edit the file or execute it. For scratch ownership, standing notes and retained paths see `orgtree-scratch-folder` (orgtree-working › workspace). If a document should be read in-page, use [Presented](../presentations/SKILL.md) and its document reader instead of treating every scratch file as a presentation.

## See also

- See `orgtree-scratch-folder` (orgtree-working › workspace).
