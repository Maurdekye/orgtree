"""Declared visible-window scenarios, derived from renderer callers.

This is HTTP demand, not a renderer benchmark: no layout, scrolling, click
latency, history expansion or background-tab throttling is simulated. Earlier
packets polled every window's full archived/backlogged docket, 300 chat messages
and org chooser continuously; those were a stress mix, not renderer defaults.
"""
WINDOWS = ("docket", "desk", "attention", "org-chooser")


def polls(slug: str, watch: str, window: int, streaming: bool = True):
    base = f"/api/orgs/{slug}"
    rows = [("org_tree", base + "?view=delta", 6.0, True)]
    kind = WINDOWS[window % len(WINDOWS)]
    if kind == "org-chooser":
        rows.append(("org_list", "/api/orgs", 3.0, False))
    else:
        rows.append(("work_items", base + "/work-items-view", 15.0 if kind == "desk" else 5.0, True))
    if kind == "desk":
        rows.append(("chat", f"{base}/nodes/{watch}/chat?last=8", 2.5 if streaming else 7.0, False))
    if kind == "attention":
        rows.append(("inbox", base + "/inbox", 5.0, False))
    return rows
