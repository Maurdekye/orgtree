// Proof: a click on a provider card's model chip changes what can be hired,
// without the edit form (user 2026-10-10 17:56Z: "i should be able to click to
// change the models available without editing the entry"; 17:56:51Z: "do this
// for both openrouter and language servers, if there are many models selected
// at once (say >8) then only show their icons, omit their names"). Settings
// only: no agent turn, no model, no network. The language servers are
// tools/rig/fakellm.mjs; OpenRouter is rig mode's canned key check and canned
// catalog (rig-home\rig-usage\openrouter-key.json, openrouter-models.json).
//   0. the canned catalog: the picker's search lists it, and a favorite can be
//      added from it (rig mode had no catalog before);
// With the UI (--ui <dir>), App settings › Providers, clicked as the user would:
//   1. the user's own Ollama (two Qwen 3.6 offered, two Qwen 3.8 not): every
//      model a chip, the two not offered dimmed; a click offers the 64K Qwen 3.8
//      and another withdraws the plain Qwen 3.6, each saved at once (the
//      engine's list says so) with no edit form or browser; the hire offers follow;
//   2. a server that is not answering: the card says so, and its chips still switch;
//   3. ten of twelve offered: every chip is its card alone, the name in its tooltip;
//   4. a server listing 302 models: its two chips and "+300 more", which opens
//      the browser saving each change at once;
//   5. OpenRouter with nine favorites: cards alone; a click deselects one at
//      once (at eight the names come back, and the chip stays, dimmed), a
//      second click selects it again in its place; "+" opens the picker, and a
//      pick there adds a chip;
//   6. screenshots on the dark and the light theme.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/provider-chips.mjs --ui <dir>

import fs from 'node:fs'
import path from 'node:path'

import { runDesktop } from '../desktop.mjs'
import { startFakeLlm } from '../fakellm.mjs'
import { RIG_DIR } from '../lib.mjs'
import { Proof } from '../proof.mjs'

const QWEN = 'qwen3.6-35b-a3b:latest', QWEN64 = 'qwen3.6-35b-a3b:latest-64k'
const Q38 = 'qwen3.8-27b:latest', Q38V = 'qwen3.8-27b:latest-64k'
const CAPS = ['completion', 'tools', 'thinking']
const qwen = (name, extra) => ({ name, context: 262144, size: 13.2e9, family: 'qwen35moe', params: '34.7B', quant: 'IQ3_XXS', capabilities: CAPS, ...extra })

/** the canned OpenRouter catalog (GET /api/v1/models): twelve models; the first nine are the favorites */
const CATALOG = [
  ['anthropic/claude-sonnet-5', 'Anthropic: Claude Sonnet 5'], ['openai/gpt-5.6-luna', 'OpenAI: GPT-5.6 Luna'],
  ['moonshotai/kimi-k3', 'MoonshotAI: Kimi K3'], ['google/gemini-3-pro', 'Google: Gemini 3 Pro'],
  ['x-ai/grok-5', 'xAI: Grok 5'], ['deepseek/deepseek-v4', 'DeepSeek: DeepSeek V4'],
  ['mistralai/mistral-large-3', 'Mistral: Mistral Large 3'], ['z-ai/glm-5.2', 'Z.AI: GLM 5.2'],
  ['minimax/minimax-m3', 'MiniMax: MiniMax M3'], ['xiaomi/mimo-v2.6-pro', 'Xiaomi: MiMo V2.6 Pro'],
  ['meta-llama/llama-5-70b', 'Meta: Llama 5 70B'], ['qwen/qwen3.6-max', 'Qwen: Qwen3.6 Max'],
].map(([id, name], i) => ({
  id, name, created: 1760000000 - i * 86400, context_length: 200000,
  pricing: { prompt: String((i + 1) / 1e6), completion: String((i + 1) * 5 / 1e6) },
  supported_parameters: ['tools', 'reasoning'], architecture: { input_modalities: ['text'], output_modalities: ['text'] },
}))
const FAVORITES = CATALOG.slice(0, 9).map((m) => m.id)

export async function setup() {
  return {
    name: 'provider-chips',
    fixture: { org: { name: 'Provider chips' }, agents: [{ name: 'boss', tier: 'opus', grant: 24 }],
      scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } },
    prepare: async ({ data }) => {
      const dir = path.join(data, 'rig-home', 'rig-usage')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'openrouter-key.json'), JSON.stringify({ status: 200, data: { label: 'rig key', limit: null,
        limit_remaining: null, limit_reset: null, usage: 1, usage_daily: 0, usage_weekly: 0, usage_monthly: 1, is_free_tier: false,
        total_credits: 10, total_usage: 1 } }))
      fs.writeFileSync(path.join(dir, 'openrouter-models.json'), JSON.stringify({ data: CATALOG }))
    },
  }
}

export default async function (rig) {
  const p = new Proof('provider-chips')
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns', timeout: 60000 })

  // ------------------------------------------------------------ 0. the canned catalog
  await rig.api('PUT', '/api/openrouter/key', { key: 'sk-or-rig-not-a-real-key' })
  const page = await rig.api('GET', '/api/openrouter/models?q=&offset=0&limit=25')
  for (const id of FAVORITES) await rig.api('PUT', '/api/openrouter/favorites', { id, selected: true })
  const or0 = await rig.api('GET', '/api/openrouter')
  p.check('0. rig mode serves the canned OpenRouter catalog: the picker lists its 12 models, and 9 favorites are added from it',
    page.total === 12 && (page.items ?? []).length === 12 && JSON.stringify((or0.tiers ?? []).map((t) => t.model)) === JSON.stringify(FAVORITES),
    { total: page.total, first: page.items?.[0]?.id, favorites: (or0.tiers ?? []).map((t) => t.model), connected: or0.connected })

  const user = await startFakeLlm({ log: path.join(p.dir, 'fakellm-user.jsonl'), models: [
    qwen(QWEN, { running: 4096 }), qwen(QWEN64, { num_ctx: 65536 }),
    qwen(Q38, { size: 10.2e9, family: 'qwen3', params: '27B' }), qwen(Q38V, { size: 10.2e9, family: 'qwen3', params: '27B', num_ctx: 65536 }),
  ] })
  const TWELVE = Array.from({ length: 12 }, (_, i) => `${['gemma', 'llama', 'mistral', 'phi', 'qwen', 'deepseek'][i % 6]}-${i}:latest`)
  const twelve = await startFakeLlm({ log: path.join(p.dir, 'fakellm-twelve.jsonl'),
    models: TWELVE.map((name, i) => ({ name, context: 131072, num_ctx: 65536, size: (2 + i) * 1e9, capabilities: CAPS })) })
  const many = await startFakeLlm({ log: path.join(p.dir, 'fakellm-302.jsonl'), models: [
    qwen(QWEN, { running: 4096 }), qwen(QWEN64, { num_ctx: 65536 }),
    ...Array.from({ length: 300 }, (_, i) => ({ name: `model-${String(i).padStart(3, '0')}:7b`, context: [32768, 65536, 131072, 262144][i % 4],
      size: (1 + (i % 30)) * 1e9, params: '7B', capabilities: ['completion', ...(i % 2 ? [] : ['tools']), ...(i % 3 ? [] : ['thinking'])] })),
  ] })
  try {
    const add = (label, address, ids) => rig.api('POST', '/api/langservers', { preset: 'ollama', address, harness: 'claude-code', label,
      models: ids.map((id) => ({ id, context: 65536 })) })
    const cards = { user: 'Ollama', down: 'Office GPU', ten: 'Twelve models', many: 'Many models' }
    await add(cards.user, user.url, [QWEN, QWEN64])
    await add(cards.down, 'http://127.0.0.1:9', ['llama-4-scout:latest', QWEN])
    await add(cards.ten, twelve.url, TWELVE.slice(0, 10))
    await add(cards.many, many.url, [QWEN, QWEN64])
    if (!rig.run.ui) {
      p.note('no renderer bundle for this run (--ui): the cards were not clicked')
      return p.summary()
    }
    const seen = await runDesktop(rig, path.join(RIG_DIR, 'desktop', 'provider-chips.cjs'), { preset: 'tall', out: path.join(p.dir, 'desktop'),
      timeout: 240000, args: { cards, q38v: Q38V, qwen: QWEN, downModel: 'llama-4-scout:latest', model0: 'model-000:7b',
        manyMoreAfter: '+299 more', orFirst: 'claude-sonnet-5', orPickName: 'MiMo V2.6 Pro' } })
    const v = seen.value ?? {}
    p.check('the page script ran to the end without console errors', seen.ok === true && (seen.consoleErrors ?? []).length === 0,
      { error: seen.error ?? null, consoleErrors: seen.consoleErrors ?? [] })
    const names = (row) => (row?.chips ?? []).map((c) => c.name)
    const ons = (row) => (row?.chips ?? []).map((c) => c.on)
    const dim = (c) => Number(c.opacity) < 0.7 && c.border === 'dashed'
    const lit = (c) => Number(c.opacity) === 1 && c.border === 'solid'
    const ids = (list) => (list ?? []).map((m) => m.id)

    const u0 = v.start?.user
    p.check('1. the user\'s Ollama card shows all four models the server lists as chips, the two Qwen 3.8 not offered dimmed and '
      + 'dashed, then "+" for the browser; nothing open', JSON.stringify(names(u0)) === JSON.stringify([QWEN, QWEN64, Q38, Q38V])
      && JSON.stringify(ons(u0)) === JSON.stringify([true, true, false, false]) && lit(u0.chips[0]) && lit(u0.chips[1])
      && dim(u0.chips[2]) && dim(u0.chips[3]) && u0.more === '+' && !u0.icons && !u0.editing && !u0.browser, u0)
    const o1 = v.afterOffer
    p.check('1. a click on the dimmed 64K Qwen 3.8 offers it at once: the engine lists it offered with its Modelfile\'s 64K window; '
      + 'no edit form, no browser', JSON.stringify(ids(o1?.offered)) === JSON.stringify([QWEN, QWEN64, Q38V])
      && o1.offered.find((m) => m.id === Q38V)?.told === 65536 && JSON.stringify(ons(o1.row)) === JSON.stringify([true, true, false, true])
      && !o1.row.editing && !o1.row.browser, o1)
    const w1 = v.afterWithdraw
    p.check('1. a click on the lit Qwen 3.6 withdraws it at once; its chip stays in its place, dimmed',
      JSON.stringify(ids(w1?.offered)) === JSON.stringify([QWEN64, Q38V]) && JSON.stringify(names(w1.row)) === JSON.stringify([QWEN, QWEN64, Q38, Q38V])
      && JSON.stringify(ons(w1.row)) === JSON.stringify([false, true, false, true]) && dim(w1.row.chips[0]) && !w1.row.editing, w1)
    const servers = (await rig.api('GET', '/api/langservers')).servers ?? []
    const su = servers.find((s) => s.label === cards.user)
    const lane = ((await rig.api('GET', '/api/providers')).providers ?? []).find((x) => x.id === 'langserver')
    const tiers = (lane?.tiers ?? []).map((t) => t.tier)
    p.check('1. the hire offers follow: the 64K Qwen 3.8 is a hireable tier, the withdrawn Qwen 3.6 is not',
      !!su?.models?.[Q38V]?.tier && tiers.includes(su.models[Q38V].tier) && !tiers.includes(su?.models?.[QWEN]?.tier),
      { q38v: su?.models?.[Q38V]?.tier, qwen: su?.models?.[QWEN]?.tier, tiers })

    const d0 = v.start?.down
    p.check('2. a server that is not answering: the card says so and offers no "+", and a click still withdraws one of its models',
      (d0?.digest ?? []).some((x) => /^not answering: nothing is answering at that address/.test(x)) && d0.more === null
      && JSON.stringify(names(d0)) === JSON.stringify(['llama-4-scout:latest', QWEN])
      && JSON.stringify(ids(v.down?.offered)) === JSON.stringify([QWEN]) && JSON.stringify(ons(v.down?.row)) === JSON.stringify([false, true]),
      { start: d0, after: v.down })

    const t0 = v.start?.ten
    p.check('3. ten of twelve offered: every chip is its card alone (no names), the name in its label and tooltip; the two not '
      + 'offered dimmed; "+" alone', t0?.icons === true && (t0.chips ?? []).length === 12 && ons(t0).filter(Boolean).length === 10
      && JSON.stringify(names(t0)) === JSON.stringify([...TWELVE].sort((a, b) => a.localeCompare(b)))
      && t0.chips.every((c) => c.title?.startsWith(`${c.name} · `)) && t0.chips.filter((c) => !c.on).every(dim) && t0.more === '+',
      t0)

    const m0 = v.start?.many
    p.check('4. a server listing 302 models: its two offered chips and "+300 more"',
      JSON.stringify(names(m0)) === JSON.stringify([QWEN, QWEN64]) && m0.more === '+300 more' && !m0.icons, m0)
    p.check('4. "+300 more" opens the browser, which says it saves each change at once; an offer there is saved at once, '
      + 'without the edit form, and the card follows', v.browser?.title === 'Models on Many models · 2 offered · each change is saved at once'
      && v.browser.after === 'Models on Many models · 3 offered · each change is saved at once' && v.browser.editing === false
      && ids(v.browser.offered).includes('model-000:7b') && JSON.stringify(ons(v.many)) === JSON.stringify([true, true, true])
      && v.many?.more === '+299 more', { browser: v.browser, card: v.many })

    const r0 = v.or?.start
    p.check('5. OpenRouter with nine favorites: nine lit chips, each its card alone with the name in its tooltip; "+" alone',
      r0?.icons === true && (r0.chips ?? []).length === 9 && r0.chips.every((c) => c.on && lit(c)) && r0.more === '+'
      && r0.chips[0]?.name === 'claude-sonnet-5' && /^claude-sonnet-5 · Claude Sonnet 5 — anthropic · /.test(r0.chips[0]?.title ?? ''),
      r0)
    const rd = v.or?.deselected
    p.check('5. a click deselects a favorite at once: eight left, so the names come back; its chip stays first, dimmed',
      JSON.stringify(rd?.favorites) === JSON.stringify(FAVORITES.slice(1)) && rd.row.icons === false && rd.row.chips.length === 9
      && rd.row.chips[0]?.name === 'claude-sonnet-5' && rd.row.chips[0]?.on === false && dim(rd.row.chips[0])
      && rd.row.chips.slice(1).every((c) => c.on), rd)
    const rr = v.or?.reselected
    p.check('5. a second click selects it again, in its place (the engine appends it, the row does not jump); nine: cards alone again',
      (rr?.favorites ?? []).length === 9 && rr.favorites.includes(FAVORITES[0]) && rr.row.icons === true
      && rr.row.chips[0]?.name === 'claude-sonnet-5' && rr.row.chips.every((c) => c.on), rr)
    p.check('5. "+" opens the picker over the canned catalog; a pick there is saved at once and adds a chip',
      (v.or?.picked?.favorites ?? []).includes('xiaomi/mimo-v2.6-pro') && (v.or?.end?.chips ?? []).length === 10
      && v.or.end.chips.every((c) => c.on) && v.or.end.chips.at(-1)?.name === 'mimo-v2.6-pro', { picked: v.or?.picked, end: v.or?.end })
    const l0 = v.light?.user
    p.check('6. the light theme shows the same chips, the withdrawn and the not offered ones dimmed',
      JSON.stringify(ons(l0)) === JSON.stringify([false, true, false, true]) && l0.chips.filter((c) => !c.on).every(dim)
      && l0.chips.filter((c) => c.on).every(lit), l0)
    p.note('screenshots', (seen.shots ?? []).map((s) => path.basename(s.file)))
  } finally {
    await user.close()
    await twelve.close()
    await many.close()
  }
  return p.summary()
}
