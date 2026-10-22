// Bounded, synthetic-only depth investigation. Each depth gets a fresh run;
// the caller stops escalation on failure/timeout and retains every verdict.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { Proof } from '../proof.mjs'
import { TOKEN_HEADER, Rig } from '../lib.mjs'
import { runDesktop } from '../desktop.mjs'

const depth = Number(process.env.DEEP_NESTING_DEPTH ?? 32)
if (![32, 128, 512, 2048].includes(depth)) throw Error('Explicit approved depth required')
if (process.argv.includes('--capture')) {
  const at = process.argv.indexOf('--capture'), rigDir = process.argv[at + 1], output = process.argv[at + 2]
  if (!rigDir?.replaceAll('\\', '/').includes('/rig/epic-combo-sol-deep-nesting/')
    || !output?.replaceAll('\\', '/').startsWith('C:/orgtree-build/epic-combo-sol/')) throw Error('Owned synthetic capture paths required')
  if (os.freemem() < 3e9) throw Error('Renderer RAM floor')
  const result = await runDesktop(Rig.attach(rigDir), path.join(import.meta.dirname, '../desktop/deep-project-nesting.cjs'),
    { out: path.join(output, 'desktop'), profile: path.join(output, 'profile'), preset: 'wide', timeout: 45000,
      args: { depth, expectedRows: depth + 7 } })
  fs.writeFileSync(path.join(output, 'desktop-receipt.json'), JSON.stringify(result, null, 2))
  process.exit(result.ok && result.exit === 0 ? 0 : 1)
}
export async function setup() {
  return { recover: true, maxParked: 1, fixture: { org: { name: `Synthetic depth ${depth}` },
    agents: [{ name: 'boss', tier: 'sol', grant: 200 }] } }
}

export default async function (rig) {
  const p = new Proof(`deep-project-nesting-${depth}`)
  const started = Date.now(), timings = []
  let phase = 'setup', org
  const record = (what, ok, detail) => p.check(`depth ${depth}: ${what}`, ok, detail)
  const api = async (method, route, body) => {
    const t = Date.now()
    const response = await fetch(rig.url + route, { method,
      headers: { [TOKEN_HEADER]: rig.token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) })
    const text = await response.text()
    timings.push({ phase, method, route, status: response.status, ms: Date.now() - t, bytes: Buffer.byteLength(text) })
    let value; try { value = JSON.parse(text) } catch { value = text }
    if (!response.ok) throw Error(`${method} ${route}: ${response.status}: ${text.slice(0, 300)}`)
    return value
  }
  const row = name => rig.one(`SELECT * FROM ot.agents WHERE org_id=${org} AND name='${name}'`)
  const tool = (who, name, args = {}) => api('POST', '/api/rig/tool', { org: rig.org, agent: who, tool: name, args })
  const op = body => api('POST', `/api/orgs/${rig.org}/ops`, body)
  const settle = () => rig.waitFor(() => rig.sql('SELECT id FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what: 'synthetic turns finish', timeout: 15000 })
  const last = `p-${depth - 1}`
  try {
    if (!rig?.org || !rig?.data || !rig.data.replaceAll('\\', '/').includes('/rig/epic-combo-sol-deep-nesting/')) {
      throw Error('Own synthetic rig identity required')
    }
    rig.api = api
    rig.scenario({ default: { turns: [{ steps: [{ text: 'Synthetic depth check complete.' }] }] } })
    await api('PUT', '/api/app-settings/runtime', { warming_enabled: false, working_checkups_enabled: false,
      idle_docket_reminders_enabled: false, blocked_docket_reminders_enabled: false, project_listener_wake_enabled: false })
    org = rig.one(`SELECT id FROM ot.orgs WHERE slug='${rig.org}' AND state='active'`).id
    await op({ op: 'retool', node: 'boss', org_visibility: 'full' })
    await op({ op: 'hire', name: 'outsider', tier: 'sol', grant: 0, org_visibility: 'full' })
    await op({ op: 'create_project', name: 'p-0', parent: 'boss' })
    for (const name of ['leaf', 'worker', 'victim', 'waiter', 'mid']) {
      await op({ op: 'hire', name, parent: 'p-0', tier: 'sol', grant: name === 'leaf' ? 8 : 0, org_visibility: 'full' })
    }
    await settle()
    // SQL expands only a real project row in this disposable database. No
    // authority result, visibility, runtime state or operation is mocked.
    const columns = rig.sql(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='ot' AND table_name='agents' AND is_generated='NEVER'
      AND identity_generation IS NULL AND column_name NOT IN ('name','parent_id','sibling_order')
      ORDER BY ordinal_position`).map(r => r.column_name)
    const boss = row('boss').id, seed = row('p-0').id
    rig.exec(`INSERT INTO ot.agents(name,parent_id,sibling_order,${columns.join(',')})
      SELECT 'p-'||g,${boss},g,${columns.map(c => 'a.' + c).join(',')}
      FROM ot.agents a,generate_series(1,${depth - 1}) g WHERE a.id=${seed};
      UPDATE ot.agents a SET parent_id=b.id FROM ot.agents b
      WHERE a.org_id=${org} AND b.org_id=${org} AND a.kind='project' AND b.kind='project'
      AND a.name LIKE 'p-%' AND a.name<>'p-0' AND b.name='p-'||(substring(a.name from 3)::int-1);
      UPDATE ot.agents SET parent_id=(SELECT id FROM ot.agents WHERE org_id=${org} AND name='${last}')
      WHERE org_id=${org} AND name IN ('leaf','worker','victim','waiter');
      UPDATE ot.agents SET parent_id=(SELECT id FROM ot.agents WHERE org_id=${org} AND name='p-${Math.floor(depth / 2)}')
      WHERE org_id=${org} AND name='mid';
      UPDATE ot.agents SET grant_credits=CASE WHEN substring(name from 3)::int<=${Math.floor(depth / 2)} THEN 18 ELSE 16 END
      WHERE org_id=${org} AND kind='project' AND name LIKE 'p-%';
      ANALYZE ot.agents;`)
    const physical = rig.one(`WITH RECURSIVE up(id,parent_id,d) AS (
      SELECT id,parent_id,0 FROM ot.agents WHERE org_id=${org} AND name='leaf'
      UNION ALL SELECT a.id,a.parent_id,u.d+1 FROM ot.agents a JOIN up u ON a.id=u.parent_id)
      SELECT max(d)::int AS depth,count(*)::int AS nodes FROM up`)
    record('fixture has the exact physical chain', physical.depth === depth + 1 && physical.nodes === depth + 2, physical)
    p.file('fixture.json', rig.sql(`SELECT id,name,parent_id,kind,state,scope FROM ot.agents WHERE org_id=${org} ORDER BY id`))
    phase = 'reload seeded synthetic org'
    await rig.restart()
    phase = 'tree records'
    const records = await api('GET', `/api/orgs/${rig.org}/records`)
    const agents = records.records.filter(r => r.entity === 'agent')
    record('record snapshot retains all projects and agents', agents.length === depth + 7
      && agents.some(r => r.body?.id === 'leaf') && agents.some(r => r.body?.id === last), { got: agents.length, expected: depth + 7 })
    phase = 'cheap source-chain and superior measurement'
    const opsSource = fs.readFileSync(path.join(import.meta.dirname, '../../../engine/rs/orgtree-engine/src/domain/ops.rs'), 'utf8')
    const chainSource = opsSource.slice(opsSource.indexOf('async fn chain('))
    const chainSql = chainSource.match(/"(WITH RECURSIVE[\s\S]*?)"/)
    if (!chainSql) throw Error('Source chain query seam changed; recheck instrument')
    const measuredSql = chainSql[1].replace('SELECT {columns}', 'SELECT a.id').replaceAll('$1', String(row('leaf').id))
    p.file('source-chain-query.sql', measuredSql)
    const chainRows = rig.sql(measuredSql)
    record('source chain query reaches the real root before locking', chainRows.length === depth + 2 && chainRows[0]?.id === boss,
      { count: chainRows.length, expected: depth + 2, first: chainRows[0], root: boss, source: 'domain/ops.rs::chain query only; per-row locks not replayed' })
    const superior = rig.one(`SELECT ot.superior_of(${row('leaf').id}) AS ordinary,ot.live_superior_of(${row('leaf').id}) AS live`)
    record('transparent projects resolve the actual agent superior', superior.ordinary === boss && superior.live === boss, superior)
    const toolsSource = fs.readFileSync(path.join(import.meta.dirname, '../../../engine/rs/orgtree-engine/src/tools/mod.rs'), 'utf8')
    const descendantSql = toolsSource.slice(toolsSource.indexOf('pub async fn is_descendant(')).match(/"(WITH RECURSIVE[\s\S]*?)"/)
    if (!descendantSql) throw Error('Descendant query seam changed; recheck instrument')
    const descendant = (ancestor, subject) => {
      const sql = descendantSql[1].replaceAll('$1', String(ancestor)).replaceAll('$2', String(subject))
      return Object.values(rig.one(sql))[0]
    }
    record('strict descendant query includes deep reports and excludes self/outsiders',
      descendant(boss, row('leaf').id) === true && descendant(row('leaf').id, row('leaf').id) === false
      && descendant(row('outsider').id, row('leaf').id) === false)
    const sqlControls = `BEGIN; SET LOCAL statement_timeout='3s';
      UPDATE ot.agents SET state='archived',parent_id=${row('outsider').id} WHERE id=${boss};
      DO $$ BEGIN
        IF ot.superior_of(${row('leaf').id}) IS DISTINCT FROM ${boss}::bigint
          OR ot.live_superior_of(${row('leaf').id}) IS DISTINCT FROM ${row('outsider').id}::bigint
        THEN RAISE EXCEPTION 'nearest structural/live superior mismatch'; END IF;
      END $$;
      UPDATE ot.agents SET parent_id=${row(last).id} WHERE id=${row(`p-${depth - 2}`).id};
      DO $$ BEGIN
        IF ot.superior_of(${row('leaf').id}) IS NOT NULL OR ot.live_superior_of(${row('leaf').id}) IS NOT NULL
        THEN RAISE EXCEPTION 'project cycle returned a superior'; END IF;
      END $$;
      UPDATE ot.agents SET parent_id=${row('leaf').id} WHERE id=${row(last).id};
      DO $$ BEGIN
        IF ot.superior_of(${row('leaf').id}) IS NOT NULL OR ot.live_superior_of(${row('leaf').id}) IS NOT NULL
        THEN RAISE EXCEPTION 'subject returned as its own superior'; END IF;
      END $$; ROLLBACK;`
    p.file('superior-controls.sql', sqlControls)
    rig.exec(sqlControls)
    record('superior controls preserve nearest/live semantics and end cycles', row('boss').state === 'live'
      && row('boss').parent_id === null && row(last).parent_id === row(`p-${depth - 2}`).id)
    phase = 'compatibility tree'
    const tree = await api('GET', `/api/orgs/${rig.org}`)
    const names = [], stack = [...tree.roots]
    while (stack.length) { const n = stack.pop(); names.push(n.id); stack.push(...n.children) }
    record('compatibility tree retains deepest agents', names.length === depth + 7 && names.includes('leaf') && names.includes(last),
      { got: names.length, expected: depth + 7, leaf: names.includes('leaf') })
    phase = 'renderer canvas and agents list'
    const captureArgs = p.file('capture-args.txt', [import.meta.filename, '--capture', rig.dir, p.dir].join('\n') + '\n')
    const fd = fs.openSync(path.join(p.dir, 'capture-job.log'), 'wx'), captureStart = Date.now()
    let capture
    try { capture = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(import.meta.dirname, '../../../apps/desktop/renderer/tests/joblimit.ps1'),
      '-LimitMB', '3072', '-TimeoutSec', '90', '-WorkDir', path.resolve(import.meta.dirname, '../../..'),
      '-Exe', process.execPath, '-ArgFile', captureArgs], { windowsHide: true, stdio: ['ignore', fd, fd] })
    } finally { fs.closeSync(fd) }
    p.file('capture-job-exit.json', { status: capture.status, signal: capture.signal, error: capture.error?.message ?? null, ms: Date.now() - captureStart })
    const desktop = fs.existsSync(path.join(p.dir, 'desktop-receipt.json'))
      ? JSON.parse(fs.readFileSync(path.join(p.dir, 'desktop-receipt.json'), 'utf8')) : { ok: false, error: 'No renderer verdict' }
    record('canvas and agents list retain deepest node without crash', desktop.ok && desktop.exit === 0
      && capture.status === 0 && desktop.value?.leaf && desktop.value?.rows === depth + 7 && !desktop.value?.crashed, desktop)
    phase = 'chart and visibility'
    for (const who of ['boss', 'leaf']) {
      const chart = await tool(who, 'orgtree_chart')
      p.file(`chart-${who}.json`, chart)
      record(`${who} chart retains nodes or explicitly reports its existing line cap`, chart.ok
        && (['boss', 'mid', 'leaf', last, 'outsider'].every(n => chart.text.includes(n))
          || (depth + 7 > 600 && chart.text.includes('more agents not shown'))), { ok: chart.ok, bytes: chart.text?.length })
    }
    const inspect = await tool('boss', 'orgtree_state_inspect', { node: 'leaf' })
    record('ancestor can inspect deepest descendant', inspect.ok, inspect.text)
    phase = 'mail and real prompt'
    const upward = await tool('leaf', 'orgtree_send_notice', { to: 'boss', body: `DEPTH-${depth}-UP` })
    const downward = await tool('boss', 'orgtree_send_notice', { to: 'leaf', body: `DEPTH-${depth}-DOWN` })
    record('mail routes both ways through transparent projects', upward.ok && downward.ok,
      { up: upward.text, down: downward.text })
    const turns = rig.turns('leaf').filter(t => t.ended_at).length
    await rig.userMail('leaf', 'Record the actual synthetic supervisor context.')
    await rig.waitTurns('leaf', turns + 1, { timeout: 20000 })
    const prompt = rig.fakeLog('leaf').filter(r => r.kind === 'turn').at(-1)?.prompt ?? ''
    p.file('leaf-prompt.txt', prompt)
    let generated = ''
    if (prompt.includes('[ORGTREE CONTEXT BY REFERENCE]')) {
      const reference = prompt.match(/snapshot \((\d+) UTF-8 bytes\) is at ([^\r\n]+?\.txt)\. Read it before/)
      if (!reference) throw Error('Malformed generated context reference')
      const actual = fs.realpathSync(reference[2]), allowed = fs.realpathSync(path.join(rig.data, 'scratch', rig.org, 'leaf'))
      if (!actual.toLowerCase().startsWith(allowed.toLowerCase() + path.sep)) throw Error('Context reference escaped own synthetic agent')
      const bytes = fs.readFileSync(actual)
      if (bytes.length !== Number(reference[1])) throw Error('Generated context byte count changed')
      generated = bytes.toString('utf8')
      p.file('leaf-generated-context.txt', bytes)
    }
    record('real fake-CLI prompt names boss as superior', (generated + prompt).includes('direct superior (boss)')
      && prompt.includes('FROM boss (your superior)'), { bytes: prompt.length })
    phase = 'descendant halt/unhalt and interruption'
    const denied = await tool('outsider', 'orgtree_halt', { node: 'leaf' })
    record('unrelated agent cannot halt deepest node', !denied.ok && !row('leaf').halt, denied.text)
    const halt = await tool('boss', 'orgtree_halt', { node: 'leaf' })
    const halted = row('leaf').halt
    const unhalt = await tool('boss', 'orgtree_unhalt', { node: 'leaf' })
    record('ancestor halt/unhalt updates deepest descendant', halt.ok && halted && unhalt.ok && !row('leaf').halt,
      { halt: halt.text, unhalt: unhalt.text, halted })
    const interrupt = await tool('boss', 'orgtree_interrupt', { node: 'leaf' })
    record('ancestor interruption is authorized', interrupt.ok, interrupt.text)
    phase = 'credits'
    const grant = Number(row('leaf').grant_credits)
    const realloc = await tool('boss', 'orgtree_reallocate', { node: 'leaf', delta: 1 })
    record('ancestor can reallocate deepest agent credits', realloc.ok && Number(row('leaf').grant_credits) === grant + 1, realloc.text)
    phase = 'deep project broadcast/listeners/queue'
    const broadcast = await tool('boss', 'orgtree_project', { action: 'broadcast', name: last, body: `DEPTH-${depth}-BROADCAST`, notice: true })
    const recipients = rig.sql(`SELECT recipient_name FROM ot.mail WHERE org_id=${org} AND body='DEPTH-${depth}-BROADCAST' ORDER BY recipient_name`).map(r => r.recipient_name)
    record('deep broadcast reaches exact direct members', broadcast.ok && recipients.join(',') === 'leaf,victim,waiter,worker', { result: broadcast.text, recipients })
    const listener = await tool('leaf', 'orgtree_watchdog', { action: 'create', name: 'depth-listener', kind: 'project_listener', target: last, once: true, notice: true })
    const fire = await tool('boss', 'orgtree_project', { action: 'fire_event', name: last, body: `DEPTH-${depth}-EVENT` })
    const eventMail = rig.sql(`SELECT body FROM ot.mail WHERE org_id=${org} AND recipient_agent_id=${row('leaf').id} AND body LIKE '%DEPTH-${depth}-EVENT%'`)
    record('ancestor fires deepest project listener', listener.ok && fire.ok && eventMail.length === 1,
      { listener: listener.text, fire: fire.text, count: eventMail.length })
    const queue = await tool('worker', 'orgtree_watchdog', { action: 'create', name: 'depth-queue', kind: 'fair_queue', target: last, once: true, notice: true })
    await rig.userMail(last, `DEPTH-${depth}-QUEUE`, { notice: true })
    await rig.waitFor(() => rig.sql(`SELECT id FROM ot.mail WHERE org_id=${org} AND recipient_agent_id=${row('worker').id}
      AND extra->'via_project'->>'name'='${last}' AND body LIKE '%DEPTH-${depth}-QUEUE%'`).length === 1,
      { what: 'deep queue delivery', timeout: 10000 }).catch(() => null)
    const copies = rig.sql(`SELECT uid,extra FROM ot.mail WHERE org_id=${org} AND recipient_agent_id=${row('worker').id}
      AND extra->'via_project'->>'name'='${last}' AND body LIKE '%DEPTH-${depth}-QUEUE%'`)
    record('deep project queue delivers one original-derived copy', queue.ok && copies.length === 1, { queue: queue.text, copies })
    phase = 'retirement with full multi-slot release and FIFO'
    await op({ op: 'set_slots', node: last, capacity: 2 })
    const held = await tool('victim', 'orgtree_watchdog', { action: 'create', name: 'depth-hold', kind: 'slot', target: last, slots: 2 })
    const queued = await tool('waiter', 'orgtree_watchdog', { action: 'create', name: 'depth-wait', kind: 'slot', target: last })
    const retire = await tool('boss', 'orgtree_retire', { node: 'victim' })
    const leases = rig.sql(`SELECT a.name,l.uid,l.slot_count,l.ended_at,l.end_reason FROM ot.slot_leases l
      JOIN ot.agents a ON a.id=l.holder_agent_id WHERE l.project_id=${row(last).id} ORDER BY l.id`)
    record('ancestor retirement releases full lease and grants next claimant', held.ok && queued.ok && retire.ok
      && row('victim').state === 'archived' && leases.some(l => l.name === 'victim' && l.slot_count === 2 && l.ended_at && l.end_reason === 'retired')
      && leases.some(l => l.name === 'waiter' && !l.ended_at), { held: held.text, queued: queued.text, retire: retire.text, leases })
    phase = 'dissolve deep project subtree'
    const dissolve = await tool('boss', 'orgtree_dissolve', { node: 'p-0' })
    const liveBelow = rig.one(`SELECT count(*)::int AS n FROM ot.agents WHERE org_id=${org} AND state='live' AND name<>'boss' AND name<>'outsider'`).n
    const activeHolds = rig.one(`SELECT count(*)::int AS n FROM ot.slot_leases WHERE project_id=${row(last).id} AND ended_at IS NULL`).n
    record('dissolve reaches whole deep subtree and releases held slots', dissolve.ok && liveBelow === 0 && activeHolds === 0,
      { result: dissolve.text, liveBelow, activeHolds })
    record('unrelated root stays live and unchanged', row('outsider').state === 'live' && !row('outsider').halt)
    p.note('Stage B must exercise the integrated descendant DnD and 4.4.2 template save/create paths; neither is present at stage A base6ca1477.')
  } catch (error) {
    record(`${phase} completed within its bounded budget`, false, { error: error.stack ?? String(error), elapsedMs: Date.now() - started })
  } finally {
    p.file('timings.json', timings)
    if (rig?.dir) {
      try { p.file('engine-tail.log', rig.engineLog().split(/\r?\n/).slice(-200).join('\n')) } catch (error) { p.note('engine log unavailable', error.message) }
    }
    p.note('Physical depth is project-wrapper count; deepest agent is one edge below it.', { projectDepth: depth, elapsedMs: Date.now() - started, finalPhase: phase })
  }
  return p.summary()
}
