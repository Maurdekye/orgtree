/** WHAT HAPPENS WHEN A MAIN WINDOW IS ASKED TO CLOSE.
 *
 *  ⚠ WHY THIS IS ONE FUNCTION AND NOT A HANDLER. The wiring had TWO
 *  `window.on('close', …)` listeners: one that decided whether to allow the
 *  close, and one that tore the window's state down. Electron runs every
 *  `close` listener regardless of whether another called `preventDefault`, so
 *  the teardown ran on exactly the paths the decision had just refused. A user
 *  with `exitOnClose` off clicked X to tuck the app into the tray, as they had
 *  every day, and their popped-out desks were closed and their organization
 *  dropped from the next launch's reopen set — while the window itself stayed
 *  open, so nothing looked like it had failed.
 *
 *  Two listeners cannot be made safe by ordering them carefully, because the
 *  danger is not the order: it is that one of them runs at all after the other
 *  refused. So there is one function, the teardown is reachable through
 *  exactly one branch of it, and the shape of the mistake is unrepresentable.
 *
 *  ⚠ AND A REFUSED CLOSE LEAVES THE RECORD EXACTLY AS IT WAS — not merely the
 *  popouts. `tearingDown` was also set on windows that were never torn down,
 *  and nothing reset it, so every later reader of that flag on that record was
 *  reading a lie for the rest of the session. That is why `teardown` is a
 *  single callback rather than a list of steps at the call site: a fix that
 *  moved only the popout loop would have left the flag behind. */
import { closeAction } from './policy'
import type { CreationCloseDecision } from '../../../packages/contracts/desktop-window'

export interface CloseInputs {
  /** The application is already shutting down, so the close is part of it. */
  quitting: boolean
  /** What the registry says about this window's unfinished creation form. */
  creation: CreationCloseDecision
  /** Is some OTHER main window still visible? Closing one of several closes
   *  it; only the last one gets to consult the tray preference. */
  otherMainsVisible: boolean
  exitOnClose: boolean
  /** Visible windows other than this one, as closeAction counts them —
   *  popouts and artifact viewers included. */
  otherViews: number
}

export type CloseOutcome =
  /** A discard confirmation for this window is already on screen. Refuse, and
   *  let the standing question be the only one asked. */
  | 'refuse'
  /** Raise the discard confirmation and refuse for now. */
  | 'confirm'
  /** The last window, with the tray preference off: hide instead of closing. */
  | 'hide'
  /** The last window, with `exitOnClose` on: take the application with it. */
  | 'quit'
  /** Let it close. ⚠ THE ONLY OUTCOME THAT TEARS ANYTHING DOWN. */
  | 'proceed'

export interface CloseHost {
  preventDefault(): void
  hide(): void
  quit(): void
  /** Ask the user whether to discard the unfinished form. */
  confirmDiscard(): void
  /** Set tearingDown, drop the reopen membership, close the owned popouts.
   *  Reached from ONE branch, so a refused close cannot touch any of it. */
  teardown(): void
}

export function performClose(input: CloseInputs, host: CloseHost): CloseOutcome {
  // ⚠ A SHUTDOWN DOES NOT STOP TO ASK. The quit has already confirmed every
  // unfinished form, once, before it began; asking again here would put the
  // same question up a second time per window.
  if (!input.quitting) {
    if (input.creation === 'awaiting') { host.preventDefault(); return 'refuse' }
    if (input.creation === 'confirm') {
      host.preventDefault()
      host.confirmDiscard()
      return 'confirm'
    }
  }
  // ⚠ CLOSING ONE OF SEVERAL CLOSES IT. The tray-retention behaviour belongs
  // to the LAST window and is preserved exactly: only when no other main
  // window remains does exitOnClose decide between hiding and quitting.
  if (!input.otherMainsVisible) {
    const action = closeAction(input.exitOnClose, input.quitting, input.otherViews)
    if (action === 'hide') { host.preventDefault(); host.hide(); return 'hide' }
    if (action === 'quit') { host.preventDefault(); host.quit(); return 'quit' }
  }
  host.teardown()
  return 'proceed'
}
