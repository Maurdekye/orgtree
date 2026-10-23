import test from 'node:test'
import assert from 'node:assert/strict'
import { firstUsePlacement, type GuideRect } from '../src/canvas/firstuseplacement'

const overlaps = (a: GuideRect, b: GuideRect) => a.left < b.left + b.width && a.left + a.width > b.left
  && a.top < b.top + b.height && a.top + a.height > b.top

for (const preferred of ['left', 'right'] as const) {
  test(`first-use ${preferred} placement clears the complete group across common and narrow viewports`, () => {
    for (const [width, height] of [[1920,1080], [1366,768], [1024,768], [800,600], [400,760]]) {
      const group = { left: width / 2 - 150, top: 160, width: 300, height: 240 }
      const target = { left: width / 2 - 60, top: 230, width: 120, height: 24 }
      const placement = firstUsePlacement(target, group, { left: 0, top: 0, width, height }, 84, preferred)
      assert.equal(!!placement, true, `${width}x${height}`)
      assert.equal(overlaps(placement!, group), false, `${width}x${height}: whole group stays clear`)
      assert.equal(placement!.left >= 12 && placement!.top >= 12
        && placement!.left + placement!.width <= width - 12
        && placement!.top + placement!.height <= height - 12, true)
      if (width >= 1024) assert.equal(placement!.side, preferred)
      if (width === 400) assert.equal(placement!.side, 'below')
    }
  })
}

test('first-use fallback moves above a low group and yields when no clear area fits', () => {
  const target = { left: 150, top: 300, width: 80, height: 24 }
  const viewport = { left: 0, top: 0, width: 400, height: 500 }
  const group = { left: 50, top: 180, width: 300, height: 260 }
  const placement = firstUsePlacement(target, group, viewport, 100, 'right')!
  assert.equal(placement.side, 'above')
  assert.equal(overlaps(placement, group), false)
  assert.equal(firstUsePlacement(target, viewport, viewport, 100, 'left'), null)
})

test('first-use placement honors the canvas inset and measured note height', () => {
  const viewport = { left: 80, top: 70, width: 900, height: 500 }
  const group = { left: 500, top: 80, width: 200, height: 250 }
  const target = { left: 520, top: 90, width: 22, height: 22 }
  const placement = firstUsePlacement(target, group, viewport, 148, 'left')!
  assert.equal(placement.top, 82)
  assert.equal(placement.height, 148)
  assert.equal(placement.left + placement.width, group.left - 20)
  assert.match(placement.path, /^M [\d.]+ [\d.]+ L 516 101$/)
})

test('legacy placement beneath one token overlaps later rows, while the side note stays clear', () => {
  const group = { left: 800, top: 300, width: 180, height: 150 }
  const target = { left: 810, top: 305, width: 22, height: 22 }
  const legacy = { left: target.left, top: target.top + target.height + 18, width: 280, height: 90 }
  assert.equal(overlaps(legacy, group), true, 'the original overlap control must be real')
  assert.equal(overlaps(firstUsePlacement(target, group, { left:0,top:0,width:1920,height:1080 }, 90, 'left')!, group), false)
})

test('first-use side note shifts above the canvas toolbar in a short window', () => {
  const target = { left:369,top:507,width:22,height:22 }
  const group = { left:331,top:430,width:138,height:174 }
  const toolbar = { left:12,top:530,width:300,height:50 }
  const placement = firstUsePlacement(target, group, {left:0,top:0,width:800,height:600}, 90, 'left', [toolbar])!
  assert.equal(placement.side, 'left')
  assert.equal(overlaps(placement, group), false)
  assert.equal(overlaps(placement, toolbar), false)
  assert.equal(placement.top + placement.height <= toolbar.top - 6, true)
})

test('message-step right-aligned fallback keeps staged and wrapped attachments clear at common and narrow sizes', () => {
  for (const [width,height] of [[1920,1080],[1440,900],[1366,768],[1280,720],[1024,768],[800,600],[400,760],[320,568]]) {
    const composer={left:24,top:height-110,width:width-48,height:80}
    const attachments={left:24,top:height-250,width:width-48,height:130}
    const group={...composer,top:attachments.top,height:composer.top+composer.height-attachments.top}
    const target={left:64,top:composer.top+8,width:width-128,height:60}
    const note=firstUsePlacement(target,group,{left:0,top:0,width,height},90,'right',[],'right')!
    assert.equal(!!note,true,`${width}x${height}`)
    assert.equal(overlaps(note,composer),false)
    assert.equal(overlaps(note,attachments),false)
    assert.equal(note.side,'above')
    assert.equal(note.left>=12&&note.left+note.width<=width-12&&note.top>=12,true)
    if(width>=400) assert.equal(note.left+note.width,composer.left+composer.width)
  }
})

test('original step-4 textarea anchoring covers a staged preview; protected right placement does not', () => {
  const viewport={left:0,top:0,width:1920,height:1080}
  const target={left:140,top:920,width:1640,height:80}
  const attachment={left:100,top:772,width:200,height:130}
  const legacy={left:target.left,top:target.top-112,width:280,height:90}
  assert.equal(overlaps(legacy,attachment),true,'cheap geometric red reproduces the old overlap')
  const note=firstUsePlacement(target,{left:100,top:772,width:1720,height:236},viewport,90,'right',[],'right')!
  assert.equal(overlaps(note,attachment),false)
  assert.equal(note.left>legacy.left,true)
})
