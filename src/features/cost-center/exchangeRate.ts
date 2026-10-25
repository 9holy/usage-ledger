import { CNY_PER_USD } from './model'

export type ExchangeRateSource = 'network' | 'cache' | 'fallback' | 'override'

export interface UsdCnyExchangeRate {
  rate: number
  rateDate: string | null
  fetchedAt: string | null
  source: ExchangeRateSource
}

interface FrankfurterRateResponse {
  date?: unknown
  base?: unknown
  base_code?: unknown
  quote?: unknown
  rate?: unknown
  rates?: Record<string, unknown>
  /** er-api 返回的更新时间(UTC 字符串) */
  time_last_update_utc?: unknown
}

// 汇率端点:er-api 在国内可达,frankfurter 作备用(er-api 不可达时尝试)
const ENDPOINTS = [
  'https://open.er-api.com/v6/latest/USD',
  'https://api.frankfurter.dev/v2/rate/USD/CNY',
  'https://api.frankfurter.app/latest?from=USD&to=CNY',
]
const CACHE_KEY = 'sub2api.cost-center.usd-cny-rate.v2'
const OVERRIDE_KEY = 'sub2api.cost-center.usd-cny-rate.user-override'
const CACHE_TTL_MS = 12 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 8_000

function isValidRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 4 && value <= 10
}

function parseCachedRate(storage: Storage | null, now: number): UsdCnyExchangeRate | null {
  if (!storage) return null
  try {
    const cached = JSON.parse(storage.getItem(CACHE_KEY) || '') as Partial<UsdCnyExchangeRate>
    const fetchedAt = typeof cached.fetchedAt === 'string' ? Date.parse(cached.fetchedAt) : Number.NaN
    if (!isValidRate(cached.rate) || !Number.isFinite(fetchedAt) || now - fetchedAt > CACHE_TTL_MS) return null
    return {
      rate: cached.rate,
      rateDate: typeof cached.rateDate === 'string' ? cached.rateDate : null,
      fetchedAt: cached.fetchedAt ?? null,
      source: 'cache',
    }
  } catch {
    return null
  }
}

function persistRate(storage: Storage | null, value: UsdCnyExchangeRate): void {
  if (!storage) return
  try {
    storage.setItem(CACHE_KEY, JSON.stringify(value))
  } catch {
    // Storage can be disabled; the in-memory value remains usable for this session.
  }
}

/** 用户手动覆盖汇率(优先级最高,网络失败时不走 7.2 fallback)。 */
function parseUserOverride(storage: Storage | null): UsdCnyExchangeRate | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(OVERRIDE_KEY)
    if (!raw) return null
    const rate = Number(JSON.parse(raw))
    if (!isValidRate(rate)) return null
    return { rate, rateDate: null, fetchedAt: null, source: 'override' }
  } catch {
    return null
  }
}

/** 同步读取用户覆盖汇率(不请求网络):有覆盖返回覆盖值,否则 null。
 *  reload 时用此函数决定汇率:有 override 用 override,否则固定 CNY_PER_USD。 */
export function getStoredUserOverrideRate(): UsdCnyExchangeRate | null {
  const storage = typeof window === 'undefined' ? null : window.localStorage
  return parseUserOverride(storage)
}

/** 保存用户手动设置的汇率(写 localStorage override key,最高优先级)。 */
export function saveUserOverrideRate(rate: number): boolean {
  if (!isValidRate(rate)) return false
  try {
    localStorage.setItem(OVERRIDE_KEY, JSON.stringify(rate))
    return true
  } catch {
    return false
  }
}

/** 清除用户覆盖(恢复网络/缓存/fallback 自动汇率)。 */
export function clearUserOverrideRate(): void {
  try { localStorage.removeItem(OVERRIDE_KEY) } catch { /* noop */ }
}

export async function loadUsdCnyExchangeRate(options: {
  fetcher?: typeof fetch
  storage?: Storage | null
  now?: number
} = {}): Promise<UsdCnyExchangeRate> {
  const fetcher = options.fetcher ?? fetch
  const storage = options.storage === undefined
    ? (typeof window === 'undefined' ? null : window.localStorage)
    : options.storage
  const now = options.now ?? Date.now()
  // 用户手动覆盖优先级最高(网络失败时不走 7.2 fallback)
  const overridden = parseUserOverride(storage)
  if (overridden) return overridden
  const cached = parseCachedRate(storage, now)
  if (cached) return cached

  try {
    let lastError: unknown = null
    for (const endpoint of ENDPOINTS) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const response = await fetcher(endpoint, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`exchange-rate request returned ${response.status}`)
        const payload = await response.json() as FrankfurterRateResponse
        const rate = payload.rate ?? payload.rates?.CNY
        // 端点固定 USD(base_code/base 校验,缺字段也接受——端点本身已锁定 USD)
        const baseOk = payload.base === 'USD' || payload.base_code === 'USD' || payload.base == null
        if (!baseOk || !isValidRate(rate)) {
          throw new Error('exchange-rate response is invalid')
        }
        const rateDate = typeof payload.time_last_update_utc === 'string'
          ? payload.time_last_update_utc.slice(0, 10)
          : typeof payload.date === 'string' ? payload.date : null
        const result: UsdCnyExchangeRate = {
          rate,
          rateDate,
          fetchedAt: new Date(now).toISOString(),
          source: 'network',
        }
        persistRate(storage, result)
        return result
      } catch (error) {
        lastError = error
      } finally {
        clearTimeout(timeout)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('exchange-rate request failed')
  } catch (error) {
    console.warn('[cost-center] USD/CNY reference rate unavailable; using fallback', error)
    return {
      rate: CNY_PER_USD,
      rateDate: null,
      fetchedAt: null,
      source: 'fallback',
    }
  }
}
