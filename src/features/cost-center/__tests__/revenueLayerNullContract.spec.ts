import './costDataI18n'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { mountWithCostI18n as mount } from '../components/__tests__/costI18n'
import MetricCell from '../components/TruthfulMetric.vue'
import { summarizeOperatingCosts, type OperatingAccount, type OperatingScope } from '../costEngine'
import centerZh from '@/i18n/locales/zh/costCenter'

const source = readFileSync(resolve(process.cwd(), 'src/views/admin/CostCenterView.vue'), 'utf8')
const script = parse(source).descriptor.scriptSetup!.content
const ast = ts.createSourceFile('CostCenterView.ts', script, ts.ScriptTarget.Latest, true)

function computedBlock(name: string): string {
  for (const statement of ast.statements) if (ts.isVariableStatement(statement)) {
    const declaration = statement.declarationList.declarations.find(item => item.name.getText(ast) === name)
    if (declaration) return declaration.getText(ast)
  }
  throw new Error(`Missing computed: ${name}`)
}

function summaryFor(source: OperatingScope['source'], revenueUsd: number | null) {
  const scope = { source, instanceId: 'fixture' }
  const row: OperatingAccount = {
    scope, accountId: 'fixture-account', billingMode: 'metered', revenueUsd,
    referenceValueUsd: 4, meteredCostUsd: 1, fixedExpenseCny: 0, knownFixedExpenseCny: 0,
    fixedHourlyCny: 0, knownFixedHourlyCny: 0,
  }
  return summarizeOperatingCosts({ scope, accounts: [row], startMs: 0, endMs: 3_600_000, cnyPerUsd: 7,
    outputBasis: source === 'sub2api' ? 'revenue' : 'api_value' })
}

describe('revenue-free sources preserve unknown contribution without hiding reference value', () => {
  it.each(['cockpit', 'cliproxy'] as const)('%s has no revenue, contribution or contribution forecast', (source) => {
    const result = summaryFor(source, null)
    expect(result.revenueUsd.total).toBeNull()
    expect(result.contributionCny).toBeNull()
    expect(result.projectedContributionCnyPerHour).toBeNull()
    expect(result.referenceValueUsd.total).toBe(4)
    expect(result.expenseCny.total).toBe(7)
  })

  it('does not replace missing Sub2API user charges with a known reference price', () => {
    const result = summaryFor('sub2api', null)
    expect(result.referenceValueUsd.total).toBe(4)
    expect(result.revenueUsd.total).toBeNull()
    expect(result.contributionCny).toBeNull()
    expect(result.projectedContributionCnyPerHour).toBeNull()
  })

  it('retains contribution and forecast when actual user billing is known', () => {
    const result = summaryFor('sub2api', 3)
    expect(result.revenueUsd.total).toBe(3)
    expect(result.contributionCny).toBe(14)
    expect(result.projectedContributionCnyPerHour).toBe(14)
  })

  it('keeps a real zero charge distinct from unknown revenue', () => {
    const result = summaryFor('sub2api', 0)
    expect(result.revenueUsd.total).toBe(0)
    expect(result.contributionCny).toBe(-7)
    expect(summaryFor('sub2api', null).contributionCny).toBeNull()
  })

  it('wires contribution and payback to operating revenue while unit expense uses the explicit output basis', () => {
    expect(computedBlock('windowContributionCny')).toContain('operatingSummary.value.contributionCny')
    expect(computedBlock('projectedContributionHourlyCny')).toContain('operatingSummary.value.projectedContributionCnyPerHour')
    expect(computedBlock('paybackRatio')).toContain('operatingSummary.value.revenueUsd.total')
    expect(computedBlock('estimatedPaybackHours')).toContain('operatingSummary.value.revenueUsd.total')
    expect(computedBlock('estimatedPaybackHours')).toContain('billed == null')
    expect(computedBlock('cnyPerBilledUsd')).toContain('operatingOutputSummary.value.total')
    expect(computedBlock('cnyPerBilledUsd')).toContain('windowEconomicCostCny.value')
    const payback = source.split('\n').find(line => line.includes(":label=\"t('costCenter.text.returnRatio')\"")) ?? ''
    expect(payback).not.toBe('')
    expect(payback).toContain("t('costCenter.text.notApplicable')")
    expect(payback).toContain("t('costCenter.text.awaitingCompleteAmounts')")
    expect(payback).toContain("connectionType === 'sub2api'")
  })

  it('renders not-applicable revenue metrics distinctly from a measured zero percentage', () => {
    const absent = mount(MetricCell, { props: { label: centerZh.text.returnRatio, value: centerZh.text.notApplicable, state: 'measured' } })
    const zero = mount(MetricCell, { props: { label: centerZh.text.returnRatio, value: '0.0%', state: 'measured' } })
    expect(absent.find('.cost-metric-cell__value').text()).toBe(centerZh.text.notApplicable)
    expect(absent.text()).not.toContain('0.0%')
    expect(zero.find('.cost-metric-cell__value').text()).toBe('0.0%')
    expect(zero.text()).not.toContain(centerZh.text.notApplicable)
    absent.unmount()
    zero.unmount()
  })
})
