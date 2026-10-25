/**
 * cliproxy 推理档位分布:补上「源已给、前端零消费」的第三源不对称。
 *
 * 缺陷(2026-09-20):`usage_events.reasoning_effort` 三源里只有 cockpit 用上了 ——
 * Rust 侧 SELECT 已取回(`src-tauri/src/main.rs:686`)、TS 类型已声明(`cpaData.ts:25`)、
 * 本仓夹具里也既有 'medium' 也有 '',但 `src/features/cost-center/` 非测试代码零引用。
 *
 * ★ 本文件的重点 —— 空串语义:
 *   `reasoning_effort` 类型是非空 `string`,可空串 '' 在真实夹具里存在。
 *   空串表示**上游没记录档位**,不是一个档位:
 *     - 必须与真实档位分开统计,不得并进任何一档(否则某一档凭空变大);
 *     - 也不得因为"没记录"而显示成 0(那会被读成"实测该档 0 次");
 *     - 未记录的请求**不计入档位占比分母**,否则每一档的占比都被稀释。
 */
import './costDataI18n'
import { describe, expect, it } from 'vitest'
import { i18n } from '@/i18n'
import zh from '@/i18n/locales/zh/costCenter'
import en from '@/i18n/locales/en/costCenter'
import { cliproxyEventsToReasoningEfforts } from '../cliproxyAdapter'
import { costDataText } from '../costDataText'
import type { CliproxyUsageEvent } from '@/api/cliproxy/cpaData'

i18n.global.mergeLocaleMessage('zh', { costCenter: zh })
i18n.global.mergeLocaleMessage('en', { costCenter: en })

function makeEvent(effort: string, overrides: Partial<CliproxyUsageEvent> = {}): CliproxyUsageEvent {
  return {
    id: 1,
    requested_at: 1_700_000_000_000,
    provider: 'openai',
    executor_type: 'codex',
    model: 'gpt-5.6-terra',
    alias: 'gpt-5.6-terra',
    auth_index: 'acct-a',
    auth_type: 'oauth',
    source: 'test',
    reasoning_effort: effort,
    service_tier: 'auto',
    latency_ms: 100,
    ttft_ms: 50,
    failed: false,
    status_code: 200,
    input_tokens: 100,
    output_tokens: 10,
    reasoning_tokens: 0,
    cached_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_tokens: 110,
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

const tiersOf = (rows: ReturnType<typeof cliproxyEventsToReasoningEfforts>) => rows.filter((r) => !r.isUnrecorded)
const unrecordedOf = (rows: ReturnType<typeof cliproxyEventsToReasoningEfforts>) => rows.find((r) => r.isUnrecorded) ?? null

describe('cliproxyEventsToReasoningEfforts · 空串与真实档位必须分开', () => {
  it('updates cached display labels with locale without changing counts or raw effort keys', () => {
    const rows = cliproxyEventsToReasoningEfforts([makeEvent('high'), makeEvent(''), makeEvent('vendor-custom')])
    expect(rows.find(row => row.key === 'high')!.label).toBe('高')
    i18n.global.locale.value = 'en'
    expect(rows.find(row => row.key === 'high')!.label).toBe('High')
    expect(rows.find(row => row.isUnrecorded)!.label).toBe('Unrecorded tier')
    expect(rows.find(row => row.key === 'vendor-custom')!.label).toBe('vendor-custom')
    expect(rows.map(row => row.count)).toEqual([1, 1, 1])
  })
  it('uses the selected half-open window and excludes older and end-boundary requests', () => {
    const now = new Date('2026-10-25T12:00:00Z')
    const start = now.getTime() - 3_600_000
    const events = [
      makeEvent('high', { requested_at: start - 1 }),
      makeEvent('medium', { requested_at: start }),
      makeEvent('', { requested_at: now.getTime() - 1 }),
      makeEvent('high', { requested_at: now.getTime() }),
    ]
    expect(cliproxyEventsToReasoningEfforts(events, '1h', now).map(row => [row.key, row.count, row.share]))
      .toEqual([['medium', 1, 1], ['', 1, null]])
    expect(cliproxyEventsToReasoningEfforts(events).reduce((sum, row) => sum + row.count, 0)).toBe(4)
  })
  it('空串单列为"未记录档位",不并进任何真实档位', () => {
    const rows = cliproxyEventsToReasoningEfforts([
      makeEvent('medium'),
      makeEvent('medium'),
      makeEvent('high'),
      makeEvent(''),
      makeEvent(''),
      makeEvent(''),
    ])

    const tiers = tiersOf(rows)
    // 只有 medium / high 两个真实档位;空串没有混进来
    expect(tiers.map((t) => t.key).sort()).toEqual(['high', 'medium'])
    expect(tiers.find((t) => t.key === 'medium')!.count).toBe(2)
    expect(tiers.find((t) => t.key === 'high')!.count).toBe(1)
    // 关键:medium 不能被空串顶成 5
    expect(tiers.find((t) => t.key === 'medium')!.count).not.toBe(5)

    const unrecorded = unrecordedOf(rows)
    expect(unrecorded).not.toBeNull()
    expect(unrecorded!.isUnrecorded).toBe(true)
    expect(unrecorded!.count).toBe(3)
    expect(unrecorded!.label).toBe(costDataText('unrecordedTier'))
  })

  it('未记录请求不计入档位占比分母(否则每档占比被稀释)', () => {
    const rows = cliproxyEventsToReasoningEfforts([
      makeEvent('medium'),
      makeEvent('high'),
      makeEvent(''),
      makeEvent(''),
    ])
    const tiers = tiersOf(rows)
    // 分母是 2 个有记录的请求,不是 4 个
    expect(tiers.find((t) => t.key === 'medium')!.share).toBeCloseTo(0.5)
    expect(tiers.find((t) => t.key === 'high')!.share).toBeCloseTo(0.5)
    // 未记录不是一个档位 ⇒ 不参与占比,share 必须是 null(不是 0)
    expect(unrecordedOf(rows)!.share).toBeNull()
  })

  it('全是空串 ⇒ 一个真实档位都不出现(不得凭空造出 0 次的档位)', () => {
    const rows = cliproxyEventsToReasoningEfforts([makeEvent(''), makeEvent('')])
    expect(tiersOf(rows)).toEqual([])
    expect(rows).toHaveLength(1)
    expect(rows[0].isUnrecorded).toBe(true)
    expect(rows[0].count).toBe(2)
  })

  it('全都有档位 ⇒ 不出现"未记录 0"这种假行', () => {
    const rows = cliproxyEventsToReasoningEfforts([makeEvent('medium'), makeEvent('high')])
    expect(unrecordedOf(rows)).toBeNull()
    expect(rows.every((r) => !r.isUnrecorded)).toBe(true)
  })

  it('窗口内无请求 ⇒ 空数组(是真实的"无",不是"读不到")', () => {
    expect(cliproxyEventsToReasoningEfforts([])).toEqual([])
  })

  it('未收录的档位取值原样作标签,不硬编中文名', () => {
    const rows = cliproxyEventsToReasoningEfforts([makeEvent('ultra')])
    expect(rows[0].key).toBe('ultra')
    expect(rows[0].label).toBe('ultra')
  })

  it('与 cockpit 同档位同名(三源标签一致)', () => {
    const rows = cliproxyEventsToReasoningEfforts([makeEvent('xhigh'), makeEvent('max'), makeEvent('low')])
    expect(rows.find((r) => r.key === 'xhigh')!.label).toBe('极高')
    expect(rows.find((r) => r.key === 'max')!.label).toBe('最高')
    expect(rows.find((r) => r.key === 'low')!.label).toBe('低')
  })

  it('真实档位按数量降序;未记录行排在最后,不参与档位排序', () => {
    const rows = cliproxyEventsToReasoningEfforts([
      makeEvent('low'),
      makeEvent('medium'),
      makeEvent('medium'),
      makeEvent(''),
      makeEvent(''),
      makeEvent(''),
    ])
    expect(tiersOf(rows).map((t) => t.key)).toEqual(['medium', 'low'])
    expect(rows[rows.length - 1].isUnrecorded).toBe(true)
  })

  it('纯空白串也算"未记录",不会被当成一个叫 "  " 的档位', () => {
    const rows = cliproxyEventsToReasoningEfforts([makeEvent('   '), makeEvent('medium')])
    expect(tiersOf(rows).map((t) => t.key)).toEqual(['medium'])
    expect(unrecordedOf(rows)!.count).toBe(1)
  })
})
