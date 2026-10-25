/**
 * cliproxy 独立 7d 配额窗口:seven_day 必须读 `secondary_*`,不得拿 `primary` 顶替。
 *
 * 缺陷(2026-09-17):`cliproxyEventsToAccountUsage` 把同一个 `progress` 同时赋给
 * `five_hour` 与 `seven_day` —— 界面上「7d」那一格显示的其实是 5h 窗口的数。
 * 而源(CPA `usage.db.usage_events`)本来就单独采了 secondary 窗口:
 * Rust 侧 SELECT 已取回(`src-tauri/src/main.rs:682`)、TS 类型已声明(`cpaData.ts:43-47`),
 * 只有 adapter 0 处引用 ⇒ 数据躺在内存里没被用,还被审计误判成「源不支持」。
 *
 * 实测(直读插件 usage.db 7700 行,只读连接):
 *   primary_reset_at − requested_at ≈ 4.69h  ⇒ primary = 5h 窗口
 *   secondary_reset_at − requested_at ≈ 6.78d ⇒ secondary = 独立 7d 窗口
 *   同一条 event 上两者可以差很远(实测 5h=100% / 7d=35%)
 *
 * 空值契约(本文件的重点):
 *   - `secondary_reset_at` 为空 ⇒ 源没报这个窗口 ⇒ `seven_day = null`(渲染「无数据」),
 *     **不得落 0** —— 实测 207 行 `secondary_used_percent=0` 且 reset 为空,全部集中在
 *     15 个从未出现过 reset 的 auth_index,那是缺省编码而不是"用了 0%"。
 *   - `secondary_used_percent=0` 且 reset 非空 ⇒ 是真 0,照实显示 0%。
 *   - 5h 窗口与 7d 窗口各自取最近一条**成功**记录(两者可能来自不同 event)。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { authIndexToAccountId, cliproxyEventsToAccountUsage } from '../cliproxyAdapter'
import type { CliproxyUsageEvent } from '@/api/cliproxy/cpaData'

/** 固定的 7d 重置时刻(unix 秒),避免用 Date.now() 让断言漂移。 */
const SEC_7D = 1_800_000_000
/** 固定的 5h 重置时刻(unix 秒)。 */
const SEC_5H = 1_790_000_000

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

/** 账号 id 由 auth_index 经 FNV 哈希派生(不是数字解析),用例必须用同一函数推导 key。 */
const idOf = (authIndex: string): string => String(authIndexToAccountId(authIndex))

describe('cliproxyEventsToAccountUsage · 7d 配额读 secondary,不复用 primary', () => {
  it('同一账号 5h 与 7d 数值不同时,seven_day 取 secondary 而非 primary', () => {
    const usage = cliproxyEventsToAccountUsage([
      makeEvent('acct-a', 1_000, {
        primary_used_percent: 100,
        primary_reset_at: SEC_5H,
        secondary_used_percent: 35,
        secondary_reset_at: SEC_7D,
      }),
    ])[idOf('acct-a')]

    expect(usage.five_hour?.utilization).toBe(100)
    expect(usage.seven_day?.utilization).toBe(35)
    // 回退到"primary 复用"时下面这条会拿到 100
    expect(usage.seven_day?.utilization).not.toBe(usage.five_hour?.utilization)
  })

  it('seven_day 的重置时间来自 secondary_reset_at(不是 primary_reset_at)', () => {
    const usage = cliproxyEventsToAccountUsage([
      makeEvent('acct-b', 1_000, {
        primary_used_percent: 62,
        primary_reset_at: SEC_5H,
        secondary_used_percent: 24,
        secondary_reset_at: SEC_7D,
      }),
    ])[idOf('acct-b')]

    expect(usage.five_hour?.resets_at).toBe(new Date(SEC_5H * 1000).toISOString())
    expect(usage.seven_day?.resets_at).toBe(new Date(SEC_7D * 1000).toISOString())
    expect(usage.seven_day?.remaining_seconds).toBeGreaterThan(0)
  })
})

describe('cliproxyEventsToAccountUsage · 源没报 7d 窗口时不得落 0', () => {
  it('secondary_used_percent=0 且 secondary_reset_at=null ⇒ seven_day 为 null(实测的缺省编码)', () => {
    const usage = cliproxyEventsToAccountUsage([
      makeEvent('acct-c', 1_000, {
        primary_used_percent: 100,
        primary_reset_at: SEC_5H,
        secondary_used_percent: 0,
        secondary_reset_at: null,
      }),
    ])[idOf('acct-c')]

    expect(usage.seven_day).toBeNull()
    // 5h 窗口是真的,不能因为 7d 缺失被一起丢掉
    expect(usage.five_hour?.utilization).toBe(100)
  })

  it('secondary_* 全为 null ⇒ seven_day 为 null,5h 仍可用', () => {
    const usage = cliproxyEventsToAccountUsage([
      makeEvent('acct-d', 1_000, { primary_used_percent: 48, primary_reset_at: SEC_5H }),
    ])[idOf('acct-d')]

    expect(usage.seven_day).toBeNull()
    expect(usage.five_hour?.utilization).toBe(48)
  })

  it('secondary_used_percent=0 但 reset 有值 ⇒ 是真 0,照实显示 0%', () => {
    const usage = cliproxyEventsToAccountUsage([
      makeEvent('acct-e', 1_000, {
        primary_used_percent: 1,
        primary_reset_at: SEC_5H,
        secondary_used_percent: 0,
        secondary_reset_at: SEC_7D,
      }),
    ])[idOf('acct-e')]

    expect(usage.seven_day?.utilization).toBe(0)
    expect(usage.seven_day?.resets_at).toBe(new Date(SEC_7D * 1000).toISOString())
  })

  it('只有 7d、没有 5h 的账号也要出现在结果里(不被整块丢掉)', () => {
    const usage = cliproxyEventsToAccountUsage([
      makeEvent('acct-f', 1_000, { secondary_used_percent: 12, secondary_reset_at: SEC_7D }),
    ])[idOf('acct-f')]

    expect(usage).toBeDefined()
    expect(usage.five_hour).toBeNull()
    expect(usage.seven_day?.utilization).toBe(12)
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
      makeEvent('acct-h', 1_000, { primary_used_percent: 10, primary_reset_at: SEC_5H, secondary_used_percent: 80, secondary_reset_at: SEC_7D }),
      makeEvent('acct-h', 2_000, { primary_used_percent: 20, primary_reset_at: SEC_5H }),
    ])[idOf('acct-h')]

    expect(usage.five_hour?.utilization).toBe(20)
    expect(usage.seven_day?.utilization).toBe(80)
    // 更新时间取两条里较新的那条
    expect(usage.updated_at).toBe(new Date(2_000).toISOString())
  })

  it('失败请求上的窗口快照不得被采信', () => {
    const usage = cliproxyEventsToAccountUsage([
      makeEvent('acct-i', 1_000, { primary_used_percent: 30, primary_reset_at: SEC_5H, secondary_used_percent: 40, secondary_reset_at: SEC_7D }),
      makeEvent('acct-i', 5_000, { failed: true, status_code: 429, primary_used_percent: 99, primary_reset_at: SEC_5H, secondary_used_percent: 99, secondary_reset_at: SEC_7D }),
    ])[idOf('acct-i')]

    expect(usage.five_hour?.utilization).toBe(30)
    expect(usage.seven_day?.utilization).toBe(40)
  })

  it('同一窗口取最新一条成功记录(不取最早)', () => {
    const usage = cliproxyEventsToAccountUsage([
      makeEvent('acct-j', 1_000, { secondary_used_percent: 5, secondary_reset_at: SEC_7D }),
      makeEvent('acct-j', 9_000, { secondary_used_percent: 70, secondary_reset_at: SEC_7D }),
    ])[idOf('acct-j')]

    expect(usage.seven_day?.utilization).toBe(70)
  })
})

describe('cliproxyEventsToAccountUsage · 不编造 token 级数据', () => {
  it('seven_day 只含 utilization/resets_at/remaining_seconds,不塞 token 字段', () => {
    const usage = cliproxyEventsToAccountUsage([
      makeEvent('acct-k', 1_000, {
        primary_used_percent: 10,
        primary_reset_at: SEC_5H,
        secondary_used_percent: 15,
        secondary_reset_at: SEC_7D,
        // 源侧 token 级字段恒 NULL,即使传进来也不得被当成可用值渲染
        secondary_used_tokens: null,
        secondary_remaining_tokens: null,
        secondary_limit_tokens: null,
      }),
    ])[idOf('acct-k')]

    expect(usage.seven_day).toEqual({
      utilization: 15,
      resets_at: new Date(SEC_7D * 1000).toISOString(),
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

  it('7d 有值渲染百分比;seven_day 为 null 且 5h 存在时渲染「无数据」占位', () => {
    expect(view).toContain('v-if="row.usage.seven_day"')
    expect(view).toContain('v-else-if="row.usage.five_hour" data-usage-window="7d-unavailable"')
    expect(view).toContain('>无数据</strong>')
  })

  it('占位分支不得出现 0% 之类的假数值', () => {
    const placeholder = view.split('data-usage-window="7d-unavailable"')[1]?.split('</span>')[0] ?? ''
    expect(placeholder).not.toBe('')
    expect(placeholder).toContain('无数据')
    expect(placeholder).not.toContain('0%')
    expect(placeholder).not.toContain('formatUtilization')
  })
})
