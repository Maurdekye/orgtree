import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { WrapExamples, WrapSettings, installWrapBackend } from './mentionwrap.fixture'
import '../src/styles.css'
import '../src/shell.css'
const backend = installWrapBackend()
window.fetch = backend.fetcher
window.WebSocket = backend.Socket as unknown as typeof WebSocket
Object.defineProperty(navigator, 'clipboard', { value: { read: async () => [], readText: async () => '', write: async () => { throw Error('Denied') }, writeText: async () => { throw Error('Denied') } } })
let showSettings: (value: boolean) => void
const opened: string[] = []
function Fixture() { const [settings, setSettings] = useState(false); showSettings = setSettings
  return <><WrapExamples open={id => opened.push(id)} />{settings && <WrapSettings close={() => setSettings(false)} />}</> }
Object.assign(window, { wrapFixture: { settings: (value: boolean) => showSettings(value), opened, writes: backend.writes } })
createRoot(document.getElementById('root')!).render(<Fixture />)
