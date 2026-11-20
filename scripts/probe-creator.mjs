import fs from 'node:fs'
import { Browser } from '../lib/cdp.js'
import { ensureDirs } from '../lib/store.js'

const exe = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p))
const dir = ensureDirs()
const b = await Browser.launch({ executable: exe, userDataDir: `${dir}/profile-creatorprobe` })
const page = await b.newPage('about:blank')
await page.enable()
await page.navigate('https://creator.douyin.com/', { timeoutMs: 30000 })
await new Promise((r) => setTimeout(r, 3000))
const info = await page.evaluate(`(() => {
  const t = (document.body.innerText || '').replace(/\\s+/g, ' ');
  const probes = ['扫码登录','登录后','请登录','立即登录','登录','手机号登录','验证码'];
  return {
    url: location.href,
    title: document.title,
    chars: t.length,
    matched: probes.filter((p) => t.includes(p)),
    head: t.slice(0, 400),
    tail: t.slice(-400)
  };
})()`)
console.log(JSON.stringify(info, null, 2))
await page.close()
await b.dispose()
