import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  cockpitTotalsToOpsOverview,
  cockpitSnapshotWindowNote,
  cockpitCoverageNote,
  cockpitWindowLabelForRange,
  cockpitWindowForRange,
} from '../cockpitAdapter'
import type { CockpitStats } from '@/api/cockpit'

/**
 * ★★ 窗口**口径**诚实性(2026-09-24,第五轮核对后的第六轮)。
 *
 * 前几轮管的是「值」是否真实(不写假 0、不把下界说成实测)、
 * 以及「覆盖范围」是否真实(标注必须等于数据源实际覆盖区间)。
 * 本文件管的是**同一个病根的另一面**:
 *
 *   **一个值属于窗口 A,却被放在窗口 B 的标签/分母下面。**
 *
 * 本机实测的四条证据(全部来自 `~/.antigravity_cockpit/codex_local_access_stats.json`):
 *   · `totals.requestCount      = 186,351` ← **生命周期累计**(since 07-29)
 *   · `daily.totals.requestCount   =      73` ← 09-18 00:00+08 起(源末端 09-18 03:19+08)
 *   · `weekly.totals.requestCount  =   1,769`
 *   · `monthly.totals.requestCount =  27,102`
 *
 * 而面板在「最近 1 小时」标签下渲染的是 **186,351 次调用**,同屏模型成本表
 * (同样已回退到 daily 快照)显示 **73 次** —— **同屏两个数,差 2,553 倍**。
 *
 * 四条修复(逐条对应下面四组用例):
 *   ① KPI 的**分子**必须是选中窗口自己的 totals,不是生命周期累计;
 *   ② qps/tps 与 $/h 的**分母**必须是分子实际覆盖的时长(`since → updatedAt`);
 *   ③ 模型区标题必须写**实际展示的窗口**,且必须按模型区自己的窗口(`modelCostRange`)判定;
 *   ④ 模型区「独立窗口」回退路径不得把快照参数传成 `undefined`(那是空表)。
 */

const H = 3_600_000

/** 本机实测:源末端(最后一条日志)2026-09-18 03:19:54+08。 */
const REAL_END = Date.UTC(2026, 8, 17, 19, 19, 54, 142)

/** cockpit 快照 fixture:生命周期 totals 与三个窗口 totals 各不相同(本机实测比例)。 */
function statsFixture(over: {
  lifetime?: number
  daily?: number | null
  weekly?: number | null
  monthly?: number | null
  /** daily 的覆盖跨度(小时);默认 3.32(本机实测)。 */
  dailySpanHours?: number
} = {}): CockpitStats {
  const { lifetime = 186_351, daily = 73, weekly = 1_769, monthly = 27_102, dailySpanHours = 3.32 } = over
  const usage = (requestCount: number, totalTokens = requestCount * 71_294) => ({
    requestCount,
    successCount: Math.round(requestCount * 0.846),
    failureCount: requestCount - Math.round(requestCount * 0.846),
    clientCanceledCount: 0,
    upstreamResponseFailedCount: 0,
    streamIncompleteCount: 0,
    totalLatencyMs: requestCount * 1_200,
    textRequestCount: requestCount,
    imageRequestCount: 0,
    imageGenerationRequestCount: 0,
    imageEditRequestCount: 0,
    imageGenerationCapabilityFailureCount: 0,
    inputTokens: Math.round(totalTokens / 3),
    outputTokens: Math.round(totalTokens / 10),
    totalTokens,
    cachedTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0,
  })
  const win = (count: number, spanHours: number) => ({
    since: REAL_END - spanHours * H,
    updatedAt: REAL_END,
    totals: usage(count),
    accounts: [],
    models: [],
  })
  return {
    since: REAL_END - 57 * 24 * H,
    updatedAt: REAL_END,
    totals: usage(lifetime),
    accounts: [],
    models: [],
    daily: daily == null ? undefined : win(daily, dailySpanHours),
    weekly: weekly == null ? undefined : win(weekly, 7 * 24),
    monthly: monthly == null ? undefined : win(monthly, 30 * 24),
  } as unknown as CockpitStats
}

// ────────────────────────────────────────────────────────────────────────────
// ① 分子:选中窗口自己的 totals
// ────────────────────────────────────────────────────────────────────────────
describe('cockpitTotalsToOpsOverview · 分子必须是**选中窗口**的 totals', () => {
  it('★ 本机实测形状:1h 窗口必须报 daily 的 73,不是 stats.totals 的 186,351', () => {
    const s = statsFixture()
    // 逐窗口都对:短窗口→daily、7d→weekly、30d→monthly
    expect(cockpitTotalsToOpsOverview(s, '1h')!.request_count_total).toBe(73)
    expect(cockpitTotalsToOpsOverview(s, '24h')!.request_count_total).toBe(73)
    expect(cockpitTotalsToOpsOverview(s, '7d')!.request_count_total).toBe(1_769)
    expect(cockpitTotalsToOpsOverview(s, '30d')!.request_count_total).toBe(27_102)
    // ★ 反向:任何一个窗口都不许等于生命周期累计(这是本轮修的那个数)
    for (const range of ['1h', '24h', '7d', '30d'] as const) {
      expect(cockpitTotalsToOpsOverview(s, range)!.request_count_total, range)
        .not.toBe(186_351)
    }
  })

  it('成功/失败/token/延迟均值也必须同窗口(否则失败率是"全历史的失败率")', () => {
    const s = statsFixture()
    const o = cockpitTotalsToOpsOverview(s, '1h')!
    const daily = s.daily!.totals
    expect(o.success_count).toBe(daily.successCount)
    expect(o.error_count_total).toBe(daily.failureCount)
    expect(o.token_consumed).toBe(daily.totalTokens)
    // 失败率 = 窗口自己的失败/窗口自己的请求
    expect(o.error_rate).toBeCloseTo(daily.failureCount / daily.requestCount, 12)
    // 成对反例:生命周期失败率与窗口失败率不同(否则上面那条断言区分不出两个口径)
    expect(daily.failureCount / daily.requestCount)
      .not.toBeCloseTo(s.totals.failureCount / s.totals.requestCount, 4)
  })

  it('★ 成对反例:一个窗口快照都没有时才退回 stats.totals(不静默变 0)', () => {
    const bare = statsFixture({ daily: null, weekly: null, monthly: null })
    expect(cockpitWindowForRange(bare, '1h')).toBeUndefined()
    expect(cockpitTotalsToOpsOverview(bare, '1h')!.request_count_total).toBe(186_351)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// ② 分母:分子实际覆盖的时长
// ────────────────────────────────────────────────────────────────────────────
describe('cockpitTotalsToOpsOverview · qps/tps 分母必须是分子覆盖的时长', () => {
  it('★ 本机实测:73 请求覆盖 3.32h ⇒ qps 用 3.32h,不是被请求的 1h', () => {
    const s = statsFixture({ dailySpanHours: 3.32 })
    const o = cockpitTotalsToOpsOverview(s, '1h')!
    // 正确:73 / (3.32 × 3600)
    expect(o.qps.avg).toBeCloseTo(73 / (3.32 * 3_600), 12)
    // 旧口径(分母 = economicsWindowHours('1h') = 1)会把速率**放大 3.32 倍**
    expect(o.qps.avg, '不得用被请求窗口的时长当分母').not.toBeCloseTo(73 / 3_600, 6)
    expect(o.tps.avg).toBeCloseTo(s.daily!.totals.totalTokens / (3.32 * 3_600), 6)
  })

  it('★ 分母随快照跨度变化(不是常数):同一份 totals、不同跨度 ⇒ 不同 qps', () => {
    // 「同值双轨」的教训:只测一个跨度,分母写死成任何常数都能通过。
    const short = cockpitTotalsToOpsOverview(statsFixture({ dailySpanHours: 1 }), '1h')!
    const long = cockpitTotalsToOpsOverview(statsFixture({ dailySpanHours: 4 }), '1h')!
    expect(short.qps.avg).toBeCloseTo(73 / 3_600, 12)
    expect(long.qps.avg).toBeCloseTo(73 / (4 * 3_600), 12)
    expect(short.qps.avg, '跨度差 4 倍 ⇒ qps 必须差 4 倍').toBeCloseTo(long.qps.avg * 4, 12)
  })

  it('★ 跨度不可得(0/负)时返回 null,不得退回被请求窗口的时长编数字', () => {
    // ★★ 2026-09-26 翻案:原用例标题是「退回被请求窗口的时长」,那是**错的**。
    //   `spanHours <= 0` 只在「没有窗口快照」时才会出现 —— 此时 `since`/`updatedAt` 都回退成了
    //   `Date.now()`(cockpitAdapter :1630-1631),跨度恒为 0;而分子 `t` 是 `stats.totals`
    //   = **生命周期累计**(186,351 请求 / 231 亿 token)。
    //   拿名义窗口时长(economicsWindowHours('1h') = 1)去除一个生命周期累计量 ⇒ 数字是编出来的。
    //   ⇒ 不可知就是 null。宁可无数据,不许假数据。
    const s = statsFixture()
    ;(s.daily as { since: number }).since = REAL_END // 跨度 = 0 ⇒ 覆盖时长不可知
    const o = cockpitTotalsToOpsOverview(s, '1h')!
    expect(o.qps.avg, 'qps 不可知 ⇒ null(不是 Infinity,更不是编出来的数)').toBeNull()
    expect(o.tps.avg, 'tps 不可知 ⇒ null').toBeNull()
    // ★ 反向断言:绝不得等于「73 / (名义窗口时长 × 3600)」—— 那是本轮推翻的旧写法。
    //   只断言 null 挡不住"有人把名义时长捞回来",必须把那个具体数字也钉死。
    expect(o.qps.avg, '不得用被请求窗口的时长当分母').not.toBe(73 / 3_600)
    expect(o.tps.avg).not.toBe(s.daily!.totals.totalTokens / 3_600)
  })

  it('★ 成对反例(防"一律返回 null"假绿):跨度正常时必须算出有限数字', () => {
    // 只测「不可知 ⇒ null」的话,把函数改成恒返回 null 也能全绿 —— 那是假绿。
    // 这条用例与上面那条成对:同一个 statsFixture,只把跨度从 0 改回正常值,结果必须从
    // null 变成一个**具体的、与跨度成反比**的数字。
    const s = statsFixture({ dailySpanHours: 2 })
    const o = cockpitTotalsToOpsOverview(s, '1h')!
    expect(o.qps.avg).not.toBeNull()
    expect(Number.isFinite(o.qps.avg as number)).toBe(true)
    expect(o.qps.avg).toBeCloseTo(73 / (2 * 3_600), 12)
    expect(o.tps.avg).toBeCloseTo(s.daily!.totals.totalTokens / (2 * 3_600), 6)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// ③ 快照口径的窗口措辞(纯函数)
// ────────────────────────────────────────────────────────────────────────────
describe('cockpitSnapshotWindowNote · 快照口径的窗口措辞(纯函数,可直测)', () => {
  const base = { snapshotLabel: '今日累计', state: 'uncovered' as const, dataEndLabel: '9/17' }

  it('源已停写 ⇒ 必须说清数据止于哪天', () => {
    expect(cockpitSnapshotWindowNote(base)).toBe('今日累计（数据源止于 9/17）')
  })

  it('★ 与 cockpitCoverageNote 的 uncovered 分支**逐字一致**(两者描述同一件事)', () => {
    // 同屏两处都在说"屏幕上是快照数字、源已停写",措辞分叉就是同屏两种口径。
    const viaCoverage = cockpitCoverageNote({
      state: 'uncovered',
      windowLabel: '最近 1 小时',
      dataEndLabel: '9/17',
      coveredRangeLabel: '',
      coveredPercent: 0,
      snapshotLabel: '今日累计',
    })
    expect(cockpitSnapshotWindowNote(base)).toBe(viaCoverage)
  })

  it('★ 快照口径**不得**说「单请求用量库」—— 那是滚动窗口口径的自我描述', () => {
    for (const state of ['uncovered', 'partial', 'unknown'] as const) {
      const note = cockpitSnapshotWindowNote({ ...base, state })
      expect(note, state).not.toContain('单请求用量库')
      expect(note, state).not.toContain('全程覆盖')
      expect(note, state).not.toContain('下界')
    }
  })

  it('源还活着且窗口被完整覆盖 ⇒ 只写窗口名,不补「止于哪天」(那是噪音)', () => {
    expect(cockpitSnapshotWindowNote({ ...base, state: 'full' })).toBe('今日累计')
  })

  it('拿不到数据源末端 ⇒ 不补半句话(否则渲染成「（数据源止于 ）」)', () => {
    expect(cockpitSnapshotWindowNote({ ...base, dataEndLabel: '' })).toBe('今日累计')
  })

  it('没有快照窗口名 ⇒ 返回空串,由调用方退回被请求窗口名(不猜)', () => {
    expect(cockpitSnapshotWindowNote({ ...base, snapshotLabel: '' })).toBe('')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// ④ 快照窗口名的判定(回退链必须按**实际选中的窗口**比,不按 range 猜)
// ────────────────────────────────────────────────────────────────────────────
describe('cockpitWindowLabelForRange · 快照窗口名(单一来源,主窗口与模型区共用)', () => {
  it('逐 range 取到对应的窗口名', () => {
    const s = statsFixture()
    expect(cockpitWindowLabelForRange(s, '1h')).toBe('今日累计')
    expect(cockpitWindowLabelForRange(s, 'today')).toBe('今日累计')
    expect(cockpitWindowLabelForRange(s, '7d')).toBe('本周累计')
    expect(cockpitWindowLabelForRange(s, '30d')).toBe('本月累计')
  })

  it('★ 回退链:monthly 缺失时 30d 落到 weekly ⇒ 必须说「本周累计」,不能说「本月累计」', () => {
    // 按 `range === '30d'` 猜就会把 7 天的数说成本月累计 —— 这正是抽成单一来源要防的。
    const noMonthly = statsFixture({ monthly: null })
    expect(cockpitWindowForRange(noMonthly, '30d')).toBe(noMonthly.weekly)
    expect(cockpitWindowLabelForRange(noMonthly, '30d')).toBe('本周累计')
  })

  it('★ 回退链:weekly 缺失时 7d 落到 monthly ⇒ 必须说「本月累计」', () => {
    const noWeekly = statsFixture({ weekly: null })
    expect(cockpitWindowLabelForRange(noWeekly, '7d')).toBe('本月累计')
  })

  it('连 daily 都没有(短窗口)时落到 weekly ⇒ 说「本周累计」,不说「今日累计」', () => {
    const onlyWeekly = statsFixture({ daily: null })
    expect(cockpitWindowLabelForRange(onlyWeekly, '1h')).toBe('本周累计')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// ⑤ 视图接线(源码扫描 —— 语义由上面的纯函数直测,这里只钉"接线")
// ────────────────────────────────────────────────────────────────────────────
describe('CostCenterView · 窗口口径接线(源码扫描)', () => {
  const view = readFileSync(resolve(process.cwd(), 'src/views/admin/CostCenterView.vue'), 'utf8')
  const viewLf = view.replace(/\r\n/g, '\n')

  it('★ 双轨:模型区覆盖态必须按 modelCostRange 算,不得按主窗口 range 算', () => {
    // 主窗口一轨
    expect(viewLf).toContain('const cockpitCoverage = computed(() => cockpitWindowCoverage(\n  range.value,')
    // 模型区另一轨
    expect(viewLf).toContain('const modelWindowCoverage = computed(() => cockpitWindowCoverage(\n  modelCostRange.value,')
    // 反向:模型区那轨不得接主窗口 —— 同值双轨用例结构上抓不到这种错接,只能靠源码扫描钉
    expect(viewLf, '模型区覆盖态不得按主窗口算').not.toContain(
      'const modelWindowCoverage = computed(() => cockpitWindowCoverage(\n  range.value,',
    )
  })

  it('★ 模型区副标题必须用窗口口径标签,不得直接渲染被请求的窗口名', () => {
    expect(view).toContain('{{ modelCostWindowLabel }} · {{ modelCostBasisNote }}')
    expect(view, '直接写 modelCostRangeLabel 就是把快照数说成被请求窗口').not.toContain(
      '{{ modelCostRangeLabel }} · {{ modelCostBasisNote }}',
    )
  })

  it('★ 模型区标签必须三态穷举(非 cockpit / 单请求库 / 快照),不许两态', () => {
    expect(viewLf).toContain('const modelCostWindowLabel = computed')
    expect(viewLf).toContain("if (connectionType.value !== null) return modelCostRangeLabel.value")
    expect(viewLf).toContain('if (modelCostFromRequestLog.value) return modelWindowCoverageNote.value')
    expect(viewLf).toContain('cockpitSnapshotWindowNote({')
    // 模型区**不得**复用主窗口的来源标记(那是按 range 算的)
    expect(viewLf).not.toContain('if (cockpitCostFromRequestLog.value) return modelWindowCoverageNote.value')
  })

  it('★ 成本速率图标题必须走覆盖感知出口,不得用裸 rangeLabel', () => {
    expect(view).toContain(':caption="apiRateChartCaption"')
    expect(viewLf).toContain('const apiRateChartCaption = computed')
    // ★★ 反向断言必须与**真会被写出来的形态**一致。
    //   血案(A9 变异存活):这里原先只钉 `` `${rangeLabel} · cockpit 单请求用量库自算成本` `` ——
    //   那是**模板里**的旧写法(模板作用域自动解包,没有 `.value`)。而该表达式已经搬进
    //   `<script setup>` 的 computed,真写错时的形态是 `` `${rangeLabel.value} · …` ``。
    //   两者差一个 `.value`,于是那条否定断言**永远不可能命中** —— 标题声称钉住了 X,
    //   函数体却放弃了 X(本项目方法论第 12 条:写完断言回头读标题)。
    //   ⇒ 抽出判据,两个形态一起钉,并对判据本身做**正向自检**(否则它是个恒真的否定断言)。
    const usesBareRangeLabel = (text: string): boolean => text.includes('`${rangeLabel.value} · cockpit 单请求用量库自算成本`')
      || text.includes('`${rangeLabel} · cockpit 单请求用量库自算成本`')
    expect(usesBareRangeLabel(viewLf), '图表标题不得用裸 rangeLabel').toBe(false)
    // 自检:两种违规形态都必须能被上面那个判据命中
    expect(usesBareRangeLabel('? `${rangeLabel.value} · cockpit 单请求用量库自算成本`'), 'computed 形态').toBe(true)
    expect(usesBareRangeLabel('`${rangeLabel} · cockpit 单请求用量库自算成本`'), '模板形态').toBe(true)
    // 反向自检:正确形态不得被误伤(否则这条会变成假红)
    expect(usesBareRangeLabel('? `${costWindowCaption.value} · cockpit 单请求用量库自算成本`'), '正确形态不该命中').toBe(false)
  })

  it('扫描面非空(否定断言在空串上恒真的红线)', () => {
    expect(view.length).toBeGreaterThan(10_000)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// ⑥ 模型区独立窗口的**回退**不许丢(源码扫描;该路径是 store 函数,无直测入口)
// ────────────────────────────────────────────────────────────────────────────
describe('useCostCenterData · 模型区独立窗口回退(源码扫描)', () => {
  const store = readFileSync(resolve(process.cwd(), 'src/features/cost-center/useCostCenterData.ts'), 'utf8')

  it('★ 回退必须给**该独立窗口**的快照,不得传 undefined', () => {
    // `cockpitModelsToModelStats` 第一行是 `if (!window?.models) return []` ⇒ 传 `undefined`
    // 等于**空表**:用户在模型区切了窗口、而单请求库在该窗口 0 行时,模型表整片变空,
    // 而同屏主路径明明会回退到日历快照 —— 两条路径行为不一致,表现就是「切一下窗口数据没了」。
    expect(store).toContain('cockpitModelsToModelStats(modelWindow, mult, modelPricing.value)')
    expect(store, '回退传 undefined ⇒ 空表').not.toContain(
      'cockpitModelsToModelStats(undefined, mult, modelPricing.value)',
    )
    // 快照按**模型区窗口**选(`range` 是 `loadCockpitModelWindow` 的形参,
    // 视图传的是 `modelCostRange.value`,见 `reloadModelWindow`)。
    expect(store).toContain('cockpitWindowForRange(cockpitStatsSnapshot.value, range)')
  })

  it('★ 模型区来源标记必须在**两条**装载路径都写(否则分离后判定悬空)', () => {
    // ★ 2026-09-25:写法从 `rlModels.length > 0` 改为「链路可用」(同族回退病根),
    //   本守卫钉的**语义**不变:两条装载路径都必须设置这个标记。
    //   ⇒ 断言"非 false 的赋值"出现 2 次,不再钉死某个具体字面量。
    const hits = store.match(/modelCostFromRequestLog\.value = (?!false)[^\n]+/g) ?? []
    // ① loadFromCockpit(主窗口) ② loadCockpitModelWindow(独立窗口)
    expect(hits.length, '主路径 + 独立窗口路径各写一次').toBe(2)
    // ★ 反向:两处都**不得**再用「窗口内有没有模型行」来判来源 ——
    //   那会把「该窗口 0 行」当成「该回退日历快照」,模型表就会画出 daily 快照的模型行。
    const legacy = store.match(/modelCostFromRequestLog\.value = rlModels\.length/g) ?? []
    expect(legacy.length, '不得再用窗口内行数决定来源标记').toBe(0)
    expect(store).toContain('cockpitStatsSnapshot.value = cockpitStats')
    // 反向:切离 cockpit 时必须复位,否则模型区会拿旧快照出数(跨源串味)
    const resets = store.match(/modelCostFromRequestLog\.value = false/g) ?? []
    expect(resets.length, '切离 cockpit 的复位点').toBeGreaterThanOrEqual(2)
    expect(store).toContain('cockpitStatsSnapshot.value = null')
  })
})
