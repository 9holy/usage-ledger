import './usageI18nFixture'
import { mount } from '@vue/test-utils'
import { describe, it, expect } from 'vitest'
import UsageCoverageAssembly from '../UsageCoverageAssembly.vue'
import UsageModeEvidence from '../UsageModeEvidence.vue'
const coverage = [
  {
    state: 'known',
    label: '可估算',
    count: 95,
    percent: 59.375,
    color: '#85d49a',
  },
  {
    state: 'unknown',
    label: '模式未知',
    count: 60,
    percent: 37.5,
    color: '#a3adb8',
  },
  {
    state: 'missing',
    label: '缺少单价',
    count: 5,
    percent: 3.125,
    color: '#e7b96a',
  },
]
describe('scenic coverage and mode evidence preserve real data', () => {
  it('keeps both checkpoints, current coverage and the distinct gaps', async () => {
    const w = mount(UsageCoverageAssembly, {
      props: { rows: coverage, total: 160, available: 59.375, loaded: true },
    })
    expect(w.findAll('.stage-count strong').map((e) => e.text())).toEqual([
      '100',
      '95',
    ])
    for (const r of coverage)
      expect(w.get(`[data-state=${r.state}]`).attributes('data-count')).toBe(
        String(r.count),
      )
    expect(w.findAll('.coverage-landscape .coverage-readouts .coverage-gap')).toHaveLength(2)
    expect(w.get('.coverage-result').text()).toContain('59.4%')
    expect(w.get('.coverage-result-meter i').attributes('style')).toContain(
      '59.375%',
    )
    expect(w.text()).toContain('模式已识别，但还缺少对应目录单价')
    await w.setProps({
      rows: [
        { ...coverage[0], count: 0, percent: 0 },
        { ...coverage[1], count: 160, percent: 100 },
        { ...coverage[2], count: 0, percent: 0 },
      ],
    })
    expect(w.get('.coverage-result').classes()).toContain('no-eligible')
    expect(w.findAll('.coverage-landscape .coverage-readouts .coverage-gap')).toHaveLength(2)
    expect(w.text()).toContain('尚无请求具备完整计价依据')
    await w.setProps({ rows: [], total: undefined, loaded: false })
    expect(w.text()).toContain('尚未取得完整的费用覆盖统计')
    await w.setProps({ loaded: true, total: 0 })
    expect(w.text()).toContain('暂无请求')
  })
  it('retains tiny positive missing counts', () => {
    const w = mount(UsageCoverageAssembly, {
      props: {
        rows: [
          { ...coverage[0], count: 99999998, percent: 99.999998 },
          { ...coverage[1], count: 1, percent: 0.000001 },
          { ...coverage[2], count: 1, percent: 0.000001 },
        ],
        total: 100000000,
        available: 99.999998,
        loaded: true,
      },
    })
    expect(w.get('[data-state=missing]').text()).toContain('<0.1%')
    expect(w.get('.stage-count strong').attributes('title')).toBe(
      '99,999,999 次',
    )
  })
  it('keeps independent sources and distinguishes absent from zero', async () => {
    const segments = [
      {
        key: 'standard',
        label: '标准',
        count: 95,
        percent: 59.375,
        color: '#79bdff',
      },
      {
        key: 'unknown',
        label: '未报告',
        count: 65,
        percent: 40.625,
        color: '#a3adb8',
      },
    ]
    const rows = [
      { label: '请求设置', counts: { standard: 95, unknown: 65 }, segments },
      {
        label: '响应确认',
        counts: { standard: 0, unknown: 160 },
        segments: [
          { ...segments[0], count: 0, percent: 0 },
          { ...segments[1], count: 160, percent: 100 },
        ],
      },
      { label: '自动识别', counts: { standard: 95, unknown: 65 }, segments },
    ]
    const w = mount(UsageModeEvidence, {
      props: { rows, total: 160 },
      global: { stubs: { UsageEvidenceRibbon: true } },
    })
    expect(w.findAll('.source-stat strong').map((e) => e.text())).toEqual([
      '59.4%',
      '0.0%',
      '59.4%',
    ])
    expect(w.get('.evidence-hero strong').text()).toBe('0')
    expect(
      w
        .findAll('.evidence-cell[data-state=standard]')
        .map((e) => e.attributes('data-count')),
    ).toEqual(['95', '0', '95'])
    expect(w.text()).toContain('优先响应回执')
    expect(w.text()).toContain('设置是请求意图，不保证服务按该模式执行')
    expect(w.text()).toContain('只有服务返回能确认实际处理模式')
    await w.setProps({
      rows: [rows[0], { ...rows[1], counts: undefined, segments: [] }, rows[2]],
    })
    expect(w.findAll('.source-stat strong')[1].text()).toBe('未取得')
    expect(w.get('.evidence-hero strong').text()).toBe('—')
    expect(
      w
        .findAll('.evidence-source')[1]
        .findAll('.evidence-cell')
        .every((e) => e.attributes('data-count') === undefined),
    ).toBe(true)
    await w.setProps({
      rows: [{ label: '响应确认', counts: undefined, segments: [] }],
    })
    expect(w.text()).toContain('来源尚未提供模式记录')
  })
})
