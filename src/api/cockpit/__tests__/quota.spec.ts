/**
 * 渠道配额客户端单测（PRD P0-21 / P1-12 / P0-23）。
 *
 * 重点不是"能不能读文件"（那是 Rust 侧 `cockpit_quota.rs` 的职责，已有 30 项单测），
 * 而是**前端展示层绝不能把"不可得"渲染成 0%** —— 这是 P0-21 验收⑤的核心。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import '@/api/__tests__/costCenterLocaleFixture'
import i18n from '@/i18n'
import { invoke } from '@tauri-apps/api/core'
import {
  quotaNoUpdatedAtNote,
  getQuotaChannels,
  getQuotaSnapshots,
  quotaPercentLabel,
  quotaSourceLabel,
  quotaStampLabel,
  quotaWindowLabel,
  quotaAgeMs,
  quotaAgeLabel,
  formatAgeMs,
  normalizePlatformKey,
  currentAccountIdFor,
  modelGroupLabelFor,
  groupLabelsFor,
  type QuotaSnapshot,
  type CurrentAccountEntry,
  type ModelGroups,
  type AccountGroups,
} from '../quota'

it('switches quota provenance and age labels without changing unknowns, timestamps or measured zero', () => {
  i18n.global.locale.value = 'en'
  expect(quotaSourceLabel('live')).toBe('Live')
  expect(quotaWindowLabel('weekly')).toBe('Weekly window')
  expect(quotaStampLabel(snapshot({ updatedAtMs: null }))).toContain('source does not provide its save time')
  expect(formatAgeMs(12 * 60_000)).toBe('12 minutes ago')
  expect(quotaPercentLabel(snapshot({ percent: null }))).toBe('Usage unavailable')
  expect(quotaPercentLabel(snapshot({ percent: 0 }))).toBe('0.0%')
  i18n.global.locale.value = 'zh'
  expect(formatAgeMs(12 * 60_000)).toBe('12 分钟前')
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/api/url', () => ({ isDesktopRuntime: () => true }))
vi.mock('@/stores/connection', () => ({ errMsg: (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback) }))

function snapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    channel: 'codex',
    accountId: 'codex_abc',
    email: 'a@b.com',
    modelId: '',
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
    fetchedAtMs: 1_789_000_000_000,
    updatedAtMs: 1_789_000_000_000,
    stale: false,
    rawKind: 'quota',
    ...overrides,
  }
}

describe('quotaPercentLabel · 不可得绝不显示 0%', () => {
  it('percent 为 null → "用量不可得"，不是 0.0%', () => {
    const label = quotaPercentLabel(snapshot({ percent: null, remainingFraction: null, usedFraction: null }))
    expect(label).toBe('用量不可得')
    expect(label).not.toContain('0.0%')
  })

  it('带 unavailableReason → "用量不可得"（API Key 类账号，P1-12 第三态）', () => {
    const label = quotaPercentLabel(
      snapshot({ percent: null, unavailableReason: '该账号类型不提供订阅配额（API Key 类）' }),
    )
    expect(label).toBe('用量不可得')
  })

  it('有百分比 → 归一化后的剩余%，保留 1 位小数', () => {
    expect(quotaPercentLabel(snapshot({ percent: 87.5 }))).toBe('87.5%')
    expect(quotaPercentLabel(snapshot({ percent: 0 }))).toBe('0.0%')
  })

  it('真实的 0% 仍然显示 0.0%（与"不可得"严格区分）', () => {
    // percent=0 是"配额真的用完了"，是事实；percent=null 是"拿不到"。
    // 两者必须可区分，否则用户无法判断该不该换号。
    expect(quotaPercentLabel(snapshot({ percent: 0 }))).toBe('0.0%')
    expect(quotaPercentLabel(snapshot({ percent: null }))).toBe('用量不可得')
  })
})

describe('quotaStampLabel · 必须标注来源类型与时间戳（P0-21 验收②）', () => {
  it('落盘快照 → 含"落盘快照"与 MM-DD HH:mm', () => {
    const label = quotaStampLabel(snapshot({ source: 'snapshot', updatedAtMs: new Date(2026, 8, 11, 3, 20).getTime() }))
    expect(label).toContain('落盘快照')
    expect(label).toContain('09-11 03:20')
  })

  it('实时 → 含"实时"', () => {
    expect(quotaStampLabel(snapshot({ source: 'live' }))).toContain('实时')
  })

  it('stale → 追加"可能过期"', () => {
    expect(quotaStampLabel(snapshot({ stale: true }))).toContain('可能过期')
  })

  it('★ 落盘时刻未知 → 改称"读取于"，不把 fetchedAtMs 冒充成"数据什么时候落盘的"', () => {
    // 旧写法 `updatedAtMs ?? fetchedAtMs` 会渲染成「落盘快照·09-11 03:20」——
    // 那是**我们算这份快照的时刻**，不是数据落盘的时刻。且 stale 由 updated_at_ms 判定，
    // 为 null 时恒为 false，连「（可能过期）」都不会出现 = 一句无提示的乐观假话。
    const label = quotaStampLabel(snapshot({ updatedAtMs: null, fetchedAtMs: new Date(2026, 8, 11, 3, 20).getTime() }))
    expect(label).toContain('读取于')
    expect(label).toContain('09-11 03:20')
    expect(label).not.toContain('落盘快照')
    expect(label).not.toContain('可能过期')
    expect(label).not.toContain('NaN')
  })
})

describe('标签映射', () => {
  it('来源类型', () => {
    expect(quotaSourceLabel('live')).toBe('实时')
    expect(quotaSourceLabel('snapshot')).toBe('落盘快照')
  })

  it('窗口类型', () => {
    expect(quotaWindowLabel('fiveHour')).toBe('5 小时窗口')
    expect(quotaWindowLabel('weekly')).toBe('周窗口')
    expect(quotaWindowLabel('monthly')).toBe('月窗口')
    expect(quotaWindowLabel('unknown')).toBe('窗口未知')
  })
})

describe('命令封装 · 失败不抛错，返回空', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it('quota_list_channels 正常返回', async () => {
    const channels = [{ channel: 'codex', accountCount: 9, dir: 'x', hasAccounts: true, usesDesktopCache: false, percentKind: 'remaining' as const }]
    vi.mocked(invoke).mockResolvedValueOnce(channels)
    await expect(getQuotaChannels()).resolves.toEqual(channels)
    expect(invoke).toHaveBeenCalledWith('quota_list_channels')
  })

  it('quota_snapshots 失败 → 空数组（单渠道失败不影响其它渠道）', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('boom'))
    await expect(getQuotaSnapshots('kiro')).resolves.toEqual([])
  })

  it('quota_snapshots 传 channel 参数', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([])
    await getQuotaSnapshots('grok')
    expect(invoke).toHaveBeenCalledWith('quota_snapshots', { channel: 'grok' })
  })
})

describe('quotaAgeMs / formatAgeMs · 数据年龄必须说得出来（2026-09-12）', () => {
  const NOW = 1_800_000_000_000
  const MINUTE = 60_000
  const HOUR = 60 * MINUTE
  const DAY = 24 * HOUR

  it('★ 年龄只认 updatedAtMs —— 47 天前写入的缓存今天读它仍是 47 天前', () => {
    // 年龄说的是"**数据**有多旧"，所以只能取 updatedAtMs。
    // fetchedAtMs（我们"刚刚"读的）在这里只是对照项：它**不得**把年龄拉成"刚刚"。
    const s = snapshot({
      updatedAtMs: NOW - 47 * DAY,
      fetchedAtMs: NOW, // 我们"刚刚"读的
      stale: true,
    })
    expect(quotaAgeMs(s, NOW)).toBe(47 * DAY)
    expect(quotaAgeLabel(s, NOW)).toBe('47 天前')
  })

  it('★ 落盘时刻未知 → 年龄判不出来，返回 null / 空串（不拿 fetchedAtMs 冒充"刚刚"）', () => {
    // "刚刚"是对"数据是新的"的正向断言 —— 我们并不知道它是不是新的，就不能这么说。
    const s = snapshot({ updatedAtMs: null, fetchedAtMs: NOW })
    expect(quotaAgeMs(s, NOW)).toBeNull()
    expect(quotaAgeLabel(s, NOW)).toBe('')
  })

  it('没有时间戳 → 年龄无从判断，返回 null / 空串（不硬编 0）', () => {
    const s = snapshot({ updatedAtMs: null, fetchedAtMs: null })
    expect(quotaAgeMs(s, NOW)).toBeNull()
    expect(quotaAgeLabel(s, NOW)).toBe('')
  })

  it('未来的时间戳 → null（时钟回拨，不产生负数年龄）', () => {
    expect(quotaAgeMs(snapshot({ updatedAtMs: NOW + DAY }), NOW)).toBeNull()
  })

  it('分档：刚刚 / 分钟 / 小时 / 天', () => {
    expect(quotaAgeLabel(snapshot({ updatedAtMs: NOW - 5_000 }), NOW)).toBe('刚刚')
    expect(quotaAgeLabel(snapshot({ updatedAtMs: NOW - 12 * MINUTE }), NOW)).toBe('12 分钟前')
    expect(quotaAgeLabel(snapshot({ updatedAtMs: NOW - 3 * HOUR }), NOW)).toBe('3 小时前')
    expect(quotaAgeLabel(snapshot({ updatedAtMs: NOW - 47 * DAY }), NOW)).toBe('47 天前')
  })

  it('★ 现场回归：陈旧数据仍是数字，但必须能同时报出年龄', () => {
    // 本机实测形态：percent=100，但 updatedAt 停在 47 天前。
    // 只显示"剩余 100%"是撒谎；年龄必须一起出来。
    const s = snapshot({ percent: 100, updatedAtMs: NOW - 47 * DAY, stale: true })
    expect(quotaPercentLabel(s)).toBe('100.0%') // 数字照出
    expect(quotaAgeLabel(s, NOW)).toBe('47 天前') // 年龄必须同时报
  })

  it('formatAgeMs 对非法输入返回空串，不渲染出 "NaN 天前"', () => {
    expect(formatAgeMs(Number.NaN)).toBe('')
    expect(formatAgeMs(-1)).toBe('')
  })
})

describe('quotaStampLabel · 不可得的快照不伪造时间戳（2026-09-12 真机核对）', () => {
  it('★ 用量不可得时只给来源类型，不显示"刚刚"的时间', () => {
    // 真机现场：codex 账号文件加密 → 读不到 updatedAtMs,
    // 若退回 fetchedAtMs 会显示「用量不可得 · 09-12 23:38」,暗示"刚查过确认没有"——是骗人。
    // （2026-09-15 补充口径：**有数据**但 updatedAtMs 为 null 时，改称「读取于」，
    //   见下面 "落盘时刻未知时改称「读取于」" 那一组；两条分支都不再伪造落盘时刻。）
    const s = snapshot({
      percent: null,
      remainingFraction: null,
      usedFraction: null,
      unavailableReason: '账号快照里没有 quota 字段:用量不可得',
      updatedAtMs: null,
      fetchedAtMs: 1_800_000_000_000,
    })
    const label = quotaStampLabel(s)
    expect(label).toBe(quotaSourceLabel(s.source))
    expect(label).not.toContain('23:')
    expect(label).not.toContain('过期')
  })

  it('有数据时照常显示时间戳与过期标记', () => {
    const fresh = snapshot({ percent: 42, updatedAtMs: 1_800_000_000_000, stale: false })
    expect(quotaStampLabel(fresh)).toContain(quotaSourceLabel(fresh.source))
    const stale = snapshot({ percent: 42, updatedAtMs: 1_800_000_000_000, stale: true })
    expect(quotaStampLabel(stale)).toContain('可能过期')
  })
})

describe('quotaStampLabel · 落盘时刻未知时改称「读取于」（2026-09-15 诚实性修复）', () => {
  const READ_AT = new Date(2026, 8, 11, 3, 20).getTime()

  it('updatedAtMs 为 null → 含"读取于"，不含"落盘快照"，不含"可能过期"', () => {
    // fetchedAtMs 是"我们确实知道"的事实（此刻读到了这批数据）；
    // 数据的落盘时刻我们不知道 → 只能说"读于"，不能说"落盘于"。
    const label = quotaStampLabel(snapshot({ updatedAtMs: null, fetchedAtMs: READ_AT, stale: false }))
    expect(label).toContain('读取于')
    expect(label).not.toContain('落盘快照')
    expect(label).not.toContain('可能过期')
  })

  it('updatedAtMs 为 null 且 stale 为 true → 仍不打"可能过期"（stale 由 updated_at_ms 判定，此处不成立）', () => {
    const label = quotaStampLabel(snapshot({ updatedAtMs: null, fetchedAtMs: READ_AT, stale: true }))
    expect(label).toContain('读取于')
    expect(label).not.toContain('可能过期')
  })

  it('updatedAtMs 有值且 stale=false → 文案仍是"落盘快照·…"，无"可能过期"（既有行为不变）', () => {
    const label = quotaStampLabel(snapshot({ updatedAtMs: READ_AT, stale: false }))
    expect(label).toContain('落盘快照')
    expect(label).toContain('09-11 03:20')
    expect(label).not.toContain('可能过期')
    expect(label).not.toContain('读取于')
  })

  it('updatedAtMs 有值且 stale=true → 仍追加"（可能过期）"（既有行为不变）', () => {
    const label = quotaStampLabel(snapshot({ updatedAtMs: READ_AT, stale: true }))
    expect(label).toContain('落盘快照·09-11 03:20')
    expect(label).toContain('可能过期')
  })

  it('updatedAtMs 为 null → 中性说明存在，用户知道这里为什么没有「可能过期」', () => {
    const label = quotaStampLabel(snapshot({ updatedAtMs: null, fetchedAtMs: READ_AT }))
    expect(label).toContain(quotaNoUpdatedAtNote())
  })

  it('中性说明只在落盘时刻未知时出现（有 updatedAtMs 时不得多出这句）', () => {
    expect(quotaStampLabel(snapshot({ updatedAtMs: READ_AT, stale: true }))).not.toContain(quotaNoUpdatedAtNote())
    expect(quotaStampLabel(snapshot({ updatedAtMs: READ_AT, stale: false }))).not.toContain(quotaNoUpdatedAtNote())
  })
})

// ─────────────────── 「当前账号」与「模型分组」（2026-09-15 新增） ───────────────────
//
// 这两个源 2026-09-15 才接进来。这里的重点不是"能不能读到"（那是 Rust 侧职责），
// 而是**两条诚实性红线**：
//   ① 渠道 ID 与文件里的 platform key 拼写不一致（连字符 vs 下划线）→ 必须能匹配上；
//   ② 读不到时返回 null（UI 显示 —），**绝不编造分组名 / 绝不显示"否"**。

describe('当前账号：平台 key 的宽松匹配', () => {
  it('连字符与下划线视为同一个平台（渠道 ID 用连字符，文件 key 用下划线）', () => {
    expect(normalizePlatformKey('github-copilot')).toBe(normalizePlatformKey('github_copilot'))
    expect(normalizePlatformKey('GitHub-Copilot')).toBe('github_copilot')
    expect(normalizePlatformKey('  github_copilot  ')).toBe('github_copilot')
  })

  it('渠道 github-copilot 能匹配到 platform 为 github_copilot 的记录', () => {
    const entries: CurrentAccountEntry[] = [
      { platform: 'github_copilot', accountId: 'gh-1', source: 'provider_current_accounts' },
    ]
    expect(currentAccountIdFor(entries, 'github-copilot')).toBe('gh-1')
  })

  it('大小写不同也能匹配', () => {
    const entries: CurrentAccountEntry[] = [
      { platform: 'GEMINI', accountId: 'gm-1', source: 'provider_current_accounts' },
    ]
    expect(currentAccountIdFor(entries, 'gemini')).toBe('gm-1')
  })

  it('无记录 → null（UI 显示 —，不显示"否"：没读到 ≠ 确定不是当前）', () => {
    expect(currentAccountIdFor([], 'cursor')).toBeNull()
    const onlyTrae: CurrentAccountEntry[] = [
      { platform: 'trae', accountId: 't-1', source: 'provider_current_accounts' },
    ]
    expect(currentAccountIdFor(onlyTrae, 'cursor')).toBeNull()
  })

  it('渠道名为空 → null（不做空串匹配，避免把空 key 当命中）', () => {
    const withEmpty: CurrentAccountEntry[] = [
      { platform: '', accountId: 'x', source: 'provider_current_accounts' },
    ]
    expect(currentAccountIdFor(withEmpty, '')).toBeNull()
  })

  it('antigravity 运行时源同样参与匹配', () => {
    const entries: CurrentAccountEntry[] = [
      { platform: 'antigravity', accountId: 'ag-9', source: 'antigravity_runtime' },
    ]
    expect(currentAccountIdFor(entries, 'antigravity')).toBe('ag-9')
  })
})

describe('模型分组：绝不编造分组名', () => {
  const groups: ModelGroups = {
    available: true,
    mappings: { 'claude-sonnet-4-5': 'claude_45', 'gemini-3-flash': 'g3_flash' },
    names: { claude_45: 'Claude 4.5', g3_flash: 'Gemini Flash' },
    order: ['claude_45', 'g3_flash'],
    updatedAtMs: 1785063641459,
    updatedBy: 'desktop',
  }

  it('已映射 → 返回分组显示名', () => {
    expect(modelGroupLabelFor(groups, 'claude-sonnet-4-5')).toBe('Claude 4.5')
    expect(modelGroupLabelFor(groups, 'gemini-3-flash')).toBe('Gemini Flash')
  })

  it('未映射的模型 → null（UI 显示 —）', () => {
    expect(modelGroupLabelFor(groups, 'gpt-5.4')).toBeNull()
  })

  it('available 为 false（文件未落盘）→ null，**不套用 cockpit 默认分组**', () => {
    // cockpit 源码 group_settings.rs:71-120 的 GroupSettings::default() 会兜底出
    // Claude 4.5 / Gemini Pro / Gemini Flash 三组。那是 cockpit 的行为，不是"用户配过"的事实。
    const notConfigured: ModelGroups = {
      available: false,
      mappings: {},
      names: {},
      order: [],
      updatedAtMs: null,
      updatedBy: null,
    }
    expect(modelGroupLabelFor(notConfigured, 'claude-sonnet-4-5')).toBeNull()
  })

  it('groups 为 null（读不到）→ null', () => {
    expect(modelGroupLabelFor(null, 'claude-sonnet-4-5')).toBeNull()
  })

  it('映射到不存在的分组名 → 退回 groupId 本身（不返回空串）', () => {
    const partial: ModelGroups = { ...groups, names: {} }
    expect(modelGroupLabelFor(partial, 'claude-sonnet-4-5')).toBe('claude_45')
  })

  it('modelId 为空 → null', () => {
    expect(modelGroupLabelFor(groups, '')).toBeNull()
  })
})

describe('账号分组：只读展示，两个来源都查', () => {
  const groups: AccountGroups = {
    available: true,
    groups: [
      { id: 'grp_a', name: '生产', accountIds: ['shared', 'only_general'], createdAtMs: 1785063641459 },
      { id: 'grp_b', name: '测试', accountIds: ['shared'], createdAtMs: null },
    ],
    codexAvailable: true,
    codexGroups: [{ id: 'grp_c', name: 'Codex 主力', accountIds: ['cx1'], createdAtMs: null }],
  }

  it('账号在通用分组里 → 返回分组名', () => {
    expect(groupLabelsFor(groups, 'only_general')).toEqual(['生产'])
  })

  it('账号在 Codex 专用分组里也能查到（两个来源都查，不能只看通用）', () => {
    expect(groupLabelsFor(groups, 'cx1')).toEqual(['Codex 主力'])
  })

  it('★ 一个账号属于多个分组时**全部**返回（不取第一个）', () => {
    // cockpit 通用分组的真实语义：WakeupTasksPage.tsx:789-800 的 groupIdsByAccountId
    // 是 string[]，一个账号可以同时挂多个分组。取第一个会吞掉其余标签。
    const labels = groupLabelsFor(groups, 'shared')
    expect(labels).toHaveLength(2)
    expect(labels).toContain('生产')
    expect(labels).toContain('测试')
  })

  it('返回顺序稳定（按名字排序，同一账号每次渲染一致）', () => {
    const labels = groupLabelsFor(groups, 'shared')
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)))
  })

  it('两个来源有同名分组 → 去重（不显示成「生产 / 生产」）', () => {
    const dup: AccountGroups = {
      ...groups,
      codexGroups: [{ id: 'grp_dup', name: '生产', accountIds: ['shared'], createdAtMs: null }],
    }
    const labels = groupLabelsFor(dup, 'shared')
    expect(labels).toHaveLength(2)
    expect(labels.filter((n) => n === '生产')).toHaveLength(1)
  })

  it('账号不属于任何分组 → []（UI 显示 —）', () => {
    expect(groupLabelsFor(groups, 'nobody')).toEqual([])
  })

  it('groups 为 null（读不到）→ []', () => {
    expect(groupLabelsFor(null, 'shared')).toEqual([])
  })

  it('accountId 为空 → []（不做空串匹配，避免把空 id 当命中）', () => {
    expect(groupLabelsFor(groups, '')).toEqual([])
  })

  it('用户没建过分组（两个文件都是空数组）→ []', () => {
    const empty: AccountGroups = {
      available: false,
      groups: [],
      codexAvailable: false,
      codexGroups: [],
    }
    expect(groupLabelsFor(empty, 'shared')).toEqual([])
  })
})
