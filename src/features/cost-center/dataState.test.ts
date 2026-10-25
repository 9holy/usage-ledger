import './__tests__/costDataI18n'
import { describe, expect, it } from 'vitest'
import {
  createDataSourceStates,
  finiteOrNull,
  hasMeasuredData,
  hasUsableData,
  poolHealthStateFor,
  probeAvailabilityNote,
  sourceState,
  sumFiniteTrendValues,
  unavailableValueLabel,
} from './dataState'

describe('cost center data states', () => {
  it('keeps a real zero distinct from missing data', () => {
    expect(finiteOrNull(0)).toBe(0)
    expect(finiteOrNull('0')).toBe(0)
    expect(finiteOrNull(null)).toBeNull()
    expect(finiteOrNull(Number.NaN)).toBeNull()
  })

  it('does not treat an unavailable source as an empty successful result', () => {
    const unavailable = sourceState('dashboard', 'unavailable', 'request failed', null)
    const empty = sourceState('dashboard', 'empty', 'window has no records')
    expect(hasUsableData(unavailable)).toBe(false)
    expect(hasMeasuredData(unavailable)).toBe(false)
    expect(unavailableValueLabel(unavailable)).toBe('无数据')
    expect(hasMeasuredData(empty)).toBe(true)
    expect(unavailableValueLabel(empty)).toBe('无记录')
  })

  it('initializes every source as loading instead of a fake zero state', () => {
    const states = createDataSourceStates()
    expect(states.economics.status).toBe('loading')
    expect(states.todayStats.status).toBe('loading')
  })
})

/**
 * 趋势值合计的「部分未知」语义(2026-09-27,Bug B)。
 *
 * 用户反馈"月数据都很多不准和没有"。根因:`sumFiniteTrendValues` 旧实现是
 * 「**任一**值为 null ⇒ 整笔返回 null」,而 30d 窗口实测有 10 个无单价的桶
 * (`actual_cost` = null)⇒ 「窗口自算成本 / 毛利 / 每 USD 采购 / 回本率」一整排 KPI
 * 全部渲染成「无数据」,与同屏有数的趋势图/模型表自相矛盾。
 *
 * 为什么在**纯函数**层测:本函数原先内联在 CostCenterView.vue 的 `<script setup>` 里,
 * 视图文本扫描只能钉住"调用了它",钉不住"它怎么算"——把实现改回旧写法(或改成
 * `computed(() => null)`)源码字符串依然全绿。故语义判定必须搬进纯函数由测试直测。
 */
describe('sumFiniteTrendValues · 部分未知 ⇒ 已知部分之和', () => {
  it('★ 部分桶为 null 时返回**非 null** 的已知部分之和(不是整笔置 null)', () => {
    // 30d 真实形状:22 个桶里 10 个无单价(null)、12 个有值。
    const values: Array<number | null> = [null, 1.5, null, 2.5, null, null, 3, null]
    expect(sumFiniteTrendValues(values)).toBeCloseTo(7, 9)
    // 旧实现的反面:若有任一 null 就返回 null —— 显式钉住"不再是这个行为"。
    expect(sumFiniteTrendValues(values)).not.toBeNull()
  })

  it('全为 null ⇒ null(全未知,不是"和为 0")', () => {
    expect(sumFiniteTrendValues([null, null, null])).toBeNull()
  })

  it('空数组 ⇒ null(没有可加的量)', () => {
    expect(sumFiniteTrendValues([])).toBeNull()
  })

  it('全为已知 ⇒ 精确求和,且**真实的 0 不被当成缺失**', () => {
    expect(sumFiniteTrendValues([0, 1, 2])).toBe(3)
    // 单个真实 0 ⇒ 0(不是 null);这区别于"全 null"。
    expect(sumFiniteTrendValues([0])).toBe(0)
    expect(sumFiniteTrendValues([0])).not.toBeNull()
  })

  it('非有限值(NaN/Infinity/非数字串)按缺失处理,不污染合计', () => {
    expect(sumFiniteTrendValues([1, Number.NaN, 2])).toBe(3)
    expect(sumFiniteTrendValues([1, Number.POSITIVE_INFINITY, 2])).toBe(3)
    expect(sumFiniteTrendValues([1, 'abc', 2])).toBe(3)
  })

  it('成对反例:单桶有值 vs 单桶 null —— 前者给数、后者给 null(判别"有值"不靠计数)', () => {
    expect(sumFiniteTrendValues([4.25])).toBe(4.25)
    expect(sumFiniteTrendValues([null])).toBeNull()
  })
})

/**
 * 「号池运行状态」的探测能力三态(2026-09-22)。
 *
 * 为什么要在**纯函数**这一层测:视图里原本是二态 `connectionType === 'cliproxy' ? A : B`,
 * 把 cockpit 当 sub2api ⇒ 它永久 `partial` + 「N 个未主动探测」。
 * 这条契约如果只靠扫视图源码文本来钉,把 `probeCapable` 改成 `computed(() => true)` 就能
 * **静默全绿**(字符串都还在)—— 实测过。所以判定搬到这里直接测。
 */
describe('pool health · 探测能力三态', () => {
  const base = {
    cliproxyRequestTotal: 0,
    unverifiedProbeCount: 0,
    economicsStatus: null,
    accountsStatus: 'measured',
  } as const

  it('★ cockpit 有未探测账号也**不得**判 partial —— 它结构上没有探测通道', () => {
    // 反例形状就是真实 cockpit:probes 恒为空 ⇒ unverifiedProbeCount === 账号总数。
    expect(poolHealthStateFor({ ...base, source: 'cockpit', unverifiedProbeCount: 7 })).toBe('measured')
    expect(poolHealthStateFor({ ...base, source: 'cockpit', unverifiedProbeCount: 7, accountsStatus: 'empty' })).toBe('empty')
  })

  it('成对反例:sub2api 有未探测账号 ⇒ 仍是 partial(那里确实「还没探测」)', () => {
    expect(poolHealthStateFor({ ...base, source: 'sub2api', unverifiedProbeCount: 7 })).toBe('partial')
    expect(poolHealthStateFor({ ...base, source: 'sub2api', unverifiedProbeCount: 0 })).toBe('measured')
  })

  it('cliproxy 走自己的口径:有请求 ⇒ measured,无请求 ⇒ unavailable', () => {
    expect(poolHealthStateFor({ ...base, source: 'cliproxy', cliproxyRequestTotal: 12 })).toBe('measured')
    expect(poolHealthStateFor({ ...base, source: 'cliproxy', cliproxyRequestTotal: 0 })).toBe('unavailable')
    // cliproxy 的未探测计数不参与 —— 它的分支在前,不受 partial 影响。
    expect(poolHealthStateFor({ ...base, source: 'cliproxy', cliproxyRequestTotal: 12, unverifiedProbeCount: 3 })).toBe('measured')
  })

  it('economics 快照存在时优先于 accounts,不存在时回落 accounts', () => {
    expect(poolHealthStateFor({ ...base, source: 'sub2api', economicsStatus: 'estimated', accountsStatus: 'measured' })).toBe('estimated')
    expect(poolHealthStateFor({ ...base, source: 'cockpit', economicsStatus: 'unavailable', accountsStatus: 'measured' })).toBe('unavailable')
  })

  it('★ 措辞:只有有探测通道的源才说「N 个未主动探测」', () => {
    expect(probeAvailabilityNote('sub2api', 3)).toBe('3 个未主动探测')
    expect(probeAvailabilityNote('cliproxy', 3)).toBe('3 个未主动探测')
    // cockpit 结构性做不到 —— 不得声称「还没探测」(与「源不支持采样 ≠ 待采样」同口径)。
    expect(probeAvailabilityNote('cockpit', 3)).toBe('本机采集源无主动探测通道')
    expect(probeAvailabilityNote('cockpit', 3)).not.toContain('未主动探测')
  })
})
