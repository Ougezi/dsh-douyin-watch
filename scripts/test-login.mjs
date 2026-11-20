/**
 * dy_login contract: it must open the browser, report a boolean login state, and
 * always give a next step. It must never claim success on a fresh profile.
 *
 *   DSH_HOME=<tmp> node scripts/test-login.mjs [chrome|edge]
 */
import { apply } from '../index.js'

const channel = process.argv[2] === 'chrome' ? 'chrome' : 'edge'
const tools = new Map()
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: console.error },
  tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
  effect: (fn) => { fn(); return () => {} }
}
apply(ctx, { browserChannel: channel, hours: [0, 24] })

const fails = []
const ok = (c, m) => {
  if (c) console.log(`  ok   ${m}`)
  else {
    console.error(`  FAIL ${m}`)
    fails.push(m)
  }
}

if (!tools.has('dy_login')) {
  console.error('FAIL: dy_login not registered')
  process.exit(1)
}

const res = await tools.get('dy_login').execute({})
console.log('dy_login:', JSON.stringify({ ok: res.ok, code: res.code, signedIn: res.signedIn, sessionCookies: res.sessionCookies, loginModalVisible: res.loginModalVisible, channel: res.channel, profileDir: res.profileDir }, null, 2))

// Always leave the browser closed, even when an assertion below fails, so a
// failing run cannot poison the next one.
await tools.get('dy_status').execute({ closeBrowser: true })
ok(res.ok === true, 'dy_login ok')
ok(typeof res.signedIn === 'boolean', 'reports signedIn as a boolean')
ok(typeof res.hint === 'string' && res.hint.length > 10, 'always gives a next step')
ok(res.browserOpen === true, 'browser is left open for the user to scan')
ok(res.signedIn === false, 'fresh profile is honestly reported as signed out')

await tools.get('dy_status').execute({ closeBrowser: true })

if (fails.length) {
  console.error(`\n${fails.length} check(s) failed`)
  process.exit(1)
}
console.log(`\nOK login (${channel})`)
