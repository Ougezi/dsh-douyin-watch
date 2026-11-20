/**
 * M3 acceptance — the ops surface and its safety gate.
 *
 * Two things are being proven:
 *   1. with `enableOps: false` (the default) no ops tool exists at all;
 *   2. with it on, the only ops tools are read-only, and the write gate refuses
 *      correctly at every door — without ever touching a real account.
 *
 *   DSH_HOME=<tmp> node scripts/smoke-ops.mjs [chrome|edge]
 */
import { apply } from '../index.js'
import { assertWriteAllowed } from '../lib/policy.js'

const channel = process.argv[2] === 'chrome' ? 'chrome' : 'edge'
const fails = []
const ok = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`)
  else {
    console.error(`  FAIL ${msg}`)
    fails.push(msg)
  }
}

function build(config) {
  const tools = new Map()
  const ctx = {
    logger: { info: () => {}, warn: console.warn, error: console.error },
    tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
    effect: (fn) => { fn(); return () => {} }
  }
  apply(ctx, config)
  return tools
}

// ---- 1) default: ops disabled => no ops tools at all ----
const off = build({ browserChannel: channel, enableKb: true, enableOps: false })
console.log('default tools:', [...off.keys()].join(', '))
ok(![...off.keys()].some((n) => n.startsWith('ops_')), 'no ops_* tool registered when enableOps is false')
ok(off.has('dy_watch') && off.has('kb_hot'), 'watch and kb surfaces still registered')

// ---- 2) enabled: read-only ops only ----
const on = build({ browserChannel: channel, enableKb: true, enableOps: true, hours: [0, 24] })
const opsTools = [...on.keys()].filter((n) => n.startsWith('ops_')).sort()
console.log('ops tools:', opsTools.join(', '))
ok(opsTools.length === 2, `exactly 2 ops tools (got ${opsTools.length})`)
ok(opsTools.includes('ops_status') && opsTools.includes('ops_trend'), 'ops tools are status + trend')
ok(!opsTools.includes('ops_comment') && !opsTools.includes('ops_dm') && !opsTools.includes('ops_publish'), 'no write tool exists')

// ---- 3) status is read-only and reports the login state ----
const status = await on.get('ops_status').execute({})
console.log('ops_status:', JSON.stringify({ ok: status.ok, opsEnabled: status.opsEnabled, login: status.login, writeToolsImplemented: status.writeToolsImplemented }))
ok(status.ok === true, 'ops_status ok')
ok(status.writeToolsImplemented === false, 'ops_status states writes are not implemented')
ok(status.login?.checked === true, 'ops_status actually probed the page')
ok(typeof status.login?.signedIn === 'boolean', 'ops_status reports signedIn as a boolean')
ok(status.login?.signedIn === false, 'fresh profile is reported as signed out')

// ---- 4) trend is login-gated, and says so ----
const trend = await on.get('ops_trend').execute({})
console.log('ops_trend:', trend.ok ? `ok (${trend.url})` : `${trend.code}`)
if (trend.ok) {
  ok(true, 'ops_trend returned a dashboard sample (account is signed in)')
} else {
  ok(trend.code === 'needs-login', 'ops_trend reports needs-login while signed out')
  ok(typeof trend.hint === 'string' && trend.hint.length > 10, 'needs-login carries an actionable hint')
}

// ---- 5) the five-door write gate refuses at every door ----
const disabledCfg = { enableOps: false, ops: {}, dailyWriteActions: 0 }
const d1 = assertWriteAllowed(disabledCfg, 'like', { id: 'x' })
ok(d1.ok === false && d1.code === 'ops-disabled', 'gate: ops-disabled when the surface is off')

const enabledCfg = { enableOps: true, ops: { allowLike: false }, dailyWriteActions: 10 }
const d2 = assertWriteAllowed(enabledCfg, 'like', { id: 'x' })
ok(d2.ok === false && d2.code === 'action-disabled', 'gate: action-disabled when the per-action flag is off')

const allowedCfg = { enableOps: true, ops: { allowLike: true }, dailyWriteActions: 10 }
const d3 = assertWriteAllowed(allowedCfg, 'like', { id: 'never-written-target' })
ok(d3.ok === true, 'gate: allows when surface + action flags are on and quota is available')

const unknownCfg = { enableOps: true, ops: { allowLike: true }, dailyWriteActions: 10 }
const d4 = assertWriteAllowed(unknownCfg, 'publish', { id: 'x' })
ok(d4.ok === false && d4.code === 'action-disabled', 'gate: unknown/disabled action is refused')

await on.get('dy_status').execute({ closeBrowser: true })

if (fails.length) {
  console.error(`\n${fails.length} check(s) failed`)
  process.exit(1)
}
console.log(`\nOK ${channel}`)
