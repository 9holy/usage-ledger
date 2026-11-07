/**
 * CPA primary and secondary quota slots are independent.
 * The older test inferred fixed 5h/7d durations from reset minus request time.
 * Upstream source now explicitly permits arbitrary durations and null slots;
 * usage_events does not preserve duration metadata. The assertions below retain
 * the original values, resets, true-zero, missing-value, failure and history cases,
 * but bind them to opaque slots instead of inventing fixed durations.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { authIndexToAccountId, cliproxyEventsToAccountUsage } from '../cliproxyAdapter'
import { quotaWindowState } from '../quotaWindowState'
import { formatUtilization } from '../honestValues'
import type { CliproxyUsageEvent } from '@/api/cliproxy/cpaData'

/** 固定的 secondary 重置时刻(unix 秒),避免用 Date.now() 让断言漂移。 */
const SECONDARY_RESET_SECONDS = 1_800_000_000
/** 固定的 primary 重置时刻(unix 秒)。 */
const PRIMARY_RESET_SECONDS = 1_790_000_000

function makeEvent(authIndex: string, requestedAtMs: number, overrides: Partial<CliproxyUsageEvent> = {}): CliproxyUsageEvent {
  return {
    id: requestedAtMs,
    requested_at: requestedAtMs,
    provider: 'openai',
    executor_type: 'codex',
    model: 'gpt-5.6-terra',
    alias: 'gpt-5.6-terra',
    auth_index: authIndex,
    auth_type: 'oauth',
    source: 'test',
    reasoning_effort: 'medium',
    service_tier: 'auto',
    latency_ms: 100,
    ttft_ms: 50,
    failed: false,
    status_code: 200,
    input_tokens: 100,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_tokens: 100,
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

/** 账号 id 保留完整原生 auth_index,用例使用相同的来源命名空间函数。 */
const idOf = (authIndex: string): string => String(authIndexToAccountId(authIndex))

describe('cliproxyEventsToAccountUsage · secondary 配额读 secondary,不复用 primary', () => {
  it('同一账号 primary 与 secondary 数值不同时,secondary_window 取 secondary 而非 primary', () => {
    const usage = cliproxyEventsToAccountUsage([
      makeEvent('acct-a', 1_000, {
        primary_used_percent: 100,
        primary_reset_at: PRIMARY_RESET_SECONDS,
        secondary_used_percent: 35,
        secondary_reset_at: SECONDARY_RESET_SECONDS,
      }),
    ])[idOf('acct-a')]

    expect(usage.primary_window?.utilization).toBe(100)
    expect(usage.secondary_window?.utilization).toBe(35)
    // 回退到"primary 复用"时下面这条会拿到 100
    expect(usage.secondary_window?.utilization).not.toBe(usage.primary_window?.utilization)
  })

  it('secondary_window 的重置时间来自 secondary_reset_at(不是 primary_reset_at)', () => {
    const usage = cliproxyEventsToAccountUsage([
      makeEvent('acct-b', 1_000, {
        primary_used_percent: 62,
        primary_reset_at: PRIMARY_RESET_SECONDS,
        secondary_used_percent: 24,
        secondary_reset_at: SECONDARY_RESET_SECONDS,
      }),
    ])[idOf('acct-b')]

    expect(usage.primary_window?.resets_at).toBe(new Date(PRIMARY_RESET_SECONDS * 1000).toISOString())
    expect(usage.secondary_window?.resets_at).toBe(new Date(SECONDARY_RESET_SECONDS * 1000).toISOString())
    expect(usage.secondary_window?.remaining_seconds).toBeGreaterThan(0)
  })
})

describe('cliproxyEventsToAccountUsage · 源没报 7d 窗口时不得落 0', () => {
  it('secondary_used_percent=0 且 secondary_reset_at=null ⇒ secondary_window 为 null(实测的缺省编码)', () => {
    const usage = cliproxyEventsToAccountUsage([
      makeEvent('acct-c', 1_000, {
        primary_used_percent: 100,
        primary_reset_at: PRIMARY_RESET_SECONDS,
        secondary_used_percent: 0,
        secondary_reset_at: null,
      }),
    ])[idOf('acct-c')]

    expect(usage.secondary_window).toBeNull()
    // primary 窗口是真的,不能因为 7d 缺失被一起丢掉
    expect(usage.primary_window?.utilization).toBe(100)
  })

  it('secondary_* 全为 null ⇒ secondary_window 为 null,primary 仍可用', () => {
    const usage = cliproxyEventsToAccountUsage([
      makeEvent('acct-d', 1_000, { primary_used_percent: 48, primary_reset_at: PRIMARY_RESET_SECONDS }),
    ])[idOf('acct-d')]

    expect(usage.secondary_window).toBeNull()
    expect(usage.primary_window?.utilization).toBe(48)
  })

  it('secondary_used_percent=0 但 reset 有值 ⇒ 是真 0,照实显示 0%', () => {
    const usage = cliproxyEventsToAccountUsage([
      makeEvent('acct-e', 1_000, {
        primary_used_percent: 1,
        primary_reset_at: PRIMARY_RESET_SECONDS,
        secondary_used_percent: 0,
        secondary_reset_at: SECONDARY_RESET_SECONDS,
      }),
    ])[idOf('acct-e')]

    expect(usage.secondary_window?.utilization).toBe(0)
    expect(usage.secondary_window?.resets_at).toBe(new Date(SECONDARY_RESET_SECONDS * 1000).toISOString())
  })

  it('只有 7d、没有 5h 的账号也要出现在结果里(不被整块丢掉)', () => {
    const usage = cliproxyEventsToAccountUsage([
      makeEvent('acct-f', 1_000, { secondary_used_percent: 12, secondary_reset_at: SECONDARY_RESET_SECONDS }),
    ])[idOf('acct-f')]

    expect(usage).toBeDefined()
    expect(usage.primary_window).toBeNull()
    expect(usage.secondary_window?.utilization).toBe(12)
    expect(usage.updated_at).toBe(new Date(1_000).toISOString())
  })

  it('两个窗口都不存在的账号不产生条目', () => {
    const usage = cliproxyEventsToAccountUsage([makeEvent('acct-g', 1_000)])
    expect(usage[idOf('acct-g')]).toBeUndefined()
  })
})

describe('cliproxyEventsToAccountUsage · 两个窗口各自取最近一条成功记录', () => {
  it('7d 来自较早的 event、5h 来自较晚的 event 时互不覆盖', () => {
    const usage = cliproxyEventsToAccountUsage([
      makeEvent('acct-h', 1_000, { primary_used_percent: 10, primary_reset_at: PRIMARY_RESET_SECONDS, secondary_used_percent: 80, secondary_reset_at: SECONDARY_RESET_SECONDS }),
      makeEvent('acct-h', 2_000, { primary_used_percent: 20, primary_reset_at: PRIMARY_RESET_SECONDS }),
    ])[idOf('acct-h')]

    expect(usage.primary_window?.utilization).toBe(20)
    expect(usage.secondary_window?.utilization).toBe(80)
    // 更新时间取两条里较新的那条
    expect(usage.updated_at).toBe(new Date(2_000).toISOString())
  })

  it('失败请求上的窗口快照不得被采信', () => {
    const usage = cliproxyEventsToAccountUsage([
      makeEvent('acct-i', 1_000, { primary_used_percent: 30, primary_reset_at: PRIMARY_RESET_SECONDS, secondary_used_percent: 40, secondary_reset_at: SECONDARY_RESET_SECONDS }),
      makeEvent('acct-i', 5_000, { failed: true, status_code: 429, primary_used_percent: 99, primary_reset_at: PRIMARY_RESET_SECONDS, secondary_used_percent: 99, secondary_reset_at: SECONDARY_RESET_SECONDS }),
    ])[idOf('acct-i')]

    expect(usage.primary_window?.utilization).toBe(30)
    expect(usage.secondary_window?.utilization).toBe(40)
  })

  it('同一窗口取最新一条成功记录(不取最早)', () => {
    const usage = cliproxyEventsToAccountUsage([
      makeEvent('acct-j', 1_000, { secondary_used_percent: 5, secondary_reset_at: SECONDARY_RESET_SECONDS }),
      makeEvent('acct-j', 9_000, { secondary_used_percent: 70, secondary_reset_at: SECONDARY_RESET_SECONDS }),
    ])[idOf('acct-j')]

    expect(usage.secondary_window?.utilization).toBe(70)
  })
})

describe('cliproxyEventsToAccountUsage · 不编造 token 级数据', () => {
  it('secondary_window 只含 utilization/resets_at/remaining_seconds,不塞 token 字段', () => {
    const usage = cliproxyEventsToAccountUsage([
      makeEvent('acct-k', 1_000, {
        primary_used_percent: 10,
        primary_reset_at: PRIMARY_RESET_SECONDS,
        secondary_used_percent: 15,
        secondary_reset_at: SECONDARY_RESET_SECONDS,
        // 源侧 token 级字段恒 NULL,即使传进来也不得被当成可用值渲染
        secondary_used_tokens: null,
        secondary_remaining_tokens: null,
        secondary_limit_tokens: null,
      }),
    ])[idOf('acct-k')]

    expect(usage.secondary_window).toEqual({
      utilization: 15,
      resets_at: new Date(SECONDARY_RESET_SECONDS * 1000).toISOString(),
      remaining_seconds: expect.any(Number),
      recorded_at: new Date(1_000).toISOString(),
      snapshot_source: 'recorded',
    })
  })
})

describe('CostCenterView · 7d 窗口无数据时的显式占位', () => {
  // 渲染层契约:seven_day 为 null 时**不能只是把整格省掉**(用户分不清"源没给"与"没渲染"),
  // 也不能落 0%。这里用源码断言钉住 —— 与 uiShellContract / cliproxyWordingContract 同款做法。
  const view = readFileSync(resolve(process.cwd(), 'src/views/admin/CostCenterView.vue'), 'utf8')

  it('5h 存在时仍创建独立的7d格，并标注来源未提供该周期', () => {
    expect(view).toContain('if (usage.five_hour || usage.seven_day || usage.seven_day_sonnet)')
    expect(view).toContain("periods.push({ key: '5h', label: '5h', reading: usage.five_hour }, { key: '7d', label: '7d', reading: usage.seven_day })")
    expect(view).toContain('provided: !!period.reading, state: quotaWindowState(period.reading, now.value.getTime())')
    expect(view).toContain('v-for="quota in row.quotaWindows"')
    expect(view).toContain("!quota.provided ? t('costCenter.integration.quotaPeriodNotReported')")
  })

  it('缺失窗口渲染未知符号，真实零利用率仍显示0%', () => {
    const placeholder = view.split(':data-usage-window="quota.key"')[1]?.split('</span>')[0] ?? ''
    expect(placeholder).not.toBe('')
    expect(placeholder).toContain('formatUtilization(quota.state.utilization)')
    expect(placeholder).toContain('costCenter.integration.quotaPeriodNotReported')
    expect(placeholder).not.toContain('0%')
    expect(formatUtilization(quotaWindowState(null).utilization)).toBe('—')
    expect(formatUtilization(quotaWindowState({ utilization: 0 }).utilization)).toBe('0%')
  })
})
