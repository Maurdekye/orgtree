// Proof: the rig's desktop harness is silent and off the real clipboard
// (docket rig-proofs-never-open-an-unguarded-desk-window-b). An explicit UI
// run: the desk is driven only with a renderer bundle asked for, so run it
// with --ui <dir> or --ui auto, in Session 0.
//   The harness reports Chromium started with --mute-audio, its window muted
//   and no application menu; the page sees clipboard-read/-write denied, the
//   in-memory clipboard stub installed at document start (a write reads back
//   from the stub), execCommand copy/paste refused; the driver refuses Ctrl+V,
//   Ctrl+C and a CDP clipboard grant, and still sends a plain key; Electron
//   ran in Session 0.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/desk-guard.mjs --ui auto

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runDesktop } from '../desktop.mjs'
import { Proof } from '../proof.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

export default async function (rig) {
  const p = new Proof('desk-guard')
  if (!rig.run.ui) {
    p.check('the run has a renderer bundle (run with --ui <dir> or --ui auto)', false, { ui: rig.run.ui })
    return p.summary()
  }
  const r = await runDesktop(rig, path.join(here, '../desktop/desk-guard.cjs'), { out: path.join(p.dir, 'desk'), timeout: 60000 })
  p.check('the desk script ran', r.ok === true, r.ok ? undefined : r)
  const g = r.guards ?? {}
  const v = r.value ?? {}
  p.check('Chromium started with --mute-audio and the window is muted', g.muteSwitch === true && g.muted === true, g)
  p.check('no application menu (no copy/paste accelerators)', g.applicationMenu === 'none', g)
  p.check('the clipboard stub ran at document start', g.clipboardStub === true && v.stub === true, { guards: g, stub: v.stub })
  p.check('the page sees clipboard-read and clipboard-write denied', v.clipboardRead === 'denied' && v.clipboardWrite === 'denied', v)
  p.check('a clipboard write lands in the stub and reads back from it', v.readBack === 'rig-desk-guard' && v.stubLast === 'rig-desk-guard', v)
  p.check('execCommand copy and paste do nothing', v.execCopy === false && v.execPaste === false, v)
  p.check('the driver refuses Ctrl+V, Ctrl+C and a CDP clipboard grant', v.pasteKeyRefused && v.copyKeyRefused && v.grantRefused, v)
  p.check('...and still sends a plain key', v.plainKeyAllowed === true, v)
  p.check('Electron ran in Session 0, and the receipt names the Electron and rig PIDs',
    r.session?.electron === 0 && Number.isInteger(r.session?.electronPid) && r.session.electronPid > 0
      && Number.isInteger(r.session?.rigPid) && r.session.rigPid > 0, r.session)
  p.file('desk-result.json', r)
  return p.summary()
}
