# Tray list recency and overflow

User 2026-10-19 18:04Z: the tray left-click list shows at most ten orgs at
once, with the most recently opened first and scrolling for the rest.

The existing native window-state file stores a validated, deduplicated
`recentOrgs` order. A successful explicit open, focus-existing request or
new-org binding moves that org to the front. Refused/pending requests and
automatic startup restoration do not change the order. Closing a window
retains recency; real deletion removes it. History is independent of saved
geometry and startup reopen membership. Orgs without history retain their
current engine-list order, and stale history never adds missing orgs.

The scriptless tray document retains every current org link, its existing
aligned name/activity/count columns and cancelled-navigation routing. Its
focusable native scroll region supports wheel, scrollbar and keyboard input.
Each fresh popup starts at the top. The viewport contains ten whole 28px rows
at most, fewer on short work areas; width/height and origin stay within the
tray icon's display work area. No popup scripts, preload or new bridge are added.

`tray-recent.test.mjs` covers bounds, durable order/migration and native open
routing; the existing tray-toggle and placement tests retain their controls.
The native synthetic capture uses more than ten orgs and checks initial order,
overflow, scrolling, selection and top position after reopening. It does not
touch a live org, native user profile, or the installed tray icon.
