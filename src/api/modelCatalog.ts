import { invoke } from '@tauri-apps/api/core'
import type { MonitorCostEstimate } from './usageMonitor'

export interface ModelCatalogStatus {
  available: boolean
  revision: string | null
  checkedAtMs: number | null
  fetchedAtMs: number | null
  etag: string | null
  refreshing: boolean
  error: string | null
  modelCount: number
  sourceUrl: string
}

export interface ModelCatalogQuoteInput {
  id: string
  model: string
  /** Exact catalog provider identity, never a guessed route alias. */
  provider?: string
  actualMode?: string
  requestedMode?: string
  timestampMs?: number
  /** Inclusive input: uncached + cache read + cache write. */
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cacheWrite5mTokens?: number
  cacheWrite1hTokens?: number
  contextTokens?: number
  aggregate?: boolean
  contextMin?: number
  contextMax?: number
  contextTier?: string
  timeBand?: 'peak' | 'off_peak'
}

export interface ModelCatalogQuote {
  id: string
  cost: MonitorCostEstimate
}

export function getModelCatalogStatus(): Promise<ModelCatalogStatus> {
  return invoke('model_catalog_status')
}

export function refreshModelCatalog(): Promise<ModelCatalogStatus> {
  return invoke('model_catalog_refresh')
}

export function quoteModelCatalogBatch(items: ModelCatalogQuoteInput[]): Promise<ModelCatalogQuote[]> {
  return items.length ? invoke('model_catalog_quote_batch', { items }) : Promise.resolve([])
}
