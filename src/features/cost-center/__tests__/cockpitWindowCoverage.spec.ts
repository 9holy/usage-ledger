import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { cockpitWindowCoverage, cockpitCoverageNote } from '../cockpitAdapter'

/**
 * ★ 数据源覆盖三态(2026-09-24 用本机 30+ 天真实数据核对后新增)。
 *
 * **病根**:cockpit 的 `codex_local_access_logs.sqlite` 会**停止写入**。本机实测
 * 186,353 行 / 跨度 50.7 天,末端停在 `2026-09-17T19:19:54.142Z`,距核对时刻
 * **156.7 小时(6.5 天)**。而面板此前**无条件**标注「(单请求用量库全程覆盖)」:
 *   · 短窗口(1m~24h)整段落在数据末端之后 ⇒ 窗口内 0 行;
 *   · 7d 窗口 `[09-17 08:00Z, 09-24 08:00Z)` 实际只被覆盖 **11.3/168 小时(6.7%)**;
 *   · 30d 窗口只覆盖 23.5/30 天。
 * ⇒ 那个 `0` 与那些偏小的数**都不是实测**,而是「**源没覆盖到这段**」。
 * 红线:「源不掌握 ≠ 实测为 0」。
 *
 * ⚠️ **本文件抓不到"类型级变异"**:`cockpitWindowCoverage` 里
 * `dataStartMs == null || dataEndMs == null` 那行是 TS 收窄承重墙,把它换成 `false`
 * 之后本文件**全绿**(esbuild 剥类型不做检查),但 `vue-tsc --noEmit` 报 9 条
 * TS18049/TS2322(EXIT=2)。判读变异时先问:「这个变异的检测器是不是测试套件?」
 */

const H = 3_600_000
const D = 86_400_000

/** 核对时刻:2026-09-24T08:00:00Z。 */
const NOW = Date.UTC(2026, 8, 24, 8, 0, 0)
/** 本机实测:最早一条日志 2026-07-29T02:58:27.821Z。 */
const REAL_START = Date.UTC(2026, 6, 29, 2, 58, 27, 821)
/** 本机实测:最后一条日志 2026-09-17T19:19:54.142Z(≈ 核对时刻前 6.5 天)。 */
const REAL_END = Date.UTC(2026, 8, 17, 19, 19, 54, 142)

/** 除 today(日历日)外的全部 range —— 都是滚动窗口 `[now-ms, now)`。 */
const ROLLING_RANGES = ['1m', '5m', '30m', '1h', '6h', '24h', '7d', '30d'] as const

describe('cockpitWindowCoverage · 数据源覆盖三态', () => {
  it('数据末端早于窗口起点 ⇒ uncovered(该窗口无数据,不是实测 0)', () => {
    const c = cockpitWindowCoverage('1h', REAL_START, REAL_END, NOW)
    expect(c.state).toBe('uncovered')
    expect(c.dataEndMs).toBe(REAL_END)
  })

  /**
   * ★ 边界必须钉住,否则 `>=` 与 `>` 写反也发现不了(半开区间 `[start, end)`)。
   * 窗口 `[NOW-1h, NOW)`;`dataEnd` 恰好等于窗口起点时,**窗口内仍可能有那一条记录**
   * ⇒ 只能判 partial(数值是下界),不能判 uncovered(那是断言"一条都没有")。
   */
  it('★ 边界成对:dataEnd == 窗口起点 - 1ms ⇒ uncovered;== 窗口起点 ⇒ partial', () => {
    const windowStart = NOW - H
    expect(cockpitWindowCoverage('1h', REAL_START, windowStart - 1, NOW).state).toBe('uncovered')
    expect(cockpitWindowCoverage('1h', REAL_START, windowStart, NOW).state).toBe('partial')
  })

  it('末端盖住窗口尾且起点不晚于窗口头 ⇒ full(可直接当实测)', () => {
    expect(cockpitWindowCoverage('1h', REAL_START, NOW, NOW).state).toBe('full')
    // 成对反例:末端只到窗口一半 ⇒ partial,数值只能算下界。
    // ⚠️ 这里**不能**用 `NOW - 1`:覆盖比例阈值是 0.9,差 1ms 仍算「全程覆盖」
    //    —— 源还活着时,末尾几毫秒的空档不代表没覆盖。要用**真的覆盖不足**才构成反例。
    expect(cockpitWindowCoverage('1h', REAL_START, NOW - 30 * 60_000, NOW).state).toBe('partial')
    // ★ 阈值成对(1h 窗口):覆盖 54/60 = 90% ⇒ full;覆盖 53/60 ≈ 88.3% ⇒ partial
    expect(cockpitWindowCoverage('1h', REAL_START, NOW - 6 * 60_000, NOW).state).toBe('full')
    expect(cockpitWindowCoverage('1h', REAL_START, NOW - 7 * 60_000, NOW).state).toBe('partial')
  })

  it('★ 覆盖比例是**相对**的:1h 窗口配 1h 容差会把 0% 覆盖判成 full(防这个回归)', () => {
    // 曾用绝对容差 `dataEnd >= windowEnd - 1h` ⇒ 1h 窗口里「窗口起点 == 数据末端」
    // (覆盖率 0%)也被判成 full。必须用相对比例。
    const windowStart = NOW - H
    expect(cockpitWindowCoverage('1h', REAL_START, windowStart, NOW).coveredRatio).toBe(0)
    expect(cockpitWindowCoverage('1h', REAL_START, windowStart, NOW).state).not.toBe('full')
    // 长窗口同理:7d 只覆盖 1 天 ⇒ partial(比例 1/7)
    expect(cockpitWindowCoverage('7d', REAL_START, NOW - 6 * D, NOW).state).toBe('partial')
    expect(cockpitWindowCoverage('7d', REAL_START, NOW - 6 * D, NOW).coveredRatio).toBeCloseTo(1 / 7, 5)
  })

  it('覆盖段必须是**数据源范围 ∩ 窗口**,不是数据源范围本身', () => {
    // 数据源从 07-29 起、窗口只有 1h ⇒ 覆盖段就是这 1 小时,而不是 07-29 → 09-17
    const c = cockpitWindowCoverage('1h', REAL_START, NOW, NOW)
    expect(c.coveredStartMs).toBe(NOW - H)
    expect(c.coveredEndMs).toBe(NOW)
    expect(c.coveredRatio).toBe(1)
  })

  it('数据起点晚于窗口起点 ⇒ partial(窗口前半段没被覆盖,数值是下界)', () => {
    expect(cockpitWindowCoverage('7d', NOW - 2 * D, NOW, NOW).state).toBe('partial')
    // 成对反例:起点不晚于窗口头 ⇒ full(证明上面那条不是因为别的原因才 partial)
    expect(cockpitWindowCoverage('7d', NOW - 7 * D, NOW, NOW).state).toBe('full')
  })

  it('拿不到覆盖范围 ⇒ unknown(不标注,不谎报「全程覆盖」)', () => {
    expect(cockpitWindowCoverage('1h', null, null, NOW).state).toBe('unknown')
    expect(cockpitWindowCoverage('1h', undefined, NOW, NOW).state).toBe('unknown')
    expect(cockpitWindowCoverage('1h', NOW, null, NOW).state).toBe('unknown')
    // NaN / Infinity 也是"拿不到",不能被 Number.isFinite 放行(与 truthfulState 同一个坑)
    expect(cockpitWindowCoverage('1h', NaN, NOW, NOW).state).toBe('unknown')
    expect(cockpitWindowCoverage('1h', REAL_START, Infinity, NOW).state).toBe('unknown')
  })

  /**
   * ★ 用**本机真实数据**核对(不是构造值):这是本轮核对任务的回归钉子。
   * 若哪天有人把「全程覆盖」改回无条件,或把 partial 判成 full,这条会红。
   */
  it('★ 本机实测:短窗口全 uncovered,7d/30d 是 partial —— 都不是 full', () => {
    for (const range of ROLLING_RANGES) {
      const state = cockpitWindowCoverage(range, REAL_START, REAL_END, NOW).state
      if (range === '7d' || range === '30d') {
        expect(state, `${range} 只被部分覆盖,必须是 partial`).toBe('partial')
      } else {
        expect(state, `${range} 整段落在数据末端之后,必须是 uncovered`).toBe('uncovered')
      }
      expect(state, `${range} 不得判成 full`).not.toBe('full')
    }
    // today 是日历日窗口:09-17 早于 09-24 的当天 00:00 ⇒ 任何时区下都 uncovered
    expect(cockpitWindowCoverage('today', REAL_START, REAL_END, NOW).state).toBe('uncovered')
  })

  it('数据完整覆盖时不得误判成 partial(防过度修正)', () => {
    for (const range of ROLLING_RANGES) {
      expect(cockpitWindowCoverage(range, REAL_START, NOW + D, NOW).state, range).toBe('full')
    }
  })
})

describe('cockpitCoverageNote · 覆盖四态措辞(纯函数,可直测)', () => {
  const base = {
    windowLabel: '最近 7 天',
    dataEndLabel: '9/17',
    coveredRangeLabel: '7/29 → 9/17',
    coveredPercent: 7,
  }

  it('full 才允许写「全程覆盖」', () => {
    expect(cockpitCoverageNote({ ...base, state: 'full' }))
      .toBe('最近 7 天（单请求用量库全程覆盖）')
  })

  it('partial 必须写明**窗口内**覆盖区间 + 占比 + 「数值为下界」,且不得写「全程覆盖」', () => {
    const note = cockpitCoverageNote({ ...base, state: 'partial' })
    expect(note).toContain('最近 7 天')
    expect(note).toContain('仅覆盖')
    expect(note).toContain('7/29 → 9/17')
    expect(note, '占比必须出现 —— 光给两个端点说不出"只覆盖了 7%"').toContain('占窗口 7%')
    expect(note).toContain('下界')
    expect(note, '部分覆盖绝不能写「全程覆盖」').not.toContain('全程覆盖')
  })

  it('★★ uncovered 必须描述**屏幕上真正显示的东西**,不得断言「该窗口无数据」', () => {
    // 血案(2026-09-24):短窗口下模型表/成本趋势**回退到 daily 快照**,屏幕上有数字;
    // 而旧措辞写「该窗口无数据」⇒ 同屏自相矛盾,用户读成「把有数据改成无数据」。
    const note = cockpitCoverageNote({
      ...base, state: 'uncovered', windowLabel: '最近 1 小时', snapshotLabel: '今日累计',
    })
    expect(note).toContain('今日累计')
    expect(note).toContain('数据源止于')
    expect(note).toContain('9/17')
    expect(note, '★ 屏幕上明明有数字,绝不能写「无数据」').not.toContain('无数据')
    expect(note, '未覆盖绝不能写「全程覆盖」').not.toContain('全程覆盖')
  })

  it('uncovered 且没有快照可展示时才退回窗口名(不猜)', () => {
    const note = cockpitCoverageNote({ ...base, state: 'uncovered', windowLabel: '最近 1 小时' })
    expect(note).toBe('最近 1 小时（数据源止于 9/17）')
  })

  it('unknown 退回窗口名本身(不猜、不加修饰)', () => {
    expect(cockpitCoverageNote({ ...base, state: 'unknown', windowLabel: '最近 1 小时' })).toBe('最近 1 小时')
  })

  it('★ 只有 full 这一种状态能产出「全程覆盖」这四个字', () => {
    const states = ['full', 'partial', 'uncovered', 'unknown'] as const
    const withFullClaim = states.filter((s) => cockpitCoverageNote({ ...base, state: s }).includes('全程覆盖'))
    expect(withFullClaim).toEqual(['full'])
  })
})

describe('cockpitWindowCoverage · 视图接线(源码扫描)', () => {
  const view = readFileSync(resolve(process.cwd(), 'src/views/admin/CostCenterView.vue'), 'utf8')

  it('三个窗口标注必须共用同一个覆盖措辞出口(否则同屏多个口径打架)', () => {
    const hits = view.match(/cockpitWindowCoverageNote\.value/g) ?? []
    // 成本列 + 请求列 + usageWindowLabel 的 request-log 分支 —— **三个**消费点。
    // ★ 起初只接了 2 个,全量回归才暴露出第三个(usageWindowLabel:2555 被
    //   costWindowCaption/requestWindowCaption 在 `!usesRangeWindow` 时消费)
    //   ⇒ 漏掉它则覆盖标注整个消失。同型复发:同一份数据的第 N 个消费点。
    expect(hits.length, '三个消费点都应用它').toBeGreaterThanOrEqual(3)
    expect(view).toContain('const cockpitWindowCoverageNote = computed')
  })

  it('覆盖状态必须由**全表**边界算出来,而不是某个窗口的 min/max', () => {
    // 累计分支(start_ms/end_ms 传 null ⇒ 无时间过滤)拿到的那份才是全表边界
    expect(view).toContain('cockpitDataSourceRange.value = { startMs: cumulative.windowStartMs, endMs: cumulative.windowEndMs }')
    expect(view).toContain('cockpitWindowCoverage(')
    // 不可用分支必须复位成 null ⇒ 判成 unknown,而不是留着上一次的区间
    expect(view).toContain('cockpitDataSourceRange.value = { startMs: null, endMs: null }')
  })

  it('★ 覆盖态必须来自真实计算(不得把状态写死 —— 纯函数测试看不见这一层)', () => {
    // 纯函数测试只验「给定 state ⇒ 什么措辞」。视图若把 state 写死成 'full',
    // 那些测试全绿、上面的接线断言也全绿 ⇒ 必须单独钉「state 的实参是谁」。
    const viewLf = view.replace(/\r\n/g, '\n')
    expect(viewLf).toContain('cockpitCoverageNote({\n  state: cockpitCoverage.value.state,')
    // 反向:不得把字面量态传进措辞函数。
    // ⚠️ 2026-09-24:**入参从位置参数改成对象后,旧正则被悄悄削弱了**。
    //   旧写法 `/cockpitCoverageNote\(\s*'full'/` 只认 `cockpitCoverageNote('full', …)`,
    //   而新签名下写死态长这样:`cockpitCoverageNote({ state: 'full', … })` —— 中间隔着
    //   `{ state: `,**一个都抓不到**。签名变更把守卫打穿却不报错,正是"守卫换皮"的同族。
    //   ⇒ 正则必须同时覆盖「位置参数」与「对象属性(含换行)」两种形态。
    const literalState = /cockpitCoverageNote\(\s*(?:'(?:full|partial|uncovered|unknown)'|\{\s*state\s*:\s*'(?:full|partial|uncovered|unknown)')/
    // ⚠️ **先自检这条正则真的能命中** —— 否则它是个恒真的否定断言(空串恒真同族)。
    expect(literalState.test("cockpitCoverageNote(\n  'full',"), '正则自检:位置参数形态的字面量态必须能被命中').toBe(true)
    expect(literalState.test("cockpitCoverageNote({ state: 'full', windowLabel: x })"), '正则自检:对象单行形态的字面量态必须能被命中').toBe(true)
    expect(literalState.test("cockpitCoverageNote({\n  state: 'full',\n  windowLabel: x,\n})"), '正则自检:对象换行形态的字面量态必须能被命中').toBe(true)
    // 反向自检:对象里的**非 state** 字段取字面量不该被误伤(否则这条会变成假红)
    expect(literalState.test("cockpitCoverageNote({\n  windowLabel: 'full',\n})"), '不该误伤非 state 字段').toBe(false)
    expect(literalState.test(viewLf), '视图不得把覆盖态写死').toBe(false)
  })

  it('★ 反向:视图里不得残留无条件硬编码的「（单请求用量库全程覆盖）」', () => {
    // 措辞只能由 cockpitCoverageNote 产出(它在 cockpitAdapter.ts 里)
    expect(view).not.toContain('（单请求用量库全程覆盖）`')
    expect(view).not.toContain("（单请求用量库全程覆盖）'")
  })

  it('扫描面非空(否定断言在空串上恒真的红线)', () => {
    expect(view.length).toBeGreaterThan(10_000)
  })
})
