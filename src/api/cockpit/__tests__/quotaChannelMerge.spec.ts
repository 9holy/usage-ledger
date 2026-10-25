/**
 * 渠道配额「同源合并」单测（2026-09-12）。
 *
 * 背景：`antigravity` / `gemini` / `antigravity_ide` 在 Rust 侧共用 `accounts` 目录，
 * 读的是同一份桌面缓存 → 快照集合完全相同 → UI 上 3 个一模一样的 chip，纯噪音。
 *
 * 本测的核心是**保守合并**：两步都过才合并（同账号目录 + 组内签名完全一致），
 * 只要有一丁点不同就**整组不合并**；尤其"用量不可得（percent=null）"
 * 绝不能被合并进去冒充有数据。
 */
import { describe, expect, it } from 'vitest'
import {
  mergeIdenticalQuotaChannels,
  quotaSnapshotSetSignature,
  isMergeableQuotaSignature,
  QUOTA_CHANNEL_JOINER,
  QUOTA_NULL_TOKEN,
  type QuotaChannelChip,
} from '../quotaChannelMerge'
import type { QuotaSnapshot } from '../quota'

const NOW = 1_800_000_000_000
const DAY = 86_400_000

/** 三个 Google 系渠道共用同一个账号目录（Rust accounts_dir_name → "accounts"）。 */
const SHARED_DIR = '/root/.cockpit/accounts'
const CODEX_DIR = '/root/.cockpit/codex_accounts'
const KIRO_DIR = '/root/.cockpit/kiro_accounts'

function snapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    channel: 'antigravity',
    accountId: 'acc_1',
    email: 'a@b.com',
    modelId: 'gemini-2.5-pro',
    displayName: '',
    percent: 87.5,
    remainingFraction: 0.875,
    usedFraction: 0.125,
    percentKind: 'remaining',
    unavailableReason: null,
    windowKind: 'weekly',
    windowStartedAtMs: null,
    resetAtMs: null,
    source: 'snapshot',
    fetchedAtMs: NOW,
    updatedAtMs: NOW - 2 * DAY,
    stale: false,
    rawKind: 'quota',
    ...overrides,
  }
}

/** 造一个 chip（signature 由快照集合算出来，和线上 computed 完全同口径）。 */
function chip(
  channel: string,
  snapshots: QuotaSnapshot[],
  options: { accountCount?: number; dir?: string } = {},
): QuotaChannelChip {
  const accountCount = options.accountCount ?? (snapshots.length ? 11 : 0)
  const dir = options.dir ?? SHARED_DIR
  const pcts = snapshots.map((s) => s.percent).filter((p): p is number => p != null)
  const ages = snapshots
    .map((s) => (s.updatedAtMs == null ? null : NOW - s.updatedAtMs))
    .filter((a): a is number => a != null && a >= 0)
  const oldestAgeMs = ages.length ? Math.max(...ages) : null
  return {
    channel,
    dir,
    accountCount,
    worst: pcts.length ? Math.min(...pcts) : null,
    allUnavailable: snapshots.length > 0 && pcts.length === 0,
    hasSnapshot: snapshots.length > 0,
    stamp: snapshots.length ? '落盘快照·09-11 03:20' : null,
    oldestAgeMs,
    ageLabel: oldestAgeMs == null ? '' : `${Math.floor(oldestAgeMs / DAY)} 天前`,
    ageDays: oldestAgeMs == null ? 0 : Math.floor(oldestAgeMs / DAY),
    signature: quotaSnapshotSetSignature(snapshots),
  }
}

/** 真机形态：3 账号 × 4 模型 = 12 条同源快照（实测 11 × 20 = 220 条）。 */
function sharedFleet(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot[] {
  const snaps: QuotaSnapshot[] = []
  for (let a = 1; a <= 3; a += 1) {
    for (let m = 1; m <= 4; m += 1) {
      snaps.push(
        snapshot({
          accountId: `acc_${a}`,
          modelId: `model_${m}`,
          percent: (a * 10 + m) % 100,
          updatedAtMs: NOW - 2 * DAY,
          ...overrides,
        }),
      )
    }
  }
  return snaps
}

describe('同源三渠道（antigravity / gemini / antigravity_ide）', () => {
  it('★ 快照集合完全一致 → 合成 1 个 chip，channel 用 " / " 连接', () => {
    const fleet = sharedFleet()
    const merged = mergeIdenticalQuotaChannels([
      chip('antigravity', fleet),
      chip('gemini', fleet),
      chip('antigravity_ide', fleet),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].channel).toBe('antigravity / gemini / antigravity_ide')
  })

  it('★ accountCount 不相加（同一批账号，相加即虚增）', () => {
    const fleet = sharedFleet()
    const merged = mergeIdenticalQuotaChannels([
      chip('antigravity', fleet, { accountCount: 11 }),
      chip('gemini', fleet, { accountCount: 11 }),
      chip('antigravity_ide', fleet, { accountCount: 11 }),
    ])
    expect(merged[0].accountCount).toBe(11)
    expect(merged[0].accountCount).not.toBe(33)
  })

  it('合并后 worst / stamp / ageDays 取组内第一个（判定完全一致，取哪个都一样）', () => {
    const fleet = sharedFleet()
    const first = chip('antigravity', fleet)
    const merged = mergeIdenticalQuotaChannels([first, chip('gemini', fleet), chip('antigravity_ide', fleet)])
    expect(merged[0].worst).toBe(first.worst)
    expect(merged[0].stamp).toBe(first.stamp)
    expect(merged[0].ageDays).toBe(first.ageDays)
    expect(merged[0].allUnavailable).toBe(first.allUnavailable)
  })

  it('★ 三渠道里有 1 条 percent 不同 → 整组不合并，仍是 3 个 chip（差异在中）', () => {
    const base = sharedFleet()
    const tweaked = base.map((s, i) => (i === 0 ? { ...s, percent: (s.percent ?? 0) + 0.1 } : s))
    const merged = mergeIdenticalQuotaChannels([
      chip('antigravity', base),
      chip('gemini', tweaked),
      chip('antigravity_ide', base),
    ])
    expect(merged).toHaveLength(3)
    expect(merged.map((c) => c.channel)).toEqual(['antigravity', 'gemini', 'antigravity_ide'])
  })

  it('★ 三渠道里有 1 条 percent 不同 → 仍是 3 个 chip（差异在尾，不把前两个悄悄合掉）', () => {
    const base = sharedFleet()
    const tweaked = base.map((s, i) => (i === 0 ? { ...s, percent: (s.percent ?? 0) + 0.1 } : s))
    const merged = mergeIdenticalQuotaChannels([
      chip('antigravity', base),
      chip('gemini', base),
      chip('antigravity_ide', tweaked),
    ])
    expect(merged).toHaveLength(3)
  })

  it('★ 三渠道里有 1 条 percent 不同 → 仍是 3 个 chip（差异在头）', () => {
    const base = sharedFleet()
    const tweaked = base.map((s, i) => (i === 0 ? { ...s, percent: (s.percent ?? 0) + 0.1 } : s))
    const merged = mergeIdenticalQuotaChannels([
      chip('antigravity', tweaked),
      chip('gemini', base),
      chip('antigravity_ide', base),
    ])
    expect(merged).toHaveLength(3)
  })

  it('updatedAtMs 差 1ms 也不合并（数据年龄不同 = 不是同一个数）', () => {
    const base = sharedFleet()
    const shifted = base.map((s) => ({ ...s, updatedAtMs: (s.updatedAtMs ?? 0) + 1 }))
    expect(mergeIdenticalQuotaChannels([chip('antigravity', base), chip('gemini', shifted)])).toHaveLength(2)
  })

  it('快照顺序不同不影响合并（签名排序后再 join）', () => {
    const base = sharedFleet()
    const shuffled = [...base].reverse()
    expect(quotaSnapshotSetSignature(base)).toBe(quotaSnapshotSetSignature(shuffled))
    expect(mergeIdenticalQuotaChannels([chip('antigravity', base), chip('gemini', shuffled)])).toHaveLength(1)
  })

  it('同源三渠道合并 + 别的目录渠道单独存在 → 2 个 chip，且顺序不乱', () => {
    const base = sharedFleet()
    const codexSnaps = sharedFleet({ accountId: 'codex_1', updatedAtMs: NOW - DAY })
    const merged = mergeIdenticalQuotaChannels([
      chip('codex', codexSnaps, { dir: CODEX_DIR, accountCount: 9 }),
      chip('antigravity', base),
      chip('gemini', base),
      chip('antigravity_ide', base),
    ])
    expect(merged.map((c) => c.channel)).toEqual(['codex', 'antigravity / gemini / antigravity_ide'])
    expect(merged[1].accountCount).toBe(11)
  })

  it('跨账号目录即使快照集合相同也不合并（组边界 = 同一账号目录）', () => {
    const fleet = sharedFleet()
    const merged = mergeIdenticalQuotaChannels([
      chip('antigravity', fleet, { dir: SHARED_DIR }),
      chip('codex', fleet, { dir: CODEX_DIR }),
    ])
    expect(merged).toHaveLength(2)
  })
})

describe('单渠道 / 空集合 · 不产生多余分隔符', () => {
  it('★ 单渠道原样返回，channel 里不出现 " / "', () => {
    const merged = mergeIdenticalQuotaChannels([chip('codex', sharedFleet(), { dir: CODEX_DIR })])
    expect(merged).toHaveLength(1)
    expect(merged[0].channel).toBe('codex')
    expect(merged[0].channel).not.toContain(QUOTA_CHANNEL_JOINER)
  })

  it('两个"无快照"渠道不合并（合并会藏掉各自的 accountCount）', () => {
    const merged = mergeIdenticalQuotaChannels([
      chip('kiro', [], { dir: KIRO_DIR, accountCount: 4 }),
      chip('windsurf', [], { dir: '/root/.cockpit/windsurf_accounts', accountCount: 7 }),
    ])
    expect(merged).toHaveLength(2)
    expect(merged.map((c) => c.accountCount)).toEqual([4, 7])
  })

  it('空快照集合的签名不可合并', () => {
    expect(isMergeableQuotaSignature(quotaSnapshotSetSignature([]))).toBe(false)
    expect(isMergeableQuotaSignature(quotaSnapshotSetSignature(sharedFleet()))).toBe(true)
  })

  it('有快照 vs 无快照 → 不合并', () => {
    const merged = mergeIdenticalQuotaChannels([
      chip('antigravity', sharedFleet(), { accountCount: 11 }),
      chip('gemini', [], { accountCount: 11 }),
    ])
    expect(merged).toHaveLength(2)
  })

  it('空输入 → 空输出（不抛错）', () => {
    expect(mergeIdenticalQuotaChannels([])).toEqual([])
  })
})

describe('★ 用量不可得（percent=null）绝不冒充有数据', () => {
  it('null 与真实 0% 不合并（null → ∅，与 "0" 严格区分）', () => {
    const withNull = [snapshot({ accountId: 'acc_1', modelId: 'm1', percent: null, unavailableReason: 'API Key 类账号' })]
    const withZero = [snapshot({ accountId: 'acc_1', modelId: 'm1', percent: 0 })]
    expect(quotaSnapshotSetSignature(withNull)).not.toBe(quotaSnapshotSetSignature(withZero))
    expect(mergeIdenticalQuotaChannels([chip('antigravity', withNull), chip('gemini', withZero)])).toHaveLength(2)
  })

  it('null 序列化成 ∅ 占位符，不是空串（空串会和其它空值撞上）', () => {
    expect(QUOTA_NULL_TOKEN).toBeTruthy()
    expect(quotaSnapshotSetSignature([snapshot({ percent: null })])).toContain(QUOTA_NULL_TOKEN)
  })

  it('缺一条快照（集合大小不同）→ 不合并', () => {
    const full = sharedFleet()
    const partial = full.slice(0, full.length - 1)
    expect(mergeIdenticalQuotaChannels([chip('antigravity', full), chip('gemini', partial)])).toHaveLength(2)
  })

  it('全 null 的同源渠道合并后 worst 仍是 null（UI 走"用量不可得"，不是 0%）', () => {
    const fleet = sharedFleet({ percent: null, unavailableReason: '该账号类型不提供订阅配额' })
    const merged = mergeIdenticalQuotaChannels([
      chip('antigravity', fleet, { accountCount: 11 }),
      chip('gemini', fleet, { accountCount: 11 }),
      chip('antigravity_ide', fleet, { accountCount: 11 }),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].worst).toBeNull()
    expect(merged[0].allUnavailable).toBe(true)
  })

  it('source 不同（落盘快照 vs 实时）不合并 —— 混标来源等于骗人', () => {
    const base = sharedFleet()
    const live = base.map((s) => ({ ...s, source: 'live' as const }))
    expect(mergeIdenticalQuotaChannels([chip('antigravity', base), chip('gemini', live)])).toHaveLength(2)
  })

  it('★ fetchedAtMs 不参与签名（每个渠道一次 invoke 都不同，否则永远合并不了）', () => {
    const base = sharedFleet()
    const later = base.map((s) => ({ ...s, fetchedAtMs: s.fetchedAtMs + 5_000 }))
    expect(quotaSnapshotSetSignature(base)).toBe(quotaSnapshotSetSignature(later))
    expect(mergeIdenticalQuotaChannels([chip('antigravity', base), chip('gemini', later)])).toHaveLength(1)
  })
})
