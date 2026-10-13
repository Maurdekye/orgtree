// The visual control reverses only this item's rendering changes. Loading
// entire historical files would discard unrelated changes in a combined batch.
function once(source, after, before) {
  if (source.split(after).length !== 2) throw new Error('Expected one overview hunk: '+after);
  return source.replace(after, before);
}
export function beforeOverview(file, contents) {
  let source=contents.replace(/\r\n/g,'\n');
  if (file==='canvas/OrgCanvas.tsx') {
    source=once(source,"if (!compact && lod !== 'mini') for (const w of tree.watchdogs ?? [])",'if (!compact) for (const w of tree.watchdogs ?? [])');
    source=once(source,"{!compact && lod !== 'mini' && (tree.watchdogs ?? []).map",'{!compact && (tree.watchdogs ?? []).map');
    source=once(source,"{!(hideRetired && lod === 'mini') && [...retiredCounts.entries()].map",'{[...retiredCounts.entries()].map');
    source=once(source," + (lod === 'mini' ? ' orginbox-far' : '')",'');
    source=once(source,'            aria-label="org inbox"\n','');
    source=once(source,'            {lod === \'mini\' ? <OutboxIcon className="oi-far-icon" fontSize="inherit" /> : <>\n','');
    const closing=/(<div className="oi-last">[\s\S]*?<\/div>)\n            <\/>}/;
    if (!closing.test(source)) throw new Error('Expected mailbox-only fragment closing hunk');
    source=source.replace(closing,'$1');
  } else if (file==='canvas/cards.tsx') {
    source=once(source,'{(zoom == null || zoom >= Z_MINI) && <div className="cbar-inf-wrap">','<div className="cbar-inf-wrap">');
    source=once(source,'          </div>}\n      <svg className="eye"','          </div>\n      <svg className="eye"');
    source=once(source,"{lod !== 'mini' && !focused && !pile && (node.documents?.length ?? 0)",'{!focused && !pile && (node.documents?.length ?? 0)');
    source=once(source,'<DocChips slug={slug} docs={node.documents!} onOpen={onOpenDoc} />','<DocChips slug={slug} docs={node.documents!} onOpen={onOpenDoc} inert={lod === \'mini\'} />');
  } else if (file==='styles.css') {
    const accent=/(\.sq\.mini::before\s*\{[^}]*background:\s*)var\(--tier-accent, var\(--provider-accent\)\)/;
    if (!accent.test(source)) throw new Error('Expected mini-only edge accent hunk');
    source=source.replace(accent,'$1var(--provider-accent)');
  } else throw new Error('Unsupported overview control file: '+file);
  // Keep the new icon import/export and unused far mailbox CSS. They cannot
  // render in this control, and preserving exports avoids breaking other items.
  return source;
}
