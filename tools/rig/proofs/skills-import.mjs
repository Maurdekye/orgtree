import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

// Red: b77512f has neither the skills registry nor installed-plugin MCP import.
// Fixtures live entirely in rig-home; no installed profile or provider is used.
export default async function (rig) {
  const p = new Proof('skills-import')
  const home = path.join(rig.data, 'rig-home')
  const write = (name, value) => {
    const file = path.join(home, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
  }
  const skill = (root, name, body = 'Shared fixture instructions') => {
    write(`${root}/${name}/SKILL.md`, `---\nname: ${name}\ndescription: Fixture skill\n---\n${body}\n`)
    write(`${root}/${name}/references/sample.txt`, 'SKILL_RESOURCE_PRIVATE')
  }
  skill('.claude/skills', 'shared')
  skill('.agents/skills', 'shared')
  skill('.codex/skills', 'shared', 'Different Codex fixture')
  skill('.gemini/antigravity-cli/skills', 'agy')
  skill('.config/muse/skills', 'muse')
  skill('.config/opencode/skills', 'opencode')
  skill('.claude/skills/.trash', 'deleted')
  skill('.claude/plugins/marketplaces/available/skills', 'marketplace-only')
  const plugin = path.join(home, '.claude/plugins/cache/fixture/1')
  write('.claude/plugins/installed_plugins.json', { version: 2, plugins: {
    'fixture@test': [{ scope: 'user', installPath: plugin, version: '1' }],
  } })
  write('.claude/plugins/cache/fixture/1/.claude-plugin/plugin.json', { name: 'fixture' })
  skill('.claude/plugins/cache/fixture/1/skills', 'plugin-skill')
  write('.claude/plugins/cache/fixture/1/.mcp.json', { mcpServers: {
    'plugin-server': { command: 'fixture', args: ['${CLAUDE_PLUGIN_ROOT}/server.js'], env: { TOKEN: 'PLUGIN_MCP_PRIVATE' } },
  } })
  const get = async (method = 'GET') => {
    try { return await rig.api(method, `/api/skills${method === 'POST' ? '/refresh' : ''}`) }
    catch { return {} }
  }
  const first = await get('POST')
  const names = first.skills?.map(x => x.name) ?? []
  p.check('imports five harnesses and installed plugin skills',
    ['shared', 'shared-codex', 'agy', 'muse', 'opencode', 'plugin-skill'].every(n => names.includes(n)), names)
  p.check('identical bundles dedupe before conflicting names get suffixes',
    names.filter(n => n.startsWith('shared')).length === 2 &&
    (first.skills?.find(x => x.name === 'shared')?.sources?.length ?? 0) >= 2)
  p.check('trash and marketplace-only skills are excluded',
    !names.includes('deleted') && !names.includes('marketplace-only'))
  p.check('public registry has metadata only', (first.skills?.length ?? 0) > 0 &&
    first.skills.every(x => Object.keys(x).sort().join(',') === 'name,sources') &&
    !/Shared fixture|SKILL_RESOURCE_PRIVATE|installPath/.test(JSON.stringify(first)))
  const again = await get('POST')
  p.check('unchanged refresh is byte-identical', first.digest && JSON.stringify(first) === JSON.stringify(again))
  skill('.config/muse/skills', 'new-skill')
  const changed = await get('POST')
  p.check('refresh discovers additions and changes digest', changed.skills?.some(x => x.name === 'new-skill') && changed.digest !== first.digest)
  fs.rmSync(path.join(home, '.config/muse/skills/new-skill'), { recursive: true })
  p.check('refresh removes deleted skills', !(await get('POST')).skills?.some(x => x.name === 'new-skill'))
  const mcp = await rig.api('POST', '/api/mcp-servers/refresh')
  p.check('same installed-plugin reader imports plugin MCP', mcp.servers?.includes('plugin-server'))
  p.check('plugin MCP public output and logs exclude definitions/secrets',
    !/PLUGIN_MCP_PRIVATE|server.js|SKILL_RESOURCE_PRIVATE/.test(JSON.stringify(mcp) + rig.engineLog()))
  return p.summary()
}
