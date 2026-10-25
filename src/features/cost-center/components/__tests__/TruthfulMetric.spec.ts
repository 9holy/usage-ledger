import { mountWithCostI18n as mount } from './costI18n'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compileStyle, parse } from 'vue/compiler-sfc'
import { describe, expect, it } from 'vitest'
import TruthfulMetric from '../TruthfulMetric.vue'

const SFC_PATH = resolve(process.cwd(), 'src/features/cost-center/components/TruthfulMetric.vue')

interface CssRule {
  selector: string
  body: string
}

/** 用真实 Vue 编译器把本组件 <style scoped> 编译出来 —— 选择器上带的就是运行时那个 scope id。 */
function compiledScopedCss(scopeId: string): string {
  const source = readFileSync(SFC_PATH, 'utf8')
  const { descriptor } = parse(source, { filename: SFC_PATH })
  const block = descriptor.styles.find((style) => style.scoped)
  if (!block) throw new Error('TruthfulMetric.vue 缺少 <style scoped>')
  return compileStyle({ source: block.content, filename: SFC_PATH, id: scopeId, scoped: true }).code
}

function cssRules(css: string): CssRule[] {
  // compileStyle 会保留源码里的 /* */ 注释,不剥掉的话注释会被当成选择器前缀,
  // 让 element.matches() 抛错 —— 那种错必须显式暴露,不能静默成「没匹配上」。
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: CssRule[] = []
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim()
    if (!selector || selector.startsWith('@')) continue
    rules.push({ selector, body: match[2] })
  }
  return rules
}

function matchesAny(element: Element, selector: string): boolean {
  // 故意不 try/catch:选择器解析失败要炸出来,而不是静默变成 false(那会造成假通过)。
  return selector.split(',').some((part) => element.matches(part.trim()))
}

function mountCell(props: Record<string, unknown>) {
  const wrapper = mount(TruthfulMetric, { props })
  const root = wrapper.element as HTMLElement
  const scopeId = root.getAttributeNames().find((name) => name.startsWith('data-v-'))
  if (!scopeId) throw new Error('组件根元素上没有 scope id,scoped style 不可能生效')
  return {
    wrapper,
    root,
    scopeId,
    rules: cssRules(compiledScopedCss(scopeId)),
    label: root.querySelector('.cost-metric-cell__label') as HTMLElement,
    value: root.querySelector('strong') as HTMLElement,
    note: root.querySelector('small') as HTMLElement,
  }
}

/** 只挑「上强调色」的规则:颜色值是 var(--cost-*)。 */
function accentRules(rules: CssRule[]): CssRule[] {
  return rules.filter((rule) => rule.selector.includes('.accent-') && rule.body.includes('var(--cost-'))
}

function accentRulesMatching(element: Element, rules: CssRule[]): CssRule[] {
  return accentRules(rules).filter((rule) => matchesAny(element, rule.selector))
}

const NON_MEASURED = ['loading', 'estimated', 'empty', 'partial', 'unavailable', 'stale'] as const

describe('TruthfulMetric', () => {
  it('keeps a measured zero as a real numeric value', () => {
    const wrapper = mount(TruthfulMetric, {
      props: {
        label: '当前产出',
        value: '$0.00',
        note: '已成功读取 usage_logs',
        state: 'measured',
      },
    })

    expect(wrapper.text()).toContain('$0.00')
    expect(wrapper.attributes('data-data-state')).toBe('measured')
    expect(wrapper.find('.cost-metric-cell__state').exists()).toBe(false)
  })

  it('labels an unavailable source instead of rendering a fake zero', () => {
    const wrapper = mount(TruthfulMetric, {
      props: {
        label: '当前产出',
        value: '无数据',
        note: '请求超时',
        state: 'unavailable',
      },
    })

    expect(wrapper.text()).toContain('无数据')
    expect(wrapper.text()).toContain('不可用')
    expect(wrapper.text()).not.toContain('$0.00')
  })

  it('exposes estimated values as estimates', () => {
    const wrapper = mount(TruthfulMetric, {
      props: {
        label: '采购费率',
        value: '¥0.3425/h',
        note: '套餐默认值',
        state: 'estimated',
      },
    })

    expect(wrapper.text()).toContain('估算')
    expect(wrapper.attributes('data-data-state')).toBe('estimated')
  })
})

/**
 * accent 契约:强调色只属于「已实测」。
 *
 * 背景:accent 原先由父组件的 scoped 规则实现(例如 CostCenterView / CockpitDataView 里的
 * `.cost-metric-cell.accent-lime > strong`)。Vue 的 scoped CSS 只把父组件的 scope id 打在
 * **子组件的根元素**上,而 <strong> 在子组件内部、只带子组件的 scope id,所以那条规则编译成
 * `... > strong[data-v-父]` 后永不匹配 —— accent 是死功能。
 * 因此这里用「选择器在真实 DOM 上是否真的命中」作为判据,而不是 getComputedStyle:
 * jsdom 对 `color: var(--x)` 不做变量替换,且在本组件这组规则上按文档顺序而非特异性裁决
 * (去掉门控的变异副本里 accent 规则明明命中,computed color 仍返回中性色),
 * 用计算样式断言会**假通过**。
 */
describe('TruthfulMetric · accent 只给实测值上强调色', () => {
  it('measured + accent=lime:accent 类挂上,且强调色规则真的命中数字', () => {
    const cell = mountCell({ label: '当前产出', value: '$12.34', state: 'measured', accent: 'lime' })

    expect(cell.root.className).toContain('accent-lime')
    const matched = accentRulesMatching(cell.value, cell.rules)
    expect(matched).toHaveLength(1)
    // 选择器末位必须是本组件内部元素(带本组件 scope id),否则就是永不匹配的死规则
    expect(matched[0].selector).toContain('.cost-metric-cell__value')
    expect(matched[0].selector).toContain(`[${cell.scopeId}]`)
    expect(cell.value.hasAttribute(cell.scopeId)).toBe(true)
    expect(matched[0].body).toContain('var(--cost-lime)')
  })

  it.each(NON_MEASURED)('%s + accent=lime:不挂 accent 类,且没有任何强调色规则命中', (state) => {
    const cell = mountCell({ label: '当前产出', value: '无数据', state, accent: 'lime' })

    expect(cell.root.className.split(/\s+/).filter((name) => name.startsWith('accent-'))).toEqual([])
    expect(accentRulesMatching(cell.value, cell.rules)).toEqual([])
  })

  it('measured 但未指定 accent:同样没有强调色规则命中', () => {
    const cell = mountCell({ label: '总 Token', value: '1,024', state: 'measured' })

    expect(cell.root.className).not.toContain('accent-')
    expect(accentRulesMatching(cell.value, cell.rules)).toEqual([])
  })

  it('强调色规则必须留在本组件内:组件自身 scoped CSS 里要能找到 accent 规则', () => {
    // 若有人把 accent 规则搬回父组件,本用例(单独挂载组件)将一条都找不到而失败。
    const cell = mountCell({ state: 'measured', accent: 'gold' })
    expect(accentRules(cell.rules).map((rule) => rule.body.trim())).toEqual([
      'color: var(--cost-lime);',
      'color: var(--cost-gold);',
      'color: var(--cost-blue);',
    ])
  })

  it('label / 数字 / note 的排版规则真的命中(原先靠父组件那条永不匹配的规则)', () => {
    const cell = mountCell({ label: '当前产出', value: '$12.34', note: '已读取 usage_logs', state: 'measured' })

    const labelRules = cell.rules.filter((rule) => matchesAny(cell.label, rule.selector))
    const valueRules = cell.rules.filter((rule) => matchesAny(cell.value, rule.selector))
    const noteRules = cell.rules.filter((rule) => matchesAny(cell.note, rule.selector))

    expect(labelRules.some((rule) => rule.body.includes('font-size: 11px'))).toBe(true)
    expect(valueRules.some((rule) => rule.body.includes('font: 700 20px'))).toBe(true)
    expect(noteRules.some((rule) => rule.body.includes('font: 10px'))).toBe(true)
  })
})

/**
 * 2026-09-16:note 是**口径说明**,而这批诚实性修复的核心交付就是把口径写到界面上。
 * 45f0faa 把 note 排版移进本组件时带了 `overflow: hidden + text-overflow: ellipsis +
 * white-space: nowrap`:格子约 200px 宽、9px 等宽字体一行只放得下 ~23 个汉字,
 * 而新增的口径注释(例如「本机自然日 · cockpit 单请求用量库按本地价目表自算 × 成本倍率（本项目配置）」)
 * 更长 —— 于是写上去的口径全被「…」截断,交付本身被自己的样式吃掉了。
 * 本条钉住:note 规则里不得出现任何截断声明(允许换行、默认完整可见)。
 */
describe('TruthfulMetric · 口径 note 默认必须完整可见', () => {
  const NOTE_CLASS = '.cost-metric-cell__note'
  const VALUE_CLASS = '.cost-metric-cell__value'

  /** scoped 编译后选择器是 `.cost-metric-cell__note[data-v-x]`,所以按"是否命中元素"找。 */
  function ruleFor(cell: ReturnType<typeof mountCell>, className: string): CssRule {
    const rule = cell.rules.find((item) => item.selector.includes(className) && matchesAny(
      className === NOTE_CLASS ? cell.note : cell.value,
      item.selector,
    ))
    if (!rule) throw new Error(`${className} 规则不存在,排版会退回浏览器默认`)
    return rule
  }

  it('note 规则不得截断文本(no nowrap / no ellipsis / no overflow:hidden)', () => {
    const cell = mountCell({ label: '今日上游账号成本（USD）', value: '$0.00', note: '本机自然日 · cockpit 单请求用量库按本地价目表自算 × 成本倍率（本项目配置）', state: 'measured' })
    const body = ruleFor(cell, NOTE_CLASS).body

    expect(body).not.toContain('white-space: nowrap')
    expect(body).not.toContain('text-overflow: ellipsis')
    expect(body).not.toContain('overflow: hidden')
    // 允许在窄格子里折行,不横向溢出
    expect(body).toContain('overflow-wrap: anywhere')
  })

  it('note 规则确实命中 note 元素(不是死规则)', () => {
    const cell = mountCell({ label: '口径', value: '1', note: '一段很长的口径说明', state: 'measured' })
    expect(matchesAny(cell.note, NOTE_CLASS)).toBe(true)
    expect(matchesAny(cell.note, ruleFor(cell, NOTE_CLASS).selector)).toBe(true)
  })

  it('large amounts remain complete instead of becoming ellipses', () => {
    const value = '$123,456,789,012.34'
    const cell = mountCell({ label: '口径', value, note: '说明', state: 'partial' })
    const body = ruleFor(cell, VALUE_CLASS).body
    expect(cell.value.textContent).toBe(value)
    expect(body).not.toContain('white-space: nowrap')
    expect(body).not.toContain('text-overflow: ellipsis')
    expect(body).toContain('overflow-wrap: anywhere')
    expect(cell.root.querySelector('.cost-metric-cell__heading .cost-metric-cell__state')).not.toBeNull()
  })
})
