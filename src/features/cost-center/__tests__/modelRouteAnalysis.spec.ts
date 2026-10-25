import './costDataI18n'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SourceAdminUsageLog as AdminUsageLog } from '../sourceTypes'
import type { Channel } from '@/api/admin/channels'
import { buildModelRouteRows, routeCostBasisLabel, type ModelRouteRow } from '../modelRouteAnalysis'

function usage(overrides: Partial<AdminUsageLog> = {}): AdminUsageLog {
  return {
    id: 1,
    user_id: 1,
    api_key_id: 1,
    account_id: 13,
    request_id: 'req-1',
    model: 'deepseek-chat',
    upstream_model: 'deepseek-v4-flash',
    model_mapping_chain: 'deepseek-chat → deepseek-v4-flash',
    channel_id: 7,
    inbound_endpoint: '/v1/chat/completions',
    upstream_endpoint: '/chat/completions',
    group_id: 3,
    subscription_id: null,
    input_tokens: 98,
    output_tokens: 356,
    cache_creation_tokens: 0,
    cache_read_tokens: 128,
    cache_creation_5m_tokens: 0,
    cache_creation_1h_tokens: 0,
    input_cost: 0.00001372,
    output_cost: 0.00009968,
    cache_creation_cost: 0,
    cache_read_cost: 0.0000003584,
    total_cost: 0.0001137584,
    actual_cost: 0.0002,
    rate_multiplier: 1,
    account_rate_multiplier: 1,
    long_context_billing_applied: false,
    billing_type: 0,
    stream: false,
    duration_ms: 100,
    first_token_ms: 50,
    image_count: 0,
    image_size: null,
    image_input_size: null,
    image_output_size: null,
    image_size_source: null,
    image_size_breakdown: null,
    image_input_tokens: 0,
    image_input_cost: 0,
    image_output_tokens: 0,
    image_output_cost: 0,
    user_agent: null,
    cache_ttl_overridden: false,
    created_at: '2026-08-06T20:00:00.000Z',
    account: { id: 13, name: 'deepseek-official' },
    group: { id: 3, name: 'DeepSeek API' } as any,
    ...overrides,
  }
}

describe('actual model route aggregation', () => {
  it('distinguishes the sent model from a mismatched model declared by upstream', () => {
    const [row] = buildModelRouteRows([
      usage({
        upstream_model: 'deepseek-v4-pro',
        upstream_response_model: 'deepseek-v4-flash',
        upstream_model_mismatch: true,
      } as any),
    ], [])

    expect(row).toMatchObject({
      requestedModel: 'deepseek-chat',
      upstreamModel: 'deepseek-v4-pro',
      upstreamResponseModel: 'deepseek-v4-flash',
      upstreamModelMismatch: true,
      modelAuditStatus: 'mismatch',
    })
  })

  it('uses only stored request, upstream, channel and endpoint values', () => {
    const channels = [{ id: 7, name: '官方直连', model_pricing: [] }] as Channel[]
    const rows = buildModelRouteRows([usage()], channels)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      requestedModel: 'deepseek-chat',
      upstreamModel: 'deepseek-v4-flash',
      provider: 'DeepSeek',
      channelName: '官方直连',
      accountName: 'deepseek-official',
      inboundEndpoint: '/v1/chat/completions',
      upstreamEndpoint: '/chat/completions',
      cacheReadTokens: 128,
      firstSeen: '2026-08-06T20:00:00.000Z',
      lastSeen: '2026-08-06T20:00:00.000Z',
    })
  })

  it('keeps the first and last real call time while aggregating a route', () => {
    const rows = buildModelRouteRows([
      usage({ id: 1, created_at: '2026-08-06T20:00:00.000Z' }),
      usage({ id: 2, created_at: '2026-08-06T20:08:00.000Z' }),
    ], [])

    expect(rows[0]).toMatchObject({
      requests: 2,
      firstSeen: '2026-08-06T20:00:00.000Z',
      lastSeen: '2026-08-06T20:08:00.000Z',
    })
  })

  it('keeps group identity in the route key instead of charging every group to the first', () => {
    const rows = buildModelRouteRows([
      usage({ id: 1, group_id: 11, group: { id: 11, name: 'Group11' } as any, actual_cost: 2 }),
      usage({ id: 2, group_id: 22, group: { id: 22, name: 'Group22' } as any, actual_cost: 3 }),
      usage({ id: 3, group_id: null, group: undefined, actual_cost: 4 }),
    ], [])

    expect(rows).toHaveLength(3)
    expect(rows.map(row => [row.groupId, row.groupName, row.requests, row.revenue])).toEqual([
      [11, 'Group11', 1, 2], [22, 'Group22', 1, 3], [null, '未分组', 1, 4],
    ])
  })

  it('preserves opaque source account IDs without numeric coercion or collisions', () => {
    const rows = buildModelRouteRows([
      usage({ id: 1, account_id: 'cockpit:01' }),
      usage({ id: 2, account_id: 'cockpit:1' }),
      usage({ id: 3, account_id: 7 }),
      usage({ id: 4, account_id: '7' }),
    ], [])
    expect(rows.map(row => row.accountId)).toEqual(['cockpit:01', 'cockpit:1', 7, '7'])
    expect(rows.every(row => row.requests === 1)).toBe(true)
  })

  it('includes cache creation in the explicit total token count', () => {
    const log = usage({ input_tokens: 100, output_tokens: 50, cache_read_tokens: 20, cache_creation_tokens: 30 })
    const [row] = buildModelRouteRows([log, { ...log, id: 2 }], [])
    expect(row).toMatchObject({ requests: 2, inputTokens: 200, outputTokens: 100, cacheReadTokens: 40, cacheCreationTokens: 60, totalTokens: 400 })
  })

  it.each(['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens'] as const)('keeps the total unknown when %s is unknown, including after aggregation', (field) => {
    const [row] = buildModelRouteRows([usage(), usage({ id: 2, [field]: null })], [])
    expect(row.totalTokens).toBeNull()
    expect(row.requests).toBe(2)
  })

  it('retains a real zero token total without inventing a response declaration', () => {
    const [row] = buildModelRouteRows([usage({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 })], [])
    expect(row.totalTokens).toBe(0)
    expect(row.upstreamResponseModel).toBe('')
    expect(row.modelAuditStatus).toBe('unobserved')
  })

  it('attaches only a matching channel custom price rule', () => {
    const channels = [{
      id: 7,
      name: '中转渠道',
      model_pricing: [
        { platform: 'openai', models: ['gpt-*'], billing_mode: 'token', input_price: 1e-6 },
        { platform: 'openai', models: ['deepseek-v4-*'], billing_mode: 'token', input_price: 1.4e-7 },
      ],
    }] as Channel[]
    const [row] = buildModelRouteRows([usage()], channels)
    expect(row.channelPricing?.input_price).toBe(1.4e-7)
  })

  it('preserves deleted-account history instead of inventing a live account', () => {
    const [row] = buildModelRouteRows([usage({ account_id: null, account: undefined, channel_id: null })], [])
    expect(row.accountName).toBe('已删除账号（历史）')
    // channelName 语义更新:channelId==null 时优先显示真实 upstream_endpoint(不造假渠道,
    // cockpit/cliproxy 渠道列依赖此回退),仅当无端点时才显示"直属账号（无渠道）"
    expect(row.channelName).toBe('/chat/completions')
  })
})
describe('成本列假零 → null 传播(源不掌握成本时不得渲染成 $0.000000)', () => {
  it('① 缺失 ⇒ null:total_cost 为 null 时 standardCost / accountCost 都是 null,不是 0', () => {
    const [row] = buildModelRouteRows([usage({ total_cost: null })], [])
    expect(row.standardCost).toBeNull()
    expect(row.accountCost).toBeNull()
  })

  it('② 真实 0 ⇒ 仍是 0:源明确给出 total_cost: 0 时不得被当成「未知」', () => {
    const [row] = buildModelRouteRows([usage({ total_cost: 0 })], [])
    expect(row.standardCost).toBe(0)
    expect(row.accountCost).toBe(0)
  })

  it('③ 混合 ⇒ null:同一 key 下 null + 0.1 累加必须是 null(未知 + 已知 != 已知)', () => {
    const rows = buildModelRouteRows([
      usage({ id: 1, total_cost: null }),
      usage({ id: 2, total_cost: 0.1 }),
    ], [])
    expect(rows).toHaveLength(1)
    expect(rows[0].standardCost).toBeNull()
    expect(rows[0].accountCost).toBeNull()
  })

  it('③b 混合顺序无关:已知在前、未知在后同样是 null', () => {
    const rows = buildModelRouteRows([
      usage({ id: 1, total_cost: 0.1 }),
      usage({ id: 2, total_cost: null }),
    ], [])
    expect(rows).toHaveLength(1)
    expect(rows[0].standardCost).toBeNull()
    expect(rows[0].accountCost).toBeNull()
  })
})


describe('route rows 排序:成本未知的行不得当 0 参与比较', () => {
  it('null 成本的行走在有值行之后', () => {
    // 未知行 3 条(requests=3)且先入表,对照行是**真实 0 成本**(total_cost: 0,requests=1)。
    // 若把 null 当 0 参与比较,两行 accountCost 都是 0 ⇒ 靠 requests 决胜会把未知行排到前面。
    const rows = buildModelRouteRows([
      usage({ id: 1, total_cost: null, account_id: 11 }),
      usage({ id: 2, total_cost: null, account_id: 11 }),
      usage({ id: 3, total_cost: null, account_id: 11 }),
      usage({ id: 4, total_cost: 0, account_id: 12 }),
    ], [])
    expect(rows).toHaveLength(2)
    expect(rows[rows.length - 1]!.standardCost).toBeNull()
    expect(rows[0]!.standardCost).toBe(0)
  })

  it('成对:两行都有值 ⇒ 仍按账号成本降序(不因空值守卫打乱原有排序)', () => {
    const rows = buildModelRouteRows([
      usage({ id: 1, total_cost: 0.1, account_id: 11 }),
      usage({ id: 2, total_cost: 0.5, account_id: 12 }),
    ], [])
    expect(rows.map((r) => r.standardCost)).toEqual([0.5, 0.1])
  })
})

/**
 * ★ 2026-09-23:「成本未知」的**渲染分支** —— 三条来源各有各的归因,不许共用一句。
 *
 * 背景:`ModelRouteRow.costUnknown` 由 cockpit(`applyCockpitModelAggregation`,
 * `cockpitAdapter.ts:1815` 定义 / `:1839` 写该字段)与
 * cliproxy(`useCostCenterData` 映射)写入,两者的含义都是「**无单价且源无估算**」。
 * 而 **sub2api 这一路从不写它** —— `buildModelRouteRows` 的"成本拿不到"是
 * `nullableNumber(log.total_cost) === null`,即**该条记录本身没带成本字段**,
 * 与"没有单价"是两回事。所以视图里是**独立分支**,不是复用 `costUnknown` 那句
 * (归因文案必须与真实原因一致;写进 costUnknown 就是假归因)。
 *
 * 修复前的表现:null 成本落到 `v-else` ⇒ 渲染「无数据 / 无数据」+ 副标题「请求快照」,
 * 而同表另外两源在同样"算不出成本"时显示的是「成本未知」。
 */
describe('成本未知的渲染分支:sub2api 的"未知"与 cockpit/cliproxy 的"无单价"必须分开', () => {
  it('sub2api 这一路不写 costUnknown(写它就是假归因),成本缺失只体现在 standardCost === null', () => {
    const rows = buildModelRouteRows([usage({ total_cost: null, account_stats_cost: null })], [])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.standardCost).toBeNull()
    expect(rows[0]!.costUnknown).toBeUndefined()
  })

  it('视图组合守卫必须同时覆盖两种未知成本，并区分实际原因(源码接线断言)', () => {
    const view = readFileSync(resolve(process.cwd(), 'src/views/admin/CostCenterView.vue'), 'utf8')
    // ★ 红线:否定断言在空串上恒真 ⇒ 扫描面必须非空(失配即红)
    expect(view, '未找到 CostCenterView.vue 内容').not.toBe('')
    const costCells = view.split('\n').filter(line => line.includes('v-if="routeRow.standardCost == null || routeRow.costUnknown"'))
    expect(costCells, '未找到同时覆盖两种成本未知的组合守卫').toHaveLength(1)
    const cell = costCells[0]!
    expect(cell).toContain("routeRow.costUnknown ? '计价条件不足且源未提供估算' : '该条记录未带成本字段'")
    expect(cell).toContain('v-if="routeRow.knownStandardCost != null"')
    expect(cell).toContain('<template v-else><strong>{{ formatUsd(routeRow.standardCost, 6) }}')
    expect(cell.indexOf('v-if="routeRow.standardCost == null || routeRow.costUnknown"')).toBeLessThan(cell.indexOf('<template v-else><strong>{{ formatUsd(routeRow.standardCost, 6) }}'))
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 路由明细「标准 / 账号成本」列的**口径标注**必须等于真实算法(2026-09-26 第七轮)
//
// 病根:模板把这一列的副标题一律写死成「请求快照」。但只有 sub2api 的 usage_logs 真的带
// 逐请求成本快照 —— cockpit 的两条链路都自带 `costBasis`
// (cockpitAdapter.ts:1215「同模型同账号内按请求数分摊」、:2058「按模型窗口用量均摊」),
// cliproxy 是按 usage_events 用 LiteLLM 单价估算后再按 model + auth_index 聚合。
// 把它们一律标成「请求快照」= 告诉用户这是实测逐请求成本,而实际上不是 ⇒ 假口径。
// ────────────────────────────────────────────────────────────────────────────
describe('routeCostBasisLabel · 成本列口径标注必须等于真实算法', () => {
  const row = (costBasis?: string): ModelRouteRow => ({
    key: 'm|1',
    requestedModel: 'gpt-5',
    upstreamModel: 'gpt-5',
    upstreamResponseModel: '',
    upstreamModelMismatch: null,
    modelAuditStatus: 'unobserved',
    mappingChain: 'gpt-5 → gpt-5',
    provider: null,
    accountId: 1,
    accountName: 'a1',
    accountType: null,
    channelId: null,
    channelName: '无 channel 维度',
    groupId: null,
    groupName: '无 group 维度',
    inboundEndpoint: '/v1/*',
    upstreamEndpoint: '',
    channelPricing: null,
    requests: 10,
    inputTokens: 100,
    cacheReadTokens: 0,
    outputTokens: 20,
    standardCost: 0.5,
    accountCost: 0.5,
    revenue: null,
    costBasis,
    firstSeen: '2026-09-26T00:00:00Z',
    lastSeen: '2026-09-26T01:00:00Z',
  })

  it('★ 行自带 costBasis 时以它为准(cockpit 均摊口径),不得写成「请求快照」', () => {
    const label = routeCostBasisLabel(row('按模型窗口用量均摊（日志无逐请求 token）'), null)
    expect(label).toBe('按模型窗口用量均摊（日志无逐请求 token）')
    expect(label).not.toContain('请求快照')
  })

  it('★ 三态穷举:三个源无 costBasis 时的兜底文案两两不同(禁止 A ? x : y)', () => {
    const bare = row()
    const cockpit = routeCostBasisLabel(bare, null)
    const cliproxy = routeCostBasisLabel(bare, 'cliproxy')
    const sub2api = routeCostBasisLabel(bare, 'sub2api')
    // 「同值双轨」的教训:只断言"三个都不是空串"抓不住共用一句文案。必须两两不等。
    expect(cockpit).not.toBe(cliproxy)
    expect(cockpit).not.toBe(sub2api)
    expect(cliproxy).not.toBe(sub2api)
  })

  it('★ 反向断言:cockpit / cliproxy 的兜底**不得**出现「请求快照」', () => {
    // 这两个源都没有逐请求成本快照 —— 标成「请求快照」就是假口径。
    expect(routeCostBasisLabel(row(), null)).not.toContain('请求快照')
    expect(routeCostBasisLabel(row(), 'cliproxy')).not.toContain('请求快照')
    // sub2api 才是真的逐请求快照,它必须这么说。
    expect(routeCostBasisLabel(row(), 'sub2api')).toContain('逐请求成本快照')
  })

  it('★ 接线:成本列必须调 routeCostBasisLabel,且不得再写死「请求快照」字面量', () => {
    const view = readFileSync(resolve(__dirname, '../../../views/admin/CostCenterView.vue'), 'utf8')
    // 扫描面非空:否定断言在空串上恒真,先确认文件真的读到了。
    expect(view.length).toBeGreaterThan(0)
    expect(view).toContain('routeCostBasisLabel(routeRow, connectionType)')
    // 成本列那一格:先筛出候选行,再逐行断言(存在性断言抓不住"同一串出现多次时的单点替换")
    const costCells = view.split('\n').filter((l) => l.includes('routeCostBasisLabel(routeRow, connectionType)'))
    expect(costCells.length, '扫描面非空').toBeGreaterThan(0)
    for (const cell of costCells) {
      expect(cell, '成本列不得再写死口径文案').not.toContain('>请求快照<')
    }
  })
})
