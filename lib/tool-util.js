/**
 * Shared tool plumbing for every surface.
 *
 * `output` is a required part of ToolDefinition: the registry rejects a
 * definition without a renderer, and a swallowed rejection looks exactly like
 * "the plugin registered nothing" (this cost us a debugging round).
 */

export function renderText(value) {
  let text
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value, null, 2)
    } catch {
      text = String(value)
    }
  }
  if (text.length > 12000) text = `${text.slice(0, 12000)}\n… (${text.length - 12000} more chars)`
  return [{ type: 'text', text }]
}

export function defineTool(def) {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters ?? { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => renderText(value)
    },
    timeoutMs: def.timeoutMs ?? 180000,
    execute: def.execute
  }
}

/** Every refusal carries a machine code and a human next step. */
export function refusal(code, error, hint, extra = {}) {
  return { ok: false, code, error, hint, ...extra }
}

export function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}
