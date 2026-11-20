/**
 * Surface B — account operations (`ops_*`).
 *
 * Scope decision (from Spike-3/4, 2026-11-21): every write surface on douyin.com
 * (comment, reply, DM, publish) sits behind a login wall, and clicking any of
 * them opens a generic login dialog. Without the owner's own sign-in there is no
 * way to verify a write, and shipping unverified write code that touches a real
 * account is worse than shipping none.
 *
 * So this surface currently provides only read-only probes:
 *   ops_status — is the account signed in, which write flags are enabled, budget
 *   ops_trend  — creator-centre dashboard reachability + a bounded text sample
 *
 * The five-door write gate lives in policy.assertWriteAllowed() and is covered by
 * tests, so adding a write tool later is a matter of implementing the page
 * adapter — not redesigning the safety model.
 */
import * as session from '../session.js'
import * as store from '../store.js'
import { capabilities } from '../policy.js'
import { defineTool, refusal } from '../tool-util.js'

const CREATOR_URL = 'https://creator.douyin.com/'

async function runOpsStatus(ctx, cfg) {
  const caps = capabilities(cfg)
  const out = {
    ok: true,
    code: 'ok',
    opsEnabled: caps.ops,
    writeFlags: cfg.ops,
    dailyWriteActions: cfg.dailyWriteActions,
    budget: store.journalBudget(store.dayKey()),
    writeToolsImplemented: false,
    note:
      '写操作（点赞/评论/回复/私信/发布）未实现：Spike 显示它们全部需要登录，且在未登录时点任何互动只弹登录框。' +
      '闸门已在 policy.assertWriteAllowed() 就绪并通过测试；实现前需要账号本人先登录并单独验收。'
  }
  try {
    const { page, probe } = await session.openFeed(cfg, ctx.logger)
    const login = await session.loginState(page)
    out.login = {
      ...login,
      captchaVisible: Boolean(probe?.captchaVisible),
      url: probe?.url ?? null
    }
  } catch (err) {
    out.login = { checked: false, error: String(err?.message ?? err) }
  }
  return out
}

async function runOpsTrend(ctx, cfg) {
  let page
  try {
    page = (await session.ensurePage(cfg, ctx.logger)).page
  } catch (err) {
    if (err?.code === 'no-browser') return refusal(err.code, err.message, err.hint)
    return refusal('browser-failed', `浏览器起不来：${err?.message ?? err}`, '先跑 dy_diagnose 看是哪一步失败。')
  }
  try {
    await page.navigate(CREATOR_URL, { timeoutMs: 30000 })
    await new Promise((r) => setTimeout(r, 2500))

    // Use the cookie-based signal, not keywords: the signed-out landing page also
    // contains "作品管理" (it advertises the product), so keyword heuristics both
    // miss real logins and fake them.
    const login = await session.loginState(page)
    const state = await page.evaluate(`(() => {
      const text = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
      return { url: location.href, title: document.title, chars: text.length, sample: text.slice(0, 500) };
    })()`)

    if (!login.signedIn) {
      return refusal(
        'needs-login',
        '创作者中心需要登录（抖音的硬限制，不是插件的问题）。',
        '在插件自己的浏览器窗口里扫码登录抖音后重试；登录态保存在 profile-<channel>/。写操作在登录前一律不可用。',
        { state, login }
      )
    }

    store.appendJournal([
      { surface: 'ops', action: 'ops_trend', ok: true, code: 'ok', evidence: { url: state.url }, cost: { modelCalls: 0 } }
    ])
    return { ok: true, code: 'ok', url: state.url, title: state.title, signedIn: true, dashText: state.sample }
  } catch (err) {
    return refusal('ops-trend-failed', `打不开创作者中心：${err?.message ?? err}`, '页面没关，可直接重试。')
  }
}

export function buildOpsTools(ctx, cfg) {
  const logger = ctx.logger
  return [
    defineTool({
      name: 'ops_status',
      description:
        '只读：抖音账号是否已登录、哪些写操作开关被打开、今日写操作预算。写工具本身尚未实现（需要登录后才能验收）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: 90000,
      execute: async () => runOpsStatus(ctx, cfg)
    }),
    defineTool({
      name: 'ops_trend',
      description: '只读：打开创作者中心并返回其可达性与一段页面文本；未登录时明确返回 needs-login。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: 90000,
      execute: async () => runOpsTrend(ctx, cfg)
    })
  ]
}
