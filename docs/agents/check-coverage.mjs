// Documentation preservation check; no engine, provider, database or build is started.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const normalize = text => text.replace(/\r\n/g, '\n');
export const digest = text => crypto.createHash('sha256').update(text).digest('hex');
export const slug = text => text.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s/g, '-');

export function headingDestinations(source, entries) {
  const lines = source.split('\n'), counts = new Map(), result = new Map();
  for (const entry of entries) {
    const heading = lines[entry.start - 1].match(/^#{1,6} (.+)$/);
    if (!heading || entry.start !== entry.end) continue;
    const base = slug(heading[1]), count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    result.set(base + (count ? `-${count}` : ''), `${path.posix.basename(entry.file)}#${entry.id}`);
  }
  return result;
}

export function relocatedBody(raw, anchors) {
  let fence = null;
  const target = value => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(value)) return value;
    if (value.startsWith('#')) return anchors.get(value.slice(1)) ?? `../../AGENTS.md${value}`;
    return `../../${value}`;
  };
  const prose = text => text.replace(/(\]\()([^\s()]+)(\))/g, (_, open, value, close) => open + target(value) + close);
  const inline = line => {
    let result = '', from = 0;
    while (from < line.length) {
      const open = line.indexOf('`', from);
      if (open < 0) return result + prose(line.slice(from));
      result += prose(line.slice(from, open));
      const run = line.slice(open).match(/^`+/)[0];
      let close = line.indexOf(run, open + run.length);
      while (close >= 0 && (line[close - 1] === '`' || line[close + run.length] === '`')) close = line.indexOf(run, close + run.length);
      if (close < 0) return result + prose(line.slice(open));
      result += line.slice(open, close + run.length);
      from = close + run.length;
    }
    return result;
  };
  return raw.trimEnd().split('\n').map(line => {
    const mark = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (mark) {
      if (!fence) fence = {char:mark[1][0], length:mark[1].length};
      else if (mark[1][0] === fence.char && mark[1].length >= fence.length && !mark[2].trim()) fence = null;
      return line;
    }
    if (fence) return line;
    return inline(line.replace(/^(#{1,6}) /, (_, hashes) => `${'#'.repeat(Math.min(hashes.length + 2, 6))} `))
      .replace(/^(\s*\[[^\]]+\]:\s*)(\S+)/, (_, prefix, value) => prefix + target(value));
  }).join('\n');
}

function rootLinks(text) { return [...text.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)].map(m => m[1]); }
function hasAnchor(text, anchor) {
  if (text.includes(`id="${anchor}"`)) return true;
  return normalize(text).split('\n').some(line => /^#{1,6} /.test(line) && slug(line.replace(/^#{1,6} /, '')) === anchor);
}

export function verify({manifest, source, rootText, documents}) {
  source = normalize(source); rootText = normalize(rootText);
  assert.equal(digest(source), manifest.source.sha256, 'source baseline differs: reconcile incoming entries first');
  const lines = source.split('\n'), covered = new Uint16Array(lines.length);
  const anchors = headingDestinations(source, manifest.entries);
  const bodies = new Map();
  for (const [file, text] of documents) {
    const matches = normalize(text).matchAll(/<!-- preserved:(e-[a-f\d]{16}) -->\n([\s\S]*?)\n<!-- \/preserved:\1 -->/g);
    for (const match of matches) {
      assert.ok(!bodies.has(match[1]), `duplicate preserved body ${match[1]}`);
      bodies.set(match[1], {file, text:match[2]});
    }
  }
  let tags = 0;
  for (const entry of manifest.entries) {
    assert.ok(Number.isInteger(entry.start) && entry.start > 0 && entry.end >= entry.start && entry.end <= lines.length, `bad range ${entry.id}`);
    const raw = lines.slice(entry.start - 1, entry.end).join('\n').trimEnd();
    assert.equal(digest(raw), entry.sha256, `source entry digest ${entry.id}`);
    const actual = bodies.get(entry.id);
    assert.ok(actual, `missing preserved entry ${entry.id}`);
    assert.equal(actual.file, entry.file, `wrong destination ${entry.id}`);
    assert.equal(actual.text, relocatedBody(raw, anchors), `changed/lost content or attribution ${entry.id}`);
    assert.ok(rootLinks(rootText).includes(entry.file), `topic unreachable from AGENTS.md: ${entry.file}`);
    for (let line = entry.start - 1; line < entry.end; line++) covered[line]++;
    tags += (raw.match(/\[(?:decided|verified)\b/gi) ?? []).length;
  }
  for (let i = 0; i < lines.length; i++) if (lines[i].trim()) assert.equal(covered[i], 1, `source line ${i + 1} is lost or counted twice`);
  const originalTags = (source.match(/\[(?:decided|verified)\b/gi) ?? []).length;
  assert.equal(tags, originalTags, 'decision/verification tag count');
  assert.equal(new Set(manifest.entries.map(e => e.id)).size, bodies.size, 'unmapped preserved bodies');
  assert.ok(Buffer.byteLength(rootText.replace(/\n/g, '\r\n')) < 60_000, 'AGENTS.md must stay below 60 KB');
  assert.doesNotMatch(rootText, /[A-Z]:[\\/]Users[\\/]|[\w.+-]+@[\w.-]+\.[a-z]{2,}/i, 'private path or address in startup guide');
  for (const link of rootLinks(rootText)) {
    if (/^[a-z][a-z\d+.-]*:/i.test(link)) continue;
    const [relative, anchor] = link.split('#'), target = path.resolve(repo, relative || 'AGENTS.md');
    assert.ok(target.startsWith(repo + path.sep) || target === path.join(repo, 'AGENTS.md'), `escaping root link ${link}`);
    const content = relative === '' || relative === 'AGENTS.md' ? rootText : documents.get(relative) ?? (fs.existsSync(target) ? normalize(fs.readFileSync(target, 'utf8')) : null);
    assert.notEqual(content, null, `broken root link ${link}`);
    if (anchor) assert.ok(hasAnchor(content, anchor), `missing root-link anchor ${link}`);
  }
  return {sourceRef:manifest.source.commit, entries:manifest.entries.length, uniqueBodies:bodies.size, nonblankLines:[...covered].filter((n,i) => lines[i].trim()).length, preservedTags:tags, rootBytes:Buffer.byteLength(rootText.replace(/\n/g, '\r\n')), rootLines:rootText.trimEnd().split('\n').length, estimatedTokens:Math.ceil(rootText.length / 4), tokenEstimate:'characters / 4 heuristic; not a provider tokenizer'};
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(repo,'docs/agents/coverage.json'),'utf8'));
  const at = process.argv.indexOf('--source-ref'), ref = at >= 0 ? process.argv[at + 1] : manifest.source.commit;
  assert.match(ref ?? '', /^[a-zA-Z\d_./-]+$/, 'invalid source ref');
  const source = execFileSync('git',['show',`${ref}:AGENTS.md`],{cwd:repo,encoding:'utf8',maxBuffer:4*1024*1024});
  const rootText = fs.readFileSync(path.join(repo,'AGENTS.md'),'utf8');
  const documents = new Map([...new Set(manifest.entries.map(e => e.file)),'docs/agents/README.md'].map(file => [file,fs.readFileSync(path.join(repo,file),'utf8')]));
  const input = {manifest, source, rootText, documents};
  const result = verify(input);
  if (process.argv.includes('--self-test')) {
    assert.equal(relocatedBody('Read [guide](docs/guide.md) and `[file](relative.md)`.',new Map()),'Read [guide](../../docs/guide.md) and `[file](relative.md)`.');
    assert.equal(relocatedBody('```md\n# Example\n[file](relative.md)\n```',new Map()),'```md\n# Example\n[file](relative.md)\n```');
    const omit = structuredClone(manifest); omit.entries.shift();
    assert.throws(() => verify({...input,manifest:omit}), 'coverage must reject an omitted entry');
    const first = manifest.entries[0], changed = new Map(documents);
    changed.set(first.file, changed.get(first.file).replace(`<!-- preserved:${first.id} -->`, `<!-- preserved:e-0000000000000000 -->`));
    assert.throws(() => verify({...input,documents:changed}), 'coverage must reject a missing body');
    const tagged = new Map(documents);
    // Mutate a preserved attribution, rather than a newer note outside the
    // source manifest's coverage.
    const tagEntry = manifest.entries.find(entry => {
      const body = tagged.get(entry.file).split(`<!-- preserved:${entry.id} -->`)[1]?.split(`<!-- /preserved:${entry.id} -->`)[0];
      return body && /\[(decided|verified)/i.test(body);
    });
    assert.ok(tagEntry, 'self-test needs a preserved attribution');
    const marker = `<!-- preserved:${tagEntry.id} -->`;
    const tagText = tagged.get(tagEntry.file), tagAt = tagText.indexOf(marker) + marker.length;
    tagged.set(tagEntry.file, tagText.slice(0, tagAt) + tagText.slice(tagAt).replace(/\[(decided|verified)/i,'[removed-attribution'));
    assert.throws(() => verify({...input,documents:tagged}), 'coverage must reject a changed attribution');
    assert.throws(() => verify({...input,rootText:rootText+'\n[broken](docs/agents/does-not-exist.md)\n'}), 'navigation must reject a broken link');
    result.negativeControls = 4;
    result.literalCodeControls = 2;
  }
  console.log(JSON.stringify(result,null,2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
