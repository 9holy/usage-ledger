import './costDataI18n'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  resolveRowUsageSuffix,
  resolveUsageBasis,
  resolveUsageStatsFor,
  type AccountUsageStatsPair,
} from '../accountRowUsageBasis'
import type { AccountWindowUsage } from '../model'

/**
 * ★★ 上游排行表「本机自然日」标注必须**逐行**判定(2026-09-26 第七轮)。
 *
 * 病根:视图此前用**整表**粒度的 `usesRangeWindow`
 *   (`accountLedgers.some(row => row.window != null)`)
 * 决定要不要标「（本机自然日）」。但回退是**逐账号**的 ——
 * A 账号在窗口内有记录、B 账号没有,B 就会回退自然日。
 * ⇒ 只要有一行拿到窗口数据,整表的标注就全部消失,于是「最近 1 小时」的列头下
 *   躺着今日的数,用户却看不到任何提示 —— **判据粒度必须与回退粒度一致**。
 *
 * 本文件两条线:① 纯函数直测语义(文本扫描钉不住语义);② 源码扫描钉接线 + 反向断言。
 */

const win = (tag: string): AccountWindowUsage => ({
  requests: 10,
  tokens: 100,
  cost: 1,
  standard_cost: 1,
  user_cost: 1,
  // 便于断言"具体取了哪一个"
  ...({ [`__${tag}`]: true } as Record<string, unknown>),
}) as unknown as AccountWindowUsage

const pair = (over: Partial<AccountUsageStatsPair> = {}): AccountUsageStatsPair => ({
  today: null,
  window: null,
  ...over,
})

describe('resolveUsageStatsFor / resolveUsageBasis · 逐行口径', () => {
  it('有窗口数据 ⇒ 用窗口值,口径 = window,无「自然日」后缀', () => {
    const row = pair({ today: win('today'), window: win('window') })
    expect(resolveUsageStatsFor(row, false)).toBe(row.window)
    expect(resolveUsageBasis(row, false)).toBe('window')
    expect(resolveRowUsageSuffix(row, false)).toBe('')
  })

  it('★ 无窗口数据 + 非权威窗口 ⇒ 回退自然日,口径 = today,**必须**带后缀', () => {
    const row = pair({ today: win('today') })
    expect(resolveUsageStatsFor(row, false)).toBe(row.today)
    expect(resolveUsageBasis(row, false)).toBe('today')
    expect(resolveRowUsageSuffix(row, false)).toContain('本机自然日')
  })

  it('★ 无窗口数据 + 窗口源权威 ⇒ 不回退(null),口径 = none,**不得**标自然日', () => {
    // sub2api 7d/30d:窗口源已被请求过,缺失就是"该窗口无数据"。
    // 回退会把今日数显示在「最近 7 天」的格子里 —— 正是本文件要钉住的缺陷。
    const row = pair({ today: win('today') })
    expect(resolveUsageStatsFor(row, true)).toBeNull()
    expect(resolveUsageBasis(row, true)).toBe('none')
    expect(resolveRowUsageSuffix(row, true)).toBe('')
  })

  it('两个源都没有 ⇒ null / none(无数据,绝不是 0)', () => {
    const row = pair()
    expect(resolveUsageStatsFor(row, false)).toBeNull()
    expect(resolveUsageBasis(row, false)).toBe('none')
    expect(resolveRowUsageSuffix(row, false)).toBe('')
  })

  it('★ 同值双轨:只有 `rangeWindowAuthoritative` 不同 ⇒ 结果必须不同', () => {
    // 只测一种 authoritative 取值,把参数忽略掉也能全绿 —— 「同值双轨」抓不住。
    const row = pair({ today: win('today') })
    expect(resolveUsageBasis(row, false)).not.toBe(resolveUsageBasis(row, true))
    expect(resolveUsageStatsFor(row, false)).not.toBe(resolveUsageStatsFor(row, true))
  })

  it('★ 逐行判定(本轮病根):同一张表里 A 行 window、B 行 today ⇒ 口径必须不同', () => {
    // 这就是整表粒度 `usesRangeWindow` 抓不到的场景:只要有一行有 window,
    // 整表就宣称"都是窗口值",B 行的自然日数值就没有任何标注。
    const rowA = pair({ window: win('window'), today: win('today') })
    const rowB = pair({ today: win('today') })
    expect(resolveUsageBasis(rowA, false)).toBe('window')
    expect(resolveUsageBasis(rowB, false)).toBe('today')
    expect(resolveRowUsageSuffix(rowA, false), 'A 行不得标自然日').toBe('')
    expect(resolveRowUsageSuffix(rowB, false), 'B 行必须标自然日').toContain('本机自然日')
  })
})

describe('接线 · 视图必须逐行调用,不得退回整表粒度', () => {
  const view = readFileSync(resolve(__dirname, '../../../views/admin/CostCenterView.vue'), 'utf8')

  it('扫描面非空(否定断言在空串上恒真 — 这是本项目的老坑)', () => {
    expect(view.length).toBeGreaterThan(0)
    expect(view).toContain('<template>')
    expect(view).toContain('usageStatsFor(row)')
  })

  it('★ 用量三列必须逐行调 rowUsageSuffix(row)', () => {
    // 三列都读 usageStatsFor(row):成本列 / 自算成本列 / 请求列。同一份数据的每一个消费点都要改。
    // ⚠️ 只筛 `usageStatsFor(row)` 会把脚本里 `rankingEligible` 的那一处也算进来(它不是展示格,
    //    不需要后缀)⇒ 必须限定 `<td>` 模板行,否则这条断言恒红、会被人"顺手改宽"。
    // 自算成本列(589)走 `rowUserCost(row)`,它内部再调 `usageStatsFor` —— 也必须一起扫。
    const cells = view.split('\n').filter((l) => l.trimStart().startsWith('<td>')
      && (l.includes('usageStatsFor(row)') || l.includes('rowUserCost(row)')))
    expect(cells.length, '扫描面非空:至少三个展示格读逐账号用量').toBeGreaterThanOrEqual(3)
    const withSuffix = cells.filter((l) => l.includes('rowUsageSuffix(row)'))
    expect(withSuffix.length, '每一处展示格都必须带逐行口径后缀').toBe(cells.length)
  })

  it('★ 反向:不得再用整表粒度的 usesRangeWindow 去决定「本机自然日」标注', () => {
    // 「只钉一处 = 没钉」:整表粒度那串只要还在,就有人会再抄回去。
    expect(view).not.toContain("usesRangeWindow ? '' : '（本机自然日）'")
    // 也不得出现任何"整表布尔 ? 空串 : 自然日"形态的写法(换皮变体)
    const start = view.indexOf('function rowUsageSuffix')
    expect(start, '未找到逐行后缀函数').toBeGreaterThan(-1)
    const body = view.slice(start, view.indexOf('\n}', start) + 2)
    expect(body).toContain('resolveRowUsageSuffix(row, data.rangeWindowAuthoritative.value)')
    expect(body).not.toContain('usesRangeWindow')
  })
})
