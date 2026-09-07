import { createRoot } from 'react-dom/client'
import '../src/styles.css'
import { Msg } from '../src/canvas/desk'
import type { ChatMessage } from '../src/types'

const mail: ChatMessage = {
  role: 'user', text: `[MAIL — 2 message(s)]
NOTICE FROM process-cache-2 (your report) · 2026-08-30T12:11:32.854Z — informational, delivered passively; no reply is expected
Measured eligibility count: **only this intentional phrase is bold**. The rest of this peer notice stays normal weight.
---
FROM @user (USER) · message · 2026-08-30T12:12:00.000Z
Can agents distinguish whether mail was sent directly or replied from the inbox?
[END MAIL]`,
}

createRoot(document.querySelector('#root')!).render(
  <div className="probe-shell"><Msg m={mail} slug="probe" nid="agent" /></div>,
)
