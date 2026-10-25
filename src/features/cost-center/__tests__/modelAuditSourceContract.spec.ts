/**
 * FIX 1 红线回归:cockpit / cliproxy 的「模型审计」4+1 格不得用 `0` 冒充实测。
 *
 * ## 修的是什么
 * `CostCenterView.vue` 的五个审计格(审计已观测 / 模型一致 / 上游替换 / 未观测 / 替换请求成本)
 * 此前读 `sourceStates.modelRoutes.status`。cockpit 在 `loadFromCockpit` 里把 modelRoutes
 * 置成 `measured`(条件是路由表非空),而 `cockpitRoutesAuditSummary()` **硬编码全 0** ——
 * 于是四格渲染成 `0`、state = measured、**无任何角标**,外观与 sub2api 的实测 0 完全一致。
 * cockpit 日志根本没有"上游响应声明模型"字段,连一帧都判不出声明模型 vs 实际模型,
 * 这与 cliproxy 的限制逐字相同(那边早已置 `unavailable`)—— 漏的是 cockpit 这一源。
 *
 * ## 为什么不能直接把 cockpit 的 modelRoutes 整个置 unavailable
 * `modelRoutes` 还被「真实模型 / 渠道 / 接口明细」表和 `modelRouteEmptyLabel` 使用,
 * 而 cockpit 的路由表**是有真实数据的**。故新增独立源键 `modelAudit`,把"审计语义"
 * 与"路由明细语义"解耦:审计不可用,路由明细照常。
 *
 * ## 为什么是「源码结构断言 + 渲染探针 + 行为断言」而不是 mount(CostCenterView)
 * 该视图直接依赖 router / connection store / Tauri internals 与十几个 composable,
 * 挂载成本远高于这条红线本身的价值;本仓库既有的同类红线(revenueLayerNullContract /
 * realRenderCheck)也用同一模式。
 *
 * 变异验证:把任一审计格的 `sourceStates.modelAudit` 改回 `sourceStates.modelRoutes`,
 * 第 2 条断言会立即失败 —— 这正是本轮交付报告里贴出的失败输出。
 */
import './costDataI18n'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { mountWithCostI18n as mount } from '../components/__tests__/costI18n'
import MetricCell from '../components/TruthfulMetric.vue'
import { COST_CENTER_SOURCE_KEYS, createDataSourceStates } from '../dataState'
import { cockpitRoutesAuditSummary } from '../cockpitAdapter'

/**
 * T-M2 行为夹具：`reload()`（sub2api 路径）在 useCostCenterData.ts:677-711 并发打约 10 个 admin 端点，
 * 这里全部给最小 resolved 夹具。其中 `usage.list` 返回**一条窗口内**的 usage_log，
 * 使 `buildModelRouteRows` 产出非空路由 ⇒ sub2api 的 modelAudit 分支应走 `measured`
 * （空夹具只会得到 `empty`，那样就测不出「被误设成 unavailable」这个变异）。
 *
 * 用 `vi.hoisted` 是因为 `vi.mock` 工厂会在 import 期执行，直接引用模块级 const 会撞 TDZ。
 */
const fixtures = vi.hoisted(() => ({
  usageLog: {
    id: 1, user_id: 1, api_key_id: 1, account_id: 13, request_id: 'req-tm2',
    model: 'deepseek-chat', upstream_model: 'deepseek-v4-flash',
    upstream_response_model: 'deepseek-v4-flash', upstream_model_mismatch: false,
    model_mapping_chain: 'deepseek-chat → deepseek-v4-flash',
    channel_id: 7, inbound_endpoint: '/v1/chat/completions', upstream_endpoint: '/chat/completions',
    group_id: 3, subscription_id: null,
    input_tokens: 98, output_tokens: 356, cache_creation_tokens: 0, cache_read_tokens: 128,
    cache_creation_5m_tokens: 0, cache_creation_1h_tokens: 0,
    input_cost: 0, output_cost: 0, cache_creation_cost: 0, cache_read_cost: 0,
    total_cost: 0, actual_cost: 0,
    rate_multiplier: 1, account_rate_multiplier: 1, long_context_billing_applied: false,
    billing_type: 0, stream: false, duration_ms: 100, first_token_ms: 50,
    image_count: 0, image_size: null, image_input_size: null, image_output_size: null,
    image_size_source: null, image_size_breakdown: null,
    image_input_tokens: 0, image_input_cost: 0, image_output_tokens: 0, image_output_cost: 0,
    user_agent: null, cache_ttl_overridden: false,
    created_at: new Date().toISOString(),
    account: { id: 13, name: 'deepseek-official' },
    group: { id: 3, name: 'DeepSeek API' },
  },
}))

vi.mock('@/api/admin', () => ({
  adminAPI: {
    accounts: {
      list: async () => ({ items: [] }),
      listCostLossStates: async () => ({ states: [] }),
      getBatchTodayStats: async () => ({ stats: {} }),
      getUsage: async () => null,
      getEconomicsSnapshot: async () => ({
        data_quality: { status: 'unavailable' },
        projection: { confidence: 'unavailable' },
      }),
    },
    dashboard: { getSnapshotV2: async () => ({ trend: [], stats: null }) },
    channels: {
      list: async () => ({ items: [] }),
      getPricingStatus: async () => null,
      getModelDefaultPricing: async () => null,
    },
    ops: {
      getDashboardSnapshotV2: async () => ({ overview: null, throughput_trend: null, error_trend: null }),
    },
    settings: { getSettings: async () => ({}) },
    usage: { list: async () => ({ items: [fixtures.usageLog] }) },
  },
}))

/** 避免 reload() 真去打汇率网络端点（3 个端点 × 8s 超时，会拖慢测试）。 */
vi.mock('../exchangeRate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exchangeRate')>()
  return {
    ...actual,
    loadUsdCnyExchangeRate: async () => ({ rate: 7.2, rateDate: null, fetchedAt: null, source: 'fallback' as const }),
  }
})

import { useCostCenterData } from '../useCostCenterData'

const VIEW = readFileSync(resolve(process.cwd(), 'src/views/admin/CostCenterView.vue'), 'utf8')
const AUDIT_LABELS = ['auditableRequests', 'matchingModels', 'substitutedModel', 'auditRecordMissing', 'substitutedRequestCost']

function auditCellLine(label: string): string {
  return VIEW.split('\n').find((line) => line.includes(`:label="t('costCenter.text.${label}')"`)) ?? ''
}

/** 与 useCostCenterData.spec.ts 同款最小 stats(已知能走通 loadFromCockpit)。 */
function minimalStats() {
  return {
    since: Date.now() - 3_600_000,
    updatedAt: Date.now(),
    totals: {
      requestCount: 5, successCount: 5, failureCount: 0, clientCanceledCount: 0,
      upstreamResponseFailedCount: 0, streamIncompleteCount: 0, totalLatencyMs: 100,
      textRequestCount: 5, imageRequestCount: 0, imageGenerationRequestCount: 0,
      imageEditRequestCount: 0, imageGenerationCapabilityFailureCount: 0,
      inputTokens: 10, outputTokens: 10, totalTokens: 20, cachedTokens: 0,
      reasoningTokens: 0, estimatedCostUsd: 0,
    },
    accounts: [],
    models: [],
    apiKeys: [],
    daily: {
      since: Date.now() - 3_600_000, updatedAt: Date.now(), accounts: [], models: [], apiKeys: [],
      totals: {
        requestCount: 0, successCount: 0, failureCount: 0, clientCanceledCount: 0,
        upstreamResponseFailedCount: 0, streamIncompleteCount: 0, totalLatencyMs: 0,
        textRequestCount: 0, imageRequestCount: 0, imageGenerationRequestCount: 0,
        imageEditRequestCount: 0, imageGenerationCapabilityFailureCount: 0,
        inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0,
        reasoningTokens: 0, estimatedCostUsd: 0,
      },
    },
    weekly: null,
    monthly: null,
  } as never
}

describe('FIX 1 · cockpit/cliproxy 的模型审计格不得用 0 冒充实测', () => {
  it('dataState 暴露独立的 modelAudit 源键,与 modelRoutes 解耦', () => {
    expect(COST_CENTER_SOURCE_KEYS).toContain('modelAudit')
    expect(COST_CENTER_SOURCE_KEYS).toContain('modelRoutes')
    const states = createDataSourceStates('unavailable')
    expect(states.modelAudit.label).toContain('模型审计')
    expect(states.modelRoutes.label).toContain('路由')
  })

  it('5 个审计格读 sourceStates.modelAudit,不读 modelRoutes(路由明细表仍用 modelRoutes)', () => {
    for (const label of AUDIT_LABELS) {
      const line = auditCellLine(label)
      expect(line, `未找到审计格「${label}」`).not.toBe('')
      expect(line, `审计格「${label}」必须读 modelAudit`).toContain('sourceStates.modelAudit')
      expect(line, `审计格「${label}」不得读 modelRoutes`).not.toContain('sourceStates.modelRoutes')
    }
    // 路由明细区(modelRouteEmptyLabel)仍必须读 modelRoutes(证明解耦,而不是把两件事一起改掉)。
    // 断言范围收敛到该 computed 本体 —— 原先的 `expect(VIEW).toContain('sourceStates.value.modelRoutes.status')`
    // 是**整文件包含**,在任何注释里写一遍就能满足,属装饰性断言,已替换。
    const routeLabelBody = VIEW.match(/const modelRouteEmptyLabel = computed\(\(\) => \{[\s\S]*?\n\}\)/)?.[0] ?? ''
    expect(routeLabelBody, '未找到 modelRouteEmptyLabel computed').not.toBe('')
    expect(routeLabelBody).toContain('sourceStates.value.modelRoutes')
  })

  it('cockpit 适配器自述"全部未观测",且不掌握营收(mismatchRevenue = null 而非 0)', () => {
    const summary = cockpitRoutesAuditSummary(120)
    expect(summary.observedRequests).toBe(0)
    expect(summary.mismatchRequests).toBe(0)
    expect(summary.mismatchRate).toBeNull()
    expect(summary.mismatchRevenue).toBeNull()
  })

  it('渲染探针:unavailable 的审计格显示「无数据」,与"实测 0"对照组可区分', () => {
    const render = (status: 'unavailable' | 'measured', value: string) => mount(MetricCell, {
      props: { label: '审计已观测', value, state: status },
    })
    const absent = render('unavailable', '无数据')
    expect(absent.text()).toContain('无数据')
    // 对照组:实测 0 必须能被区分出来,证明上面那条断言不是恒真。
    const realZero = render('measured', '0')
    expect(realZero.text()).toContain('0')
    expect(realZero.text()).not.toContain('无数据')
  })

  it('切换到 CPA 或清空 Cockpit 时，不能沿用 Sub2API 的实测模型审计', async () => {
    const data = useCostCenterData()
    await data.reload('1h')
    expect(data.sourceStates.value.modelAudit.status).toBe('measured')
    data.loadFromCliproxy([], null, null, [], {}, {}, '1h', '1h', 7.2)
    expect(data.sourceStates.value.modelAudit.status).toBe('unavailable')
    expect(data.modelAuditSummary.value.mismatchRevenue).toBeNull()
    expect(data.sourceStates.value.modelRoutes.status).toBe('empty')
    data.clearCockpitSourceData('fixture source unavailable')
    expect(data.sourceStates.value.modelAudit.status).toBe('unavailable')
    expect(data.sourceStates.value.modelAudit.reason).toBe('fixture source unavailable')
  })

  /**
   * T-M2（**行为断言**，非退路）：走真实 `reload()`（sub2api 路径），断言 modelAudit 不是 unavailable。
   *
   * mock 面：`@/api/admin` 的 accounts/dashboard/channels/ops/settings/usage 共约 10 个端点全部
   * 给最小 resolved 夹具；`usage.list` 返回一条窗口内的 usage_log ⇒ `buildModelRouteRows` 非空
   * ⇒ 期望 `measured`。另 mock `../exchangeRate` 以免真打汇率网络端点。
   *
   * 强度弱点：`measured` 依赖夹具能产出非空路由；若上游 `buildModelRouteRows` 语义变化导致
   * 路由为空，这条会退化成 `empty`（仍 ≠ unavailable，仍能抓 M2），但不再覆盖「实测」这一档。
   */
  it('T-M2 行为验证：sub2api 源 reload() 后 modelAudit = measured（不得被误设成 unavailable）', async () => {
    const data = useCostCenterData()
    await data.reload('1h')
    expect(data.sourceStates.value.modelAudit.status).not.toBe('unavailable')
    expect(data.sourceStates.value.modelAudit.status).toBe('measured')
  })

  it('行为验证:loadFromCockpit 后 modelAudit = unavailable(路由表状态独立判定)', () => {
    const data = useCostCenterData()
    data.loadFromCockpit(minimalStats(), null, '1h')
    expect(data.sourceStates.value.modelAudit.status).toBe('unavailable')
    expect(data.sourceStates.value.modelAudit.reason).toContain('响应声明模型')
    // modelRoutes 不受影响:它由真实路由数据判定(此夹具无路由 → empty,绝不是 unavailable)
    expect(data.sourceStates.value.modelRoutes.status).not.toBe('unavailable')
  })
})
