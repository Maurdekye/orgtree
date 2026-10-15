---
name: orgtree-suggestion-box
description: "Record concrete gaps in how Orgtree explains its own functions to agents."
---

Up: [orgtree-workspace](../SKILL.md)

# suggestion-box.md

This is a team working practice from the user ruling relayed by coordinator-opus on 2026-10-15, not an engine-managed feature. While doing a task, keep `suggestion-box.md` in your own scratch folder with notes about how Orgtree could better inform its agents about its own functions.

Append when you encounter the gap: a misleading instruction, a surprising tool/setting, a limit found only after failure, or a rule discovered in source or old mail. Record what happened, what it cost, and the sentence or built-in skill text that would have prevented it. Separate a missing explanation from a suspected behavior bug, and identify the source or observed result behind the claim.

Useful example:

```text
I treated a send success as evidence the receiver had read the file.
That caused an unnecessary follow-up round. Suggested tool text:
“Success records the download card; it does not prove a download or read.”
```

Do not claim a product defect from an unverified inference. Keep evidence pointers and remaining uncertainty so the reviewer can decide whether the fix belongs in instructions, documentation or code. Send findings to the assigned consolidator when the task requires it; merely writing this file does not notify anyone or create a docket item.

Keep the resumption history in [breadcrumbs](../breadcrumbs/SKILL.md), and durable implementation requirements in the docket. The suggestion box collects improvements; it is not an authorization to implement them outside your assignment.

## See also

- [orgtree-breadcrumbs](../breadcrumbs/SKILL.md)
