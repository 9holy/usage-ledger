import './usageI18nFixture'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import UsageTurnTimeline from '../UsageTurnTimeline.vue'
import type { MonitorSessionDetail } from '@/api/usageMonitor'

type Turn = NonNullable<MonitorSessionDetail['turns']>[number]
function turn(id: string, input: number, output: number): Turn {
  return { id, startedAtMs: 10000, updatedAtMs: 90000, totals: { inputTokens: input, outputTokens: output, totalTokens: input + output, cacheReadTokens: input / 2, cacheWriteTokens: 0, requestCount: 1, pricedCostUsd: 0, unpricedRequests: 1, incompleteRequests: 0, cacheHitRatio: 0.5, outputTokensPerSecond: 0 } }
}

describe('UsageTurnTimeline', () => {
  it('compares turns using one token scale and keeps selection tied to the real id', async () => {
    const rows = [turn('large-turn', 80, 20), turn('small-turn', 30, 20)]
    const wrapper = mount(UsageTurnTimeline, { props: { turns: rows, selected: 'small-turn', loading: false } })
    const buttons = wrapper.findAll('.turn-choice')
    expect(buttons[0].get('.input-volume').attributes('style')).toContain('width: 80%')
    expect(buttons[0].get('.output-volume').attributes('style')).toContain('width: 20%')
    expect(buttons[1].get('.input-volume').attributes('style')).toContain('width: 30%')
    expect(buttons[1].attributes('aria-pressed')).toBe('true')
    await buttons[0].trigger('click')
    expect(wrapper.emitted('select')?.[0]).toEqual(['large-turn'])
    await wrapper.get('.parent-link').trigger('click')
    expect(wrapper.emitted('select')?.[1]).toEqual([null])
  })

  it('does not turn usage-record time gaps into duration and marks incomplete usage', () => {
    const missing = turn('partial', 40, 10)
    missing.totals.incompleteRequests = 1
    const known = turn('timed', 80, 20)
    known.timing = { turnId: 'timed', startedAtMs: 1000, completedAtMs: 62000, durationMs: 61000, ttftMs: null, basis: 'codex_task_complete' }
    const wrapper = mount(UsageTurnTimeline, { props: { turns: [missing, known, turn('zero', 0, 0)], selected: null, loading: false } })
    const rows = wrapper.findAll('.turn-choice')
    expect(rows[0].text()).toContain('耗时未报告')
    expect(rows[0].text()).toContain('首条用量记录')
    expect(rows[0].get('.turn-volume').attributes('aria-label')).toContain('仅含已记录部分')
    expect(rows[1].text()).toContain('1分1秒')
    expect(rows[1].text()).toContain('轮次开始')
    expect(rows[2].get('.input-volume').attributes('style')).toContain('width: 0%')
    expect(wrapper.html()).not.toContain('NaN')
  })
})
