import './costDataI18n'
import { describe, expect, it, vi } from 'vitest'

// loadFromCockpit 是纯本地装入,但模块顶层 import 了 adminAPI;mock 掉避免拉入真实 axios 实例。
vi.mock('@/api/admin', () => ({
  adminAPI: { accounts: {}, dashboard: {}, ops: {}, channels: {}, settings: {} },
}))

import {
  cockpitOpsAccountsToRequestCounts,
  filterCockpitRequestLogByAccount,
} from '../cockpitAdapter'
import { useCostCenterData } from '../useCostCenterData'

const ACCOUNT_A = 'codex_aaaa1111bbbb2222'
const ACCOUNT_B = 'codex_cccc3333dddd4444'

/**
 * 用与适配层**同一套**路径(FNV-1a,`accountIdToNumber`)取账号数字 id,
 * 避免在测试里重写哈希 —— 若哪天口径改了,这里会一起失败而不是假绿。
 */
function accountNumberId(accountId: string): string {
  const counts = cockpitOpsAccountsToRequestCounts([
    { account_id: accountId, requests: 1, success_count: 1, error_count: 0 },
  ])
  return Object.keys(counts)[0]!
}

/** 单条 (模型×账号) 聚合格子。 */
function group(model: string, accountId: string, requests: number): any {
  return {
    model,
    accountId,
    apiKeyId: '',
    firstMs: null,
    lastMs: null,
    requests,
    success: requests,
    error: 0,
    stdNormalInput: 1_000 * requests,
    stdCached: 0,
    stdOutput: 100 * requests,
    longNormalInput: 0,
    longCached: 0,
    longOutput: 0,
    estimatedCostUsd: 0,
    rateLimited: 0,
    upstreamError: 0,
    clientCanceled: 0,
  }
}

function summary(groups: any[]): any {
  return {
    available: true,
    reason: null,
    rowCount: groups.length,
    windowStartMs: 0,
    windowEndMs: 0,
    bucketHours: 1,
    cells: [],
    groups,
    bucketLatencies: [],
  }
}

function statsFixture(): any {
  const totals = {
    requestCount: 0, successCount: 0, failureCount: 0, clientCanceledCount: 0,
    totalLatencyMs: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    cachedTokens: 0, reasoningTokens: 0, estimatedCostUsd: 0,
  }
  return {
    since: Date.now() - 3_600_000,
    updatedAt: Date.now(),
    totals,
    accounts: [],
    models: [],
    apiKeys: [],
    daily: { since: Date.now() - 3_600_000, accounts: [], models: [], apiKeys: [], totals },
    weekly: null,
    monthly: null,
  }
}

describe('filterCockpitRequestLogByAccount', () => {
  it('按 accountIdToNumber 同口径过滤 groups,而不是直接比原始字符串', () => {
    const a = accountNumberId(ACCOUNT_A)
    const s = summary([group('gpt-6-astra', ACCOUNT_A, 3), group('gpt-5', ACCOUNT_B, 5)])

    const filtered = filterCockpitRequestLogByAccount(s, a)!
    expect(filtered.groups).toHaveLength(1)
    expect(filtered.groups[0].model).toBe('gpt-6-astra')
    // cells/bucketLatencies 无账号维度,原样保留(全局趋势不受影响)
    expect(filtered.cells).toEqual(s.cells)

    // 「全部账号」→ 原样返回入参本身(零复制、引用相等)
    expect(filterCockpitRequestLogByAccount(s, null)).toBe(s)

    // 匹配不上的账号 → 空 groups(不是"原样全量",这正是空转的老毛病)
    expect(filterCockpitRequestLogByAccount(s, 999_999_999)!.groups).toHaveLength(0)

    // null summary 安全
    expect(filterCockpitRequestLogByAccount(null, a)).toBeNull()
  })

  it('空 accountId 的组不归属任何账号,过滤时剔除', () => {
    const s = summary([group('gpt-6-astra', '', 3)])
    expect(filterCockpitRequestLogByAccount(s, 123)!.groups).toHaveLength(0)
  })
})

describe('cockpit「成本账号」选择器真正生效(2026-09-13 修空转)', () => {
  it('选中某账号后模型表只含该账号的模型,不再是全账号合计', () => {
    const data = useCostCenterData()
    const s = summary([group('gpt-6-astra', ACCOUNT_A, 3), group('gpt-5', ACCOUNT_B, 5)])

    data.modelCostAccountId.value = accountNumberId(ACCOUNT_A)
    data.loadFromCockpit(statsFixture(), null, '1h', [], null, new Map(), undefined, [], null, null, null, s, s)

    expect(data.models.value.map((m) => m.model)).toEqual(['gpt-6-astra'])
  })

  it('过滤后为空:如实留空并标 empty,不静默回退成全账号合计', () => {
    const data = useCostCenterData()
    // 窗口内只有账号 B 的记录
    const s = summary([group('gpt-5', ACCOUNT_B, 5)])

    data.modelCostAccountId.value = accountNumberId(ACCOUNT_A) // 账号 A 此窗口无记录
    data.loadFromCockpit(statsFixture(), null, '1h', [], null, new Map(), undefined, [], null, null, null, s, s)

    expect(data.models.value).toEqual([])
    expect(data.sourceStates.value.models.status).toBe('empty')
    expect(data.sourceStates.value.models.reason).toContain('所选账号')
  })

  it('未选账号时行为不变:仍是全账号合计', () => {
    const data = useCostCenterData()
    const s = summary([group('gpt-6-astra', ACCOUNT_A, 3), group('gpt-5', ACCOUNT_B, 5)])

    data.loadFromCockpit(statsFixture(), null, '1h', [], null, new Map(), undefined, [], null, null, null, s, s)

    expect(data.models.value.map((m) => m.model).sort()).toEqual(['gpt-5', 'gpt-6-astra'])
  })
})
