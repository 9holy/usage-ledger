import { normalizeBillingCycle, normalizeCurrency } from '@/features/cost-center/model'

/** Validate only keys whose ownership and consumer contract are known.
 * Unresolved legacy keys remain untouched; their presence is not an account binding.
 * Keep the original values for a lossless read/write (the cost model normalizes units).
 */
export function validateLocalCostProfiles(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid local cost profile file: expected an object')
  }
  for (const [id, candidate] of Object.entries(value)) {
    const multiplier = id === '__cockpit_cost_multiplier__'
    if (!multiplier && !/^(cockpit|cliproxy):/.test(id)) continue
    const profile = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      ? candidate as Record<string, unknown> : null
    const amount = profile?.amount
    if (!profile || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || (multiplier && amount === 0)) {
      throw new Error('Invalid local cost profile: amount must be a finite non-negative number (a multiplier must be positive)')
    }
    if (multiplier) continue
    if (!normalizeCurrency(profile.currency) || !normalizeBillingCycle(profile.billing_cycle)
      || typeof profile.started_at !== 'string' || !profile.started_at.trim()
      || !Number.isFinite(new Date(profile.started_at).getTime())) {
      throw new Error('Invalid local cost profile: currency, billing cycle or start time is unreadable')
    }
  }
}
