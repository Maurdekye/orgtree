// canvas/mailchip.tsx — a specific mail as its @mail: link wherever a surface used to offer an "open" button for it (USER
// 2026-10-31 m4ad918885ce9 "also replace this open button with that new mail link", m53e1fd94c038 "this is in agent
// transcripts after orgtree_message tool calls", mf1a79901405e "but also all other places too").
//
// It is the app's one mail link (`RefChip` of a `@mail:` reference): the same mark, the first words of the message as its
// name, the same hover, right-click menu (Open, Copy message text, Copy reference) and click as a mail link in chat. The
// caller passes what the button did as `onOpen`, so a click does exactly what the button did. A mail its box does not hold
// reads as unavailable, like any other reference to nothing.

import { useMemo } from 'react'
import type { MailIdentity } from './mailidentity'
import { mailRefLabel } from './mailrefs'
import { RefChip, resolveRef } from './reflinks'
import type { RefWorld } from './reflinks'
import { useRefNames } from './refnames'

/** `hint` is the message's text where the surface already holds it (a queue row's gist): it names the link until the message
 *  itself is read, so the link never reads as the generic "mail in …" for a message the surface knows. The message's own text
 *  replaces it, and a message the box does not hold is unavailable whatever the hint says. */
export function MailRefChip({ mail, onOpen, hint }: { mail: MailIdentity; onOpen: () => void; hint?: string | null }) {
  const refName = useRefNames(mail.org)
  const hinted = hint ? mailRefLabel(hint) : null
  const r = useMemo(() => {
    const named: RefWorld['refName'] = hinted
      ? ref => { const a = refName(ref); return a?.outcome === 'ready' && a.label ? a : a?.outcome === 'absent' ? a : { outcome: 'ready', label: hinted } }
      : refName
    return resolveRef({ kind: 'mail', org: mail.org, box: mail.box, node: mail.node, id: mail.id }, { org: mail.org, refName: named })
  }, [mail.org, mail.box, mail.node, mail.id, refName, hinted])
  return <RefChip r={r} onOpen={() => onOpen()} />
}
