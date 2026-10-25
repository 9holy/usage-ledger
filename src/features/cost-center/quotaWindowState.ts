import type { UsageProgress } from '@/types'

/** Source evidence for one quota period, not the most recently updated account. */
export interface QuotaWindowReading {
  utilization?: number | null
  resets_at?: string | null
  reset_time?: string | null
  recorded_at?: string | null
  snapshot_source?: 'recorded' | 'live'
  snapshot_stale?: boolean
  snapshot_error?: string | null
}

export type RecordedQuotaProgress = UsageProgress & QuotaWindowReading

export function quotaTimestamp(value: number | null | undefined): string | null {
  return typeof value === 'number' && value > 0 && Number.isFinite(new Date(value).getTime())
    ? new Date(value).toISOString() : null
}

function validTimestamp(value: string | null | undefined): string | null {
  return value && Number.isFinite(new Date(value).getTime()) && new Date(value).getTime() > 0 ? value : null
}

export function quotaWindowState(
  reading: QuotaWindowReading | null | undefined,
  nowMs = Date.now(),
  fallbackUpdatedAt: string | null = null,
) {
  const utilization = reading?.utilization
  const value = typeof utilization === 'number' && Number.isFinite(utilization) && utilization >= 0 ? utilization : null
  const resetAt = validTimestamp(reading?.resets_at ?? reading?.reset_time)
  const updatedAt = validTimestamp(reading && 'recorded_at' in reading ? reading.recorded_at : fallbackUpdatedAt)
  const resetState = resetAt == null ? 'unknown' : new Date(resetAt).getTime() > nowMs ? 'future' : 'expired'
  return {
    utilization: value,
    resetAt,
    updatedAt,
    resetState,
    historical: reading?.snapshot_source === 'recorded' || reading?.snapshot_stale === true || !!reading?.snapshot_error || resetState === 'expired',
    sourceError: reading?.snapshot_error ?? null,
  }
}
