/**
 * M4 failure-path contract: every refusal must carry a machine `code` AND a
 * human `hint`. A quota that refuses silently is indistinguishable from a broken
 * plugin, so these are asserted rather than assumed.
 *
 * Codes covered: no-browser, outside-hours, cooldown, quota-rounds, quota-cards,
 * quota-minutes, quota-model-calls, needs-login.
 * NOT covered: captcha — it cannot be triggered on demand without waiting for a
 * real challenge, so it stays a manually-verified path (documented in DETAIL).
 *
 *   DSH_HOME=<tmp> node scripts/smoke-failures.mjs [chrome|edge]
 */
import { apply } from '../index.js'
import { checkQuota, dayKey, appendJournal } from '../lib/store.js'
import { checkBudget } from '../lib/policy.js'

const channel = process.argv[2] === 'chrome' ? 'chrome' : 'edge'
const fails = []
const ok = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`)
  else {
    console.error(`  FAIL ${msg}`)
    fails.push(msg)
  }
}
const wellFormed = (r, expectedCode, label) => {
  ok(r?.ok === false, `${label}: ok === false`)
  ok(r?.code === expectedCode, `${label}: code === ${expectedCode} (got ${r?.code})`)
  ok(typeof r?.hint === 'string' && r.hint.length > 10, `${label}: hint is actionable`)
  ok(typeof r?.error === 'string' && r.error.length > 4, `${label}: error is human readable`)
}

function build(config) {
  const tools = new Map()
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
    effect: (fn) => { fn(); return () => {} }
  }
  apply(ctx, config)
  return tools
}

// ---- 1) no-browser (live: a path that cannot exist) ----
const noBrowser = build({ browserChannel: 'chrome', chromePath: 'C:\\definitely-not\\here\\browser.exe', hours: [0, 24] })
const diag = await noBrowser.get('dy_diagnose').execute({})
console.log('no-browser:', JSON.stringify({ code: diag.code, hint: diag.hint }))
wellFormed(diag, 'no-browser', 'no-browser')

// ---- 2) pure quota gates ----
const at = new Date('2026-11-21T01:24:00')
const baseCfg = { hours: [8, 24], dailyRounds: 4, dailyCards: 40, minIntervalMin: 30 }
wellFormed(
  checkQuota(baseCfg, { cards: 0, rounds: 0, lastRunAt: 0 }, at),
  'outside-hours',
  'outside-hours'
)
wellFormed(
  checkQuota(baseCfg, { cards: 0, rounds: 4, lastRunAt: 0 }, new Date('2026-11-21T10:00:00')),
  'quota-rounds',
  'quota-rounds'
)
wellFormed(
  checkQuota(baseCfg, { cards: 40, rounds: 0, lastRunAt: 0 }, new Date('2026-11-21T10:00:00')),
  'quota-cards',
  'quota-cards'
)
wellFormed(
  checkQuota(baseCfg, { cards: 1, rounds: 1, lastRunAt: new Date('2026-11-21T10:00:00').getTime() }, new Date('2026-11-21T10:05:00')),
  'cooldown',
  'cooldown'
)

// ---- 3) budget gates (derived from the journal) ----
appendJournal([{ surface: 'watch', action: 'watch_play', ok: true, code: 'ok', cost: { modelCalls: 1, watchSeconds: 600 } }])
const budgetCfg = { dailyModelCalls: 0, dailyMinutes: 180 }
wellFormed(checkBudget(budgetCfg, dayKey()), 'quota-model-calls', 'quota-model-calls')
wellFormed(checkBudget({ dailyModelCalls: 999, dailyMinutes: 0 }, dayKey()), 'quota-minutes', 'quota-minutes')

// ---- 4) needs-login (live: search is login-gated) ----
const live = build({ browserChannel: channel, enableKb: true, hours: [0, 24] })
const search = await live.get('kb_search').execute({ keyword: '测试', limit: 3 })
console.log('needs-login:', JSON.stringify({ code: search.code }))
if (search.ok) {
  console.log('  (account is signed in; needs-login path not exercised)')
} else {
  wellFormed(search, 'needs-login', 'needs-login')
}
await live.get('dy_status').execute({ closeBrowser: true })

console.log('\nnote: captcha is a manual-only path (cannot be triggered on demand)')

if (fails.length) {
  console.error(`\n${fails.length} check(s) failed`)
  process.exit(1)
}
console.log(`\nOK failures (${channel})`)
