/**
 * 真机渲染核对（**可复跑的端到端验证**，默认跳过）。
 *
 * ## 为什么要有它
 *
 * 单测用的是造出来的夹具，可能跟现场不一致 —— 2026-09-12 就栽过一次：
 * "解析测试全绿、用户屏幕上还是一整面用量不可得"。根因是真机的账号文件是**加密**的，
 * 夹具里根本没有这种形态。
 *
 * 这条走的是**真实数据 + 真实渲染链路**：
 *   1. Rust 侧 `cargo test --bin console2api dump_real_snapshots -- --ignored --nocapture`
 *      把本机 `~/.antigravity_cockpit` 跑出来的快照原样写成 JSON；
 *   2. 前端用**同一套** `quotaChannelMerge` + 年龄/时间戳逻辑渲染一遍。
 *
 * 不打开浏览器也能确认「用户到底会看到什么」：合并成几个 chip、百分比多少、
 * 有没有标年龄、颜色是绿还是灰、不可得的行有没有伪造时间戳。
 *
 * ## 怎么跑
 *
 * ```bash
 * # ① 先导出真机快照
 * cd src-tauri && cargo test --bin console2api dump_real_snapshots -- --ignored --nocapture
 * # ② 再跑这条（dump 文件不存在时自动跳过，不会误报失败）
 * npx vitest run src/features/cost-center/__tests__/realRenderCheck.spec.ts
 * ```
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import {
  mergeIdenticalQuotaChannels,
  quotaSnapshotSetSignature,
  type QuotaChannelChip,
} from '@/api/cockpit/quotaChannelMerge'
import { formatAgeMs, quotaAgeMs, quotaStampLabel, type QuotaSnapshot } from '@/api/cockpit/quota'
import { formatUtilization, pickMostStaleSnapshot, quotaGrade, quotaStaleNotice } from '../honestValues'
import MetricCell from '../components/TruthfulMetric.vue'
import { TriangleAlert } from '@lucide/vue'

/** 与 Rust `dump_real_snapshots_for_ui_verification` 写出的路径保持一致。 */
const DUMP = join(tmpdir(), 'console2api-real-quota-snapshots.json')

/** Google 系三渠道在 Rust 侧共用 `accounts` 目录（见 cockpit_quota.rs::accounts_dir_name）。 */
const SHARED_ACCOUNTS_DIR = 'accounts'
const GOOGLE_CHANNELS = ['antigravity', 'gemini', 'antigravity_ide']

function buildChips(raw: QuotaSnapshot[]): QuotaChannelChip[] {
  const byChannel = new Map<string, QuotaSnapshot[]>()
  for (const s of raw) {
    if (!byChannel.has(s.channel)) byChannel.set(s.channel, [])
    byChannel.get(s.channel)!.push(s)
  }
  const now = Date.now()
  return [...byChannel.entries()].map(([channel, snaps]) => {
    const pcts = snaps.map((s) => s.percent).filter((p): p is number => p != null)
    const ages = snaps.map((s) => quotaAgeMs(s, now)).filter((a): a is number => a != null)
    const oldest = ages.length ? Math.max(...ages) : null
    // 与 CostCenterView 保持一致(审查 #8):百分比与时间戳取自**同一条**快照,
    // 取"最老且有百分比"的那条。早期的 min(pcts) + snaps[0] 会让两个数字互不相干。
    const shown = pickMostStaleSnapshot(
      snaps,
      (s) => quotaAgeMs(s, now),
      (s) => s.percent != null,
      (s) => s.percent,
    )
    return {
      channel,
      dir: GOOGLE_CHANNELS.includes(channel) ? SHARED_ACCOUNTS_DIR : `${channel}_accounts`,
      accountCount: new Set(snaps.map((s) => s.accountId)).size,
      worst: shown?.percent ?? null,
      allUnavailable: snaps.length > 0 && pcts.length === 0,
      hasSnapshot: snaps.length > 0,
      stamp: shown ? quotaStampLabel(shown) : null,
      oldestAgeMs: oldest,
      ageLabel: oldest != null ? formatAgeMs(oldest) : '',
      ageDays: oldest != null ? Math.floor(oldest / 86_400_000) : 0,
      signature: quotaSnapshotSetSignature(snaps),
    }
  })
}

describe.skipIf(!existsSync(DUMP))('真机渲染核对（需要 dump 文件，见文件头说明）', () => {
  it('渲染结果与 P0-21 / 年龄标注 / 同源合并的约定一致', () => {
    const raw = JSON.parse(readFileSync(DUMP, 'utf-8')) as QuotaSnapshot[]
    const chips = buildChips(raw)
    const merged = mergeIdenticalQuotaChannels(chips)

    // 打印出来供人眼核对（这才是这条用例的主要用途）
    const lines = [`原始快照 ${raw.length} 条 / 渠道 ${chips.length} 个 / 合并后 ${merged.length} 个 chip`]
    for (const c of merged) {
      const color = c.worst == null ? '灰' : c.ageDays >= 1 ? '灰' : c.worst <= 20 ? '警告' : '绿'
      const pct =
        c.worst == null
          ? '用量不可得'
          : `剩余 ${c.worst.toFixed(1)}%` + (c.ageDays >= 1 ? ` · ${c.ageLabel}` : '')
      lines.push(`  [${color}] ${c.channel}  →  ${pct}   [${c.accountCount} 账号 · ${c.stamp ?? '无时间戳'}]`)
    }
    console.log('\n' + lines.join('\n'))

    expect(raw.length).toBeGreaterThan(0)

    // ① 共用 accounts 目录的三渠道，只要快照一致就必须合并成一个 chip
    const shared = chips.filter((c) => c.dir === SHARED_ACCOUNTS_DIR)
    if (shared.length > 1) {
      const allSame = shared.every((c) => c.signature === shared[0].signature)
      if (allSame) {
        const combined = merged.filter((c) => c.channel.includes(' / '))
        expect(combined.length, '同源且快照一致的三渠道应合并成一个 chip').toBe(1)
        // 合并后 accountCount 不得虚增
        expect(combined[0].accountCount).toBe(shared[0].accountCount)
      }
    }

    // ② 陈旧数据必须标出年龄（不拿"剩余 100%"冒充实时值）
    for (const c of merged) {
      if (c.worst != null && c.ageDays >= 1) {
        expect(c.ageLabel, '陈旧数据必须给出年龄文案').not.toBe('')
      }
    }

    // ③ 不可得的快照**不得**伪造时间戳（否则暗示"刚查过、确认没有"）
    for (const c of merged) {
      if (c.worst == null && c.stamp) {
        expect(c.stamp, `不可得的 ${c.channel} 不应带数据时间戳`).not.toMatch(/\d{2}:\d{2}/)
      }
    }
  })
})

/**
 * 真实 DOM 渲染核对（**常跑**，不依赖 dump 文件）。
 *
 * 上面的用例要真机数据；这一组是"兜底红线":把审查 #1/#3/#5 修好的取值喂给
 * 真实组件渲染一遍，断言屏幕上**不会**出现 0 ms / 0.0% / 绿色健康态。
 * 单测只验证函数返回 null 是不够的 —— 用户看的是渲染结果。
 */
describe('渲染红线 · 无数据不得渲染出 0 或绿色健康态', () => {
  it('TTFT 无样本:渲染「无样本」+ 不可用态,不渲染 0 ms', () => {
    const wrapper = mount(MetricCell, {
      props: { label: 'TTFT P95', value: '无样本', note: '窗口内无首 token 样本', state: 'unavailable' },
    })
    const text = wrapper.text()
    expect(text).toContain('无样本')
    expect(text).not.toMatch(/0\s*ms/)
    expect(wrapper.find('.cost-metric-cell').attributes('data-data-state')).toBe('unavailable')
  })

  it('零观测失败率:渲染 — ,不渲染 0.0%', () => {
    const wrapper = mount(MetricCell, {
      props: { label: '成功 / 失败', value: '无数据 / 无数据', note: '失败率 —', state: 'measured' },
    })
    expect(wrapper.text()).toContain('失败率 —')
    expect(wrapper.text()).not.toContain('0.0%')
  })

  it('未知利用率:data-grade 是 unknown(灰),绝不给 high(绿)', () => {
    const Probe = defineComponent({
      props: { utilization: { type: Number, default: null } },
      setup(props) {
        return () =>
          h('strong', { 'data-grade': quotaGrade(props.utilization) }, formatUtilization(props.utilization))
      },
    })
    const unknown = mount(Probe, { props: { utilization: null as unknown as number } })
    expect(unknown.find('strong').attributes('data-grade')).toBe('unknown')
    expect(unknown.text()).toBe('—')

    // 对照组:真实的 0% 消耗仍然是绿色,不能一刀切把 0 也变成 unknown
    const zero = mount(Probe, { props: { utilization: 0 } })
    expect(zero.find('strong').attributes('data-grade')).toBe('high')
    expect(zero.text()).toBe('0%')
  })

  it('窗口余量无数据:渲染 — ,不渲染 0.0%', () => {
    const wrapper = mount(MetricCell, {
      props: { label: '渠道账号', value: '3 / 8', note: '窗口余量 —', state: 'measured' },
    })
    expect(wrapper.text()).toContain('窗口余量 —')
    expect(wrapper.text()).not.toContain('0.0%')
  })

  it('成本未知:渲染「成本未知」,不渲染 $0.00', () => {
    const wrapper = mount(MetricCell, {
      props: { label: '累计成本', value: '成本未知', note: '无单价且数据源无估算', state: 'unavailable' },
    })
    expect(wrapper.text()).toContain('成本未知')
    expect(wrapper.text()).not.toContain('$0.00')
  })
})

/**
 * 审查 #10 · 加载失败时**不得静默显示旧数据**。
 *
 * 下面两个探针复刻 `CostCenterView` 资产总览配额横条里的判定与配色分支
 * （数据层失败时保留旧值是对的，界面必须说清它是上次成功的）。
 * 断言的是"用户会看到什么"，而不是函数返回值。
 */
const QuotaStripNotice = defineComponent({
  props: { error: { type: String, default: null }, hasData: { type: Boolean, default: true } },
  setup(props) {
    return () => {
      const notice = quotaStaleNotice(props.error, props.hasData)
      if (!notice.staleDueToError) return null
      return h('p', { class: 'cost-quota-strip__notice' }, [
        h(TriangleAlert, { size: 13 }),
        h('span', null, notice.title),
        notice.detail ? h('small', null, notice.detail) : null,
      ])
    }
  },
})

/** 单个 chip 的百分比配色分支（转灰 = 不再对当前状态做正向断言）。 */
const QuotaChipValue = defineComponent({
  props: {
    worst: { type: Number, default: 100 },
    staleDueToError: { type: Boolean, default: false },
    ageDays: { type: Number, default: 0 },
  },
  setup(props) {
    return () => {
      if (props.worst == null) return h('span', { class: 'cost-muted' }, '用量不可得')
      if (props.ageDays >= 1) return h('span', { class: 'cost-muted' }, `剩余 ${props.worst.toFixed(1)}%`)
      if (props.staleDueToError) return h('span', { class: 'cost-muted' }, `剩余 ${props.worst.toFixed(1)}%`)
      return h('span', { class: props.worst <= 20 ? 'cost-warning-text' : 'cost-lime' }, `剩余 ${props.worst.toFixed(1)}%`)
    }
  },
})

describe('渲染红线 · 配额读取失败时不得静默显示旧数据', () => {
  const ERROR = '渠道配额读取失败: io error'

  it('失败 + 有旧数据 → 渲染提示与原文', () => {
    const wrapper = mount(QuotaStripNotice, { props: { error: ERROR, hasData: true } })
    expect(wrapper.text()).toContain('读取失败')
    expect(wrapper.text()).toContain('上次成功加载')
    expect(wrapper.text()).toContain(ERROR)
    expect(wrapper.find('.cost-quota-strip__notice').exists()).toBe(true)
  })

  it('失败但无旧数据可展示 → 不渲染任何提示(横条本身也不出现)', () => {
    const wrapper = mount(QuotaStripNotice, { props: { error: ERROR, hasData: false } })
    expect(wrapper.find('.cost-quota-strip__notice').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
  })

  it('没有失败 → 不出现多余提示,行为与改动前一致', () => {
    const wrapper = mount(QuotaStripNotice, { props: { error: null, hasData: true } })
    expect(wrapper.find('.cost-quota-strip__notice').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
  })

  it('失败时 chip 转灰:绝不出现 cost-lime(绿色是"健康"的正向断言)', () => {
    const wrapper = mount(QuotaChipValue, { props: { worst: 100, staleDueToError: true } })
    expect(wrapper.find('span').classes()).toContain('cost-muted')
    expect(wrapper.find('span').classes()).not.toContain('cost-lime')
    // 数值照旧展示 —— 旧值 + 说明 > 一片空白,不清空数据
    expect(wrapper.text()).toBe('剩余 100.0%')
  })

  it('对照组:没有失败时满血 chip 仍是绿色', () => {
    const wrapper = mount(QuotaChipValue, { props: { worst: 100, staleDueToError: false } })
    expect(wrapper.find('span').classes()).toContain('cost-lime')
  })
})
