/** Pure geometry: absent and negative amounts never become positive ring ratios. */
export const finiteAmount = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value)

export function billingRatio(value: number | null | undefined, maximum: number): number | null {
  if (!finiteAmount(value) || value < 0 || !Number.isFinite(maximum) || maximum <= 0) return null
  return Math.min(1, value / maximum)
}

export function compositionRatio(cost: number | null | undefined, difference: number | null | undefined, billing: number | null | undefined): number | null {
  if (!finiteAmount(cost) || !finiteAmount(difference) || !finiteAmount(billing) || cost < 0 || difference < 0 || billing <= 0) return null
  const total = cost + difference
  // A source delta is authoritative; do not fabricate a reconciliation or ratio.
  if (!Number.isFinite(total) || total <= 0 || Math.abs(total - billing) > Math.max(1e-8, Math.abs(billing) * 1e-6)) return null
  return cost / total
}

export function modelRingColor(model: string): string {
  const name = model.toLowerCase()
  if (name.includes('claude')) return name.includes('haiku') ? '#F1B998' : '#E79C81'
  if (name.includes('gpt')) return /6\.1|mini|nano/.test(name) ? '#A1E5CA' : '#65D6AF'
  if (name.includes('deepseek')) return /reasoner|r1/.test(name) ? '#9FC8FA' : '#64AEF2'
  if (name.includes('gemini')) return name.includes('flash') ? '#D1BFF6' : '#B2A0ED'
  const palette = ['#82C9C8', '#D5B780', '#BBABC9', '#A5C58E', '#D29FB4']
  let hash = 0
  for (const character of name) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0
  return palette[(hash >>> 0) % palette.length]!
}
