/**
 * M0 acceptance: the same diagnostician must work on both channels.
 *
 *   node scripts/smoke-channel.mjs edge
 *   node scripts/smoke-channel.mjs chrome
 */
import { apply } from '../index.js'

const channel = process.argv[2] === 'chrome' ? 'chrome' : 'edge'
const tools = new Map()
const ctx = {
  logger: { info: (...a) => console.log('[info]', ...a), warn: (...a) => console.warn('[warn]', ...a), error: (...a) => console.error('[error]', ...a) },
  tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
  effect: (fn) => { fn(); return () => {} }
}

apply(ctx, { browserChannel: channel, minIntervalMin: 0, hours: [0, 24] })

console.log('tools:', [...tools.keys()].join(', '))

const status = await tools.get('dy_status').execute({})
console.log('status.browser:', JSON.stringify(status.browser, null, 2))

const diag = await tools.get('dy_diagnose').execute({})
if (!diag.ok) {
  console.error(`FAIL(${channel}): ${diag.code} — ${diag.hint}`)
  await tools.get('dy_status').execute({ closeBrowser: true })
  process.exit(1)
}
console.log(`diagnose(${channel}): channel=${diag.channel} cards=${diag.probe?.cards} captcha=${diag.probe?.captchaVisible} loginModal=${diag.probe?.loginModal} url=${diag.probe?.url}`)
console.log('sample[0]:', diag.sample?.[0]?.text?.slice(0, 90))

await tools.get('dy_status').execute({ closeBrowser: true })
if (!diag.probe?.cards) {
  console.error('FAIL: no cards parsed')
  process.exit(1)
}
console.log(`OK ${channel}`)
