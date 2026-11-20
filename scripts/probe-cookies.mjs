import fs from 'node:fs'
import { Browser } from '../lib/cdp.js'
import { FEED_URL } from '../lib/adapters/douyin/feed.js'
import { ensureDirs } from '../lib/store.js'

const exe = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p))
const dir = ensureDirs()
const b = await Browser.launch({ executable: exe, userDataDir: `${dir}/profile-cookieprobe` })
const page = await b.newPage('about:blank')
await page.enable()
await page.navigate(FEED_URL, { timeoutMs: 30000 })
await new Promise((r) => setTimeout(r, 2500))
const cookies = await page.cookies('douyin.com')
console.log('cookie count:', cookies.length)
console.log('names:', cookies.map((c) => c.name || '(empty)').join(', '))
const { loginState } = await import('../lib/session.js')
const state = await loginState(page)
console.log('loginState:', JSON.stringify(state))
await page.close()
await b.dispose()
