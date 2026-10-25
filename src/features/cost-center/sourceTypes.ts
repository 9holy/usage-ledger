import type { Account, AdminUsageLog, ModelStat } from '@/types'

export type CostAccountId = number | string

/** Remote Sub2API IDs stay numeric; local sources retain their opaque identity. */
export type SourceAccount = Omit<Account, 'id'> & { id: CostAccountId }

/** Some local sources cannot establish inclusive input or reasoning/output overlap. */
export type SourceModelStat = Omit<ModelStat, 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_creation_tokens' | 'total_tokens'> & {
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_creation_tokens: number | null
  total_tokens: number | null
}

export type SourceAdminUsageLog = Omit<AdminUsageLog, 'account_id'> & {
  account_id: CostAccountId | null
}
