import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

// No real profiles or provider process is used. Red control: same proof on
// 9735bd4 discovers only Claude; refresh returns 404. All checks keep running.
export default async function (rig) {
  const p = new Proof('mcp-import')
  const home = path.join(rig.data, 'rig-home')
  const write = (name, text) => {
    const file = path.join(home, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text))
  }
  const local = { command: 'fixture-runner', args: ['serve'], env: { TOKEN: 'MCP_FIXTURE_SECRET' } }
  const remote = { url: 'https://mcp-fixture-private.invalid', headers: { Authorization: 'MCP_HEADER_SECRET' } }
  write('.claude.json', { mcpServers: { shared: local, orgtree: local } })
  write('.codex/config.toml', '[mcp_servers.shared]\nurl="https://mcp-fixture-private.invalid"\n[mcp_servers.shared.http_headers]\nAuthorization="MCP_HEADER_SECRET"\n[mcp_servers.codex]\ncommand="fixture-codex"\n')
  write('.gemini/config/mcp_config.json', { mcpServers: { agy: { serverUrl: remote.url, headers: remote.headers }, shared: local } })
  write('.config/muse/settings.json', { mcp_servers: { muse: { transport: 'stdio', command: 'fixture-muse' }, off: { enabled: false, command: 'fixture-off' } } })
  write('.config/opencode/opencode.jsonc', '{// comment\n"mcp":{"opencode":{"type":"local","command":["fixture-opencode"],},},}')
  write('.agents/plugins/orgtree/mcp_config.json', { mcpServers: { must_not_import: local } })
  const doc = await rig.api('GET', '/api/mcp-servers')
  const names = doc.servers ?? []
  p.check('imports five installed harness sources, preserving Claude names',
    ['shared', 'shared-codex', 'codex', 'agy', 'muse', 'opencode'].every(n => names.includes(n)), names)
  p.check('identical shared definitions combine provenance',
    JSON.stringify(doc.details?.find(d => d.name === 'shared')?.sources) === JSON.stringify(['claude-code', 'antigravity']))
  p.check('conflicting name keeps a suffixed Codex definition', doc.details?.find(d => d.name === 'shared-codex')?.transport === 'http')
  p.check('disabled entries, own bridge and generated plugins are absent',
    ['off', 'orgtree', 'must_not_import'].every(n => !names.includes(n)))
  p.check('endpoint excludes definitions and secrets',
    !/MCP_FIXTURE_SECRET|MCP_HEADER_SECRET|mcp-fixture-private|fixture-runner|Authorization/.test(JSON.stringify(doc)))
  p.check('metadata exposes only name, sources and transport',
    (doc.details?.length ?? 0) > 0 && doc.details.every(d => Object.keys(d).sort().join(',') === 'name,sources,transport'))
  write('.config/muse/settings.json', { mcp_servers: { added: { command: 'new-fixture' } } })
  const changed = await rig.api('GET', '/api/mcp-servers')
  p.check('changed file is picked up automatically without refresh', changed.servers?.includes('added') && !changed.servers?.includes('muse'))
  let refreshed
  try { refreshed = await rig.api('POST', '/api/mcp-servers/refresh') } catch { /* expected on red */ }
  p.check('explicit refresh succeeds with updated safe metadata', refreshed?.details?.some(d => d.name === 'added' && d.sources.includes('muse')))
  write('.config/muse/settings.json', '{broken')
  const bad = await rig.api('GET', '/api/mcp-servers')
  p.check('malformed source is skipped while other sources remain', !bad.servers?.includes('added') && bad.servers?.includes('codex'))
  p.check('engine log excludes fixture secrets', !/MCP_FIXTURE_SECRET|MCP_HEADER_SECRET/.test(rig.engineLog()))
  return p.summary()
}
