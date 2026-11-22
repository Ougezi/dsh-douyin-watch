import { buildExtTools } from '../lib/surfaces/ext.js'
import * as session from '../lib/session.js'
const cfg = { browserChannel: 'auto', chromePath: '', headless: false, enableDownload: true, enableUser: true, enableSearchUser: true, enableExport: true, enableBatch: true, enableAccounts: true, enableOps: false, ops: {} }
const ctx = { logger: { info: console.log, warn: console.log, error: console.log }, tools: { register() {} }, effect() {} }
const tools = Object.fromEntries(buildExtTools(ctx, cfg).map((t) => [t.name, t]))
const r = await tools.kb_download.execute({ modalId: 'https://v.douyin.com/G8Oggg_IXMA/', parts: ['images'] })
console.log('result', JSON.stringify(r).slice(0, 300))
await session.disposeBrowser().catch(() => {})
