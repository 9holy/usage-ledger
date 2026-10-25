import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'
import postcss from 'postcss'
import ts from 'typescript'

const source = readFileSync(
  resolve(process.cwd(), 'src/views/admin/CostCenterView.vue'),
  'utf8',
)
const sfc = parse(source).descriptor
const theme = readFileSync(resolve(process.cwd(), 'src/styles/console-theme.css'), 'utf8')
const css = postcss.parse(sfc.styles.map(style => style.content).join('\n'))
const script = ts.createSourceFile('CostCenterView.ts', sfc.scriptSetup!.content, ts.ScriptTarget.Latest, true)

function declaration(name: string): string {
  for (const statement of script.statements) if (ts.isVariableStatement(statement)) {
    const value = statement.declarationList.declarations.find(item => item.name.getText(script) === name)
    if (value) return value.getText(script)
  }
  throw new Error(`Missing declaration: ${name}`)
}

function declarationsFor(selector: string): Record<string, string> {
  const result: Record<string, string> = {}
  css.walkRules(selector, rule => { rule.walkDecls(value => { result[value.prop] = value.value }) })
  return result
}

function cssHex(variable: string): string {
  const match = theme.match(new RegExp(`--${variable}:\\s*(#[0-9a-f]{6})`, 'i'))
  if (!match) throw new Error(`Missing CSS variable --${variable}`)
  return match[1]
}

function relativeLuminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map((value) => Number.parseInt(value, 16) / 255)
  if (!channels || channels.length !== 3) throw new Error(`Invalid color ${hex}`)
  const [red, green, blue] = channels.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ))
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrast(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

describe('cost center UI shell contract', () => {
  it('keeps every cost workspace inside an explicit dark semantic boundary', () => {
    expect(source).toContain('data-aui-appearance="dark"')
    expect(source).toContain('--aui-label-primary: var(--cost-text)')
    expect(source).toContain('--aui-label-tertiary: var(--cost-muted)')
    expect(source).toContain('--aui-canvas: var(--cost-bg)')
    expect(source).toContain('--aui-content-plane: var(--cost-bg)')
    expect(source).toContain('--aui-content-plane-secondary: var(--cost-panel)')
    expect(source).toContain('> main[data-aui-layer="content"]')
  })

  it('maintains readable primary, secondary and accent contrast', () => {
    expect(source).toContain("import '@/styles/console-theme.css'")
    expect(source).toContain('class="cost-console console-theme"')
    expect(contrast(cssHex('cost-text'), cssHex('cost-bg'))).toBeGreaterThanOrEqual(7)
    expect(contrast(cssHex('cost-muted'), cssHex('cost-panel'))).toBeGreaterThanOrEqual(4.5)
    expect(contrast(cssHex('cost-lime'), cssHex('cost-bg'))).toBeGreaterThanOrEqual(7)
    expect(contrast('#10140f', cssHex('cost-lime'))).toBeGreaterThanOrEqual(7)
  })

  it('keeps governance out of primary navigation and exposes it as a toolbar utility', () => {
    const workspaceItems = declaration('workspaceItems')
    expect(workspaceItems).not.toContain("key: 'governance'")
    expect(workspaceItems).toContain("key: 'api'")
    expect(source).toContain('class="cost-icon-button cost-governance-button"')
    expect(source).toContain(':aria-label="t(\'costCenter.text.dataManagement\')"')
    expect(source).toContain("@click=\"activePanel = 'governance'\"")
  })

  it('renders one compact, non-wrapping segmented workspace control', () => {
    expect(source).toContain('data-aui-component="segmented"')
    expect(source).not.toContain('data-aui-component="sidebar"')
    expect(source).toContain(':aria-pressed="activePanel === item.key"')
    const button = declarationsFor('.cost-workspaces button')
    expect(button['white-space']).toBe('nowrap')
    expect(button.width).toBe('auto')
    expect(Number.parseFloat(button['min-width'])).toBeGreaterThanOrEqual(96)
    expect(button.flex).toBe('0 0 auto')
    expect(declarationsFor('.cost-console .cost-toolbar')['min-height']).toBe('74px')
  })

  it('keeps historical losses out of the selected observation-window headline', () => {
    // Headline amounts use the selected operating window, not lifetime loss totals.
    expect(source).toContain(':label="t(\'costCenter.text.accountLosses\')" :value="formatCny(windowImpairmentCny, 2)"')
    expect(declaration('windowImpairmentCny')).toContain('row.windowLossCny')
    expect(declaration('windowEconomicCostCny')).toContain('operatingSummary.value.expenseCny.total')
    expect(source).toContain("t('costCenter.text.recordedLossesIn', { value0: rangeLabel })")
    expect(source).not.toContain('label="生命周期已确认封禁损失"')
  })

  it('uses the actual account-usage window for finance, with local calendar-day fallback clipped to its anchor', () => {
    // Finance now follows the proven account window for every source, not the optional remote sampling interval.
    const window = declaration('financeWindow')
    expect(window).toContain('operatingUsageReady.value')
    expect(window).toContain('data.rangeAccountStatsWindow.value')
    expect(window).toContain('usageWindowBounds(range.value, anchor)')
    expect(window).toContain('Math.min(bounds.end.getTime(), anchor.getTime())')
    // 反向:不得再无条件把 today 写成「近 24 小时」
    expect(source).not.toContain("range.value === 'today' ? '近 24 小时' : rangeLabel.value")
    expect(source).not.toContain(':label="`${rangeLabel}新增封禁损失`"')
  })

  it('includes deleted one-time purchase snapshots in the monthly purchase total', () => {
    expect(source).toContain('archivedMonthlyOneTimeProcurementCny')
    expect(source).toContain("state.cost_profile.billing_cycle === 'one_time'")
    expect(source).toContain('month_one_time_procurement_cny')
    expect(source).toContain('month_deleted_recurring_procurement_cny')
    // 2026-09-20:note 由固定字面量改为 computed 逐段披露「哪一段计入了」。
    // 旧断言钉的是 `含 ${monthlyDeletedPurchaseCount} 个已删除账号快照` 这个**字面量**,
    // 它恰好掩盖了「经常性采购账本该源不提供」这半段的缺口 —— 所以断言要跟着语义走。
    expect(declaration('monthlyProcurementNote')).toContain("t('costCenter.text.includesDeletedAccountSnapshots', { value0: deleted })")
    expect(declaration('monthlyProcurementNote')).toContain("t('costCenter.text.excludesDeletedAccountsRecurringProcurementSourceHasNo')")
    const budgetCell = source.split('\n').find(line => line.includes(":label=\"t('costCenter.text.monthlyProcurementBudget')\"")) ?? ''
    expect(budgetCell, '未找到预算格，不能在空扫描面验证披露信息').not.toBe('')
    expect(budgetCell).toContain(':title="monthlyProcurementNote"')
    // 经常性那半不可得时**不得**用 0 冒充:条数走 `?? null`,总数任一分量缺失即整体 null
    expect(source).toContain('month_deleted_recurring_purchase_count ?? null')
    expect(source).toContain('if (recurring == null) return null')
  })

  /**
   * 缺列/缺字段守卫的**接线**断言。
   *
   * 这两处守卫是模板级的(v-if 分支),没有可单测的函数边界,只能钉源码。
   * 但钉的是"守卫**接在模板上**"这件事,不是"某个字符串存在" ——
   * 变异检查:把下面任一处还原成旧写法,本测试必须失败。
   */
  it('缺列守卫必须真的接在模板上,不是只声明一个没人用的 computed', () => {
    // reasoning_tokens 是 Rust 侧 optional 列(cockpit_logs_db.rs),缺列时 SQL 走
    // expr_or(&columns,"reasoning_tokens","0") ⇒ 聚合值恒 0。
    // 不守卫就会渲染成「0 / 0 次请求」,与"实测就是 0"无法区分 —— 正是假零。
    expect(source).toContain("facetDimensionUnavailable(facets.value, 'reasoning_tokens')")
    expect(source).toContain('<div v-if="reasoningTokensUnavailable" class="cost-facet-chip is-muted">')
    expect(source).toContain("<small>{{ t('costCenter.text.cockpitLacksReasoningTokens') }}</small>")
    // supportsVision 在 CockpitModelProvider 里是**可选**字段:源没给 ≠ 该提供商不支持视觉。
    // 旧写法 `? '支持' : '否'` 把「未知」说成「否」,是编造的否定结论。
    expect(source).toContain("p.supportsVision == null ? '—' : p.supportsVision ? t('costCenter.text.supported') : t('costCenter.text.notSupported')")
    expect(source).not.toContain("{{ p.supportsVision ? '支持' : '否' }}")
  })
})

describe('三端汇总面板的隔离与口径契约', () => {
  it('口径标签由 composable 提供,不在视图里写死', () => {
    expect(source).not.toContain('· 口径 累计')
    expect(source).not.toContain('· 口径 窗口')
    expect(source).toContain('unifiedCostNote(')
  })

  it('caption 消费 contributedSources(不再是死导出)', () => {
    expect(source).toContain('unified.contributedSources.value.length')
  })

  it('口径混合提示分支仍在', () => {
    expect(source).toContain('unified.totalCostUnitMixed.value')
  })

  it('总成本无值时显示 — 而不是假 0', () => {
    expect(source).toContain("unified.totalCostUsd.value == null ? '—' : formatUsd(unified.totalCostUsd.value, 2)")
  })
})

describe('标签与数据来源一致性契约(2026-09-16 B1/C1/C2/C3/C5)', () => {
  const store = readFileSync(
    resolve(process.cwd(), 'src/features/cost-center/useCostCenterData.ts'),
    'utf8',
  )

  it('B1:cockpit「累计」标签只在快照路径确实是数值来源时才出现', () => {
    // store:单请求用量库可用时不得再写"今日/本周/本月累计"(滚动窗口会被读成日历累计)
    expect(store).toContain('cockpitCostFromRequestLog.value = rlAvailable')
    expect(store).toContain('cockpitWindowRange.value = rlAvailable ? null : range')
    expect(store).toContain('const cockpitWindowLabel = computed')
    // 视图:request-log 口径下**三个**消费点都必须走窗口口径标注
    // (不得渲染空串,也不得继续写累计)。
    // ★ 2026-09-24:标注由「窗口名」升级为「窗口名 + 覆盖区间」的**共用出口**
    //   `cockpitWindowCoverageNote`(内部 `cockpitCoverageNote({ state, windowLabel, … })`,
    //   `unknown` 态即退回窗口名本身)。断言从旧字面量改钉「共用出口」——
    //   契约意图(不得出现累计标签)不变,只是出口换了。
    expect(source).toContain('if (connectionType.value === null && cockpitCostFromRequestLog.value) return cockpitWindowCoverageNote.value')
    expect(source).toContain('if (opsTrendFromRequestLog.value) return cockpitWindowCoverageNote.value')
    // ★ 第三个消费点:usageWindowLabel 的 request-log 分支会被 costWindowCaption/requestWindowCaption
    //   在 `!usesRangeWindow` 时消费。漏掉它 ⇒ 覆盖标注整个消失、下界又被说成完整窗口值。
    expect(source).toContain('if (cockpitCostFromRequestLog.value) return cockpitWindowCoverageNote.value')
    // 共用出口的窗口名实参必须是 rangeLabel(不是累计标签),否则 B1 的初衷被绕过
    // ⚠️ 2026-09-24:`cockpitCoverageNote` 入参从**位置参数**改成**对象**(6 个位置参数没法读),
    //   断言随之改成对象属性形态。契约意图未变:窗口名实参仍必须是 `rangeLabel.value`。
    expect(source).toContain('const cockpitWindowCoverageNote = computed(() => cockpitCoverageNote({')
    expect(source).toContain('  windowLabel: rangeLabel.value,')
    // 反向:request-log 口径下不得再出现未标注的裸窗口名回退
    expect(source).not.toContain('if (cockpitCostFromRequestLog.value) return rangeLabel.value')
    expect(source).not.toContain('if (connectionType.value === null && cockpitCostFromRequestLog.value) return rangeLabel.value')
    expect(source).not.toContain('if (opsTrendFromRequestLog.value) return rangeLabel.value')
  })

  it('C1:号池分组表产出/成本列不得硬编码绿色', () => {
    expect(source).not.toContain('<strong class="cost-lime">{{ formatUsd(group.outputUsd, 2) }}')
    expect(source).not.toContain('<strong class="cost-lime">{{ formatCny(group.hourlyCny, 5) }}')
    expect(source).toContain('poolValueClass(group.outputSummary.total)')
    const hourlyCell = source.split('\n').find(line => line.includes('formatAmount(group.hourlySummary')) ?? ''
    expect(hourlyCell).not.toBe('')
    expect(hourlyCell).toContain('formatAmount(group.sourceCostSummary')
    expect(hourlyCell).not.toContain('class="cost-lime"')
  })

  it('C2:排行表成本列按值判绿,无值渲染「无数据」', () => {
    expect(source).toContain("rowUserCost(row) != null ? 'cost-lime' : 'cost-unknown-value'")
    expect(source).not.toContain("usageStatsFor(row) ? 'cost-lime' : 'cost-unknown-value'")
  })

  it('C3:三个 MetricCell 的状态跟着值走,不写死 measured', () => {
    expect(source).toContain(':state="truthfulState(cockpitGatewayUrl)"')
    expect(source).toContain(':state="truthfulState(cockpitLocalAccess.apiKey)"')
    expect(source).toContain(':state="truthfulState(cockpitLocalAccess.apiKeys)"')
    expect(source).not.toContain('note="apiKey(脱敏)" state="measured"')
  })

  it('C5:cliproxy 计价依据 basis/label 被模板消费,不再静默丢弃', () => {
    expect(source).toContain("unified.cliproxyCostBasis.value.kind === 'no_price_no_estimate' ? t('costCenter.text.costUnknown')")
    expect(source).toContain(':note="cliproxyCostNote"')
    expect(source).toContain('unified.cliproxyCostLabel.value')
    expect(source).toContain('cliproxyEstimateBasisSuffix')
    expect(source).toContain('unified.cliproxyEstimate.value.totalCostLabel')
    expect(source).toContain("m.costUnknown ? t('costCenter.text.costUnknown')")
  })
})

/**
 * 2026-09-16:TruthfulMetric 的 span / strong / small 在**子组件内部**,
 * Vue scoped CSS 只把父组件的 scope id 打在子组件根元素上 ——
 * 所以 `.cost-metric-cell > strong` 编译成 `... > strong[data-v-父]` 后**永不匹配**。
 * 45f0faa 已把排版与 accent 移入 TruthfulMetric.vue,但 CostCenterView 里那几条死规则
 * 留了下来:其中 `.cost-metric-cell > strong { font-size: clamp(17px,1.25vw,20px) }`
 * 是**响应式字号**,死了就等于数字被组件硬编码的 20px 固定住 —— 视觉上"看起来没坏",
 * 所以谁也不会去删,只会一直烂在那里。这条守卫把它钉住。
 */
describe('cost center · MetricCell 的父组件选择器不得是永不匹配的死规则', () => {
  /** 只取 <style scoped> 段落,避免模板/脚本里的同名文本误判。 */
  const styleBlock = source.slice(source.lastIndexOf('<style'))
  // 再剥掉 CSS 注释:注释里会引用这些选择器(解释为什么删),不能当规则判。
  const styleCss = styleBlock.replace(/\/\*[\s\S]*?\*\//g, '')

  it('不得再有末位落在子组件内部元素上的 `.cost-metric-cell > *` 规则', () => {
    // 末位元素选择器(span / strong / small / em)一律死;末位是 .cost-metric-cell__* 且带 :deep() 才活。
    const deadSelectors = styleCss
      .split('}')
      .map((chunk) => chunk.split('{')[0].trim())
      .filter((selector) => /\.cost-metric-cell(\.[\w-]+)?\s*>\s*(span|strong|small|em|\.cost-metric-cell__)/.test(selector))

    expect(deadSelectors).toEqual([])
  })

  it('数字字号通过 :deep() 落到子组件，使用稳定可读字号而非视口缩放', () => {
    expect(styleCss).toContain('.cost-metric-cell :deep(.cost-metric-cell__value)')
    const size = declarationsFor('.cost-metric-cell :deep(.cost-metric-cell__value)')['font-size']
    expect(size).toMatch(/^\d+px$/)
    expect(Number.parseFloat(size)).toBeGreaterThanOrEqual(17)
    expect(Number.parseFloat(size)).toBeLessThanOrEqual(20)
    expect(styleCss).not.toContain('.cost-metric-cell > strong')
  })

  it('保留真正生效的根元素规则(::before 左色条 / 边框)', () => {
    expect(styleCss).toContain('.cost-metric-cell::before')
    expect(styleCss).toContain('.cost-metric-cell.accent-lime::before')
  })
})
