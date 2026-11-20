/**
 * Verify the *installed* copy loads and registers, independently of the runtime.
 * If this passes but the tools are still missing from the running Host, the
 * bundle needs a restart to compose (module generation), not a code fix.
 */
// Defaults to this checkout's own index.js; point DSH_DOUYIN_INSTALL at the
// profile copy to contract-check an installed bundle instead.
const target = process.env.DSH_DOUYIN_INSTALL
  ? `file:///${process.env.DSH_DOUYIN_INSTALL.replace(/\\/g, '/')}`
  : new URL('../index.js', import.meta.url).href
const mod = await import(target)
console.log('exports:', Object.keys(mod))
console.log('inject:', mod.inject)

const tools = []
const ctx = {
  logger: { info: (...a) => console.log('[info]', ...a), warn: (...a) => console.warn('[warn]', ...a), error: (...a) => console.error('[error]', ...a) },
  tools: {
    // Mirror the real contract check: ToolDefinition.output is required.
    register: (t) => {
      if (!t.output || !t.output.schema || typeof t.output.render !== 'function') {
        throw new TypeError(`tool ${t.name} has no output.schema/render (ToolDefinition.output is required)`)
      }
      if (typeof t.name !== 'string' || !t.name) throw new TypeError('tool without a name')
      if (typeof t.description !== 'string' || t.description.length < 10) throw new TypeError(`tool ${t.name} has no description`)
      if (typeof t.parameters !== 'object' || t.parameters === null) throw new TypeError(`tool ${t.name} has no parameters object`)
      if (typeof t.execute !== 'function') throw new TypeError(`tool ${t.name} has no execute`)
      tools.push(t.name)
      return () => {}
    }
  },
  effect: (fn) => { const d = fn(); return () => {} }
}
try {
  mod.apply(ctx, { dailyCards: 5 })
} catch (err) {
  console.error('apply threw:', err)
  process.exit(1)
}
console.log('registered:', tools.join(', '))
// The exact count grows as surfaces are added, so assert the contract instead:
// the watching surface must always be present, and every tool must have passed
// the shape checks in the fake registry above.
const required = ['dy_watch', 'dy_status', 'dy_report', 'dy_diagnose']
const missing = required.filter((n) => !tools.includes(n))
if (missing.length) {
  console.error(`FAIL: missing required tools: ${missing.join(', ')}`)
  process.exit(1)
}
if (tools.length < required.length) {
  console.error(`FAIL: expected at least ${required.length} tools, got ${tools.length}`)
  process.exit(1)
}
console.log(`OK: installed module loads and registers (${tools.length} tools, contract-checked)`)
