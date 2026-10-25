import './costDataI18n'
/**
 * cliproxy 营收契约测试 — CPA 无营收口径,ModelStat.actual_cost 必须恒为 null。
 *
 * 为什么需要它:cliproxy 的成本是按 LiteLLM 单价反算的**估算值**。CPA 只回 usage 事件,
 * 既没有 usage_logs、也没有用户计费/营收层。此前 cliproxyEventsToModelStats 把估算成本
 * 填进 actual_cost(用户计费字段),下游 buildModelCostRows 因此得到 revenueMissing=false、
 * revenue=costUsd、grossProfit=0 —— 界面把"算不出毛利"渲染成了绿色的"毛利为零"。
 * 契约见 src/types/index.ts 的 ModelStat:actual_cost: number | null,
 * null = 该数据源不掌握营收,不得渲染成 0。
 */
import { describe, it, expect, vi } from 'vitest'
import { cliproxyEventsToModelStats } from '../cliproxyAdapter'
import { buildModelCostRows, summarizeModelCosts } from '../modelCostAnalysis'
import { usageWindowBounds } from '../usageWindow'
import type { CliproxyUsageEvent, LitellmPricing } from '@/api/cliproxy/cpaData'

/** LiteLLM 单价表(per-token USD):两个真实模型,覆盖"多模型各自计价"。 */
const prices: Record<string, LitellmPricing> = {
  'glm-4.6': { input_cost_per_token: 0.0000006, output_cost_per_token: 0.0000022, litellm_provider: 'zhipu' },
  'deepseek-v3.2': { input_cost_per_token: 0.00000028, output_cost_per_token: 0.00000042, litellm_provider: 'deepseek' },
}

function makeEvent(
  model: string,
  requestedAt: number,
  inputTokens: number,
  outputTokens: number,
): CliproxyUsageEvent {
  return {
    id: requestedAt,
    requested_at: requestedAt,
    provider: 'zhipu',
    executor_type: '',
    model,
    alias: model,
    auth_index: '0',
    auth_type: 'api_key',
    source: 'test',
    reasoning_effort: '',
    service_tier: 'auto',
    latency_ms: 100,
    ttft_ms: 50,
    failed: false,
    status_code: 200,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: 0,
    cached_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_tokens: inputTokens + outputTokens,
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
  }
}

/** 3 条真实用量事件、2 个模型(glm-4.6 两条用于验证累加不改变 actual_cost 语义)。
 *
 *  2026-09-23:`cliproxyEventsToModelStats` 起按 `range` 半开区间过滤(表头渲染用户选的窗口,
 *  数字必须同窗口)。夹具时间戳因此不能再钉 2023 的固定值 —— 改成相对 `Date.now()` 的
 *  近 1 小时窗口内,与本文件断言用的 `'1h'` 一致。 */
const NOW = Date.now()
const events: CliproxyUsageEvent[] = [
  makeEvent('glm-4.6', NOW - 180_000, 1_000_000, 500_000),
  makeEvent('glm-4.6', NOW - 120_000, 200_000, 100_000),
  makeEvent('deepseek-v3.2', NOW - 60_000, 300_000, 150_000),
]

/** 本文件所有取数用的窗口 —— 与上面夹具的时间戳必须同窗,否则表会被过滤成空。 */
const RANGE = '1h' as const

describe('cliproxy 模型营收契约(CPA 无营收口径)', () => {
  it('keeps same-window reference value separate from the multiplier-adjusted account estimate', () => {
    const scopedEvents = [makeEvent('glm-4.6', NOW - 60_000, 1_000_000, 0), makeEvent('glm-4.6', NOW - 2 * 3600000, 9_000_000, 0)]
    const raw = cliproxyEventsToModelStats(scopedEvents, prices, RANGE, 0.2, new Date(NOW))
    expect(raw).toHaveLength(1)
    expect(raw[0]!.requests).toBe(1)
    expect(raw[0]!.cost).toBeCloseTo(0.6)
    expect(raw[0]!.account_cost).toBeCloseTo(0.12)
    const [display] = buildModelCostRows(raw)
    expect(display!.standardCost).toBeCloseTo(0.6)
    expect(display!.accountCost).toBeCloseTo(0.12)
    expect(display!.revenue).toBeNull()
    const unknown = cliproxyEventsToModelStats([makeEvent('unpriced-fixture', NOW - 1000, 100, 0)], prices, RANGE, 0.2, new Date(NOW))[0]!
    expect(unknown.cost).toBeNull()
    expect(unknown.account_cost).toBeNull()
  })

  it('每一行 actual_cost 都是 null,不把估算成本冒充用户计费', () => {
    const stats = cliproxyEventsToModelStats(events, prices, RANGE)
    expect(stats).toHaveLength(2)
    for (const row of stats) {
      expect(row.actual_cost).toBeNull()
    }
  })

  it('buildModelCostRows:每行营收/毛利/毛利率均不可得,revenueMissing=true', () => {
    const rows = buildModelCostRows(cliproxyEventsToModelStats(events, prices, RANGE))
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.revenueMissing).toBe(true)
      expect(row.revenue).toBeNull()
      expect(row.grossProfit).toBeNull()
      expect(row.grossMargin).toBeNull()
    }
  })

  it('summarizeModelCosts:合计同样标营收缺失,绝不回退成 0', () => {
    const summary = summarizeModelCosts(buildModelCostRows(cliproxyEventsToModelStats(events, prices, RANGE)))
    expect(summary.revenueMissing).toBe(true)
    expect(summary.revenue).toBeNull()
    expect(summary.grossProfit).toBeNull()
    expect(summary.grossMargin).toBeNull()
  })

  it('成本估算链路仍正常工作:standardCost > 0,不是把整块数据弄没了', () => {
    const rows = buildModelCostRows(cliproxyEventsToModelStats(events, prices, RANGE))
    for (const row of rows) {
      expect(row.standardCost).toBeGreaterThan(0)
    }
    const summary = summarizeModelCosts(rows)
    expect(summary.standardCost).toBeGreaterThan(0)
    expect(summary.modelCount).toBe(2)
  })
})

describe('cliproxy 模型表按窗口过滤(2026-09-23 修复)', () => {
  // 缺陷:表头渲染的是用户选的模型窗口(modelCostRangeLabel),但取数不带窗口参数 ——
  // events 是 Rust 侧截断的近 30 天全量,于是选「最近 1 分钟」时显示的是 30 天合计。
  // 同一模型两条事件:一条在 1h 窗口内,一条在 3 小时前(1h 外、24h 内)。
  const IN = NOW - 60_000
  const OUT = NOW - 3 * 3_600_000
  const windowed: CliproxyUsageEvent[] = [
    makeEvent('glm-4.6', IN, 1_000_000, 500_000),
    makeEvent('glm-4.6', OUT, 200_000, 100_000),
  ]

  it('窗口外事件不计入:requests 只算窗口内那一条', () => {
    const stats = cliproxyEventsToModelStats(windowed, prices, '1h')
    expect(stats).toHaveLength(1)
    expect(stats[0]!.model).toBe('glm-4.6')
    // 过滤被改成永真 / range 被忽略时,这里会拿到 2 与 1_800_000
    expect(stats[0]!.requests).toBe(1)
    expect(stats[0]!.total_tokens).toBe(1_500_000)
  })

  it('成对反例:同一 events 数组、两个不同 range ⇒ 结果不同(防「参数加了但没用」)', () => {
    const hourly = cliproxyEventsToModelStats(windowed, prices, '1h')
    const daily = cliproxyEventsToModelStats(windowed, prices, '24h')
    expect(hourly[0]!.requests).toBe(1)
    expect(daily[0]!.requests).toBe(2)
    expect(hourly[0]!.requests).not.toBe(daily[0]!.requests)
    expect(hourly[0]!.total_tokens).not.toBe(daily[0]!.total_tokens)
  })

  it('区间语义是半开区间 [start, end):恰好等于起点的计入、恰好等于终点的剔除', () => {
    // ★ 2026-09-23 修正一条**假测试**:本用例此前标题声称钉住半开区间,函数体却因为
    //   「用 '1h' 反推边界不可靠(usageWindowBounds 的 end 是调用时刻)」而**放弃了边界断言**,
    //   退化成「40 天前的事件 → 空」—— 那是上面两条已经覆盖的性质,半开区间实际**没有牙齿**。
    //   独立复核用变异 `>= start && < end` → `> start && <= end` 打过来时全量 2550 条**全绿**,
    //   正是这个缺口的直接证据。修法:用假时钟把「现在」钉死,边界就确定了。
    vi.useFakeTimers()
    try {
      const NOW_MS = new Date(2026, 8, 23, 12, 0, 0).getTime()
      vi.setSystemTime(NOW_MS)
      const { start, end } = usageWindowBounds('1h')
      const startMs = start.getTime()
      const endMs = end.getTime()
      expect(endMs - startMs).toBe(3_600_000)

      const onBoundary = [
        makeEvent('glm-4.6', startMs, 111, 0), // 恰好 = start ⇒ 计入(>=)
        makeEvent('glm-4.6', endMs - 1, 333, 0), // 边界内最后一毫秒 ⇒ 计入
        makeEvent('glm-4.6', endMs, 222, 0), // 恰好 = end ⇒ 剔除(<)
      ]
      const stats = cliproxyEventsToModelStats(onBoundary, prices, '1h')
      expect(stats).toHaveLength(1)
      // 只有起点那条与 end-1 那条计入;end 那条被剔除。
      // 变异成 `> start && <= end` 时这里会拿到 222+333(丢掉起点、多算终点)⇒ 红。
      expect(stats[0]!.requests).toBe(2)
      expect(stats[0]!.input_tokens).toBe(111 + 333)
    } finally {
      vi.useRealTimers()
    }
  })
})
