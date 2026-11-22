/**
 * dsh-douyin-watch — one browser substrate, three capability surfaces.
 *
 *   A  watch  `dy_*`   autonomous watching (read + local report)
 *   C  kb     `kb_*`   read-only knowledge source        (planned, M1)
 *   B  ops    `ops_*`  account operations (write)        (planned, M3)
 *
 * Design notes:
 *  - It drives its own browser through CDP instead of borrowing another plugin's
 *    runtime. A shared runtime breaks silently whenever that plugin updates; this
 *    module only needs Node 22+ (global WebSocket) and a browser (Chrome or Edge,
 *    both Chromium, verified on Edge 157).
 *  - Its own profile per browser channel, so a one-time Dy login survives and a
 *    login in Chrome is never assumed present in Edge.
 *  - Every refusal carries a machine `code` and a human `hint`; a quota that
 *    refuses silently is indistinguishable from a broken plugin.
 *  - A capability that is off must be ABSENT, not present-but-refusing: register
 *    only the surfaces that are enabled.
 */
import { findBrowser, resolveBrowser } from './lib/cdp.js'
import * as store from './lib/store.js'
import * as session from './lib/session.js'
import { capabilities } from './lib/policy.js'
import { buildWatchTools } from './lib/surfaces/watch.js'
import { buildKbTools } from './lib/surfaces/kb.js'
import { buildOpsTools } from './lib/surfaces/ops.js'
import { buildExtTools } from './lib/surfaces/ext.js'
import { clampInt } from './lib/tool-util.js'

export const inject = ['tools']

const DEFAULTS = {
  cardsPerRound: 10,
  dailyCards: 40,
  dailyRounds: 4,
  minIntervalMin: 30,
  hours: [8, 24],
  headless: false,
  chromePath: '',
  scrollRounds: 4,
  scrollStepPx: 700,
  // play mode (M2)
  playSeekTo: 2,
  playFrame: true,
  // M0 additions
  browserChannel: 'auto',
  dailyMinutes: 180,
  dailyModelCalls: 120,
  enableKb: true,
  enableDownload: true,
  enableUser: true,
  enableSearchUser: true,
  enableExport: true,
  enableBatch: true,
  enableAccounts: true,
  enableOps: false,
  dailyWriteActions: 0,
  ops: {
    allowLike: false,
    allowComment: false,
    allowReply: false,
    allowDm: false,
    allowPublish: false
  }
}

const CHANNELS = new Set(['auto', 'chrome', 'edge', 'chromium'])

function resolveConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  cfg.cardsPerRound = clampInt(cfg.cardsPerRound, 1, 40, DEFAULTS.cardsPerRound)
  cfg.dailyCards = clampInt(cfg.dailyCards, 1, 500, DEFAULTS.dailyCards)
  cfg.dailyRounds = clampInt(cfg.dailyRounds, 1, 50, DEFAULTS.dailyRounds)
  cfg.minIntervalMin = clampInt(cfg.minIntervalMin, 0, 1440, DEFAULTS.minIntervalMin)
  cfg.scrollRounds = clampInt(cfg.scrollRounds, 1, 12, DEFAULTS.scrollRounds)
  cfg.dailyMinutes = clampInt(cfg.dailyMinutes, 0, 1440, DEFAULTS.dailyMinutes)
  cfg.dailyModelCalls = clampInt(cfg.dailyModelCalls, 0, 10000, DEFAULTS.dailyModelCalls)
  cfg.dailyWriteActions = clampInt(cfg.dailyWriteActions, 0, 200, DEFAULTS.dailyWriteActions)
  cfg.playSeekTo = clampInt(cfg.playSeekTo, 0, 3600, DEFAULTS.playSeekTo)
  cfg.playFrame = cfg.playFrame !== false
  const h = Array.isArray(cfg.hours) && cfg.hours.length === 2 ? cfg.hours.map(Number) : DEFAULTS.hours
  cfg.hours = [clampInt(h[0], 0, 23, 8), clampInt(h[1], 1, 24, 24)]
  if (cfg.hours[1] <= cfg.hours[0]) cfg.hours = [cfg.hours[0], 24]
  cfg.headless = cfg.headless === true
  cfg.chromePath = typeof cfg.chromePath === 'string' ? cfg.chromePath : ''
  cfg.browserChannel = CHANNELS.has(cfg.browserChannel) ? cfg.browserChannel : DEFAULTS.browserChannel
  cfg.enableKb = cfg.enableKb !== false
  cfg.enableOps = cfg.enableOps === true
  cfg.ops = { ...DEFAULTS.ops, ...(cfg.ops && typeof cfg.ops === 'object' ? cfg.ops : {}) }
  return cfg
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  store.ensureDirs()

  const caps = capabilities(cfg)
  const builders = []
  if (caps.watch) builders.push(buildWatchTools)
  if (caps.kb) builders.push(buildKbTools)
  if (caps.ops) builders.push(buildOpsTools)
  builders.push(buildExtTools)
  // No write tool exists yet on purpose: every douyin write surface needs a
  // signed-in account to verify, and unverified write code is not shipped.

  const registered = []
  for (const build of builders) {
    for (const tool of build(ctx, cfg)) {
      // No try/catch on purpose: a registration failure must surface in the
      // Loader (failed entry, visible in Plugins) rather than leaving the agent
      // with a plugin that silently registered nothing.
      const off = ctx.tools.register(tool)
      registered.push(tool.name)
      ctx.effect?.(() => off)
    }
  }

  ctx.effect?.(() => {
    return () => {
      session.disposeBrowser().catch(() => {})
    }
  })

  const resolved = resolveBrowser(cfg.chromePath, cfg.browserChannel)
  ctx.logger?.info?.(
    `douyin-watch: ready (${registered.length} tools: ${registered.join(', ')}; data=${store.dataDir()}; ` +
      `channel=${cfg.browserChannel}->${resolved.channel ?? 'none'}; kb=${caps.kb}; ops=${caps.ops})`
  )
  if (!findBrowser(cfg.chromePath, cfg.browserChannel)) {
    ctx.logger?.warn?.(
      `douyin-watch: no browser found for channel "${cfg.browserChannel}". Install Chrome or Edge, or set config.chromePath.`
    )
  }
}
