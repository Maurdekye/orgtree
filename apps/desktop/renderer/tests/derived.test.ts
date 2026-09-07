// derived.test.ts — the state-deduplication programme, kept honest.
//
// `docs/state-architecture-review.md` deleted a long list of second copies of
// server-owned state and replaced them with derivations. Nothing in a running
// app notices when one creeps back: the copy is right for a while, and the bug
// it causes surfaces weeks later as "the panel is stale again". So this suite
// reads the sources and asserts the shapes that were removed are still absent,
// with an ALLOWLIST that has to name a reason for every survivor.
//
// It also carries a drift guard, in the spirit of `backend/tests/msgvis.py`:
// the numbers the behavioural suites assume are re-read here, so changing one
// fails loudly instead of quietly making a test meaningless.
//
// Run:  cd frontend && node tests/run.mjs derived

import './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

/** injected by tests/run.mjs — the bundle does not sit next to the sources */
declare const __SRC_DIR__: string
const SRC = __SRC_DIR__
const read = (p: string) => readFileSync(path.join(SRC, p), 'utf8')
const uiFiles = ['App.tsx', 'DiskBrowser.tsx', 'picker.tsx', 'forms.tsx',
  ...readdirSync(path.join(SRC, 'canvas')).filter((f) => f.endsWith('.tsx'))
    .map((f) => `canvas/${f}`)]

const lines = (p: string) => read(p).split('\n').map((l, i) => ({ n: i + 1, l }))
/** the file with comment lines removed — this suite asserts on what the code
 *  DOES, and every deleted mechanism here is named in a comment explaining why
 *  it was deleted (`beat()`'s docstring cites `pollWhileBusy` by name) */
const code = (p: string) => read(p).split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

// --------------------------------------------------------------------- ①
test('①  no useState is seeded from server data, except where documented',
  () => {
    // P3 collapsed 25 of these into three edit buffers. The shape to catch is
    // `useState(<something read from a prop>)`: it snapshots once at mount and
    // never re-syncs, which is the mechanism behind "the charter looks empty".
    const SERVERISH = /useState(?:<[^>]*>)?\(\s*(?!\)|\[\]|''|""|`|0[,)]|1[,)]|false|true|null|undefined|\{\s*\}|\(\)\s*=>)/
    const PROPISH = /\b(tree|node|chat|box|inbox|scope|base|draft|data|org|m|b|it)\??\./
    const hits: string[] = []
    for (const f of uiFiles) {
      for (const { n, l } of lines(f)) {
        if (SERVERISH.test(l) && PROPISH.test(l)) hits.push(`${f}:${n} ${l.trim()}`)
      }
    }
    // Every entry must be an UNCOMMITTED OPERATION or a one-time proposal —
    // never a mirror of a value the server owns and keeps changing.
    const allow = [
      // DraftScopeModal stages permissions for an agent that does not exist
      // yet: `base` is a proposal, not a live server value (D-32 records the
      // deliberate exception, and re-deriving would overwrite staged edits)
      /canvas\/modals\.tsx:\d+ const \[dirs, setDirs\]/,
      /canvas\/modals\.tsx:\d+ const \[tools, setTools\]/,
      /canvas\/modals\.tsx:\d+ const \[vis, setVis\] = useState\(base\.org_visibility\)/,
      /canvas\/modals\.tsx:\d+ const \[effort, setEffort\] = useState\(base\.effort/,
      // item 12: the draft's "Prefer reserve" box — the same one-time
      // proposal for an agent not yet hired (the gear's copy for an
      // EXISTING node goes through the edit buffer, not useState)
      /canvas\/modals\.tsx:\d+ const \[preferReserve, setPreferReserve\] = useState\(base\.prefer_reserve/,
      // the hire draft's credit slider — same thing, for a node not yet hired
      /canvas\/cards\.tsx:\d+ const \[grant, setGrant\] = useState\(\(\) => \{/,
    ]
    const unexplained = hits.filter((h) => !allow.some((a) => a.test(h)))
    assert.deepEqual(unexplained, [],
      'a new useState-from-a-prop appeared; make it derived, or add it to the '
      + 'allowlist WITH the reason it is an uncommitted edit and not a mirror')
  })

// --------------------------------------------------------------------- ②
test('②  the conversation is fetched in exactly one place', () => {
  const hits: string[] = []
  for (const f of uiFiles) {
    for (const { n, l } of lines(f)) {
      if (/\bgetChat\(/.test(l)) hits.push(f)
    }
  }
  // desk.tsx LineagePanel reads an ARCHIVED bearer's transcript (an immutable
  // object — §8.3 of the review says a snapshot is correct there); modals.tsx
  // reads `init` once for the model/permission header of a config panel.
  //
  // ⚠ FILES, not file:line. Pinning the line number made this guard fail on
  // any edit ANYWHERE ABOVE the call — it fired on an unrelated change seven
  // lines earlier (2026-08-04) reporting "a live conversation must come from
  // convo.ts", which is not remotely what had happened. A guard that cries
  // wolf on every refactor gets muted, and this one is worth keeping audible.
  assert.deepEqual(hits.sort(), ['canvas/desk.tsx', 'canvas/modals.tsx'],
    'a live conversation must come from convo.ts, not a private getChat')
  assert.equal(hits.length, 2, 'exactly two sanctioned getChat call sites')
  assert.ok(read('convo.ts').includes('getChat(slug, nid, e.s.win)'),
    'convo.ts is still the one that fetches it')
})

// --------------------------------------------------------------------- ③
test('③  liveness is never gated on the data it repairs (D-34)', () => {
  // the bootstrap trap: `poll only while the payload says busy`, where busy
  // arrives in the payload the poll fetches. The gate must be something known
  // locally — a mounted view, an open panel.
  const src = read('convo.ts')
  assert.ok(!/pollWhileBusy/.test(code('convo.ts')),
    'the busy-gated poller stays deleted')
  assert.ok(/if \(e\.poll \|\| !e\.subs\.size\) return/.test(src),
    'the heartbeat is gated on SUBSCRIPTION')
  assert.ok(/cur\.s\.chat\?\.busy \? BUSY_POLL_MS : IDLE_POLL_MS/.test(src),
    'busy still decides the CADENCE — only how often, never whether')
  const shared = read('canvas/shared.ts')
  assert.ok(/export function usePolled/.test(shared),
    'the panel heartbeat (G5) still exists')
  assert.ok(/const t = setInterval\(tick, ms\)/.test(shared),
    'and it is unconditional while mounted')
})

// --------------------------------------------------------------------- ④
test('④  the mutable read panels all poll (G5)', () => {
  // getInbox / getNodeInbox / getEvents / getAudiences / getHistory /
  // getScratch display data that changes while the panel is open.
  const polled = ['getInbox', 'getNodeInbox', 'getEvents', 'getAudiences',
    'getHistory', 'getScratch']
  const bad: string[] = []
  for (const f of uiFiles) {
    const text = read(f)
    for (const fn of polled) {
      const re = new RegExp(`^.*\\b${fn}\\(`, 'gm')
      for (const m of text.match(re) ?? []) {
        if (!/usePolled|folder ===/.test(m)) bad.push(`${f}: ${m.trim()}`)
      }
    }
  }
  assert.deepEqual(bad, [], 'a mutable panel went back to fetching once')
})

// --------------------------------------------------------------------- ⑤
test('⑤  the client-side event accumulations stay deleted (G4)', () => {
  const gone = ['setActivity', 'setPulses', 'setStreams', 'streamEvt']
  const hits: string[] = []
  for (const f of [...uiFiles, 'convo.ts', 'canvas/shared.ts']) {
    for (const { n, l } of lines(f)) {
      for (const g of gone) if (l.includes(g)) hits.push(`${f}:${n} ${g}`)
    }
  }
  assert.deepEqual(hits, [],
    'activity/pulses are derived from the tree payload and the server live tail')
  // and the live tail is the SERVER's, mirrored — never accumulated here.
  // (Mirrored via a per-row normalization, not a cast: LiveRowPayload.text is
  // optional on the wire and LiveRow.text is not — review fix 2026-08-04.)
  const src = read('convo.ts')
  assert.ok(/const live: LiveRow\[\] = \(c\.live \?\? \[\]\)\.map/.test(src),
    'convo.live is a mirror of chat.live, not a local accumulation')
  assert.ok(!/live: \[\.\.\.e\.s\.live/.test(src), 'nothing appends to it locally')
})

// --------------------------------------------------------------------- ⑥
test('⑥  a wide table still scrolls inside its own message (D-14)', () => {
  const css = readFileSync(path.join(SRC, 'styles.css'), 'utf8')
  const rule = /\.md table \{[^}]*\}/.exec(css)?.[0] ?? ''
  assert.ok(rule, '.md table rule is gone')
  for (const decl of ['display: block', 'max-width: 100%', 'overflow-x: auto']) {
    assert.ok(rule.includes(decl), `.md table lost \`${decl}\``)
  }
})

// --------------------------------------------------------------------- ⑦
test('⑦  drift guard: the constants the behavioural suites assume', () => {
  const src = read('convo.ts')
  const want: [RegExp, string][] = [
    [/export const CHAT_WINDOW = (\d+)/, '120'],
    [/export const MAX_WINDOW = (\d+)/, '1000'],
    [/const BUSY_POLL_MS = (\d+)/, '2500'],
    [/const IDLE_POLL_MS = (\d+)/, '7000'],
    [/const NUDGE_MS = (\d+)/, '200'],
    [/const COPIES_WINDOW = (\d+)/, '200'],
    [/const COPIES_NEEDLE = (\d+)/, '200'],
  ]
  for (const [re, v] of want) {
    const m = re.exec(src)
    assert.ok(m, `${re} no longer matches convo.ts`)
    assert.equal(m![1], v,
      `${re} changed — re-read frontend/tests/convo.test.tsx before trusting it`)
  }
  assert.equal(/const MAIL_WINDOW = (\d+)/.exec(read('canvas/mail.tsx'))?.[1], '40')
  assert.ok(/scrollTop < 240 && hasOlder/.test(read('canvas/desk.tsx')),
    'the chat still pages on scroll (D-56)')
  assert.ok(/scrollHeight - el\.scrollTop - el\.clientHeight < 240/.test(read('canvas/mail.tsx')),
    'the mail list still pages on scroll (D-56)')
})

// --------------------------------------------------------------------- ⑧
test('⑧  nothing on screen is retired on a clock', () => {
  // D-50's rule: superseded is not replaced. The 5-second expiry and the
  // 300-character prefix match that used to drop live rows are gone, and the
  // scaffolding now retires only in the patch that installs its replacement.
  const src = code('convo.ts')
  assert.ok(!/_at < 5000|Date\.now\(\) - r\._at/.test(src), 'no live-row expiry timer')
  assert.ok(!/startsWith\(r\.text\.slice/.test(src), 'no prefix matching')
  assert.ok(/const retire: Partial<Convo> = \{\}/.test(src),
    'retirement still happens in one atomic patch with the payload')
  const desk = code('canvas/desk.tsx')
  assert.equal((desk.match(/setInterval\(/g) ?? []).length, 1,
    'the only desk timer is the shared completed-turn age clock')
  assert.ok(/ageClockTimer = setInterval\(pulseAgeClock, 1000\)/.test(desk),
    'the one allowed timer stopped being the shared age-label pulse')
  assert.ok(!/_at < 5000|Date\.now\(\) - r\._at/.test(desk),
    'the age-label clock must not revive live-row retirement')
})

// --------------------------------------------------------------------- ⑨
test('⑨  every read-marking call refreshes the payload its rows come from',
  () => {
    // TWO user bug reports, one defect, 2026-08-07 and 2026-08-08: "marking
    // mail as read takes several seconds". The server answers in ~5 ms both
    // times. The rows come from getInbox (a 5 s usePolled) or from the tree
    // prop (a 6 s heartbeat), and a read call that refreshes neither leaves
    // the mark sitting there until an unrelated tick.
    //
    // ⚠ The server's `changed` broadcast does NOT rescue it: that makes
    // clients refetch the TREE, and the user-inbox rows are not in the tree.
    // That is exactly why the per-mail path had to bump its own dep — and why
    // fixing it did not fix "mark all read", a SIBLING CALL SITE I missed.
    // One missed sibling is the whole reason this is a family guard and not
    // another per-case test: it fails on the next one too.
    const CALLS = /\b(markRead|clearInbox|orgInboxRead)\s*\(/g
    // documented exception: the modal-CLOSE acknowledgement in OrgCanvas. Its
    // only visible effect is the canvas tile's badge, which IS tree-backed —
    // so the server's broadcast genuinely does refresh it.
    const EXEMPT = [/if \(tree\.org_inbox\?\.unread\) orgInboxRead/]
    const bad: string[] = []
    for (const f of ['App.tsx', 'canvas/mail.tsx', 'canvas/OrgCanvas.tsx']) {
      for (const { n, l } of lines(f)) {
        if (/^\s*(\/\/|\*)/.test(l)) continue
        if (!CALLS.test(l)) { CALLS.lastIndex = 0; continue }
        CALLS.lastIndex = 0
        if (/^\s*(export )?const (markRead|clearInbox|orgInboxRead)/.test(l)) continue
        if (EXEMPT.some((re) => re.test(l))) continue
        // the refresh may ride the same line or the next two (formatting)
        const near = lines(f).filter((x) => x.n >= n && x.n <= n + 3)
          .map((x) => x.l).join(' ')
        if (!/\.then\(/.test(near)) {
          bad.push(`${f}:${n}  ${l.trim().slice(0, 80)}`)
        }
      }
    }
    assert.deepEqual(bad, [],
      'a read-marking call with no .then() refresh — its rows will keep their '
      + 'unread mark until the next poll:\n  ' + bad.join('\n  '))
  })

// --------------------------------------------------------------------- ⑩
test('⑩  no destructive op fires straight off a click — each one asks first',
  () => {
    // User bug 2026-08-09: "retire on desk view has no confirmation". It was
    // the ONE seat-freeing action wired directly to onClick, sitting next to
    // a dissolve button that asks — and a mis-click stops an agent mid-turn,
    // with the undo living in a toast that scrolls away.
    //
    // Three call sites had it (the desk action bar, the ⚙ panel, the lineage
    // bearer row) and only the reporter's route was named. That is the same
    // shape as the read-marking miss in ⑨: fix the family, not the instance.
    //
    // The rule: an op whose effect is to STOP or DESTROY something reaches
    // `op({op: ...})` from a ConfirmModal's onConfirm, never from an onClick
    // handler. Detected structurally — an onClick line that also carries the
    // op call is the defect; a setAsking/setRetiring hand-off is the fix.
    const DESTRUCTIVE = /op\(\{\s*op:\s*'(retire|dissolve|delete|rescind)'/
    const bad: string[] = []
    for (const f of ['canvas/desk.tsx', 'canvas/modals.tsx', 'canvas/cards.tsx',
      'canvas/OrgCanvas.tsx', 'App.tsx']) {
      for (const { n, l } of lines(f)) {
        if (/^\s*(\/\/|\*)/.test(l)) continue
        if (DESTRUCTIVE.test(l) && /onClick/.test(l)) {
          bad.push(`${f}:${n}  ${l.trim().slice(0, 90)}`)
        }
      }
    }
    assert.deepEqual(bad, [],
      'a destructive op fires directly from a click, with no confirmation:\n  '
      + bad.join('\n  '))
  })

// --------------------------------------------------------------------- ⑪
test('⑪  the command-ghost drop is keyed on the shapes that write no row',
  () => {
    // User bug 2026-08-09. The drop was `if (r.command)` — true for ALL three
    // command shapes, including the ordinary one that IS delivered verbatim as
    // its own user event and therefore does get a transcript row. Dropping its
    // ghost left an idle desk blank between send and turn start.
    //
    // convo.test §6 proves the store half (a kept ghost graduates on the row,
    // and an immediate one would be immortal without the drop). This pins the
    // BRANCH, which lives in desk.tsx and no store test can reach.
    const src = code('canvas/desk.tsx')
    const m = /if \(r\.(\w+)(?:\s*\|\|\s*r\.(\w+))?\)\s*dropPending/.exec(src)
    assert.ok(m, 'the command-ghost drop is gone entirely — a ghost for an '
      + 'immediate command would now sit on the desk forever')
    const keys = [m[1], m[2]].filter(Boolean).sort()
    assert.deepEqual(keys, ['compacting', 'immediate'],
      `the drop is keyed on ${keys.join('+')}. It must be exactly the shapes `
      + 'that never write a transcript row: `command` alone also catches the '
      + 'ordinary command, whose ghost is the only thing on screen until its '
      + 'turn starts')
  })

// --------------------------------------------------------------------- ⑫
test('⑫  the canvas turn-end stamp reads TurnStat, never NodeStatus',
  () => {
    // FR-23 (user request 2026-08-09). Two `at` fields exist and only one is
    // authoritative for "when did the last turn END": TurnStat.at is written
    // unconditionally at turn completion (killed turns included), while
    // NodeStatus.at exists only when the agent chose to report a status — a
    // node that never reports would show "never" while turning daily. The
    // badge must also hide while busy: "3m ago" under a running turn is a
    // contradiction the activity dot already answers.
    const src = code('canvas/cards.tsx')
    const m = /const lastTurn = node\.turns\?\.\[node\.turns\.length - 1\]/.exec(src)
    assert.ok(m, 'lastTurn is no longer derived from node.turns — if the '
      + 'stamp moved to last_status.at, nodes that never self-report show '
      + 'nothing however many turns they run')
    assert.ok(src.includes('<LastTurnAge turn={lastTurn} busy={node.busy}'),
      'the canvas stopped using the shared authoritative turn-age component')
    const desk = code('canvas/desk.tsx')
    assert.ok(desk.includes('if (!turn || busy) return null'),
      'the shared turn-age badge lost its busy/never-ran gate')
    assert.ok(desk.includes('<TurnStatusBanner state={turnBannerState} turn={lastTurn}'),
      'the focused desk stopped feeding the authoritative turn age into its '
      + 'persistent status banner')
    assert.ok(!desk.includes('<LastTurnAge turn={lastTurn}'),
      'the focused desk reintroduced a separate last-turn age chip')
    assert.ok(!/last_status\S*\.at/.test(code('canvas/cards.tsx')),
      'cards.tsx reads last_status.at — the glanceable stamp must come from '
      + 'TurnStat (see FR-23: NodeStatus.at depends on the agent having '
      + 'reported at all)')
  })

// --------------------------------------------------------------------- ⑬
test('⑬  the agent tray lists by hierarchy, with filtered ancestors kept',
  () => {
    // FR-16 (user request 2026-08-06). The old tray sorted every row by
    // canvas position alone, so a child hired far from its parent landed
    // nowhere near it. The hierarchy walk must exist, sibling order may still
    // use position, and a filtered-out ancestor of a matching row renders as
    // a ghost — dropping it would leave the descendant's indent pointing at a
    // gap.
    const src = code('canvas/OrgCanvas.tsx')
    assert.ok(/const walk = \(id: string, depth: number\)/.test(src),
      'the tray hierarchy walk is gone — rows are no longer grouped under '
      + 'their superior')
    assert.ok(/paddingLeft: 8 \+ depth \* \d+/.test(src),
      'the depth indent is gone — hierarchy order without indentation reads '
      + 'as an arbitrary shuffle')
    assert.ok(/anyMatch/.test(src) && /ghost/.test(src),
      'the ghost-ancestor path is gone — a name filter now orphans matching '
      + 'descendants under an invisible parent')
  })

// --------------------------------------------------------------------- ⑭
test('⑭  the pinned last-user-turn chip attributes by envelope, not role',
  () => {
    // FR-20 (user idea 2026-08-08). In orgtree a user-ROLE transcript record
    // is envelope-wrapped input from ANY sender — a sibling's mail pinned as
    // "you" misattributes someone else's words to the human. The durable twin
    // of pending-mail's `m.from === USER` filter is the envelope's FROM line.
    const src = code('canvas/desk.tsx')
    assert.ok(/`\^FROM \$\{USER\} \\\(`/.test(src)
      || /\^FROM \$\{USER\}/.test(src),
      'lastUser no longer keys on the envelope FROM line — bare role would '
      + 'pin a sibling\'s mail as "you"')
    assert.ok(/\{pinTarget && \(/.test(src),
      'the chip render lost its visibility gate — it must only show while '
      + 'a target row is above the scrollport')
    assert.ok(/getBoundingClientRect\(\)\.bottom < /.test(src),
      'calcPin no longer measures the row against the scrollport — a chip '
      + 'shown while the row is BELOW the viewport points the wrong way')
    // retarget-up (user request 2026-08-14): scrolling past the target hands
    // the chip to the next user turn up the chain — calcPin must scan ALL
    // user turns newest→oldest, not test a single latest row
    assert.ok(/for \(let i = userTurns\.length - 1; i >= 0; i--\)/.test(src),
      'calcPin lost its newest→oldest scan — scrolling above the latest user '
      + 'turn must retarget the chip to the next one up, not hide it')
    // full-width, three lines, faded where cut (user request 2026-08-19).
    // jsdom lays nothing out, so the geometry half of that is only ever
    // stated here; §9.8 in render.test.tsx covers the measurement that
    // decides WHETHER to fade.
    const css = readFileSync(path.join(SRC, 'styles.css'), 'utf8')
    const chip = /\.pinuser \{[^}]*\}/.exec(css)?.[0] ?? ''
    assert.ok(/left: 2px/.test(chip) && /right: 2px/.test(chip),
      '.pinuser no longer spans the card — the absolute overlay needs both '
      + 'left and right insets')
    assert.ok(!/nowrap/.test(chip) && !/text-overflow/.test(chip),
      '.pinuser is back to a one-line ellipsis — the chip wraps now, and the '
      + 'cut is a fade')
    const inner = /\.pinuser-t \{[^}]*\}/.exec(css)?.[0] ?? ''
    assert.ok(/max-height: calc\(3 \* 1\.45em\)/.test(inner)
      && /line-height: 1\.45/.test(inner),
      '.pinuser-t lost its three-line clamp (the clamp and the line-height '
      + 'that sizes it must move together)')
    assert.ok(/\.pinuser\.clipped \.pinuser-t \{[^}]*mask-image: linear-gradient/
      .test(css),
      'the fade is gone — a cut label now ends mid-word with no sign that '
      + 'anything follows')
  })

// --------------------------------------------------------------------- ⑮
test('⑮  the insert-superior splice is atomic with the hire, and the draft '
  + 'previews it in place',
  () => {
    // FR-25 rework (user request 2026-08-19, superseding the 2026-08-10
    // client-chained build). The old shape — hire, then a SEPARATE move op,
    // each with its own broadcast and reflow — read as "a slow few
    // consecutive steps". Now the anchor rides the hire op (`above`) and the
    // SERVER splices in one save; a partial failure (hired but unspliced)
    // is impossible by construction, so the loud-toast path ⑮ used to pin
    // is gone WITH its failure mode, not silently dropped.
    const src = code('canvas/OrgCanvas.tsx')
    assert.ok(/above: draft!\.above\?\.anchor/.test(src),
      'the hire op no longer carries the anchor — the server cannot splice, '
      + 'and insert-superior degrades to a plain side hire')
    assert.ok(!/op\(\{ op: 'move', node: above\.anchor/.test(src),
      'the client-chained splice move is back — that resurrects the two-step '
      + 'reflow and the hired-but-unspliced failure mode the rework removed')
    assert.ok(/const spawnAbove = /.test(src)
      && /above: \{ anchor: n\.id \}/.test(src),
      'spawnAbove is gone or no longer records the anchor — confirmDraft '
      + 'cannot tell the server what to splice above')
    // the preview half: the draft must WRAP the anchor (take its slot, anchor
    // beneath), so the form already sits in the final shape and confirm does
    // not move anything on screen
    const sh = code('canvas/shared.ts')
    assert.ok(/d\.children = \[kids\[i\]!\]/.test(sh),
      'withDraftTree no longer wraps the insert-superior anchor — the draft '
      + 'would render as a sibling and the confirmed hire would reflow')
  })

// --------------------------------------------------------------------- (16)
test('(16)  open requests render as ONE composed batch card per agent',
  () => {
    // FR-14 (user ruling 2026-08-12). Open per-kind rows would resurrect the
    // multi-card state the batch model replaced: the inbox derives its open
    // rows from the NODES' composed `ask` (kind batch), while the raw
    // per-store entries feed only the resolved history.
    const src = code('App.tsx')
    assert.ok(/\[\.\.\.nodes\.values\(\)\]\s*\n?\s*\.filter\(\(n\) => n\.ask && askOpen\(n\.ask\)\)/.test(src),
      'askPending no longer derives from the composed node batches — open '
      + 'components now render as separate per-kind rows')
    const asks = code('canvas/asks.tsx')
    assert.ok(/ask\.kind === 'batch' && ask\.tabs\?\.length/.test(asks),
      'AskCard lost its batch dispatch — composed cards fall through to the '
      + 'single-kind forms and the submit shape breaks')
    assert.ok(/skiprow/.test(asks) && /skip: true/.test(asks),
      'the explicit-skip affordance is gone — a tab the user wants to leave '
      + 'unanswered has no honest path, and close-all loses its meaning')
  })
