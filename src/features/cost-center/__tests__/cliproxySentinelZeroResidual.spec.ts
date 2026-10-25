/**
 * 哨兵 0 收尾轮 · cliproxy 残余链路 —— 2026-09-21
 *
 * 背景:`costBasis.noPriceNoEstimateCost` 在「本项目没有该模型单价、数据源也没给估算」时返回
 * `{ cost: 0, basis: { kind: 'no_price_no_estimate' } }` —— **0 是哨兵,不是金额**。
 * 调用点写成 `const { cost } = 计价函数(...)` 就把 basis 标注丢了,哨兵 0 落进数值列,
 * 界面渲染 `$0.000000` 并挂上「LiteLLM 单价估算」这类**假口径**。
 *
 * 本文件覆盖 cliproxy 侧三处漏网:
 *   ① `cliproxyEventsToOps` 每个桶硬编码 `user_billed_usd/account_cost_usd/contribution_usd = 0`
 *      → 被 `selectFinancialTrend` 当成"经济证据" ⇒ 趋势图画一条贴底假零线;
 *   ② `cliproxyEventsToEconomics` 逐条累加哨兵 0 ⇒ `actual.billed_usd = 0`(不是 null),
 *      并让 costEngine 算出**负的假 contribution_margin**;
 *   ⑥ `cliproxyEventsToModelRoutes` 用裸 `eventCostUsd` + `useCostCenterData` 填 `revenue: 0`
 *      ⇒ 结构性假营收(cliproxy 根本没有营收层)。
 *
 * 每条断言都**成对**写:缺失 ⇒ null;真实 0 ⇒ 仍是 0(防过度修正)。
 */
import { describe, expect, it } from 'vitest'
import { cliproxyEventsToEconomics, cliproxyEventsToOps, cliproxyEventsToTrend } from '../cliproxyAdapter'
import { cliproxyEventsToModelRoutes } from '../cliproxyManagementAdapter'
import { selectFinancialTrend } from '../financialTrend'
import { useCostCenterData } from '../useCostCenterData'
import type { OpsThroughputTrendPoint } from '../../../api/admin/ops'
import type { CliproxyUsageEvent, LitellmPricing } from '../../../api/cliproxy/cpaData'
import type { CostTrendDataPoint } from '../usageWindow'

const PRICED_MODEL = 'gpt-5.6-terra'
/** 价目表里**没有**的模型名 ⇒ 无匹配单价 ⇒ 哨兵 0。 */
const UNPRICED_MODEL = 'zzz-unpriced-cpa-model'

const PRICES: Record<string, LitellmPricing> = {
  [PRICED_MODEL]: { input_cost_per_token: 2e-6, output_cost_per_token: 1.2e-5 },
}
/** 单价存在但全是 0 ⇒ 算出来恰好 $0(真实 0),不是"算不出"。 */
const ZERO_PRICES: Record<string, LitellmPricing> = {
  [PRICED_MODEL]: { input_cost_per_token: 0, output_cost_per_token: 0 },
}

/**
 * **只有 output 档有价**的模型（input 档在 LiteLLM 表里缺字段 ⇒ `undefined`）。
 *
 * 为什么必须有它：`pricedEventCostUsd` 的"缺档"守卫是**按需**判定的 ——
 * 只有该事件**确实消耗了**那一类 token 却拿不到单价时才算"算不出"：
 *   · `input_tokens > 0` 且 input 档无价 ⇒ **算不出**
 *   · `input_tokens === 0`（没用到 input 档）且 output 档有价 ⇒ **算得出**
 * ⇒ 同一个 `model|authIndex` 键内**两种 basis 并存**，这是 `_unpriced` 的 `||` 累加
 *   （"任一分量算不出 ⇒ 整行算不出"）唯一真正起作用的情形，此前**没有用例覆盖**。
 */
const MIXED_MODEL = 'gpt-5.6-mixed-tiers'
const MIXED_PRICES: Record<string, LitellmPricing> = {
  [MIXED_MODEL]: { output_cost_per_token: 1.2e-5 },
}

function cliproxyEvent(overrides: Partial<CliproxyUsageEvent> = {}): CliproxyUsageEvent {
  return {
    id: 1,
    requested_at: Date.now() - 60_000,
    provider: 'openai',
    executor_type: 'codex',
    model: PRICED_MODEL,
    alias: PRICED_MODEL,
    auth_index: 'auth-a',
    auth_type: 'api_key',
    source: 'test',
    reasoning_effort: 'medium',
    service_tier: 'auto',
    latency_ms: 100,
    ttft_ms: 50,
    failed: false,
    status_code: 200,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_tokens: 0,
    primary_used_percent: null,
    primary_reset_at: null,
    primary_used_tokens: null,
    primary_remaining_tokens: null,
    primary_limit_tokens: null,
    secondary_used_percent: null,
    secondary_reset_at: null,
    secondary_used_tokens: null,
    secondary_remaining_tokens: null,
    secondary_limit_tokens: null,
    ...overrides,
  }
}

/* -------------------------------------------------------------------------- */
/* ① ops 桶经济列                                                            */
/* -------------------------------------------------------------------------- */

describe('① cliproxy ops 桶:经济列是 null(该源不在这一层承载成本),不是假 0', () => {
  it('retains each bucket TTFT P95 and leaves an unsampled bucket unknown', () => {
    const now = new Date('2026-10-25T12:00:00Z')
    const at = now.getTime() - 1000
    const sampled = cliproxyEventsToOps([
      cliproxyEvent({ requested_at: at, ttft_ms: 10 }),
      cliproxyEvent({ requested_at: at, ttft_ms: 20 }),
      cliproxyEvent({ requested_at: at, ttft_ms: 90 }),
    ], '1h', now)
    expect(sampled.trend[0]).toMatchObject({ ttft_p50_ms: 20, ttft_p95_ms: 90 })
    const noSample = cliproxyEventsToOps([cliproxyEvent({ requested_at: at, ttft_ms: 0 })], '1h', now)
    expect(noSample.trend[0]).toMatchObject({ ttft_p50_ms: null, ttft_p95_ms: null })
  })
  it('三个经济列一律 null;同桶的实测列照常是数字', () => {
    const { trend } = cliproxyEventsToOps(
      [cliproxyEvent({ input_tokens: 1000, output_tokens: 500, total_tokens: 1500 })],
      '1h',
    )
    expect(trend).toHaveLength(1)
    expect(trend[0]!.user_billed_usd).toBeNull()
    expect(trend[0]!.account_cost_usd).toBeNull()
    expect(trend[0]!.contribution_usd).toBeNull()
    // 成对反例:这些是真实采集值,不能被一并改成 null
    expect(trend[0]!.request_count).toBe(1)
    expect(trend[0]!.success_count).toBe(1)
    expect(trend[0]!.token_consumed).toBe(1500)
    expect(trend[0]!.qps).toBeGreaterThan(0)
  })

  it('selectFinancialTrend:ops 桶经济列全 null 不构成经济证据 ⇒ 选中 usage_logs 源', () => {
    const { trend } = cliproxyEventsToOps([cliproxyEvent({ total_tokens: 100 })], '1h')
    const usage: CostTrendDataPoint[] = [{
      date: trend[0]!.bucket_start,
      requests: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0,
      cost: 1.5,
      actual_cost: 2.5,
      account_cost: 1.5,
    }]

    const selected = selectFinancialTrend(trend, usage, 1, 1)
    expect(selected).toHaveLength(1)
    expect(selected[0]!.source).toBe('usage_logs')
    expect(selected[0]!.billedUsd).toBe(2.5)
    expect(selected[0]!.accountCostUsd).toBe(1.5)
  })

  it('有判别力:ops 桶经济列全 null + usage_logs 也无成本证据 ⇒ 不画零线(返回空)', () => {
    // 这一条才抓得住「把 null 改回 0」的变异:改回 0 时 opsColumnsPresent = true、
    // 两侧证据都为 0 ⇒ useOps = true ⇒ 返回一个 billedUsd = 0 的**确定**点(贴底零线)。
    const { trend } = cliproxyEventsToOps([cliproxyEvent({ total_tokens: 100 })], '1h')
    expect(selectFinancialTrend(trend, [], 1, 1)).toEqual([])
  })

  it('成对反例:ops 桶带真实经济值时仍被选中(真实值不被误伤)', () => {
    const { trend } = cliproxyEventsToOps([cliproxyEvent({ total_tokens: 100 })], '1h')
    const ops: OpsThroughputTrendPoint[] = [
      { ...trend[0]!, user_billed_usd: 3, account_cost_usd: 1, contribution_usd: 2 },
    ]
    expect(selectFinancialTrend(ops, [], 1, 1)).toMatchObject([
      { source: 'ops', billedUsd: 3, accountCostUsd: 1, contributionUsd: 2 },
    ])
  })
})

/* -------------------------------------------------------------------------- */
/* ② economics.actual.billed_usd                                             */
/* -------------------------------------------------------------------------- */

describe('② cliproxy economics:算不出来 ⇒ billed/账号成本/贡献毛利/比值/回本率五个一起 null', () => {
  const CNY = 7.2

  it('窗口内全部请求无匹配单价 ⇒ 五个字段全 null(0 会算出负的假 contribution_margin)', () => {
    const snapshot = cliproxyEventsToEconomics(
      [cliproxyEvent({ model: UNPRICED_MODEL, input_tokens: 1000, total_tokens: 1000 })],
      PRICES, CNY, undefined, '1h', 1,
    )
    expect(snapshot).not.toBeNull()
    expect(snapshot!.actual.billed_usd).toBeNull()
    expect(snapshot!.actual.billed_usd).not.toBe(0)
    expect(snapshot!.actual.account_cost_usd).toBeNull()
    expect(snapshot!.actual.contribution_margin_cny).toBeNull()
    expect(snapshot!.actual.cny_per_billed_usd).toBeNull()
    expect(snapshot!.actual.payback_ratio).toBeNull()
  })

  it('成对:全部有单价 ⇒ 参考金额可算，但自用来源不虚构贡献毛利', () => {
    const snapshot = cliproxyEventsToEconomics(
      [cliproxyEvent({ input_tokens: 1_000_000, total_tokens: 1_000_000 })],
      PRICES, CNY, undefined, '1h', 1,
    )
    expect(snapshot!.actual.billed_usd).toBeCloseTo(2, 9)
    expect(snapshot!.actual.account_cost_usd).toBeCloseTo(2, 9)
    expect(snapshot!.actual.contribution_margin_cny).toBeNull()
  })

  it('成对:单价为 0 ⇒ billed_usd 是真实 0(不是 null,不误伤)', () => {
    const snapshot = cliproxyEventsToEconomics(
      [cliproxyEvent({ input_tokens: 1_000_000, total_tokens: 1_000_000 })],
      ZERO_PRICES, CNY, undefined, '1h', 1,
    )
    expect(snapshot!.actual.billed_usd).toBe(0)
    expect(snapshot!.actual.billed_usd).not.toBeNull()
  })

  it('部分无单价(同窗口有价 + 无价)⇒ billed_usd 是数值(真实下界),不是 null', () => {
    const snapshot = cliproxyEventsToEconomics(
      [
        cliproxyEvent({ input_tokens: 1_000_000, total_tokens: 1_000_000 }),
        cliproxyEvent({ model: UNPRICED_MODEL, input_tokens: 1000, total_tokens: 1000 }),
      ],
      PRICES, CNY, undefined, '1h', 1,
    )
    expect(snapshot!.actual.billed_usd).toBeCloseTo(2, 9)
    expect(snapshot!.actual.billed_usd).not.toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* ⑥ 路由明细:成本带 basis + 结构性假营收置 null                              */
/* -------------------------------------------------------------------------- */

describe('⑥ cliproxy 路由明细:成本算不出来 ⇒ null + costUnknown;营收结构性置 null', () => {
  it('无匹配单价 ⇒ costUsd = null 且 costUnknown = true', () => {
    const rows = cliproxyEventsToModelRoutes(
      [cliproxyEvent({ model: UNPRICED_MODEL, input_tokens: 100, total_tokens: 100 })],
      PRICES, [], '1h', 1,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.costUsd).toBeNull()
    expect(rows[0]!.costUsd).not.toBe(0)
    expect(rows[0]!.costUnknown).toBe(true)
  })

  it('成对:有单价 ⇒ costUsd 是数值且 costUnknown = false', () => {
    const rows = cliproxyEventsToModelRoutes(
      [cliproxyEvent({ input_tokens: 1_000_000, total_tokens: 1_000_000 })],
      PRICES, [], '1h', 1,
    )
    expect(rows[0]!.costUsd).toBeCloseTo(2, 9)
    expect(rows[0]!.costUnknown).toBe(false)
  })

  it('成对:单价为 0 ⇒ costUsd = 0(真实 0)且 costUnknown = false', () => {
    const rows = cliproxyEventsToModelRoutes(
      [cliproxyEvent({ input_tokens: 1_000_000, total_tokens: 1_000_000 })],
      ZERO_PRICES, [], '1h', 1,
    )
    expect(rows[0]!.costUsd).toBe(0)
    expect(rows[0]!.costUsd).not.toBeNull()
    expect(rows[0]!.costUnknown).toBe(false)
  })

  it('同键混价:先算不出、后算得出 ⇒ 整行仍是 null(取更差一侧,不被最后一个事件覆盖)', () => {
    // 两个事件 model + auth_index 相同 ⇒ 落进**同一行**。
    // 事件 A 消耗了 input 档而该档无价 ⇒ 算不出;事件 B 只消耗 output 档(有价)⇒ 算得出。
    const rows = cliproxyEventsToModelRoutes(
      [
        cliproxyEvent({ model: MIXED_MODEL, input_tokens: 100, output_tokens: 0, total_tokens: 100 }),
        cliproxyEvent({ model: MIXED_MODEL, input_tokens: 0, output_tokens: 50, total_tokens: 50 }),
      ],
      MIXED_PRICES, [], '1h', 1,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.requests).toBe(2)
    // ★ 关键:算得出的那 50 output token 有真成本,但整行含"算不出"的分量 ⇒ 只能报未知。
    //   若把累加写成 `_unpriced = unpriced`(后者覆盖前者),这里会变成数值 ⇒ 假成本。
    expect(rows[0]!.costUsd).toBeNull()
    expect(rows[0]!.costUnknown).toBe(true)
  })

  it('同键混价:顺序反过来结论不变(不依赖事件顺序)', () => {
    const rows = cliproxyEventsToModelRoutes(
      [
        cliproxyEvent({ model: MIXED_MODEL, input_tokens: 0, output_tokens: 50, total_tokens: 50 }),
        cliproxyEvent({ model: MIXED_MODEL, input_tokens: 100, output_tokens: 0, total_tokens: 100 }),
      ],
      MIXED_PRICES, [], '1h', 1,
    )
    expect(rows[0]!.costUsd).toBeNull()
    expect(rows[0]!.costUnknown).toBe(true)
  })

  it('成对:只消耗 output 档(该档有价)⇒ 该行是数值,证明上面的 null 不是"整个模型无价"造成的', () => {
    const rows = cliproxyEventsToModelRoutes(
      [cliproxyEvent({ model: MIXED_MODEL, input_tokens: 0, output_tokens: 50, total_tokens: 50 })],
      MIXED_PRICES, [], '1h', 1,
    )
    expect(rows[0]!.costUsd).toBeCloseTo(50 * 1.2e-5, 12)
    expect(rows[0]!.costUnknown).toBe(false)
  })

  it('store 装配:modelRoutes 的营收是 null(不是 0),成本未知时 standardCost/accountCost 一起 null', () => {
    // 行为断言(不是源码结构断言):真的跑一遍 loadFromCliproxy 再看 modelRoutes。
    const data = useCostCenterData()
    data.loadFromCliproxy(
      [], null, null,
      [cliproxyEvent({ model: UNPRICED_MODEL, input_tokens: 100, total_tokens: 100 })],
      PRICES, {}, '1h', '1h', 7.2,
    )
    expect(data.modelRoutes.value).toHaveLength(1)
    const row = data.modelRoutes.value[0]!
    // 结构性假营收:cliproxy 没有营收层 ⇒ 必须 null(ModelRouteRow.revenue 契约 number | null)
    expect(row.revenue).toBeNull()
    expect(row.revenue).not.toBe(0)
    expect(row.costUnknown).toBe(true)
    expect(row.standardCost).toBeNull()
    expect(row.accountCost).toBeNull()
    // 请求数是实测值,照常给出
    expect(row.requests).toBe(1)
  })

  it('成对:有单价时 store 装配的营收仍是 null(该源永远不掌握营收),但成本是数值', () => {
    const data = useCostCenterData()
    data.loadFromCliproxy(
      [], null, null,
      [cliproxyEvent({ input_tokens: 1_000_000, total_tokens: 1_000_000 })],
      PRICES, {}, '1h', '1h', 7.2,
    )
    const row = data.modelRoutes.value[0]!
    expect(row.revenue).toBeNull()
    expect(row.costUnknown).toBe(false)
    // 标准参考值不乘本机倍率，账号费率值才乘倍率。
    expect(row.standardCost).toBeGreaterThan(0)
    expect(row.accountCost).toBeCloseTo(row.standardCost! * 0.2)
  })

  it('窗口过滤:窗口外事件不计入 routes 的 requests(2026-09-23 修复)', () => {
    // 表头渲染的是模型区独立窗口(modelCostRangeLabel),此前取数不带窗口参数 ⇒ 30 天合计。
    const now = Date.now()
    const rows = cliproxyEventsToModelRoutes(
      [
        cliproxyEvent({ requested_at: now - 60_000, input_tokens: 1_000_000, total_tokens: 1_000_000 }),
        cliproxyEvent({ requested_at: now - 3 * 3_600_000, input_tokens: 100, total_tokens: 100 }),
      ],
      PRICES, [], '1h', 1,
    )
    // 两条事件同 model + 同 auth_index ⇒ 一行;过滤被改成永真时 requests 会是 2
    expect(rows).toHaveLength(1)
    expect(rows[0]!.requests).toBe(1)
    expect(rows[0]!.totalTokens).toBe(1_000_000)
  })

  it('成对反例:同一 events 数组、两个不同 range ⇒ routes 结果不同(防「参数加了但没用」)', () => {
    const now = Date.now()
    const windowed = [
      cliproxyEvent({ requested_at: now - 60_000, input_tokens: 1_000_000, total_tokens: 1_000_000 }),
      cliproxyEvent({ requested_at: now - 3 * 3_600_000, input_tokens: 100, total_tokens: 100 }),
    ]
    const hourly = cliproxyEventsToModelRoutes(windowed, PRICES, [], '1h', 1)
    const daily = cliproxyEventsToModelRoutes(windowed, PRICES, [], '24h', 1)
    expect(hourly[0]!.requests).toBe(1)
    expect(daily[0]!.requests).toBe(2)
    expect(hourly[0]!.requests).not.toBe(daily[0]!.requests)
  })
})

/* -------------------------------------------------------------------------- */
/* ⑦ 第二道防线:cliproxyEventsToTrend 全未知(不同入口/形态)                  */
/* -------------------------------------------------------------------------- */

describe('⑦ cliproxyEventsToTrend 全未知:补一条不同形态的用例(多桶)', () => {
  it('两个无价事件落在两个不同的桶 ⇒ 两个桶的三个成本字段都是 null', () => {
    const now = Date.now()
    const trend = cliproxyEventsToTrend(
      [
        cliproxyEvent({ model: UNPRICED_MODEL, requested_at: now - 30_000, input_tokens: 100, total_tokens: 100 }),
        cliproxyEvent({ model: UNPRICED_MODEL, requested_at: now - 120_000, input_tokens: 100, total_tokens: 100 }),
      ],
      PRICES, '1h', 1,
    )
    expect(trend).toHaveLength(2)
    for (const point of trend) {
      expect(point.cost).toBeNull()
      expect(point.actual_cost).toBeNull()
      expect(point.account_cost).toBeNull()
      expect(point.costBasis).toBe('no_price_no_estimate')
      expect(point.requests).toBe(1)
    }
  })

  it('成对:两个有价事件落在两个不同的桶 ⇒ 数值 + 不标下界', () => {
    const now = Date.now()
    const trend = cliproxyEventsToTrend(
      [
        cliproxyEvent({ requested_at: now - 30_000, input_tokens: 1_000_000, total_tokens: 1_000_000 }),
        cliproxyEvent({ requested_at: now - 120_000, input_tokens: 1_000_000, total_tokens: 1_000_000 }),
      ],
      PRICES, '1h', 1,
    )
    expect(trend).toHaveLength(2)
    for (const point of trend) {
      expect(point.cost).toBeCloseTo(2, 9)
      expect(point.costBasis).toBeUndefined()
    }
  })
})
