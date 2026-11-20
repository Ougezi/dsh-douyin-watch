/**
 * Pre-install smoke test.
 *
 * Loads the plugin exactly as the Loader would (apply + tool registration) with
 * a fake ctx, then drives a real round against the live Douyin page. This is the
 * gate before `plugin_manager install_bundle`: a broken module here costs a
 * Node run, a broken module in the profile costs a DSH restart.
 *
 *   node scripts/smoke.mjs            # full: diagnose + watch 2 cards + report
 *   node scripts/smoke.mjs --probe    # probe only, no watch, no quota consumed
 */
import { apply } from '../index.js'

const probeOnly = process.argv.includes('--probe')

const tools = new Map()
const ctx = {
  logger: {
    info: (...a) => console.log('[info]', ...a),
    warn: (...a) => console.warn('[warn]', ...a),
    error: (...a) => console.error('[error]', ...a)
  },
  tools: {
    register(tool) {
      tools.set(tool.name, tool)
      return () => tools.delete(tool.name)
    }
  },
  effect(fn) {
    fn()
    return () => {}
  }
}

const t0 = Date.now()
apply(ctx, { dailyCards: 40, dailyRounds: 4, minIntervalMin: 0, hours: [0, 24], cardsPerRound: 2 })

console.log(`registered tools: ${[...tools.keys()].join(', ')}`)
if (tools.size !== 4) {
  console.error(`FAIL: expected 4 tools, got ${tools.size}`)
  process.exit(1)
}
for (const [name, tool] of tools) {
  if (typeof tool.execute !== 'function') {
    console.error(`FAIL: ${name} has no execute()`)
    process.exit(1)
  }
  if (!tool.description || tool.description.length < 20) {
    console.error(`FAIL: ${name} has no usable description`)
    process.exit(1)
  }
}

const status = await tools.get('dy_status').execute({})
console.log('status:', JSON.stringify(status, null, 2))

if (probeOnly) {
  const diag = await tools.get('dy_diagnose').execute({})
  console.log('diagnose:', JSON.stringify(diag, null, 2).slice(0, 3000))
  await tools.get('dy_status').execute({ closeBrowser: true })
  console.log(`OK (probe only) in ${Date.now() - t0}ms`)
  process.exit(0)
}

const diag = await tools.get('dy_diagnose').execute({})
if (!diag || !diag.ok) {
  console.error('FAIL: diagnose refused:', JSON.stringify(diag, null, 2))
  process.exit(1)
}
console.log('diagnose probe:', JSON.stringify(diag.probe, null, 2))
console.log('diagnose sample:', JSON.stringify(diag.sample ?? [], null, 2).slice(0, 1200))

const round = await tools.get('dy_watch').execute({ cards: 2 })
console.log('watch:', JSON.stringify(round, null, 2).slice(0, 3000))
if (!round.ok) {
  console.error(`FAIL: watch refused: ${round.code} — ${round.hint}`)
  process.exit(1)
}
if (round.watched === 0) {
  console.error('FAIL: watch returned 0 cards (parser or selectors are wrong)')
  process.exit(1)
}
if (!round.covers) {
  console.error('WARN: no cover screenshots captured')
}

const report = await tools.get('dy_report').execute({})
console.log('report file:', report.file)
console.log('--- report excerpt ---')
console.log(String(report.markdown).split('\n').slice(0, 24).join('\n'))

await tools.get('dy_status').execute({ closeBrowser: true })
console.log(`OK in ${Date.now() - t0}ms`)
