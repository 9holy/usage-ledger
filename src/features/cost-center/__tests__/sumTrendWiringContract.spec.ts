/**
 * 2026-09-27 红线回归:趋势合计的三态语义必须落在**生产函数**里,且视图真的调用它。
 *
 * ## 修的是什么(Bug B)
 * 旧实现(内联在 CostCenterView.vue)语义是「任一桶为 null ⇒ 整笔返回 null」。
 * 30d 窗口实测有 10 个无单价桶(actual_cost === null)⇒ 整排 KPI
 * (窗口自算成本 / 毛利 / 每 USD 采购 / 回本率 / 预计回本)全部渲染成「无数据」。
 * 修法:把语义抽进 `dataState.sumFiniteTrendValues`,改成三态 ——
 *   全未知 ⇒ null;空数组 ⇒ null;部分未知 ⇒ 已知(有限)值之和(真实下界)。
 *
 * ## 为什么需要本文件(独立复核发现的盲区)
 * `dataState.test.ts` 直测纯函数,只证**函数**对;把视图消费点改回旧的
 * 「任一 null ⇒ null」内联写法,整个 cost-center 872 tests **仍全绿** ——
 * 纯函数绿 ≠ 界面绿。本文件用**源码扫描**把「视图确实调用该函数」这条接线钉住
 * (与 modelAuditSourceContract.spec.ts 同一模式:语义直测纯函数,接线用源码扫描)。
 *
 * 变异验证:把 windowActualOutputUsd 改回 `.some(...) ? null : ...` 内联、或在视图里
 * 重新定义一个旧的 `function sumFiniteTrendValues`,第 2/3 条断言必红。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { sumFiniteTrendValues } from '../dataState'
import { cockpitRequestLogToModelRoutes } from '../cockpitAdapter'

const VIEW = readFileSync(resolve(process.cwd(), 'src/views/admin/CostCenterView.vue'), 'utf8')
const COMPOSABLE = readFileSync(resolve(process.cwd(), 'src/features/cost-center/useCostCenterData.ts'), 'utf8')

/** 取视图中声明某 computed 的那一行。 */
function computedLine(name: string): string {
  return VIEW.split('\n').find((line) => line.includes(`const ${name} = computed`)) ?? ''
}

describe('2026-09-27 · 趋势合计(三态)接线守卫', () => {
  it('dataState 导出 sumFiniteTrendValues,语义为「部分未知 ⇒ 已知部分之和」', () => {
    // 直测语义(与 dataState.test.ts 同源,这里只做最小锚定,防函数被删/改名/改回旧语义)。
    expect(sumFiniteTrendValues([1, null, 2])).toBe(3)
    expect(sumFiniteTrendValues([null, null])).toBeNull()
    expect(sumFiniteTrendValues([])).toBeNull()
  })

  it('视图从 @/features/cost-center/dataState 引入,而非本地内联定义', () => {
    // 不得再在视图里定义同名函数(旧实现就内联在此,复核 M8 即把它塞回视图)。
    expect(VIEW, '视图内不得再出现 sumFiniteTrendValues 的本地定义').not.toMatch(/function\s+sumFiniteTrendValues/)
    const importLine = VIEW.split('\n').find((line) => line.includes("from '@/features/cost-center/dataState'")) ?? ''
    expect(importLine, '未找到 dataState 的 import').not.toBe('')
    expect(importLine).toContain('sumFiniteTrendValues')
  })

  it('两个 KPI 消费点逐行调用 sumFiniteTrendValues,且不含旧「任一 null ⇒ null」写法', () => {
    const targets = ['windowActualOutputUsd', 'windowAccountCostUsd']
    const lines = targets.map(computedLine)
    // 扫描面非空:两个 computed 都必须找到(否则下面的 for 零次 ⇒ 恒绿)。
    for (let i = 0; i < targets.length; i++) {
      expect(lines[i], `未找到 computed「${targets[i]}」`).not.toBe('')
      expect(lines[i], `「${targets[i]}」必须调用 sumFiniteTrendValues`).toContain('sumFiniteTrendValues(')
      // 旧写法特征:`.some(` 配合 `? null :` —— 必须不复存在。
      expect(lines[i], `「${targets[i]}」仍含旧「任一 null ⇒ null」内联写法`).not.toContain('.some(')
    }
  })

  it('主窗口与独立窗口复用 SQL 路由入口，合法空查询不能被当成来源不可用', () => {
    const ast = ts.createSourceFile('useCostCenterData.ts', COMPOSABLE, ts.ScriptTarget.Latest, true)
    const bodies = new Map<string, string>()
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name) bodies.set(node.name.text, node.getText(ast))
      ts.forEachChild(node, visit)
    }
    visit(ast)
    for (const name of ['loadFromCockpit', 'loadCockpitModelWindow']) {
      expect(bodies.has(name), `未找到 ${name}`).toBe(true)
      expect(bodies.get(name)).toContain('cockpitRequestLogToModelRoutes(')
    }
    const empty = { available: true, groups: [], cells: [], rowCount: 0 } as any
    expect(cockpitRequestLogToModelRoutes(empty, [], {})).toEqual({ routes: [], totalRequests: 0 })
    expect(cockpitRequestLogToModelRoutes({ ...empty, available: false }, [], {})).toBeNull()
  })
})
