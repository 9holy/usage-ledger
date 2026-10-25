/**
 * 回归:cockpit 侧的「幽灵 key 冒充实测」与「跨源残留」。
 *
 * D7 —— cockpitQuotaToAccountUsage 此前在 email 未命中真实账号时回退成 `file.email` 当 accountId,
 *   经 accountIdToNumber 派生出一个不代表任何真实账号的 key;而配额状态判定只看
 *   `Object.keys(accountUsage).length`,于是 6 个幽灵 key 把状态从 empty 抬成 measured。
 *   本机 cache/quota_history 的 8 个文件 updatedAt 全为 2026-03-24(约 6 个月前),
 *   模型是 claude-4-5/g3-pro/g3-flash(antigravity 系),与当前 codex 池不同源。
 *   修法:未命中直接跳过该文件;状态按命中账号数判定(命中 0 个 → empty)。
 *
 * D5 —— systemSettings 只由 cockpit/sub2api 写入,cliproxy 既不写也不清,残留后
 *   schedulerBaseScoreMax 会拿 cockpit 的路由权重和当归一化分母。
 *
 * D6 —— cockpit 分支被跳过时必须显式清空,否则 store 保留上一连接源的数据,
 *   而 connectionType === null 让所有文案都标成「cockpit …」。
 *
 * D8 —— cockpit 日志缺 `path` 时,eventsToUsageLogs 曾套 `'/v1/responses'` 兜底,
 *   把一条没被记录入站端点的请求渲染成"实测走的是 Responses API"。
 *   同函数对缺 accountId 的处理是如实写「未记录（日志无 accountId）」——同一个缺口两套待遇。
 */
import { describe, expect, it } from 'vitest'
import { cockpitLogToModelRoutes, cockpitQuotaToAccountUsage } from '../cockpitAdapter'
import { useCostCenterData } from '../useCostCenterData'
import type { CockpitQuotaHistoryFile, CockpitStatsAccount } from '@/api/cockpit'

function makeFile(email: string, modelId = 'claude-4-5'): CockpitQuotaHistoryFile {
  return {
    email,
    // 2026-03-24:本机 quota_history 的真实 updatedAt(约 6 个月前)
    updatedAt: Date.UTC(2026, 2, 24),
    models: {
      [modelId]: {
        modelId,
        points: [
          { timestamp: Date.UTC(2026, 2, 24), remainingPercentage: 62, resetTime: Date.UTC(2026, 2, 25), countdownSeconds: 3600 },
        ],
      },
    },
  }
}

function makeStatsAccount(accountId: string, email: string): CockpitStatsAccount {
  return { accountId, email, usage: {} as CockpitStatsAccount['usage'] }
}

describe('D7 · cockpitQuotaToAccountUsage 不得用 file.email 冒充 accountId', () => {
  it('email 未命中真实账号 → 跳过该文件,不产生幽灵 key', () => {
    const files = [makeFile('ghost-1@example.com'), makeFile('ghost-2@example.com')]
    // stats.accounts 里只有别的邮箱 → 两个文件都不该命中
    const stats = [makeStatsAccount('acct-live', 'live@example.com')]

    const result = cockpitQuotaToAccountUsage(files, stats)

    expect(Object.keys(result)).toHaveLength(0)
    // 幽灵 key 的特征:曾经是 email 经哈希派生出来的数字串
    expect(Object.keys(result).some((k) => k === 'ghost-1@example.com')).toBe(false)
  })

  it('全部未命中 → 空对象(状态判定据此得 empty,而不是 measured)', () => {
    const files = Array.from({ length: 6 }, (_, i) => makeFile(`ghost-${i}@example.com`))

    const result = cockpitQuotaToAccountUsage(files, [])

    expect(Object.keys(result)).toHaveLength(0)
  })

  it('email 命中真实账号 → 按 accountId 派生 key,配额负载完整', () => {
    const files = [makeFile('live@example.com', 'gpt-6-astra')]
    const stats = [makeStatsAccount('acct-live', 'live@example.com')]

    const result = cockpitQuotaToAccountUsage(files, stats)
    const keys = Object.keys(result)

    expect(keys).toHaveLength(1)
    // key 是 accountIdToNumber(accountId) 派生出的数字串,不是 email 本身
    expect(keys[0]).toMatch(/^\d+$/)
    expect(keys[0]).not.toBe('live@example.com')
    expect(result[keys[0]].antigravity_quota?.['gpt-6-astra'].utilization).toBe(38)
  })

  it('命中与未命中混合 → 只保留命中账号,命中数 == 条目数', () => {
    const files = [makeFile('live@example.com'), makeFile('ghost@example.com')]
    const stats = [makeStatsAccount('acct-live', 'live@example.com')]

    expect(Object.keys(cockpitQuotaToAccountUsage(files, stats))).toHaveLength(1)
  })
})

describe('D5 · systemSettings 必须进跨源清理', () => {
  it('resetRangeWindowState() 清掉 cockpit 残留的调度设置', () => {
    const data = useCostCenterData()
    // 模拟 cockpit 写入的路由权重(与 sub2api/cliproxy 无关)
    data.systemSettings.value = {
      openai_advanced_scheduler_effective_weight_priority: 1.5,
      openai_advanced_scheduler_effective_weight_load: 1,
    } as never

    expect(data.systemSettings.value).not.toBeNull()
    data.resetRangeWindowState()
    expect(data.systemSettings.value).toBeNull()
  })
})

describe('D6 · cockpit 分支被跳过时必须清空上一连接源的数据', () => {
  it('清空 cockpit 专属 ref 并把相关 sourceStates 置 unavailable,同时收尾 loading', () => {
    const data = useCostCenterData()
    // 模拟上一连接源(sub2api/cliproxy)留下的数据
    data.accounts.value = [{ id: 1 }] as never
    data.todayStats.value = { '1': { requests: 9, tokens: 9, cost: 9 } }
    data.models.value = [{ modelId: 'x' }] as never
    data.trend.value = [{ timestamp: 1 }] as never
    data.accountUsage.value = { '1': { updated_at: null, five_hour: null, seven_day: null, seven_day_sonnet: null } }
    data.opsOverview.value = { health_score: 90 } as never
    data.modelRoutes.value = [{ id: 1 }] as never
    data.accountEconomics.value = { data_quality: { status: 'complete' } } as never
    data.systemSettings.value = { a: 1 } as never
    data.loading.value = true

    data.clearCockpitSourceData('cockpit 未安装或 codex_local_access_stats.json 缺失')

    expect(data.accounts.value).toEqual([])
    expect(data.todayStats.value).toEqual({})
    expect(data.models.value).toEqual([])
    expect(data.trend.value).toEqual([])
    expect(data.accountUsage.value).toEqual({})
    expect(data.opsOverview.value).toBeNull()
    expect(data.modelRoutes.value).toEqual([])
    expect(data.accountEconomics.value).toBeNull()
    expect(data.systemSettings.value).toBeNull()

    for (const key of ['accounts', 'todayStats', 'models', 'dashboard', 'accountUsage', 'economics', 'ops', 'modelRoutes'] as const) {
      expect(data.sourceStates.value[key].status).toBe('unavailable')
      expect(data.sourceStates.value[key].reason).toContain('cockpit 未安装')
    }

    // 关键:loadFromCockpit 被跳过时没人置回 loading,必须自己收尾,否则 reload() 永久早退
    expect(data.loading.value).toBe(false)
  })
})

/** cockpit codex-api 日志行格式:`<ts> INFO [CodexLocalAccess][sidecar] {...json...}` */
function logLine(payload: Record<string, unknown>): string {
  return `2026-08-26T08:00:04.400+08:00 INFO [CodexLocalAccess][sidecar] ${JSON.stringify(payload)}`
}

describe('D8 · cockpit 日志缺 path 不得用 /v1/responses 冒充实测入站端点', () => {
  it('事件里没有 path → inbound_endpoint 留空,路由表如实标「未记录」', () => {
    const log = [
      logLine({ type: 'request_started', requestId: 'r1', model: 'gpt-5', startedAtMs: 1_700_000_000_000 }),
      logLine({ type: 'request_completed', requestId: 'r1', status: 200, completedAtMs: 1_700_000_001_000 }),
    ].join('\n')

    const { logs, routes } = cockpitLogToModelRoutes(log, [])

    expect(logs).toHaveLength(1)
    // 不能把"日志没记"说成"实测是 /v1/responses"
    expect(logs[0].inbound_endpoint).not.toBe('/v1/responses')
    expect(logs[0].inbound_endpoint).toBe('')
    expect(routes[0].inboundEndpoint).toBe('未记录')
  })

  it('日志带 path 时原样透传(本修复不吞真值)', () => {
    const log = logLine({
      type: 'request_started',
      requestId: 'r2',
      model: 'gpt-5',
      path: '/v1/chat/completions',
      startedAtMs: 1_700_000_000_000,
    })

    const { logs, routes } = cockpitLogToModelRoutes(log, [])

    expect(logs[0].inbound_endpoint).toBe('/v1/chat/completions')
    expect(routes[0].inboundEndpoint).toBe('/v1/chat/completions')
  })
})
