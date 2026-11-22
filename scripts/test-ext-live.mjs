import { buildExtTools } from '../lib/surfaces/ext.js'
import * as session from '../lib/session.js'

const cfg = {
  browserChannel: 'auto', chromePath: '', headless: false, scrollRounds: 3, scrollStepPx: 700,
  enableDownload: true, enableUser: true, enableSearchUser: true, enableExport: true,
  enableBatch: true, enableAccounts: true, enableOps: false,
  ops: {}, dailyWriteActions: 0
}
const ctx = { logger: { info: console.log, warn: console.log, error: console.log }, tools: { register() {} }, effect() {} }
const tools = Object.fromEntries(buildExtTools(ctx, cfg).map((t) => [t.name, t]))
console.log('tools:', Object.keys(tools).join(','))

const which = process.argv[2] || 'download'
try {
  if (which === 'download') {
    const r = await tools.kb_download.execute({ modalId: '7680883233307342947', parts: ['images'] })
    console.log('download =>', JSON.stringify(r).slice(0, 500))
  } else if (which === 'export') {
    const r = await tools.kb_export.execute({ format: 'json' })
    console.log('export =>', JSON.stringify(r).slice(0, 300))
  } else if (which === 'index') {
    const r = await tools.kb_index.execute({ query: '鲸鱼' })
    console.log('index =>', JSON.stringify(r).slice(0, 400))
  } else if (which === 'user') {
    const r = await tools.kb_user.execute({ query: '霖贝塔AI日记', limit: 10 })
    console.log('user =>', JSON.stringify(r).slice(0, 600))
  } else if (which === 'accounts') {
    const r = await tools.dy_accounts.execute({ action: 'list' })
    console.log('accounts =>', JSON.stringify(r).slice(0, 400))
  }
} finally {
  await session.disposeBrowser().catch(() => {})
}
