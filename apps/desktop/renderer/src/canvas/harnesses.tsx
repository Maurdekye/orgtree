// canvas/harnesses.tsx — App settings › Harnesses (user 2026-10-13: "document
// the full harness list in the app", placed in App settings by the
// coordinator, there being no Help surface). Every harness the engine knows,
// from its one registry (GET /api/harnesses, engine `harnesses.rs`): what it
// is, whether it is installed on this computer, the providers whose agents it
// runs and how to install it. A harness added to the registry (opencode)
// appears here with nothing to change in this file.
//
// `HarnessesLink` is the "Which harnesses are supported?" link every harness
// selector carries; it opens this tab.

import { useEffect, useState } from 'react'
import { getHarnesses } from '../api'
import type { HarnessesDoc } from '../types'
import { SetGroup, openAppSettings } from './settingskit'

export function HarnessesLink() {
  return <button type="button" className="link-btn harness-help-link"
    onClick={() => openAppSettings('harnesses')}>Which harnesses are supported?</button>
}

export function HarnessesSection({ active }: { active: boolean }) {
  const [doc, setDoc] = useState<HarnessesDoc | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // read on every visit: installing a CLI changes the answer, and the read
  // spawns nothing (presence only)
  useEffect(() => {
    if (!active) return
    // an engine without the route (or a malformed answer) is an error line,
    // never a render crash that takes the whole settings modal down
    getHarnesses().then((d) => {
      if (Array.isArray(d?.harnesses)) { setDoc(d); setErr(null) }
      else setErr('the engine did not list its harnesses')
    }).catch((e: Error) => setErr(e.message))
  }, [active])
  return <SetGroup title="Harnesses" note=" · the CLIs that run agents">
    <p className="dim harness-intro">A harness is the command-line agent an Orgtree agent runs in. Where
      you choose one (an OpenRouter key, a language server, a hire), only the harnesses installed on this
      computer are offered.</p>
    {err && <div className="ask-warn" role="alert">could not read the harnesses: {err}</div>}
    {!doc && !err && <div className="dim">reading the harnesses…</div>}
    {doc && <div className="harness-list" role="list">
      {doc.harnesses.map((h) => <div className="harness-entry" role="listitem" key={h.id}>
        <div className="harness-head">
          <b>{h.name}</b>
          <span className={h.installed ? 'harness-installed' : 'dim'}>
            {h.installed ? ' · installed' : ' · not installed'}</span>
        </div>
        <div className="dim">{h.what}</div>
        <div><span className="dim">Runs agents on: </span>{(h.providers ?? []).map((p) => p.label).join(', ')}
          {h.selectable ? <span className="dim"> · can be chosen per OpenRouter key, language server and hire</span> : null}</div>
        <div><span className="dim">Install: </span>{h.install}
          {h.install_url && <> <a href={h.install_url} target="_blank" rel="noreferrer">{h.install_url}</a></>}</div>
      </div>)}
    </div>}
  </SetGroup>
}
