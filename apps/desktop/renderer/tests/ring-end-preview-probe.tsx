import { createRoot } from 'react-dom/client'
import { ReorderMarker } from '../src/canvas/reorderpreview'
import { ringReorderSlot } from '../src/canvas/ringreorder'
import { NODE_H, NODE_W } from '../src/canvas/shared'

const index = Number(new URLSearchParams(location.search).get('case') ?? 0)
const radius = index < 2 ? 260 : 490, first = index % 2 === 0
const eye = { x: 0, y: 0 }, angles = [2.9, 3.25, 3.7]
const polar = (angle: number) => ({ x: -radius * Math.cos(angle), y: radius * Math.sin(angle) })
const nodes = new Map(['a', 'b', 'c'].map((id, i) => [id, polar(angles[i]!)]))
const anchorAngle = angles[first ? 0 : 2]!, anchor = nodes.get(first ? 'a' : 'c')!
const slot = ringReorderSlot(['a', 'b', 'c'], nodes, eye, polar(anchorAngle + (first ? -.01 : .01)))!
const extent = (NODE_W * Math.abs(Math.sin(anchorAngle)) + NODE_H * Math.abs(Math.cos(anchorAngle))) / 2
const gutter = ((slot.point.x - anchor.x) * Math.sin(anchorAngle) + (slot.point.y - anchor.y) * Math.cos(anchorAngle)) * (first ? -1 : 1) - extent
const points = [eye, ...nodes.values(), slot.point]
const left = Math.min(...points.map(p => p.x)) - 80, top = Math.min(...points.map(p => p.y)) - 90
const width = Math.max(...points.map(p => p.x + NODE_W)) - left + 80
const height = Math.max(...points.map(p => p.y + NODE_H)) - top + 90
createRoot(document.getElementById('root')!).render(<main style={{ fontFamily: 'sans-serif', background: '#15191f', color: '#e7edf4', height: '100vh', padding: 16, boxSizing: 'border-box' }}>
  <h2 style={{ margin: '0 0 8px' }}>{radius === 260 ? 'Inner' : 'Outer'} ring · {first ? 'before first agent' : 'after last agent'}</h2>
  <p style={{ margin: '0 0 4px' }}>Synthetic occupied arc · marker gutter: <b data-gutter={gutter}>{gutter.toFixed(2)} world px</b> · drop {JSON.stringify(slot.request)}</p>
  <svg width="920" height="540" viewBox={`${left} ${top} ${width} ${height}`} style={{ '--accent': '#63d6ff' } as React.CSSProperties}>
    <circle cx={NODE_W / 2} cy={NODE_H / 2} r={radius} fill="none" stroke="#445365" strokeDasharray="8 6" />
    <circle cx={NODE_W / 2} cy={NODE_H / 2} r="5" fill="#d9b866" />
    {[...nodes].map(([id, p]) => <g key={id}>
      <rect x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx="8" fill="#283440" stroke="#778a9c" />
      <text x={p.x + 12} y={p.y + 25} fill="#e7edf4" fontSize="18">agent {id}</text>
    </g>)}
    <ReorderMarker slot={slot} eye={eye} zoom={1} />
  </svg>
</main>)
