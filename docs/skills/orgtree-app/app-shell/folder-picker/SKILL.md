---
name: orgtree-folder-picker
description: Choose an existing folder on the engine computer through the in-app picker.
---

Up: [orgtree-app-shell](../SKILL.md)

# Folder picker

The in-app chooser browses the computer hosting the engine, including when the UI is opened in a remote browser. Its home and drive/root shortcuts do not refer to the browser device's filesystem.

Click a folder to enter it, use Up to visit its parent, or select a breadcrumb to move directly to an ancestor. Select current folder returns the displayed folder. It is disabled when there is no current folder path, including the initial load and the drive overview. Later navigation keeps the previous listing and path until a new listing succeeds, so the previous folder can remain selectable while that request is pending or after it fails. A failed navigation shows an error. An empty listing means there are no listed subfolders.

Cancel, Escape, backdrop dismissal, or leaving the page returns no selection. Choosing a folder only fills the calling field; save or submit that form to apply the resulting configuration. This chooser selects existing directories, not individual files, and does not create a folder.

## See also

- [orgtree-agent-folders-tab](../../agent-settings/agent-folders-tab/SKILL.md)
