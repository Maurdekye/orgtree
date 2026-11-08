# orgtree:// links: Orgtree mentions in Hubchat open in Orgtree

Desktop Hubchat draws Orgtree's mentions as chips. A chip for an org that runs
on the same PC opens its target in Orgtree through an `orgtree://` link. This
is the mirror of the `hubchat://chat?to=@net:…` links Orgtree opens for
Hubchat. This document is the one contract both apps implement: Orgtree
(4.5.9 and later) accepts these links, and Hubchat (1.3.3 and later) builds
them.

Rulings (docket `hubchat-render-orgtree-mentions-as-chips-linking`):
- USER 2026-11-08 14:49Z m601d7df721da: the idea, chips for documents,
  tickets, apps, panels, agents, projects and mails.
- 14:52Z m0dc5cb44bd7f: one generic icon for agents and projects.
- 14:54Z m888c908115a5: chips in people's messages too.
- 14:55Z m60c68ee07683: build it.
- 15:08Z mb3e5b66f1e00 "i suggest we mirror it": an orgtree:// protocol, the
  mirror of hubchat://.
- 15:09Z mb6a4bdb7c944: a menu entry that opens just the org.
- 15:10Z m7c183781895c: the edge-case rules below, accepted as proposed.

## The link shapes

One exact shape per kind. The path is the canonical reference token
(`packages/contracts/reference-tokens.ts`) without its `@` and with `/` after
the kind:

| Link | Token it names | Opens |
| --- | --- | --- |
| `orgtree://item/<org>/<slug>` | `@item:<org>/<slug>` | the docket item |
| `orgtree://doc/<org>/<id>` | `@doc:<org>/<id>` | the presented document |
| `orgtree://app/<org>/<id>` | `@app:<org>/<id>` | the app |
| `orgtree://panel/<org>/<id>` | `@panel:<org>/<id>` | the panel |
| `orgtree://agent/<org>/<node>` | `@agent:<org>/<node>` | the agent or project node |
| `orgtree://project/<org>/<name>` | `@project:<org>/<name>` | the project node |
| `orgtree://mail/<org>/user/<id>`, `…/org/<id>` | `@mail:<org>/user/<id>`, `@mail:<org>/org/<id>` | the mail |
| `orgtree://mail/<org>/node/<node>/<id>` | `@mail:<org>/node/<node>/<id>` | the mail |
| `orgtree://org/<org>` | (none) | the org's own window only |

A bare `@name` in Hubchat is sent as `orgtree://agent/<org>/<name>`, the
generic node form, with the org resolved as described in "Which org" below.

Orgtree refuses everything else (`main/orgtree-link.ts` `orgtreeLink`):
- characters outside `[a-z0-9@/-]` after `orgtree://`. That rules out
  capitals, a query, a fragment, a port, credentials, percent-escapes, spaces
  and quotes;
- links longer than 400 characters;
- an unknown kind;
- a path that, rebuilt as `@<kind>:<path>`, does not pass the renderer's own
  `parseRef` unchanged.

The link grammar is the token grammar, so the two cannot drift. Windows hands
the link over as a command-line argument, so nothing else may get through.

## What Orgtree does with one

- **Registration.** The installed app claims the scheme at start, the way
  Hubchat claims hubchat:// (its `src-tauri/src/lib.rs` `register_scheme`).
  It writes the per-user class (`app.setAsDefaultProtocolClient`) only when
  the class points elsewhere. That happens only on Windows and only in a
  packaged build running with its real profile. Development builds, a custom
  `ORGTREE_V2_DATA`/`ORGTREE_V2_PROFILE`, and a packaged smoke run whose
  `APPDATA` is not the real Roaming folder never register. The class
  survives an uninstall, as Hubchat's does: a link then opens nothing.
- **Routing.** Windows starts `Orgtree.exe "<link>"`. The link is one
  command-line destination, like the taskbar's `--orgtree-taskbar=` targets.
  A command line holding both, or two links, names nothing. Links queue with
  the taskbar targets for a cold start and for a second instance
  (`main/jumplist.ts` `taskbarTarget`, `main/index.ts` taskbar router).
- **Org check.** A link opens something only in an org this Orgtree holds:
  the router asks the engine's org list (`GET /api/orgs`, as the tray does)
  per link. If the org is unknown, or the engine cannot answer, nothing
  opens. A malformed link is consumed and opens nothing, so a running
  Orgtree does not even come forward. A cold start whose link opens nothing
  starts Orgtree as usual. A relaunch never replays a link.
- **Opening.** `orgtree://org/<org>` opens that org's window, exactly like
  the taskbar's org entry. A reference is revealed in that org's own window
  as the held `open-reference` event (`revealOrgItem`, the
  notification-click path). The window (`renderer/src/canvas/openreference.ts`)
  takes only a canonical token of its own org. It waits until its tree has
  arrived, then opens the reference through the same routes as the gallery's
  chips (`App.tsx` `galleryRefs`). A target that is gone gets that route's
  usual not-found state. A link only navigates: it never carries an action.

## What Hubchat does

- **Which mentions.** Hubchat draws chips for every canonical token above,
  in people's and orgs' messages, using the token text only: it fetches
  nothing from Orgtree. A bare `@name` becomes the generic agent/project chip
  only when it matches no contact and the message has an org (below). A bare
  `@name` that matches exactly one contact stays the person/org mention it
  was. Hubchat's `@net:` mentions are unchanged.
- **Which org.** A message's org is the org that sent it, or, for a message
  I sent, the org I sent it to. In a message between people there is no org,
  so bare names stay plain text and canonical tokens are display-only. My
  own messages to people are the exception: I am this PC's user, so their
  tokens can open.
- **When a chip opens.**
  - The message's org must be one of this PC's orgs by ADDRESS (Orgtree's
    `local-orgs.json`, the identity check the contact-info badge uses), and
    the token's `<org>` must be one of this PC's org slugs. So a token from
    someone else's org that happens to share a slug with one of mine stays
    inert.
  - The installed Orgtree (its Uninstall entry's DisplayVersion) must be
    4.5.9 or later, prereleases included.
  - Hubchat builds the link natively from validated parts and hands it to the
    OS opener.
- **Hover text.** An openable chip says "<kind> <org>/<id> · Open in
  Orgtree". Any other chip says "Opens in Orgtree on the PC that runs
  <org>".
- **Menu.** The right-click menu adds "Open <org> in Orgtree"
  (`orgtree://org/<org>`) under the same rules. It is disabled, with the
  same hint, when the chip cannot open.
- **Phone.** Chips are display-only. A tap shows the hint, and there is no
  menu entry.

## Verification

- Orgtree:
  - `tests/orgtree-links.test.mjs`: shapes, refusals, the shared
    `ref-tokens.json` fixture, routing, the org check, registration and
    wiring.
  - `tests/taskbar-jumplist.test.mjs`.
  - `tests/multi-window-wiring.test.mjs`: the held type.
  - Renderer `tests/openreference.test.tsx` and `tests/heldbus.test.tsx`.
- Hubchat: its own docs name its tests.
