import { expect, it } from 'vitest'
import { usageColors, usageModelColor, usageToolColor, usageModeColor, usagePercentLabel, usageIntensityColor, usageIntensityColors } from '../usageChartPalette'

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)!.map(value => Number.parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

it('maps numeric intensity continuously without changing zero or missing-data semantics', () => {
  expect([0, 5, 10].map(value => usageIntensityColor(value, 10))).toEqual([...usageIntensityColors])
  expect(usageIntensityColor(1, 10)).not.toBe(usageIntensityColor(8, 10))
  expect(usageIntensityColor(0, 0)).toBe(usageIntensityColors[0])
})

it('does not round a real remainder to zero or a near-full share to full', () => {
  expect([0, 0.04, 0.1, 8, 99.9, 99.96, 100].map(usagePercentLabel)).toEqual(['0.0%', '<0.1%', '0.1%', '8.0%', '99.9%', '>99.9%', '100.0%'])
})

it('keeps category identity independent of order, spelling case and missing identity', () => {
  const models = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'claude-sonnet', 'gemini-pro', 'deepseek-chat']
  expect(new Set(models.map(usageModelColor)).size).toBe(models.length)
  for (const model of [...models, 'another-provider-model'].reverse()) {
    expect(usageModelColor(model.toUpperCase())).toBe(usageModelColor(model))
  }
  expect(usageModelColor(null)).toBe(usageColors.unknown)
  expect(usageModeColor('unknown')).toBe(usageColors.unknown)
  expect(usageModeColor('fast')).not.toBe(usageModeColor('standard'))
  expect(new Set(['codex', 'claude', 'antigravity', 'deepseek-harness'].map(usageToolColor)).size).toBe(4)
})

it('keeps semantic labels and model colors readable on all monitor surfaces', () => {
  const colors = [...Object.values(usageColors), ...['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'claude', 'gemini', 'deepseek', 'unlisted'].map(usageModelColor)]
  for (const color of colors) {
    for (const background of ['#101413', '#171c1b', '#202725']) {
      expect((luminance(color) + 0.05) / (luminance(background) + 0.05), `${color} on ${background}`).toBeGreaterThanOrEqual(4.5)
    }
  }
})
