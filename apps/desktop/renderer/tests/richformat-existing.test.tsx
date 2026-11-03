// RT-S1..S13 (spec §2.1): surfaces that were already complete. These are
// regression guards, GREEN at the base: Markdown, LaTeX and mentions through
// the shared pipeline stay intact. Surfaces named in comments that need a
// whole screen around them (inbox list, gallery, document reader) are covered
// through the component that renders their text.
import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { Msg } from '../src/canvas/desk'
import { MailMessage } from '../src/events/segments'
import { ReplySourceContent, indexReplySources } from '../src/canvas/replysource'
import { AskCard } from '../src/canvas/asks'
import { AnsweredCard } from '../src/events/answered'
import { DocketDescription } from '../src/canvas/docketdesc'
import { MentionLanding, requestMentionLanding } from '../src/canvas/mentionlanding'
import type { AskInfo, ChatMessage } from '../src/types'
import { ORG, RICH, expectRich, onOpen, refs, world } from './fixtures/richformat'

const mount = async (node: React.ReactNode) => {
  const view = await mountView(node, el => el)
  await inAct(async () => { await flush(3) })
  return view
}

test('RT-S3/S5 transcript message text (assistant and user rows)', async t => {
  for (const role of ['assistant', 'user'] as const) {
    const view = await mount(<Msg m={{ role, text: RICH, seq: 1 } as ChatMessage} slug={ORG} nid="alpha" refs={refs} />)
    t.after(() => view.unmount())
    expectRich(view.el.querySelector('.msgtext')!)
  }
})

test('RT-S1/S2/S6 mail rows and event cards (MailMessage, the shared mail card)', async t => {
  const view = await mount(<MailMessage profile="operator" slug={ORG} nid="alpha" world={world} onOpen={onOpen}
    row={{ id: 'm1', from: 'alpha', kind: 'message', body: RICH, at: '2026-11-03T10:00:00Z' }} />)
  t.after(() => view.unmount())
  expectRich(view.el)
})

test('RT-S7 the reply-source viewer prose', async t => {
  const sources = indexReplySources({ messages: [{ role: 'assistant', event_id: 'e1', text: RICH, ts: '2026-11-03T10:00:00Z' } as ChatMessage] })
  const view = await mount(<ReplySourceContent source={sources.get('e1')!} slug={ORG} nid="alpha" profile="operator" refs={refs} />)
  t.after(() => view.unmount())
  expectRich(view.el)
})

test('RT-S8 open question text and option descriptions', async t => {
  const view = await mount(<AskCard slug={ORG} toast={() => {}} refs={refs}
    ask={{ id: 'q1', node: 'alpha', kind: 'question', status: 'open', at: '2026-11-03T10:00:00Z', question: RICH,
      options: [{ label: 'One', description: RICH }, { label: 'Two' }], header: 'H' } as unknown as AskInfo} />)
  t.after(() => view.unmount())
  expectRich(view.el.querySelector('.ask-q')!)
  expectRich(view.el.querySelector('.ask-opt-desc, .ask-option-desc, [class*="desc"]')!)
})

test('RT-S9 answered question text and option descriptions', async t => {
  const view = await mount(<AnsweredCard dismissed={false} world={world} onOpen={onOpen} org={ORG}
    questions={[{ label: 'Q', question: RICH, options: [{ label: 'One', description: RICH }], multi: false, selected: ['One'], typed: null }]} />)
  t.after(() => view.unmount())
  expectRich(view.el.querySelector('.answered-qbody')!)
  expectRich(view.el.querySelector('.answered-opt-desc')!)
})

test('RT-S10 the docket description', async t => {
  const view = await mount(<DocketDescription text={RICH} slug="x" world={world} onOpen={onOpen} />)
  t.after(() => view.unmount())
  expectRich(view.el)
})

test('RT-S13 the mention-landing blurb', async t => {
  requestMentionLanding(ORG, { target: { kind: 'work', item: 'sample-item' }, blurb: RICH, at: '2026-11-03T10:00:00Z' } as never)
  const view = await mount(<MentionLanding org={ORG} kind="work" id="sample-item" refs={{ world, onOpen }} />)
  t.after(() => view.unmount())
  expectRich(view.el.querySelector('.mention-landing .md')!)
})
