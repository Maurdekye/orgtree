// replystyle.scenes.ts — the reply scenes shared by the capture fixture
// (replystyle.visual.tsx) and its jsdom check (replystyle.test.tsx §4), so the
// test proves the captured scene renders a real reply card.
import type { RefWorld } from '../src/canvas/reflinks'
import replyMail from './fixtures/events/reply.mail.json'

export const org = 'synthetic'
export const world: RefWorld = { org, handles: new Set(['mail', 'item', 'doc']), docs: new Map([['doc-plan', 'Attract mode: design notes']]) }
export const QUOTE = 'USER 2026-11-02 21:05:08Z m578f4c33fa34, verbatim: "finish the muse work on appropriate claude and codex agents. whats left to be done?" This supersedes m2e2a78426006\'s "Wonder seats finish their own work" and "don\'t move frozen Wonder work unasked". Move the three unfinished Wonder items.'
export const BODY = 'Done (USER m578f4c33fa34). I removed the Muse-reset watchdog and retired all four Wonder seats. Their handover notes were already on the items.'
export const AT = '2026-11-02T21:06:33Z', QAT = '2026-11-02T21:05:29Z'
// the schema's own reply.mail fixture (the same one replystyle.test §3 uses),
// with this scene's mail and quote: a hand-built event failed validation and
// drew "Unsupported message format" instead of the card (@rig-sol-b bounce)
export const linkedEv = {
  ...replyMail.private,
  actor: { kind: 'agent', id: 'coordinator-opus' },
  object: { ...replyMail.private.object, org, box: 'user', id: 'm578f4c33fa34' },
  body: BODY, quote: { from: 'liaison-opus', at: QAT, gist: QUOTE },
}
