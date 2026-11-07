import { describe, expect, it, vi } from 'vitest'
import { loadUsdCnyExchangeRate } from '../exchangeRate'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

describe('USD/CNY exchange-rate synchronization', () => {
  it('parses the provider UTC date instead of truncating an RFC 2822 timestamp', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      base_code: 'USD', time_last_update_utc: 'Fri, 06 Nov 2026 00:02:31 +0000', rates: { CNY: 6.9 },
    }), { status: 200 }))
    await expect(loadUsdCnyExchangeRate({ fetcher, storage: memoryStorage() })).resolves.toMatchObject({ rate: 6.9, rateDate: '2026-11-06' })
  })

  it.each([{ base_code: 'EUR' }, { base: 'USD', quote: 'JPY' }])('rejects a rate for the wrong currency pair: %j', async (pair) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...pair, rate: 7.5 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ base: 'USD', quote: 'CNY', rate: 6.8 }), { status: 200 }))
    await expect(loadUsdCnyExchangeRate({ fetcher, storage: memoryStorage() })).resolves.toMatchObject({ rate: 6.8, source: 'network' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('uses and caches a valid network reference rate', async () => {
    const storage = memoryStorage()
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      date: '2026-08-05',
      base: 'USD',
      quote: 'CNY',
      rate: 7.1842,
    }), { status: 200 }))

    const network = await loadUsdCnyExchangeRate({ fetcher, storage, now: Date.UTC(2026, 7, 6) })
    const cached = await loadUsdCnyExchangeRate({
      fetcher: vi.fn().mockRejectedValue(new Error('network should not be called')),
      storage,
      now: Date.UTC(2026, 7, 6, 1),
    })

    expect(network).toMatchObject({ rate: 7.1842, rateDate: '2026-08-05', source: 'network' })
    expect(cached).toMatchObject({ rate: 7.1842, rateDate: '2026-08-05', source: 'cache' })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('falls back to the configured baseline when synchronization fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(loadUsdCnyExchangeRate({
      fetcher: vi.fn().mockRejectedValue(new Error('offline')),
      storage: memoryStorage(),
    })).resolves.toMatchObject({ rate: 6.8, source: 'fallback' })
  })

  it('tries the compact endpoint when the primary endpoint is unavailable', async () => {
    const storage = memoryStorage()
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('primary unavailable'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        amount: 1,
        base: 'USD',
        date: '2026-08-06',
        rates: { CNY: 6.7491 },
      }), { status: 200 }))

    await expect(loadUsdCnyExchangeRate({ fetcher, storage })).resolves.toMatchObject({
      rate: 6.7491,
      source: 'network',
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
