import { createRoot } from 'react-dom/client'
import { useEffect, useRef } from 'react'
import { HeldAudienceChips } from '../src/canvas/desk'

function Example({ label, projects, explicit }: { label: string; projects: string[]; explicit: boolean }) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const host = ref.current!
    host.querySelector('output')!.textContent = host.querySelector<HTMLElement>('.badge')!.title
  }, [])
  return <section ref={ref} style={{ marginBottom: 22 }}>
    <h3 style={{ margin: '0 0 8px' }}>{label}</h3>
    <div className="badges"><HeldAudienceChips slug="synthetic" toast={() => {}} map={new Map()} node={{
      id: 'worker', audiences_held: ['@user'], audiences_explicit: explicit ? ['@user'] : [],
      audiences_inherited: projects.map(project => ({ grantor: '@user', project })),
    }} /></div>
    <output style={{ display: 'block', whiteSpace: 'pre-wrap', padding: 10, marginTop: 8,
      background: 'var(--panel)', border: '1px solid var(--line)', fontSize: 13 }} />
  </section>
}
document.body.style.cssText = 'margin:0;background:var(--bg);color:var(--ink);font:14px sans-serif'
createRoot(document.getElementById('root')!).render(<main style={{ padding: 28 }}>
  <h2 style={{ marginTop: 0 }}>Audience header badges</h2>
  <p>Native tooltip text shown below each badge for inspection. First badge has keyboard focus.</p>
  <Example label="Inherited audience" projects={['build-slot']} explicit={false} />
  <Example label="Several project sources and an explicit grant" projects={['outer', 'inner']} explicit />
  <Example label="Explicit-only audience" projects={[]} explicit />
</main>)
