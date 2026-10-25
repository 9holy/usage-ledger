/**
 * 真实 cockpit 数据逐列审计(诊断工具,非回归断言)。
 *
 * 目的:把 CostCenterView 上游排行/号池/资产总览的每个栏目用**真实** cockpit JSON
 * 实算一遍并打印,定位"栏目空白"到底是 ①数据源真无 ②id 键不匹配 ③倍率未生效。
 *
 * 复制 useCostCenterData.loadFromCockpit + CostCenterView 的装载口径:
 * stats 账号 + 多平台账号清单合并 → 过滤历史孤儿 → 逐列取值。
 *
 * 仅在 USAGE_LEDGER_REAL_DATA_AUDIT=1 时运行；输出可能包含本机账号与用量。
 * 真实文件缺失时跳过(不阻塞 CI)。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cockpitWindowToAccountStats,
  cockpitPlatformAccountsToAccounts,
  cockpitStatsToAccounts,
  cockpitStatsToEconomics,
  cockpitWindowForRange,
} from '../cockpitAdapter'
import { economicCostSnapshot, inferPlan, resolveAccountBillingMode, resolveCostProfile, resolveFallbackCostProfile } from '../model'
import type { CockpitCodexAccount, CockpitStats } from '@/api/cockpit'

const DIR = join(homedir(), '.antigravity_cockpit')
const MULTIPLIER = 0.7
const realDataAuditEnabled = process.env.USAGE_LEDGER_REAL_DATA_AUDIT === '1'

function readJson<T>(name: string): T | null {
  const p = join(DIR, name)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T
  } catch {
    return null
  }
}

interface RawAccount {
  id: string
  email?: string
  plan_name?: string
  created_at?: number
  last_used?: number
}

describe.skipIf(!realDataAuditEnabled)('真实 cockpit 数据逐列审计', () => {
  it('打印界面实际会显示的每一行每一列', () => {
    const stats = readJson<CockpitStats>('codex_local_access_stats.json')
    if (!stats) {
      console.log('[audit] 无 codex_local_access_stats.json,跳过')
      return
    }
    const codexAccounts = readJson<{ accounts: CockpitCodexAccount[] }>('codex_accounts.json')
    const gemini = readJson<{ accounts: RawAccount[] }>('gemini_accounts.json')
    const antigravity = readJson<{ accounts: RawAccount[] }>('accounts.json')

    const accountMeta = new Map((codexAccounts?.accounts ?? []).map((a) => [a.id, a]))

    // 与 CostCenterView 同口径:stats 账号 + 多平台账号清单(gemini/antigravity/claude/cursor/kiro)
    const statsAccounts = cockpitStatsToAccounts(stats, new Map(), accountMeta)
    const platformInputs = [
      ...(gemini?.accounts ?? []).map((a) => ({
        id: a.id, email: a.email, planLabel: a.plan_name,
        createdAt: a.created_at, lastUsed: a.last_used, platform: 'gemini' as const,
      })),
      ...(antigravity?.accounts ?? []).map((a) => ({
        id: a.id, email: a.email, createdAt: a.created_at,
        lastUsed: a.last_used, platform: 'antigravity' as const,
      })),
    ]
    const existingIds = new Set(statsAccounts.map((a) => a.id))
    const platformOnly = cockpitPlatformAccountsToAccounts(platformInputs).filter((a) => !existingIds.has(a.id))
    const allAccounts = [...statsAccounts, ...platformOnly]

    const window = cockpitWindowForRange(stats, '7d')
    const todayStats = cockpitWindowToAccountStats(stats.daily, MULTIPLIER)
    const windowStats = cockpitWindowToAccountStats(window, MULTIPLIER)
    const economics = cockpitStatsToEconomics(stats, '7d', 7.2, accountMeta, MULTIPLIER)

    const isHistorical = (acc: { extra?: Record<string, unknown> | null }) =>
      acc.extra?.cockpit_historical === true

    // 界面默认过滤:showHistoricalAccounts=false
    const visible = allAccounts.filter((a) => !isHistorical(a as never))
    const hidden = allAccounts.filter((a) => isHistorical(a as never))

    const out: string[] = []
    out.push('=== 账号池构成 ===')
    out.push(`stats 账号=${statsAccounts.length}  多平台账号(已去重)=${platformOnly.length}  合计=${allAccounts.length}`)
    out.push(`界面默认显示=${visible.length}   默认隐藏的历史孤儿=${hidden.length}`)

    out.push('')
    out.push(`=== 界面实际显示的 ${visible.length} 行 · 逐列核对 ===`)
    for (const acc of visible) {
      // 与视图 usageStatsFor() 同口径:优先观察窗口,回退自然日
      const today = windowStats[String(acc.id)] ?? todayStats[String(acc.id)]
      const costAcc = acc as never
      const plan = inferPlan(costAcc)
      const profile = resolveCostProfile(costAcc)
      const fb = resolveFallbackCostProfile(costAcc, MULTIPLIER)
      const label = (acc.extra as { cockpit_plan_label?: string } | null)?.cockpit_plan_label
      out.push([
        `  ${acc.name}`,
        `     平台=${acc.platform} 类型=${acc.type} 状态=${acc.status} 套餐=${plan}${label ? ` (原文: ${label})` : ''} 计费=${resolveAccountBillingMode(costAcc)}`,
        `     当前价格: 官方价 $${profile.amount} → 兜底后 $${fb.amount.toFixed(2)} [${fb.source}]`,
        `     今日: 请求=${today?.requests ?? '—'} Token=${today?.tokens ?? '—'} 成本=${today?.cost == null ? '—' : '$' + today.cost.toFixed(4)}`,
      ].join('\n'))
    }

    out.push('')
    out.push('=== 平台分布(用户问"为什么只对接了 codex") ===')
    const byPlatform = new Map<string, number>()
    for (const acc of visible) byPlatform.set(acc.platform, (byPlatform.get(acc.platform) ?? 0) + 1)
    out.push(`  显示中: ${[...byPlatform.entries()].map(([k, v]) => `${k}:${v}`).join('  ') || '(空)'}`)
    const byPlatformAll = new Map<string, number>()
    for (const acc of allAccounts) byPlatformAll.set(acc.platform, (byPlatformAll.get(acc.platform) ?? 0) + 1)
    out.push(`  含孤儿: ${[...byPlatformAll.entries()].map(([k, v]) => `${k}:${v}`).join('  ')}`)

    out.push('')
    out.push('=== 用量命中率(决定请求/Token/成本列是否为空) ===')
    out.push(`  daily(今日) 命中 = ${visible.filter((a) => todayStats[String(a.id)]).length}/${visible.length}`)
    out.push(`  ${'7d'}(观察窗口) 命中 = ${visible.filter((a) => windowStats[String(a.id)]).length}/${visible.length}`)

    out.push('')
    out.push('=== 经济学 KPI(号池页/资产总览) ===')
    out.push(`  status=${economics?.data_quality.status} procurement_accrued_cny=${economics?.actual.procurement_accrued_cny.toFixed(2)}`)
    out.push(`  economic_cost_cny=${economics?.actual.economic_cost_cny?.toFixed(2)} payback_ratio=${economics?.actual.payback_ratio?.toFixed(4)}`)
    out.push(`  projection.confidence=${economics?.projection.confidence}`)

    out.push('')
    out.push(`=== 当前 range(7d) 窗口: models=${window ? Object.keys(window.models ?? {}).length : 0} accounts=${window?.accounts?.length ?? 0} ===`)

    console.log('\n' + out.join('\n') + '\n')
    expect(visible.length).toBeGreaterThan(0)
  })
})

/**
 * 资产与成本总览 KPI 实算(2026-09-08 新增)。
 *
 * 对异常放大的上游成本与每小时成本逐项复核:
 * 用真实 cockpit 数据把总览页 KPI 重算一遍并断言量级合理,
 * 防止"某个 ref 被放大几百倍"这类回归再次静默进入面板。
 */
describe.skipIf(!realDataAuditEnabled)('真实 cockpit 数据 · 资产总览 KPI 量级', () => {
  it('采购小时成本与累计成本落在合理量级(不出现百倍放大)', () => {
    const stats = readJson<CockpitStats>('codex_local_access_stats.json')
    const codexAccounts = readJson<{ accounts: Array<{ id: string }> }>('codex_accounts.json')
    if (!stats || !codexAccounts) return
    const accountMeta = new Map<string, CockpitCodexAccount>(
      (codexAccounts.accounts ?? []).map((a) => [a.id, a as CockpitCodexAccount]),
    )
    const accounts = cockpitStatsToAccounts(stats, new Map(), accountMeta)
    let hourlyCny = 0
    let accruedCny = 0
    for (const account of accounts) {
      if ((account as { extra?: Record<string, unknown> }).extra?.cockpit_historical === true) continue
      const profile = resolveFallbackCostProfile(account, MULTIPLIER)
      const snap = economicCostSnapshot(profile, null, Date.now())
      hourlyCny += snap.hourlyRate * 7.2
      accruedCny += snap.economicCost * 7.2
    }
    // 量级护栏:几十个订阅账号、按 $20~$100/月 推算,每小时采购成本应当是**几元到几十元**,
    // 累计(自加入起)应当是**几千到几万元**。出现万元/小时或百万元累计 = 单位/倍率回归。
    expect(hourlyCny).toBeGreaterThanOrEqual(0)
    expect(hourlyCny).toBeLessThan(1_000)
    expect(accruedCny).toBeLessThan(1_000_000)
  })
})
