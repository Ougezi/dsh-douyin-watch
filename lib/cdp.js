/**
 * Minimal Chrome DevTools Protocol driver — zero dependencies.
 *
 * Node 22+ ships a global WebSocket (undici), so this module only needs
 * `node:child_process`, `node:net` and `fetch` to drive a real browser:
 *
 *   launch()  -> spawn Chrome with an isolated --user-data-dir
 *   page()    -> PUT /json/new to get a websocket target
 *   Page      -> navigate / evaluate / screenshot
 *
 * Deliberately no Playwright, no puppeteer: a native module here would break on
 * the next DSH/Electron ABI change, and this plugin must survive upgrades.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Candidate browser binaries, ordered by `channel`:
 *   auto   -> Chrome first, then Edge, then Chromium (preserves old behaviour)
 *   chrome -> Chrome/Chromium only, Edge omitted
 *   edge   -> Edge only, Chrome omitted
 *
 * Edge is Chromium-based, so the same CDP commands work; measured on Edge 157
 * (launch 865ms, feed rendered, player opened, frames captured).
 */
export function browserCandidates(override, channel = 'auto') {
  if (override) return [override]
  const chrome = []
  const edge = []
  const win = process.platform === 'win32'
  const mac = process.platform === 'darwin'
  if (win) {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean)
    for (const r of roots) {
      chrome.push(path.join(r, 'Google/Chrome/Application/chrome.exe'))
      chrome.push(path.join(r, 'Chromium/Application/chrome.exe'))
      edge.push(path.join(r, 'Microsoft/Edge/Application/msedge.exe'))
    }
  } else if (mac) {
    chrome.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    chrome.push('/Applications/Chromium.app/Contents/MacOS/Chromium')
    edge.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
  } else {
    chrome.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser')
    edge.push('/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable')
  }
  if (process.env.DY_CHROME) chrome.unshift(process.env.DY_CHROME)
  if (channel === 'edge') return edge
  if (channel === 'chrome') return chrome
  return [...chrome, ...edge]
}

export function findBrowser(override, channel = 'auto') {
  for (const p of browserCandidates(override, channel)) {
    try {
      if (fs.existsSync(p)) return p
    } catch {}
  }
  return null
}

/** Which channel a resolved executable belongs to, for profile isolation and logs. */
export function channelOf(executable) {
  if (!executable) return null
  const lower = executable.toLowerCase()
  if (lower.includes('msedge')) return 'edge'
  if (lower.includes('chromium')) return 'chromium'
  if (lower.includes('chrome')) return 'chrome'
  return 'other'
}

/** Resolve both the path and its channel in one pass. */
export function resolveBrowser(override, channel = 'auto') {
  const executable = findBrowser(override, channel)
  return { executable, channel: channelOf(executable), requestedChannel: channel }
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
}

function markerFile(userDataDir) {
  return path.join(userDataDir, 'dsh-douyin-browser.json')
}

function readMarker(userDataDir) {
  try {
    return JSON.parse(fs.readFileSync(markerFile(userDataDir), 'utf8'))
  } catch {
    return null
  }
}

function writeMarker(userDataDir, marker) {
  try {
    fs.writeFileSync(markerFile(userDataDir), JSON.stringify(marker), 'utf8')
  } catch {}
}

function clearMarker(userDataDir) {
  try {
    fs.rmSync(markerFile(userDataDir), { force: true })
  } catch {}
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Chrome records the owning process inside its SingletonLock file as
 * `<host>-<pid>`. Reading it lets us reclaim an orphan even when our own marker
 * file is missing (a browser spawned by an older build, or killed mid-launch).
 */
function lockHolderPid(userDataDir) {
  try {
    const raw = fs.readFileSync(path.join(userDataDir, 'SingletonLock'), 'utf8').trim()
    const m = /[-_](\d{2,})$/.exec(raw)
    if (m) return Number(m[1])
  } catch {}
  return null
}

async function killPid(pid) {
  if (!pidAlive(pid)) return false
  try {
    process.kill(pid)
  } catch {}
  for (let i = 0; i < 16 && pidAlive(pid); i++) await sleep(150)
  if (pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
    await sleep(200)
  }
  return !pidAlive(pid)
}

/**
 * A crashed or force-killed round can leave a Chrome still holding the profile,
 * which makes every later launch attach to nothing and never open a debug port.
 * Reclaim it: close it gracefully through its own devtools endpoint if possible,
 * otherwise kill the recorded pid.
 */
async function reclaimOrphan(userDataDir) {
  const marker = readMarker(userDataDir)
  let pid = marker && pidAlive(marker.pid) ? marker.pid : lockHolderPid(userDataDir)
  if (!pid || !pidAlive(pid)) {
    clearMarker(userDataDir)
    return false
  }
  const port = marker && marker.pid === pid ? marker.port : null
  if (port) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) {
        const info = await res.json()
        if (info?.webSocketDebuggerUrl) {
          const s = await CdpSession.open(info.webSocketDebuggerUrl)
          try {
            await s.send('Browser.close')
          } catch {}
          s.close()
        }
      }
    } catch {}
    for (let i = 0; i < 20 && pidAlive(pid); i++) await sleep(150)
  }
  await killPid(pid)
  clearMarker(userDataDir)
  return true
}

async function waitForDevtools(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = ' '
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return await res.json()
      lastError = `HTTP ${res.status}`
    } catch (err) {
      lastError = err?.message ?? String(err)
    }
    await sleep(150)
  }
  throw new Error(`devtools endpoint did not answer on 127.0.0.1:${port} (${lastError})`)
}

/** One CDP page target: request/response over a single websocket. */
class CdpSession {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.listeners = new Map()
    ws.addEventListener('message', (ev) => {
      let msg
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
      } catch {
        return
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`))
        else resolve(msg.result)
        return
      }
      if (msg.method) {
        const arr = this.listeners.get(msg.method)
        if (arr) for (const fn of arr) fn(msg.params)
      }
    })
  }

  static async open(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup()
        resolve()
      }
      const onErr = (e) => {
        cleanup()
        reject(new Error(`websocket failed: ${e?.message ?? 'error'}`))
      }
      const cleanup = () => {
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onErr)
      }
      ws.addEventListener('open', onOpen)
      ws.addEventListener('error', onErr)
    })
    return new CdpSession(ws)
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(fn)
    return () => {
      const arr = this.listeners.get(method) ?? []
      const i = arr.indexOf(fn)
      if (i >= 0) arr.splice(i, 1)
    }
  }

  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP timeout: ${method}`))
        }
      }, 45000)
      const done = (fn) => (v) => {
        clearTimeout(timer)
        fn(v)
      }
      const orig = this.pending.get(id)
      this.pending.set(id, { resolve: done(orig.resolve), reject: done(orig.reject) })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

/**
 * A launched browser plus its devtools port. `dispose()` closes every page and
 * terminates the process group; the profile directory on disk is kept so a
 * one-time Douyin login survives later rounds.
 */
export class Browser {
  constructor({ child, port, userDataDir, wsUrl }) {
    this.child = child
    this.port = port
    this.userDataDir = userDataDir
    this.wsUrl = wsUrl
    this.sessions = []
  }

  static async launch({ executable, userDataDir, headless = false, windowSize = '1280,900' }) {
    fs.mkdirSync(userDataDir, { recursive: true })
    await reclaimOrphan(userDataDir)
    const attempt = async () => {
      const port = await freePort()
      fs.mkdirSync(userDataDir, { recursive: true })
      const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,MediaRouter',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--mute-audio',
        `--window-size=${windowSize}`,
        'about:blank'
      ]
      if (headless) args.unshift('--headless=new')
      const child = spawn(executable, args, { stdio: 'ignore', detached: process.platform !== 'win32' })
      child.on('error', () => {})
      // Record the pid before waiting: a launch that dies while the devtools port
      // is still coming up must stay reclaimable by the next round.
      writeMarker(userDataDir, { pid: child.pid, port })
      let version
      try {
        version = await waitForDevtools(port, 20000)
      } catch (err) {
        try {
          child.kill()
        } catch {}
        err.code = 'devtools-unreachable'
        throw err
      }
      return new Browser({ child, port, userDataDir, wsUrl: version?.webSocketDebuggerUrl })
    }

    try {
      return await attempt()
    } catch (first) {
      // A profile directory keeps Chrome's Singleton* lock files. If a previous
      // round was killed rather than closed gracefully, the next launch attaches
      // to nothing and never opens the debug port. Clear the stale locks and try
      // once more; this is the single most common reason a browser "won't start".
      Browser.clearStaleLocks(userDataDir)
      await sleep(700)
      try {
        return await attempt()
      } catch (second) {
        second.message = `${second.message}; first attempt: ${first.message}`
        throw second
      }
    }
  }

  static clearStaleLocks(userDataDir) {
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      const file = path.join(userDataDir, name)
      try {
        fs.rmSync(file, { force: true })
      } catch {}
    }
  }

  async newPage(url = 'about:blank') {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    if (!res.ok) throw new Error(`could not create a page target (HTTP ${res.status})`)
    const target = await res.json()
    if (!target.webSocketDebuggerUrl) throw new Error('page target has no websocket url')
    const session = await CdpSession.open(target.webSocketDebuggerUrl)
    session.targetId = target.id
    this.sessions.push(session)
    return new Page(session)
  }

  async dispose() {
    for (const s of this.sessions) {
      try {
        s.close()
      } catch {}
    }
    // Graceful shutdown matters: Chrome only flushes cookies to the profile on a
    // clean close, and that flush is what preserves a Douyin login for next time.
    if (this.wsUrl) {
      try {
        const browserSession = await CdpSession.open(this.wsUrl)
        try {
          await browserSession.send('Browser.close')
        } catch {}
        browserSession.close()
      } catch {}
    }
    try {
      this.child.kill()
    } catch {}
    await new Promise((resolve) => {
      if (this.child.exitCode !== null) return resolve()
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      this.child.once('exit', finish)
      setTimeout(finish, 5000)
    })
    clearMarker(this.userDataDir)
  }
}

export class Page {
  constructor(session) {
    this.session = session
  }

  async enable() {
    await this.session.send('Page.enable')
    await this.session.send('Runtime.enable')
  }

  async navigate(url, { timeoutMs = 30000 } = {}) {
    const loaded = new Promise((resolve) => {
      const off = this.session.on('Page.loadEventFired', () => {
        off()
        resolve(true)
      })
      setTimeout(() => {
        off()
        resolve(false)
      }, timeoutMs)
    })
    await this.session.send('Page.navigate', { url })
    await loaded
  }

  async evaluate(expression, { awaitPromise = true, timeoutMs = 30000 } = {}) {
    const result = await this.session.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      timeout: timeoutMs
    })
    if (result.exceptionDetails) {
      const d = result.exceptionDetails
      throw new Error(d.exception?.description ?? d.text ?? 'page evaluation failed')
    }
    return result.result?.value
  }

  /**
   * Click by selector *inside the page*.
   *
   * Measured: dispatching real CDP mouse events at a feed card's centre does NOT
   * open the player (videoCount stayed 0), while a synthetic `el.click()` does.
   * The site's handler is bound to a synthetic click, so use this for feed cards.
   */
  async clickElement(selector) {
    return this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: 'not-found' };
      el.click();
      return { ok: true, tag: el.tagName };
    })()`)
  }

  /**
   * Screenshot with a black-frame suspicion flag. A flat/black capture compresses
   * to a few KB, so size is a cheap, honest heuristic: callers must not claim a
   * decoded frame when this says `suspect`.
   */
  async captureFrame(clip) {
    const png = await this.screenshot(clip)
    return { png, bytes: png.length, suspect: png.length < 20000 }
  }

  async pressEscape() {
    const base = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
    await this.session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
    await this.session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  async screenshot(clip) {
    const params = { format: 'png', captureBeyondViewport: true }
    if (clip) {
      params.clip = {
        x: Math.max(0, Math.round(clip.x)),
        y: Math.max(0, Math.round(clip.y)),
        width: Math.max(1, Math.round(clip.width)),
        height: Math.max(1, Math.round(clip.height)),
        scale: 1
      }
    }
    const res = await this.session.send('Page.captureScreenshot', params)
    return Buffer.from(res.data, 'base64')
  }

  async close() {
    try {
      await this.session.send('Page.close')
    } catch {}
    this.session.close()
  }
}

export function dataHome() {
  const raw = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return raw
}
