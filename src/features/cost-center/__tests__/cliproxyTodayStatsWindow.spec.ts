/**
 * B3 回归:cliproxyEventsToTodayStats 必须按窗口过滤。
 *
 * 缺陷:该函数原本没有窗口参数,内部遍历全部 events;而 events 被 Rust 侧硬截断到 30 天
 * (src-tauri/src/main.rs:675)。于是上游排行表「{range}账号成本 / 请求 / Token」、
 * 概览「今日上游账号成本」、号池「今日当前池自产」显示的其实是**近 30 天**的数字,标签却写「今日」。
 *
 * 修法:加 window 参数,按**自然日**过滤(usageWindowBounds('today')),
 * 与 sub2api 的 todayStats 语义及「今日」标签对齐。requested_at 已是毫秒(main.rs:689)。
 */
import { describe, expect, it } from 'vitest'
import { authIndexToAccountId, cliproxyEventsToTodayStats } from '../cliproxyAdapter'
import { usageWindowBounds } from '../usageWindow'
import { UNATTRIBUTED_USAGE_ACCOUNT_ID } from '../model'
import type { CliproxyUsageEvent } from '@/api/cliproxy/cpaData'
import type { LitellmPricing } from '@/api/cliproxy/cpaData'

const PRICES: Record<string, LitellmPricing> = {
  'gpt-5.6-terra': { input_cost_per_token: 2e-6, output_cost_per_token: 1.2e-5 },
}

function makeEvent(authIndex: string, requestedAtMs: number, totalTokens: number): CliproxyUsageEvent {
  return {
    id: requestedAtMs,
    requested_at: requestedAtMs,
    provider: 'openai',
    executor_type: 'codex',
    model: 'gpt-5.6-terra',
    alias: 'gpt-5.6-terra',
    auth_index: authIndex,
    auth_type: 'api_key',
    source: 'test',
    reasoning_effort: 'medium',
    service_tier: 'auto',
    latency_ms: 100,
    ttft_ms: 50,
    failed: false,
    status_code: 200,
    input_tokens: totalTokens,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_tokens: totalTokens,
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

/** 账号 id 由 auth_index 经 FNV 哈希派生(不是数字解析),用例必须用同一函数推导 key。 */
const idOf = (authIndex: string): string => String(authIndexToAccountId(authIndex))

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

describe('cliproxyEventsToTodayStats · 窗口过滤(B3)', () => {
  it('30 天里的旧事件不得冒充「今日」', () => {
    const { start, end } = usageWindowBounds('today')
    const inDay = start.getTime() + HOUR
    const justBeforeDay = start.getTime() - HOUR
    const twentyDaysAgo = start.getTime() - 20 * DAY
    const events = [
      makeEvent('7', inDay, 100),
      makeEvent('7', justBeforeDay, 5_000),
      makeEvent('7', twentyDaysAgo, 9_000),
    ]

    // 不传窗口 = 旧行为:近 30 天全部计入(这就是被标成"今日"的那批数)
    expect(cliproxyEventsToTodayStats(events, PRICES, 1)[idOf('7')].requests).toBe(3)

    const scoped = cliproxyEventsToTodayStats(events, PRICES, 1, { start, end })
    expect(scoped[idOf('7')].requests).toBe(1)
    expect(scoped[idOf('7')].tokens).toBe(100)
  })

  it('边界为左闭右开:end 时刻的事件不计入', () => {
    const { start, end } = usageWindowBounds('today')
    const scoped = cliproxyEventsToTodayStats(
      [makeEvent('9', start.getTime(), 10), makeEvent('9', end.getTime(), 10)],
      PRICES,
      1,
      { start, end },
    )
    expect(scoped[idOf('9')].requests).toBe(1)
  })

  it('窗口内无事件 → 不产生条目(不是 $0 的假实测)', () => {
    const { start, end } = usageWindowBounds('today')
    const scoped = cliproxyEventsToTodayStats([makeEvent('5', start.getTime() - DAY, 100)], PRICES, 1, { start, end })
    expect(scoped[idOf('5')]).toBeUndefined()
  })

  it('separates local metered cost from API reference value and never invents user revenue', () => {
    const stats = cliproxyEventsToTodayStats([makeEvent('5', Date.now(), 1_000_000)], PRICES, 0.2)[idOf('5')]
    expect(stats.cost).toBeCloseTo(0.4)
    expect(stats.standard_cost).toBeCloseTo(2)
    expect(stats.user_cost).toBeNull()
  })

  it('retains the priced subtotal when another request on the same account has no price', () => {
    const priced = makeEvent('5', Date.now(), 1_000_000)
    const stats = cliproxyEventsToTodayStats([priced, { ...priced, id: 2, model: 'unpriced-fixture' }], PRICES, 0.2)[idOf('5')]
    expect(stats).toMatchObject({ requests: 2, cost: null, standard_cost: null, user_cost: null, known_cost: 0.4, known_standard_cost: 2, unknown_cost_requests: 1 })
  })

  it('keeps missing auth separate from the real auth_index unknown', () => {
    const stats = cliproxyEventsToTodayStats([makeEvent('', Date.now(), 1_000_000), makeEvent('unknown', Date.now(), 500_000)], PRICES, 0.2)
    expect(stats[UNATTRIBUTED_USAGE_ACCOUNT_ID]).toMatchObject({ requests: 1, tokens: 1_000_000, cost: 0.4, standard_cost: 2, user_cost: null })
    expect(stats[idOf('unknown')]).toMatchObject({ requests: 1, tokens: 500_000, cost: 0.2, standard_cost: 1 })
  })
})
