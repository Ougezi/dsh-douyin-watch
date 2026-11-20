/**
 * One entry point for the regression suite.
 *
 *   node scripts/test-all.mjs          # fast: parser + contract + failure paths
 *   node scripts/test-all.mjs --full   # also the live browser suites (slow)
 *
 * The fast set never launches a browser except for the live needs-login probe in
 * smoke-failures (which is part of the failure contract). Use an isolated
 * DSH_HOME when you care about the real ledger.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const full = process.argv.includes('--full')
const channel = process.argv.includes('--chrome') ? 'chrome' : 'edge'
const suites = [
  { name: 'parser', file: 'scripts/test-parse.mjs' },
  { name: 'contract', file: 'scripts/verify-install.mjs' },
  { name: 'login', file: 'scripts/test-login.mjs', args: [channel] },
  { name: 'search', file: 'scripts/test-search.mjs', args: [channel] },
  { name: 'failures', file: 'scripts/smoke-failures.mjs', args: [channel] }
]
if (full) {
  suites.push(
    { name: 'channel', file: 'scripts/smoke-channel.mjs', args: [channel] },
    { name: 'kb', file: 'scripts/smoke-kb.mjs', args: [channel] },
    { name: 'play', file: 'scripts/smoke-play.mjs', args: [channel] },
    { name: 'ops', file: 'scripts/smoke-ops.mjs', args: [channel] }
  )
}

// Every suite gets its own DSH_HOME. Without this, a suite that intentionally
// writes synthetic journal rows (smoke-failures) makes a later suite's
// "model calls are zero" assertion fail — a test-isolation bug, not a product one.
const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-testall-'))
console.log(`isolated homes under ${runRoot}`)

const results = []
for (const suite of suites) {
  const started = Date.now()
  const suiteHome = path.join(runRoot, suite.name)
  fs.mkdirSync(suiteHome, { recursive: true })
  const res = spawnSync(process.execPath, [suite.file, ...(suite.args ?? [])], {
    stdio: 'pipe',
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: suiteHome }
  })
  const ms = Date.now() - started
  const ok = res.status === 0
  results.push({ name: suite.name, ok, ms })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${suite.name.padEnd(9)} ${String(ms).padStart(6)}ms`)
  if (!ok) {
    const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
    console.error(out.split('\n').slice(-25).join('\n'))
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} suites passed${full ? ' (full)' : ''}`)
if (failed.length) process.exit(1)
