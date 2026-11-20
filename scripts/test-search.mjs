/**
 * kb_search classification: it must never return a fake empty success, and it
 * must tell three situations apart — login wall, upstream error, structure change.
 *
 * Douyin's search is currently login-gated, so on a fresh profile we expect
 * `needs-login`. A transient `502 Bad Gateway` must surface as `upstream-error`
 * (measured 2026-11-21: kngx/1.10.2), not as "no results".
 *
 *   DSH_HOME=<tmp> node scripts/test-search.mjs [chrome|edge]
 */
import { apply } from '../index.js'

const channel = process.argv[2] === 'chrome' ? 'chrome' : 'edge'
const tools = new Map()
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: console.error },
  tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
  effect: (fn) => { fn(); return () => {} }
}
apply(ctx, { browserChannel: channel, enableKb: true, hours: [0, 24] })

const fails = []
const ok = (c, m) => {
  if (c) console.log(`  ok   ${m}`)
  else {
    console.error(`  FAIL ${m}`)
    fails.push(m)
  }
}

const res = await tools.get('kb_search').execute({ keyword: '美食', limit: 5 })
const known = ['needs-login', 'upstream-error', 'no-results', 'no-results-parsed']
console.log('kb_search:', res.ok ? `ok count=${res.count}` : `code=${res.code}`)
if (!res.ok) {
  console.log('  state:', JSON.stringify(res.state ?? {}))
  console.log('  sample:', String(res.sample ?? '').slice(0, 160))
}

// The core contract: never a silent empty success.
if (res.ok) {
  ok((res.count ?? 0) > 0, 'logged-in search returned results')
} else {
  ok(known.includes(res.code), `refusal code is one of the known kinds (got ${res.code})`)
  ok(typeof res.hint === 'string' && res.hint.length > 10, 'refusal carries an actionable hint')
  ok(typeof res.sample === 'string' && res.sample.length > 0, 'refusal carries the page sample for diagnosis')
}

// A junk keyword must be rejected before touching the browser.
const empty = await tools.get('kb_search').execute({ keyword: '   ' })
ok(empty.ok === false && empty.code === 'invalid-argument', 'blank keyword is rejected as invalid-argument')
ok(typeof empty.hint === 'string' && empty.hint.length > 5, 'invalid-argument carries a hint')

await tools.get('dy_status').execute({ closeBrowser: true })

if (fails.length) {
  console.error(`\n${fails.length} check(s) failed`)
  process.exit(1)
}
console.log(`\nOK search (${channel})`)
