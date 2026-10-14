import { useEffect, useId, useRef, type PointerEvent, type KeyboardEvent } from 'react'
import { cropRect, keyCrop, moveCrop, resizeCrop, type Crop, type Corner } from './cropmath'
import './squarecrop.css'

/** Only the native, oriented preview enters this editor; original bytes stay with its caller. */
export function SquareCrop({ src, width, height, value, onChange, disabled = false }: {
  src: string; width: number; height: number; value: Crop; onChange: (crop: Crop) => void; disabled?: boolean
}) {
  const help = useId(), stage = useRef<HTMLDivElement>(null)
  const gesture = useRef<{ id: number; x: number; y: number; scaleX: number; scaleY: number;
    rect: ReturnType<typeof cropRect>; corner?: Corner } | null>(null)
  const rect = cropRect(value, width, height)
  useEffect(() => { gesture.current = null }, [disabled, src, width, height])
  const start = (e: PointerEvent<HTMLElement>, corner?: Corner) => {
    if (disabled || gesture.current || e.button !== 0) return
    const bounds = stage.current?.getBoundingClientRect()
    if (!bounds?.width || !bounds.height) return
    e.preventDefault(); e.stopPropagation(); e.currentTarget.focus()
    e.currentTarget.setPointerCapture(e.pointerId)
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, scaleX: width / bounds.width,
      scaleY: height / bounds.height, rect, corner }
  }
  const move = (e: PointerEvent<HTMLElement>) => {
    const g = gesture.current
    if (!g || g.id !== e.pointerId || disabled) return
    e.preventDefault(); e.stopPropagation()
    const dx = (e.clientX - g.x) * g.scaleX, dy = (e.clientY - g.y) * g.scaleY
    onChange(g.corner ? resizeCrop(g.rect, g.corner, dx, dy, width, height) : moveCrop(g.rect, dx, dy, width, height))
  }
  const end = (e: PointerEvent<HTMLElement>) => {
    if (gesture.current?.id !== e.pointerId) return
    gesture.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  const key = (e: KeyboardEvent<HTMLElement>) => {
    if (disabled || e.altKey || e.ctrlKey || e.metaKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault(); e.stopPropagation(); gesture.current = null
    onChange(keyCrop(value, e.key, e.shiftKey, width, height))
  }
  const position = { left: `${rect.left / width * 100}%`, top: `${rect.top / height * 100}%`,
    width: `${rect.side / width * 100}%`, height: `${rect.side / height * 100}%` }
  return <div className="square-crop">
    <div className="square-crop-stage" ref={stage} style={{ aspectRatio: `${width} / ${height}`, width: `min(100%, 420px, ${340 * width / height}px)` }}>
      <img className="square-crop-image" src={src} alt="Full image for cropping" draggable={false} />
      <div className="square-crop-shade" aria-hidden="true"><div style={position} /></div>
      <div className="square-crop-box" style={position}>
        <button type="button" className="square-crop-move" aria-label="Move crop square" aria-describedby={help} disabled={disabled}
          onPointerDown={e => start(e)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} onKeyDown={key} />
        {(['nw', 'ne', 'sw', 'se'] as const).map(corner => <button type="button" key={corner}
          className={`square-crop-handle square-crop-${corner}`} disabled={disabled}
          aria-label={`Resize crop from ${({ nw: 'top left', ne: 'top right', sw: 'bottom left', se: 'bottom right' })[corner]}`}
          aria-describedby={help} onPointerDown={e => start(e, corner)} onPointerMove={move} onPointerUp={end}
          onPointerCancel={end} onLostPointerCapture={end} onKeyDown={key} />)}
      </div>
    </div>
    <p className="square-crop-help" id={help}>Drag the square to move it. Drag a corner to resize. Arrow keys move; Shift + arrows resize (left/up smaller, right/down larger).</p>
    <output className="square-crop-value" aria-live="polite">Crop size: {Math.round(value.size * 100)}%; position: {Math.round(rect.left / width * 100)}% from left, {Math.round(rect.top / height * 100)}% from top</output>
  </div>
}
