import './usageI18nFixture'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import UsageLivePanel from '../UsageLivePanel.vue'
import type { LiveWindow, MonitorSnapshot } from '@/api/usageMonitor'
import { Chart } from 'vue-chartjs'
import { usageColors, usageModelColor } from '../usageChartPalette'

vi.mock('vue-chartjs', () => ({ Chart: { name: 'MockChart', props: ['data', 'options', 'plugins', 'type'], template: '<canvas />' } }))

const window = (seconds: number, tokens: number, complete = true): LiveWindow => ({ seconds, observedOutputTokens: tokens, outputTokensPerSecond: complete ? tokens / seconds : null, coveredMs: complete ? seconds * 1000 : 30000, complete, sourceComplete: complete })
function snapshot(): MonitorSnapshot {
  const totals = { inputTokens: 0, outputTokens: 600, totalTokens: 600, cacheReadTokens: 0, cacheWriteTokens: 0, requestCount: 1, pricedCostUsd: 0, unpricedRequests: 1, incompleteRequests: 0, cacheHitRatio: null, outputTokensPerSecond: 10 }
  return { collectedAtMs: 100000, refreshMs: 2000, rateWindowSeconds: 60, totals, sessions: [], activeSessions: [], sessionCount: 0, sources: [], collecting: false, error: null,
    live: { sampledAtMs: 100000, collectionUpdatedAtMs: 100000, basis: 'collector_observed_output', windows: [window(60, 600), window(300, 600, false)], byTool: [{ tool: 'codex', model: null, sessionKey: null, windows: [window(60, 600), window(300, 600, false)] }], byModel: [{ tool: 'codex', model: 'gpt-6-astra', sessionKey: null, windows: [window(60, 600), window(300, 600, false)] }], bySession: [], timeline: [], timelineByTool: { codex: [] }, peakMinuteOutputTokens: null, sourceCoverageIncomplete: true, unavailableTools: ['antigravity'] },
  }
}

describe('UsageLivePanel', () => {
  it('indexes session windows once with first-match semantics and reacts to missing/null keys and new snapshots', async () => {
    const data = snapshot()
    data.rateSessions = Array.from({ length: 24 }, (_, index) => ({ key: `codex:${index}`, tool: 'codex', id: String(index), parentId: null, project: null, model: 'gpt-6-astra', status: 'active', startedAtMs: 1, updatedAtMs: 100000, totals: data.totals }))
    data.rateSessions.push({ ...data.rateSessions[0], key: 'missing', id: 'missing' })
    data.live!.bySession = data.rateSessions.slice(0, 24).map(session => ({ tool: 'codex', model: null, sessionKey: session.key, windows: [window(60, 60)] }))
    data.live!.bySession.push({ ...data.live!.bySession[0], windows: [window(60, 0)] }, { tool: 'codex', model: null, sessionKey: null, windows: [window(60, 600)] })
    let reads = 0
    for (const row of data.live!.bySession) {
      const key = row.sessionKey
      Object.defineProperty(row, 'sessionKey', { configurable: true, enumerable: true, get() { reads++; return key } })
    }
    const expected = data.rateSessions.map(session => data.live!.bySession.find(row => row.sessionKey === session.key))
    expect(reads).toBe(326)
    reads = 0
    const wrapper = mount(UsageLivePanel, { props: { snapshot: data, tool: null } })
    expect(expected.filter(row => row?.windows[0].observedOutputTokens)).toHaveLength(24)
    expect(wrapper.findAll('.rate-session')).toHaveLength(24)
    expect(wrapper.findAll('.rate-session strong').every(row => row.text().includes('1.00'))).toBe(true)
    reads = 0
    await wrapper.get('[aria-label="速度统计时段"]').findAll('button')[1].trigger('click')
    expect(reads).toBe(26)
    expect(wrapper.find('.rate-session').exists()).toBe(false)
    reads = 0
    await wrapper.get('[aria-label="速度统计时段"]').findAll('button')[0].trigger('click')
    expect(reads).toBe(26)
    expect(wrapper.findAll('.rate-session')).toHaveLength(24)
    await wrapper.setProps({ tool: 'claude' })
    expect(wrapper.find('.rate-session').exists()).toBe(false)
    const next = snapshot()
    next.rateSessions = data.rateSessions
    next.live!.bySession = [{ tool: 'codex', model: null, sessionKey: 'codex:0', windows: [window(60, 120)] }]
    await wrapper.setProps({ snapshot: next, tool: null })
    expect(wrapper.findAll('.rate-session')).toHaveLength(1)
    expect(wrapper.get('.rate-session strong').text()).toContain('2.00')
    await wrapper.setProps({ snapshot: null })
    expect(wrapper.find('.rate-session').exists()).toBe(false)
    wrapper.unmount()
  })

  it('does not turn missing activity data into zero counts, but keeps loaded empty data distinct', async () => {
    const wrapper = mount(UsageLivePanel, { props: { snapshot: null, tool: null } })
    expect(wrapper.findAll('.hour-statistics strong').map(row => row.text())).toEqual(Array(4).fill('尚未取得'))
    await wrapper.setProps({ snapshot: snapshot() })
    expect(wrapper.get('.hour-statistics').text()).toContain('尚未取得')
    const data = snapshot()
    data.live!.recordedTimeline = []
    await wrapper.setProps({ snapshot: data })
    expect(wrapper.get('.hour-statistics').text()).not.toContain('尚未取得')
    expect(wrapper.get('.minute-chart').text()).toContain('最近60分钟没有用量记录')
    data.live!.recordedTimeline = [{ startMs: 0, endMs: 60000, outputTokens: null, knownOutputTokens: 0, requestCount: 2, unknownOutputRequests: 2 }]
    await wrapper.setProps({ snapshot: { ...data } })
    expect(wrapper.get('.hour-statistics strong').text()).toBe('输出未报告')
    expect(wrapper.get('.minute-chart').getComponent(Chart).props('data').datasets[0].data).toEqual([null])
    expect(wrapper.get('.minute-chart').getComponent(Chart).props('data').datasets[1].data).toEqual([2])
  })

  it('keeps unknown model values visible without interpreting their drill as all models', async () => {
    const data = snapshot()
    data.live!.byModel[0].model = null
    const wrapper = mount(UsageLivePanel, { props: { snapshot: data, tool: null } })
    const legend = wrapper.get('.spectrum-legend button')
    expect(legend.attributes('disabled')).toBeDefined()
    expect(legend.text()).toContain('10.00')
    const options = wrapper.get('.model-spectrum').getComponent(Chart).props('options')
    options.onClick(null, [{ datasetIndex: 0, index: 0 }])
    expect(wrapper.emitted('model')).toBeUndefined()
    await wrapper.get('[aria-label="速率分组"]').findAll('button')[1].trigger('click')
    expect(wrapper.get('.rate-session').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.tool-color-key').exists()).toBe(false)
  })

  it('uses saved request timestamps for history instead of collector receipt, without filling unknown minutes', () => {
    const data = snapshot()
    data.live!.recordedTimeline = [
      { startMs: 0, endMs: 60000, outputTokens: 120, knownOutputTokens: 120, requestCount: 2, unknownOutputRequests: 0 },
      { startMs: 60000, endMs: 120000, outputTokens: null, knownOutputTokens: 0, requestCount: 0, unknownOutputRequests: 0 },
      { startMs: 120000, endMs: 180000, outputTokens: 0, knownOutputTokens: 0, requestCount: 1, unknownOutputRequests: 0 },
    ]
    const wrapper = mount(UsageLivePanel, { props: { snapshot: data, tool: null }, global: { stubs: { Chart: true } } })
    expect(wrapper.get('.minute-chart').getComponent(Chart).props('data').datasets[0].data).toEqual([120, null, 0])
    expect(wrapper.get('.minute-chart').getComponent(Chart).props('data').datasets[1].data).toEqual([2, null, 1])
    expect(wrapper.get('.hour-statistics').text()).toContain('120')
    expect(wrapper.findAll('.minute-presence .present')).toHaveLength(2)
    expect(wrapper.get('.coverage-note').text()).toContain('停机期间补采的记录会回到原时间')
    expect(wrapper.get('.global-rate').text()).toContain('10.00')
  })
  it('keeps known totals visible with a coverage warning and exposes per-model attribution', async () => {
    const wrapper = mount(UsageLivePanel, { props: { snapshot: snapshot(), tool: null }, global: { stubs: { Bar: true } } })
    expect(wrapper.get('.global-rate strong').text()).toContain('10.00')
    expect(wrapper.get('.model-spectrum').getComponent(Chart).props('data').datasets.map((row: { data: number[] }) => row.data)).toEqual([[600], [600]])
    expect(wrapper.get('.global-rate').text()).toContain('部分工具暂时读不到')
    await wrapper.get('[aria-label="速率分组"]').findAll('button')[1].trigger('click')
    expect(wrapper.get('[aria-label="各模型输出均速"]').text()).toContain('gpt-6-astra')
    await wrapper.get('.rate-session').trigger('click')
    expect(wrapper.emitted('model')?.[0]).toEqual(['codex', 'gpt-6-astra'])
    await wrapper.get('[aria-label="速度统计时段"]').findAll('button')[1].trigger('click')
    expect(wrapper.get('.global-rate strong').text()).toContain('2.00')
    expect(wrapper.get('.global-rate').text()).toContain('600 输出')
    expect(wrapper.get('.global-rate').text()).toContain('记录不完整')
  })

  it('keeps each model color when its rank changes and separates the output area from request counts', async () => {
    const data = snapshot()
    data.live!.byModel.push({ tool: 'codex', model: 'gpt-6.1-sol', sessionKey: null, windows: [window(60, 1200)] })
    data.live!.recordedTimeline = [{ startMs: 0, endMs: 60000, outputTokens: 600, knownOutputTokens: 600, requestCount: 2, unknownOutputRequests: 0 }]
    const wrapper = mount(UsageLivePanel, { props: { snapshot: data, tool: null } })
    const colorsByModel = () => Object.fromEntries(wrapper.findAll('.spectrum-legend button').map(button => [button.get('.spectrum-model-name').text(), (button.element as HTMLElement).style.getPropertyValue('--model-color')]))
    expect(colorsByModel()).toEqual({ 'gpt-6.1-sol': usageModelColor('gpt-6.1-sol'), 'gpt-6-astra': usageModelColor('gpt-6-astra') })
    const chart = wrapper.get('.minute-chart').getComponent(Chart).props('data')
    expect(chart.datasets[0]).toMatchObject({ type: 'line', fill: 'origin', cubicInterpolationMode: 'monotone', yAxisID: 'y', spanGaps: true })
    expect(chart.datasets[0].backgroundColor).toBeTypeOf('function')
    expect(chart.datasets[1]).toMatchObject({ type: 'line', yAxisID: 'requests' })
    expect(chart.datasets[1].fill).not.toBeTruthy()
    expect(chart.datasets[1].borderColor).toBe(usageColors.requests)
    data.live!.byModel[0].windows = [window(60, 1800)]
    await wrapper.setProps({ snapshot: { ...data } })
    expect(wrapper.find('.spectrum-legend button').text()).toContain('gpt-6-astra')
    expect(colorsByModel()).toEqual({ 'gpt-6.1-sol': usageModelColor('gpt-6.1-sol'), 'gpt-6-astra': usageModelColor('gpt-6-astra') })
  })

  it('anchors mountain colors to the measured peak and preserves zero, gaps, partial output and the tool scope', async () => {
    const data = snapshot()
    const minute = (startMs: number, knownOutputTokens: number, requestCount: number, unknownOutputRequests = 0) => ({ startMs, endMs: startMs + 60000, knownOutputTokens, outputTokens: unknownOutputRequests ? null : knownOutputTokens, requestCount, unknownOutputRequests })
    data.live!.recordedTimeline = [minute(0, 0, 1), minute(60000, 0, 0), minute(120000, 40, 2, 1), minute(180000, 100, 1)]
    data.live!.recordedTimelineByTool = { codex: [minute(0, 20, 1)] }
    const wrapper = mount(UsageLivePanel, { props: { snapshot: data, tool: null } })
    const chart = () => wrapper.get('.minute-chart').getComponent(Chart)
    expect(chart().props('type')).toBe('line')
    expect(chart().props('data').datasets[0].data).toEqual([0, null, 40, 100])
    expect(chart().props('data').datasets[1].data).toEqual([1, null, 2, 1])
    expect(chart().props('data').datasets.every((dataset: {spanGaps: boolean}) => dataset.spanGaps)).toBe(true)
    expect(wrapper.get('.hour-statistics').text()).toContain('分钟输出峰值（已知）100')
    expect(wrapper.get('.minute-presence .partial').exists()).toBe(true)
    const addColorStop = vi.fn()
    const createLinearGradient = vi.fn(() => ({ addColorStop }))
    const getPixelForValue = vi.fn((value: number) => 300 - value * 2)
    chart().props('data').datasets[0].borderColor({ chart: { ctx: { createLinearGradient }, chartArea: {}, scales: { y: { getPixelForValue } } } })
    expect(createLinearGradient).toHaveBeenCalledWith(0, 300, 0, 100)
    expect(addColorStop.mock.calls).toEqual([[0, usageColors.input], [0.5, usageColors.cache], [1, usageColors.output]])
    await wrapper.setProps({ tool: 'codex' })
    expect(chart().props('data').datasets[0].data).toEqual([20])
    expect(wrapper.get('.hour-statistics strong').text()).toContain('20')
  })

  it('uses the model speed scale and updates it with the selected window', async () => {
    const data = snapshot()
    data.live!.byModel = [{ tool: 'codex', model: 'gpt-6-astra', sessionKey: null, windows: [window(60, 900), window(300, 15000)] }, { tool: 'codex', model: 'gpt-6.1-sol', sessionKey: null, windows: [window(60, 300), window(300, 3000)] }]
    data.live!.byTool[0].windows = [window(60, 1200), window(300, 18000)]
    const wrapper = mount(UsageLivePanel, { props: { snapshot: data, tool: null } })
    expect(wrapper.get('.speed-scale').text()).toContain('满刻度 20')
    expect(wrapper.get('.speed-scale').text()).not.toContain('工具')
    await wrapper.get('[aria-label="速度统计时段"]').findAll('button')[1].trigger('click')
    expect(wrapper.get('.speed-scale').text()).toContain('满刻度 50')
  })

  it('retains tiny model shares in the model and speed rings without a platform legend', async () => {
    const data = snapshot()
    data.live!.windows = [window(60, 10000)]
    data.live!.byModel = [
      { tool: 'codex', model: 'gpt-6-astra', sessionKey: null, windows: [window(60, 9999)] },
      { tool: 'claude', model: 'claude-sonnet', sessionKey: null, windows: [window(60, 1)] },
    ]
    data.live!.byTool = data.live!.byModel.map(row => ({ ...row, model: null }))
    const wrapper = mount(UsageLivePanel, { props: { snapshot: data, tool: null } })
    expect(wrapper.find('.tool-color-key').exists()).toBe(false)
    expect(wrapper.get('.model-spectrum').text()).not.toContain('Claude Code')
    expect(wrapper.get('.model-spectrum').text()).not.toContain('Codex')
    expect(wrapper.get('.spectrum-legend').text()).toContain('占已记录输出 <0.1%')
    const chart = wrapper.get('.model-spectrum').getComponent(Chart).props('data')
    expect(chart.datasets.map((row: { data: number[] }) => row.data)).toEqual([[9999, 1], [9999, 1]])
    expect(chart.datasets.map((row: { label: string }) => row.label)).toEqual(['速度', '模型'])
    await wrapper.get('.spectrum-legend').findAll('button')[1].trigger('click')
    expect(wrapper.emitted('model')?.[0]).toEqual(['claude', 'claude-sonnet'])
  })

  it('merges equal model names across tools and highlights the fastest confirmed speed in red', async () => {
    const data = snapshot()
    data.live!.windows = [window(60, 1500)]
    data.live!.byModel = [
      { tool: 'codex', model: 'gpt-6.1-sol', sessionKey: null, windows: [window(60, 600)] },
      { tool: 'claude', model: 'gpt-6.1-sol', sessionKey: null, windows: [window(60, 600)] },
      { tool: 'codex', model: 'gpt-6-luna', sessionKey: null, windows: [window(60, 300)] },
    ]
    data.live!.byTool = [
      { tool: 'codex', model: null, sessionKey: null, windows: [window(60, 900)] },
      { tool: 'claude', model: null, sessionKey: null, windows: [window(60, 600)] },
    ]
    const wrapper = mount(UsageLivePanel, { props: { snapshot: data, tool: null } })
    const section = wrapper.get('.model-spectrum')
    expect(section.findAll('.spectrum-legend button')).toHaveLength(2)
    expect(section.text()).not.toContain('Codex')
    expect(section.text()).not.toContain('Claude Code')
    expect(section.get('.orbit-label strong').text()).toBe('25.00')
    expect(section.getComponent(Chart).props('data').datasets[0].data).toEqual([1200, 300])
    const rows = section.findAll('.spectrum-legend button')
    expect(rows[0].text()).toContain('20.00')
    expect((rows[0].element as HTMLElement).style.getPropertyValue('--speed-color')).toBe(usageColors.danger)
    expect((rows[1].element as HTMLElement).style.getPropertyValue('--speed-color')).not.toBe(usageColors.danger)
    expect(rows[0].get('.fastest-label').text()).toBe('最快')
    await rows[0].trigger('click')
    expect(wrapper.emitted('model')?.[0]).toEqual([null, 'gpt-6.1-sol'])
    await wrapper.setProps({ tool: 'codex' })
    expect(section.getComponent(Chart).props('data').datasets[0].data).toEqual([600, 300])
    expect(section.get('.orbit-label strong').text()).toBe('15.00')
  })

  it('retains the known merged lower bound without claiming a complete or fastest speed', () => {
    const data = snapshot()
    data.live!.windows = [window(60, 900)]
    data.live!.byModel.push({ tool: 'claude', model: 'gpt-6-astra', sessionKey: null, windows: [window(60, 300, false)] })
    const wrapper = mount(UsageLivePanel, { props: { snapshot: data, tool: null } })
    const row = wrapper.get('.spectrum-legend button')
    expect(row.text()).toContain('900 输出 Token')
    expect(row.text()).toContain('15.00')
    expect(row.text()).toContain('只读到部分记录')
    expect(row.find('.fastest-label').exists()).toBe(false)
    expect((row.element as HTMLElement).style.getPropertyValue('--speed-color')).not.toBe(usageColors.unknown)
    expect(wrapper.get('.speed-scale').text()).toContain('满刻度 20')
    const tooltip = wrapper.get('.model-spectrum').getComponent(Chart).props('options').plugins.tooltip.callbacks.label
    expect(tooltip({ dataIndex: 0, datasetIndex: 0 })).toContain('15.00 Token/秒 · 只读到部分记录')
  })

  it('hides a quiet session and shows it again when output resumes without changing global totals', async () => {
    const data = snapshot()
    data.rateSessions = [{ key: 'codex:a', tool: 'codex', id: 'a', parentId: null, project: null, model: 'gpt-6-astra', status: 'running', startedAtMs: 1, updatedAtMs: 100000, totals: data.totals }]
    data.live!.bySession = [{ tool: 'codex', model: null, sessionKey: 'codex:a', windows: [window(60, 600)] }]
    const wrapper = mount(UsageLivePanel, { props: { snapshot: data, tool: null } })
    expect(wrapper.get('.rate-session strong').text()).toContain('10.00 Token/秒')
    const quiet = snapshot()
    quiet.rateSessions = data.rateSessions
    quiet.live!.windows = [window(60, 0)]
    quiet.live!.bySession = [{ ...data.live!.bySession[0], windows: [window(60, 0)] }]
    quiet.live!.byModel[0].windows = [window(60, 0)]
    await wrapper.setProps({ snapshot: quiet })
    expect(wrapper.get('.global-rate strong').text()).toBe('暂无输出')
    expect(wrapper.get('.global-rate').text()).toContain('这段时间还没有新的输出记录')
    expect(wrapper.find('.rate-session').exists()).toBe(false)
    expect(wrapper.get('.rate-sessions .empty').text()).toBe('这段时间还没有输出记录')
    expect(wrapper.get('.spectrum-legend b').text()).toBe('暂无输出')
    expect(wrapper.find('.fastest-label').exists()).toBe(false)
    expect(wrapper.get('.orbit-label strong').text()).toBe('暂无输出')
    expect(wrapper.find('.orbit-label>small').exists()).toBe(false)
    await wrapper.setProps({ snapshot: data })
    expect(wrapper.get('.rate-session strong').text()).toContain('10.00 Token/秒')
  })

  it('does not keep a no-output session visible just because an older request had speed', async () => {
    const data = snapshot()
    const timestampMs = 60000
    data.rateSessions = [{ key: 'codex:a', tool: 'codex', id: 'a', parentId: null, project: null, model: null, status: 'active', startedAtMs: 1, updatedAtMs: 100000, totals: data.totals,
      requestSpeed: { latest: { requestId: 'old', timestampMs, outputTokens: 100, durationMs: 2000, outputTokensPerSecond: 50, basis: 'measured_request', startedAtMs: null, completedAtMs: null, ttftMs: null, streamingDurationMs: null, streamingTokensPerSecond: null }, last10: { basis: null, validSamples: 0, totalSamples: 0, outputTokens: 0, durationMs: 0, outputTokensPerSecond: null }, byBasis: [] },
      latestCompletedTurn: { timing: { turnId: 'turn', startedAtMs: 1, completedAtMs: 1000, durationMs: 999, ttftMs: null, basis: 'whole_turn' }, outputTokens: 900, outputTokensPerSecond: 900 },
    }]
    data.live!.bySession = [{ tool: 'codex', model: null, sessionKey: 'codex:a', windows: [window(60, 0, false)] }]
    const wrapper = mount(UsageLivePanel, { props: { snapshot: data, tool: null } })
    expect(wrapper.find('.rate-session').exists()).toBe(false)
    expect(wrapper.find('.recent-request-speed').exists()).toBe(false)
    data.live!.bySession[0].windows = [window(60, 600, false)]
    await wrapper.setProps({ snapshot: { ...data } })
    expect(wrapper.get('.rate-session strong').text()).toContain('10.00')
    expect(wrapper.find('.recent-request-speed').exists()).toBe(false)
  })

  it('uses the selected window for session visibility and retains completed positive contributors', async () => {
    const data = snapshot()
    data.rateSessions = ['active', 'idle', 'completed'].map((status, index) => ({
      key: `codex:${index}`, tool: 'codex', id: String(index), parentId: index ? '0' : null,
      project: null, model: 'gpt-6-astra', status, startedAtMs: 1, updatedAtMs: 100000, totals: data.totals,
    }))
    data.live!.bySession = data.rateSessions.map((session, index) => ({
      tool: 'codex', model: null, sessionKey: session.key,
      windows: [window(60, index === 2 ? 60 : 0, index !== 1), window(300, index === 0 ? 600 : index === 2 ? 60 : 0, false)],
    }))
    const wrapper = mount(UsageLivePanel, { props: { snapshot: data, tool: null } })
    expect(wrapper.findAll('.rate-session')).toHaveLength(1)
    expect(wrapper.get('.rate-session .usage-state').text()).toContain('已完成')
    await wrapper.get('.rate-session').trigger('click')
    expect(wrapper.emitted('session')?.[0]?.[0]).toBe('codex:2')
    await wrapper.get('[aria-label="速度统计时段"]').findAll('button')[1].trigger('click')
    expect(wrapper.findAll('.rate-session')).toHaveLength(2)
    await wrapper.setProps({ tool: 'claude' })
    expect(wrapper.find('.rate-session').exists()).toBe(false)
    expect(data.rateSessions).toHaveLength(3)
  })

  it('keeps loading, legacy rates and unavailable long windows distinct without invented coverage', async () => {
    const wrapper = mount(UsageLivePanel, { props: { snapshot: null, tool: null } })
    expect(wrapper.get('.global-rate strong').text()).toBe('读取中')
    expect(wrapper.get('.global-rate strong').find('small').exists()).toBe(false)
    const data = snapshot()
    delete data.live
    await wrapper.setProps({ snapshot: data })
    expect(wrapper.get('.global-rate strong').text()).toBe('10.00 Token/秒')
    expect(wrapper.get('.global-rate').text()).toContain('旧记录未注明实际记录了多长时间')
    await wrapper.get('[aria-label="速度统计时段"]').findAll('button')[1].trigger('click')
    expect(wrapper.get('.global-rate strong').text()).toBe('暂无样本')
    expect(wrapper.get('.global-rate strong').find('small').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('统计中')
  })

  it('qualifies complete-time samples whose source coverage is incomplete', () => {
    const data = snapshot()
    data.live!.windows[0].sourceComplete = false
    data.live!.byModel[0].windows[0].sourceComplete = false
    const wrapper = mount(UsageLivePanel, { props: { snapshot: data, tool: null } })
    expect(wrapper.get('.global-rate strong').text()).toContain('10.00')
    expect(wrapper.get('.global-rate').text()).toContain('部分工具的数据还读不到')
    expect(wrapper.text()).not.toContain('≥')
    expect(wrapper.get('.spectrum-legend b').text()).toContain('10.00')
    expect(wrapper.find('.fastest-label').exists()).toBe(false)
  })
})
