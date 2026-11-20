/**
 * M2 acceptance: play mode opens real players, records durations, keeps frames,
 * and spends the model-call budget instead of pretending to be free.
 *
 *   DSH_HOME=<tmp> node scripts/smoke-play.mjs [chrome|edge]
 */
import fs from 'node:fs'
import { apply } from '../index.js'

const channel = process.argv[2] === 'chrome' ? 'chrome' : 'edge'
const tools = new Map()
const ctx = {
  logger: { info: (...a) => console.log('[info]', ...a), warn: (...a) => console.warn('[warn]', ...a), error: (...a) => console.error('[error]', ...a) },
  tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
  effect: (fn) => { fn(); return () => {} }
}

apply(ctx, {
  browserChannel: channel,
  enableKb: true,
  minIntervalMin: 0,
  hours: [0, 24],
  dailyMinutes: 180,
  dailyModelCalls: 120,
  cardsPerRound: 3,
  playSeekTo: 3
})

const fails = []
const ok = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`)
  else {
    console.error(`  FAIL ${msg}`)
    fails.push(msg)
  }
}

const before = await tools.get('dy_status').execute({})
console.log('before budget:', JSON.stringify(before.budget.bySurface ?? {}), 'modelCalls=', before.budget.modelCalls)

const round = await tools.get('dy_watch').execute({ mode: 'play', cards: 2 })
console.log('round:', JSON.stringify({ ok: round.ok, code: round.code, mode: round.mode, watched: round.watched, covers: round.covers, modelCalls: round.modelCalls, watchedMinutes: round.watchedMinutes, playFailures: round.playFailures }))
if (!round.ok) {
  console.error(`  ${round.code}: ${round.error} / ${round.hint}`)
}

ok(round.ok === true, 'dy_watch(play) ok')
ok(round.mode === 'play', 'mode echoed as play')
ok((round.watched ?? 0) >= 1, 'at least one video watched')
ok((round.videos ?? []).some((v) => v.modalId), 'at least one video got a modalId')
ok((round.videos ?? []).some((v) => Number(v.durationSec) > 0), 'at least one duration recorded')
ok((round.covers ?? 0) >= 1, 'at least one frame captured')
ok((round.modelCalls ?? 0) >= 1, 'model call budget charged for frames')
ok((round.watchedMinutes ?? 0) > 0, 'watchedMinutes reported')

for (const v of round.videos ?? []) {
  if (v.frame) ok(fs.existsSync(v.frame), `frame exists: ${v.frame.split(/[\\/]/).pop()}`)
}

const status = await tools.get('dy_status').execute({})
console.log('after budget:', JSON.stringify(status.budget))
ok(status.budget.modelCalls >= 1, 'journal budget reflects model calls')
ok(status.budget.watchSeconds > 0, 'journal budget reflects watched seconds')

const report = await tools.get('dy_report').execute({})
console.log('report excerpt:')
console.log(String(report.markdown).split('\n').slice(0, 8).join('\n'))
ok(String(report.markdown).includes('打开的视频总时长'), 'report mentions total opened duration')
ok(/抓帧 \d+ 张/.test(String(report.markdown)), 'report reports frame count')

// ---- cards mode must stay free: no model call, no minutes ----
const beforeCards = await tools.get('dy_status').execute({})
const cardsRound = await tools.get('dy_watch').execute({ mode: 'cards', cards: 1 })
console.log('cards round:', JSON.stringify({ ok: cardsRound.ok, code: cardsRound.code, mode: cardsRound.mode, watched: cardsRound.watched, modelCalls: cardsRound.modelCalls }))
const afterCards = await tools.get('dy_status').execute({})
ok(cardsRound.ok === true, 'cards-mode round ok')
ok(cardsRound.modelCalls === 0, 'cards mode spends 0 model calls')
ok(afterCards.budget.modelCalls === beforeCards.budget.modelCalls, 'budget modelCalls unchanged by cards mode')
ok(afterCards.budget.watchSeconds === beforeCards.budget.watchSeconds, 'budget watchSeconds unchanged by cards mode')

await tools.get('dy_status').execute({ closeBrowser: true })

if (fails.length) {
  console.error(`\n${fails.length} check(s) failed`)
  process.exit(1)
}
console.log(`\nOK ${channel}`)
