export const BILLING_MODE_TOKEN = 'token'
export const BILLING_MODE_PER_REQUEST = 'per_request'
export const BILLING_MODE_IMAGE = 'image'
export const BILLING_MODE_VIDEO = 'video'

export function getBillingModeLabel(mode: string | null | undefined, t: (key: string) => string): string {
  switch (mode) {
    case BILLING_MODE_PER_REQUEST: return t('admin.usage.billingModePerRequest')
    case BILLING_MODE_IMAGE: return t('admin.usage.billingModeImage')
    case BILLING_MODE_VIDEO: return t('admin.usage.billingModeVideo')
    default: return t('admin.usage.billingModeToken')
  }
}

export function getBillingModeBadgeClass(mode: string | null | undefined): string {
  switch (mode) {
    case BILLING_MODE_PER_REQUEST: return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
    case BILLING_MODE_IMAGE: return 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-300'
    case BILLING_MODE_VIDEO: return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
    default: return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
  }
}

interface ImageBillingRow {
  /** null = 该数据源不记录图片张数(cockpit 的 codex-api 日志回退路径)。
   *  谓词一律用 `?? 0` 兜底:语义是"没有图片计数 ⇒ 不按图片计费",不是"实测零张图"。 */
  image_count: number | null
  billing_mode?: string | null
  /** null = 该数据源不掌握成本。仅在 imageUnitPrice 里参与除法,已有 `?? 0` 兜底。 */
  total_cost: number | null
}

export function isImageUsage(row: Pick<ImageBillingRow, 'image_count' | 'billing_mode'> | null | undefined): boolean {
  return (row?.image_count ?? 0) > 0 && row?.billing_mode !== BILLING_MODE_TOKEN && row?.billing_mode !== BILLING_MODE_VIDEO
}

export function getDisplayBillingMode(row: Pick<ImageBillingRow, 'billing_mode' | 'image_count'> | null | undefined): string | null | undefined {
  // Explicit video/token modes always win over image_count heuristics.
  if (row?.billing_mode === BILLING_MODE_VIDEO || row?.billing_mode === BILLING_MODE_TOKEN) {
    return row.billing_mode
  }
  if ((row?.image_count ?? 0) > 0 && !row?.billing_mode) {
    return BILLING_MODE_IMAGE
  }
  return row?.billing_mode
}

export function imageUnitPrice(row: Pick<ImageBillingRow, 'image_count' | 'total_cost'> | null): number {
  // 先归一成非空局部量:TS 不穿透 `??` 表达式做窄化,直接读 row.image_count 仍是 number|null。
  const count = row?.image_count ?? 0
  if (count <= 0) return 0
  const total = row?.total_cost ?? 0
  const price = total / count
  return Number.isFinite(price) ? price : 0
}
