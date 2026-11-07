import type { AccountCostLossStatesResponse } from './accounts'
import type { PricingCatalogStatus } from './channels'

const record = (value: unknown): value is Record<string, unknown> => value != null && typeof value === 'object' && !Array.isArray(value)
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const date = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && Number.isFinite(Date.parse(value))
const currency = (value: unknown) => value === 'USD' || value === 'CNY'

/** This is the local consumer contract for an optional extension, not proof of
 * the extension's producer or bookkeeping algorithm. No missing fact becomes zero.
 */
export function assertCostLossStatesResponse(value: unknown): asserts value is AccountCostLossStatesResponse {
  if (!record(value) || !Array.isArray(value.states) || value.states.some(state => {
    if (!record(state) || !Number.isSafeInteger(state.account_id) || (state.account_id as number) <= 0
      || typeof state.account_name !== 'string' || typeof state.platform !== 'string' || typeof state.account_type !== 'string'
      || !date(state.occurred_at) || !currency(state.currency) || typeof state.active !== 'boolean'
      || typeof state.account_deleted !== 'boolean' || !nonnegative(state.accrued_cost) || !nonnegative(state.net_loss)) return true
    const profile = state.cost_profile
    return !record(profile) || !nonnegative(profile.amount) || !currency(profile.currency)
      || !['hourly', 'daily', 'weekly', 'monthly', 'one_time'].includes(profile.billing_cycle as string)
      || !date(profile.started_at)
  })) throw new Error('Invalid cost-loss response: expected interpretable states, account identities and cost profiles')
}

export function assertPricingCatalogStatus(value: unknown): asserts value is PricingCatalogStatus {
  if (!record(value) || !Number.isSafeInteger(value.model_count) || (value.model_count as number) < 0
    || typeof value.last_updated !== 'string' || typeof value.catalog_source !== 'string'
    || typeof value.configured_source !== 'string' || typeof value.fallback_available !== 'boolean'
    || typeof value.update_interval_hours !== 'number' || !Number.isFinite(value.update_interval_hours) || value.update_interval_hours <= 0) {
    throw new Error('Invalid pricing status response: catalogue counts, sources or refresh interval are unavailable')
  }
}
