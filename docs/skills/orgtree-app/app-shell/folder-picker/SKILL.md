---
name: orgtree-folder-picker
description: Choose a folder through the OS native dialog on local desktop orgs or the in-app engine chooser on remote orgs and browsers.
---

Up: [orgtree-app-shell](../SKILL.md)

# Folder picker

Every folder browse button in Orgtree (`pickFolder`) chooses between two folder dialogs depending on where the organization's engine runs:

- **Organizations on this computer (desktop app):** opens the operating system's native folder dialog, modal to the window that asked, allowing existing directories to be chosen or new folders to be created. When the calling field already contains an existing directory path on this computer, the dialog opens at that folder; canceling leaves the field unchanged.
- **Remote organizations and browser surfaces:** when the window belongs to an organization on a remote engine (`remote_link`), or when the UI is opened in a browser without the desktop preload bridge, Orgtree opens its in-app `/api/fs` chooser instead so it browses the **engine computer's** disk rather than the local browser device.

In the in-app `/api/fs` chooser, click a folder to enter it, use Up to visit its parent, or select a breadcrumb to move directly to an ancestor. Select this folder returns the displayed folder; it is disabled when there is no current folder path, including the initial load and the drive overview. Later navigation keeps the previous listing and path until a new listing succeeds, so the previous folder can remain selectable while that request is pending or after it fails. A failed navigation shows an error, and an empty listing means there are no listed subfolders. Cancel, Escape, backdrop dismissal, or leaving the page returns no selection, and the in-app chooser selects existing directories without creating new ones.

In both pickers, choosing a folder only updates or stages the calling field; save or submit that form where required to apply the configuration.

## See also

- [orgtree-agent-folders-tab](../../agent-settings/agent-folders-tab/SKILL.md)
