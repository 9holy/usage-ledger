// Keep the same data meaning across DOM, SVG and canvas charts.
export const usageColors = {
  input: '#79bdff',
  cache: '#50d9b4',
  output: '#f4c467',
  requests: '#bea1f4',
  value: '#e5be72',
  forecast: '#a5b9f5',
  success: '#85d49a',
  warning: '#f0ad62',
  danger: '#f28f85',
  unknown: '#a3adb8',
} as const

export const usageCoverageColors = { known: usageColors.success, unknown: '#c9a66b', missing: usageColors.danger } as const

export const usageIntensityColors = [usageColors.input, usageColors.cache, usageColors.output] as const
const intensityRgb = usageIntensityColors.map(color => color.slice(1).match(/../g)!.map(channel => Number.parseInt(channel, 16)))

export function usageIntensityColor(value: number, maximum: number): string {
  const position = maximum > 0 ? Math.max(0, Math.min(1, value / maximum)) * 2 : 0
  const index = Math.min(1, Math.floor(position))
  const mix = position - index
  return '#' + intensityRgb[index].map((channel, i) => Math.round(channel + (intensityRgb[index + 1][i] - channel) * mix).toString(16).padStart(2, '0')).join('')
}

export const usageChartStyle = {
  ...Object.fromEntries(Object.entries(usageColors).map(([key, value]) => [`--usage-${key}`, value])),
  '--usage-intensity': `linear-gradient(90deg, ${usageIntensityColors.join(', ')})`,
}

export { formatUsagePercent as usagePercentLabel } from '@/utils/usageFormat'

const modelFamilies: [RegExp, string][] = [
  [/astra/i, '#b9e55a'], [/sol/i, '#79adff'], [/luna/i, '#f2aa77'],
  [/claude/i, '#c4a5f2'], [/gemini/i, '#50d9b4'], [/deepseek/i, '#7bcbe3'],
]
const otherModels = ['#8eb8ff', '#e8a9cd', '#76d8b5', '#e9c879', '#bda8ef', '#8bcdd7']

export function usageModelColor(model: string | null | undefined): string {
  if (!model) return usageColors.unknown
  const family = modelFamilies.find(([pattern]) => pattern.test(model))
  if (family) return family[1]
  let hash = 0
  for (const char of model.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return otherModels[hash % otherModels.length]
}

export function usageToolColor(tool: string | null): string {
  return ({ codex: '#79bdff', claude: '#e8a9cd', antigravity: '#50d9b4', 'deepseek-harness': '#7bcbe3' } as Record<string, string>)[tool || ''] ?? usageColors.unknown
}

export function usageModeColor(mode: string): string {
  return ({ standard: usageColors.input, fast: '#c4a5f2', ultrafast: '#e8a9cd', flex: usageColors.cache, scale: '#7bcbe3' } as Record<string, string>)[mode] ?? usageColors.unknown
}

