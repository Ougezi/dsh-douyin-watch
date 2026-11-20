/**
 * Capability switches, budgets and the write gate.
 *
 * Why a separate module: the three surfaces have very different trust levels.
 * `watch` and `kb` only read. `ops` changes the account's public state, so it
 * must not be reachable just because a tool happens to exist. Keeping every
 * decision here means the policy is auditable in one file instead of scattered
 * through page adapters.
 *
 * Design rule: a capability that is off must be *absent*, not "present but
 * refusing". A model that cannot see `ops_comment` will not try it.
 */
import * as store from './store.js'

export function capabilities(cfg) {
  return {
    watch: true,
    kb: cfg.enableKb === true,
    ops: cfg.enableOps === true
  }
}

/**
 * Budget check. Returns `{ ok: true }` or a refusal carrying a machine `code`
 * and a human `hint` — never a bare false.
 */
export function checkBudget(cfg, day = store.dayKey()) {
  const budget = store.journalBudget(day)
  if (budget.modelCalls >= cfg.dailyModelCalls) {
    return {
      ok: false,
      code: 'quota-model-calls',
      error: `今天已经产生 ${budget.modelCalls} 次模型调用，达到上限 ${cfg.dailyModelCalls}。`,
      hint: '调高 config.dailyModelCalls，或用 mode=cards 跑零模型成本的轮次。',
      budget
    }
  }
  if (budget.watchSeconds >= cfg.dailyMinutes * 60) {
    return {
      ok: false,
      code: 'quota-minutes',
      error: `今天打开的视频总时长已达 ${Math.round(budget.watchSeconds / 60)} 分钟，上限 ${cfg.dailyMinutes} 分钟。`,
      hint: '调高 config.dailyMinutes，或用 mode=cards 跑不消耗时长预算的轮次。',
      budget
    }
  }
  return { ok: true, budget }
}

/** Gate every write action. Five doors, in this order. */
export function assertWriteAllowed(cfg, action, target = {}) {
  if (cfg.enableOps !== true) {
    return {
      ok: false,
      code: 'ops-disabled',
      error: '写操作默认关闭，ops_* 工具未注册。',
      hint: '在 bundle 配置里设 enableOps: true 并重启插件行后才会出现这些工具。'
    }
  }
  const allowKey = {
    like: 'allowLike',
    comment: 'allowComment',
    reply: 'allowReply',
    dm: 'allowDm',
    publish: 'allowPublish'
  }[action]
  if (!allowKey || cfg.ops?.[allowKey] !== true) {
    return {
      ok: false,
      code: 'action-disabled',
      error: `写动作 ${action} 未单独开启。`,
      hint: `在 config.ops.${allowKey ?? '<action>'} 显式设为 true。默认全关不是保守，是必须。`
    }
  }
  const today = store.journalBudget(store.dayKey())
  if (today.writeActions >= cfg.dailyWriteActions) {
    return {
      ok: false,
      code: 'quota-write-actions',
      error: `今天已执行 ${today.writeActions} 次写操作，达到上限 ${cfg.dailyWriteActions}。`,
      hint: '调高 config.dailyWriteActions，或明天再做。'
    }
  }
  if (target?.id) {
    const dup = store
      .readJournal(store.dayKey())
      .some((r) => r.surface === 'ops' && r.action === action && r.target?.id === target.id && r.ok)
    if (dup) {
      return {
        ok: false,
        code: 'duplicate-write',
        error: `对 ${target.id} 的 ${action} 今天已经成功执行过一次，拒绝重复。`,
        hint: '幂等保护：同一目标的同类写动作一天只允许一次。'
      }
    }
  }
  return { ok: true }
}
