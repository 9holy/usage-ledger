import { afterEach, describe, expect, it } from 'vitest'
import { computed } from 'vue'
import { i18n } from '@/i18n'
import en from '@/i18n/locales/en/costData'
import zh from '@/i18n/locales/zh/costData'
import { costDataText, type CostDataKey } from '../costDataText'
import { createDataSourceStates, dataAvailabilityLabel, sourceState } from '../dataState'
import { describeCurrentAccountState } from '../upstreamTable'
import { providerLabels } from '../upstreamProvider'
import { costCenterRangeLabel } from '../usageWindow'
import { describePlanLabel, subscriptionPriceUsdOf } from '../planInfer'
import { resolveCostCell } from '../honestValues'
import { useCostCenterData } from '../useCostCenterData'
import { buildLocalEconomicsSnapshot } from '../costEngine'

const previous = i18n.global.locale.value
afterEach(() => { i18n.global.locale.value = previous })

describe('cost data localization', () => {
  it('keeps every dictionary key and interpolation parameter aligned and compiles real English messages', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    i18n.global.locale.value = 'en'
    for (const key of Object.keys(en) as CostDataKey[]) {
      const params = (message: string) => [...message.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
      expect(params(en[key]), key).toEqual(params(zh[key]))
      expect(en[key], key).not.toMatch(/\p{Script=Han}/u)
      const translated = costDataText(key, Object.fromEntries(params(en[key]).map(name => [name, 7])))
      expect(translated, key).not.toContain('costData.')
      expect(translated, key).not.toMatch(/\{\w+\}/)
    }
  })

  it('retranslates cached source labels and diagnostics without reloading data or translating source values', () => {
    const state = sourceState('dashboard', 'partial', () => costDataText('sourceErrorOriginalText', { detail: '原始错误 / raw backend error' }))
    const display = computed(() => `${state.label}: ${state.reason}`)
    i18n.global.locale.value = 'zh'
    expect(display.value).toContain('使用记录与成本趋势')
    expect(display.value).toContain('来源错误（原文）')
    i18n.global.locale.value = 'en'
    expect(display.value).toContain('Usage records and cost trends')
    expect(display.value).toContain('Source error (original text)')
    expect(display.value).toContain('原始错误 / raw backend error')
    expect(createDataSourceStates().accounts.reason).toBe('Reading data')
    expect(useCostCenterData().sourceStates.value.models.label).toBe('Model cost statistics')
  })

  it('translates helper-owned labels while preserving plan recognition and prices', () => {
    i18n.global.locale.value = 'en'
    expect(costCenterRangeLabel('7d')).toBe('Last 7 days')
    expect(dataAvailabilityLabel('partial')).toBe('Partially available')
    expect(providerLabels.openai).toBe('Official OpenAI')
    expect(describeCurrentAccountState({ status: 'inactive' }).label).toBe('Inactive')
    expect(describePlanLabel('CodeBuddy CN 旗舰版')?.rule.tier).toBe('Flagship (CN CNY 999/month)')
    expect(subscriptionPriceUsdOf('CodeBuddy CN 旗舰版', 7)).toBeCloseTo(999 / 7)
    i18n.global.locale.value = 'zh'
    expect(costCenterRangeLabel('7d')).toBe('最近 7 天')
    expect(providerLabels.openai).toBe('OpenAI 官方')
    expect(describePlanLabel('CodeBuddy CN 旗舰版')?.rule.tier).toBe('旗舰版（CN ¥999/月）')
    expect(subscriptionPriceUsdOf('CodeBuddy CN 旗舰版', 7)).toBeCloseTo(999 / 7)
  })

  it('retranslates an existing local forecast warning without changing its amounts or caller overrides', () => {
    const snapshot = buildLocalEconomicsSnapshot({ accounts: [], billedUsdTotal: 10, accountCostUsdTotal: 2, cnyPerUsd: 7,
      now: Date.parse('2026-10-25T12:00:00Z'), window: { start: new Date('2026-10-25T11:00:00Z'), end: new Date('2026-10-25T12:00:00Z') } })!
    i18n.global.locale.value = 'en'
    expect(snapshot.projection.warning).toContain('Estimated from average recorded usage')
    i18n.global.locale.value = 'zh'
    expect(snapshot.projection.warning).toContain('根据已读取时段的平均用量推算')
    expect(snapshot.actual.billed_usd).toBe(10)
    snapshot.projection.warning = 'caller-supplied raw diagnostic'
    expect(snapshot.projection.warning).toBe('caller-supplied raw diagnostic')
  })
})

describe('honest cost cell partial values', () => {
  it('does not promote unknown sentinel zero to a priced or partial zero', () => {
    const cell = resolveCostCell({ selfCost: 0, selfCostBasis: 'no_price_no_estimate', sourceEstimate: 99 })
    expect(cell.costBasis).toBe('no_price_no_estimate')
    expect(cell.costPartial).not.toBe(true)
  })

  it('retains a positive known subtotal without claiming the complete cost is known', () => {
    expect(resolveCostCell({ selfCost: 4.2, selfCostBasis: 'no_price_no_estimate', sourceEstimate: 99 })).toEqual({ costUsd: 4.2, costIsOurs: true, costBasis: 'no_price_no_estimate', costPartial: true })
  })

  it('keeps a real priced zero distinct from missing cost', () => {
    expect(resolveCostCell({ selfCost: 0, selfCostBasis: 'priced', sourceEstimate: 99 })).toEqual({ costUsd: 0, costIsOurs: true, costBasis: 'priced' })
    expect(resolveCostCell({ selfCost: null, selfCostBasis: 'no_price_no_estimate' }).costBasis).toBe('no_price_no_estimate')
  })
})
