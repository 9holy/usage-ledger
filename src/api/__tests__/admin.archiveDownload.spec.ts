import { beforeEach, describe, expect, it, vi } from 'vitest'

const get = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({ apiClient: { get } }))

import { getDownloadURL } from '@/api/admin/backup'

describe('admin backup download URLs', () => {
  beforeEach(() => {
    get.mockReset()
  })

  it('preserves signed HTTPS query parameters for a single backup', async () => {
    const url = 'https://storage.example/backups/daily.sql.gz?X-Amz-Credential=user%2F20261107%2Fregion%2Fs3%2Faws4_request&X-Amz-Signature=a1b2&response-content-disposition=attachment%3B%20filename%3D%22daily.sql.gz%22'
    get.mockResolvedValue({ data: { url } })

    await expect(getDownloadURL('daily')).resolves.toEqual({ url })
    expect(get).toHaveBeenCalledWith('/admin/backups/daily/download-url')
  })

  it('preserves every valid HTTP(S) part, its order, and its metadata', async () => {
    const response = {
      url: 'https://storage.example/backups/manifest?signature=a%2Fb%2Bc%3D',
      parts: [
        { index: 1, size_bytes: 100, url: 'https://storage.example/backups/part-1?signature=a%2Fb%2Bc%3D' },
        { index: 2, size_bytes: 50, url: 'http://storage.example/backups/part-2?signature=d%2Be%3D' },
      ],
    }
    get.mockResolvedValue({ data: response })

    await expect(getDownloadURL('multipart')).resolves.toEqual(response)
  })

  it('accepts an empty top-level URL placeholder when valid parts provide the downloads', async () => {
    const response = {
      url: '',
      parts: [{ index: 1, size_bytes: 100, url: 'https://storage.example/backups/part-1' }],
    }
    get.mockResolvedValue({ data: response })

    await expect(getDownloadURL('multipart')).resolves.toEqual(response)
  })

  it.each([
    'javascript:alert(document.domain)',
    'data:text/html,<script>alert(document.domain)</script>',
    '//storage.example/backup',
    '/backups/local',
  ])('rejects an unsafe or non-absolute single download URL: %s', async (url) => {
    get.mockResolvedValue({ data: { url } })

    await expect(getDownloadURL('unsafe')).rejects.toThrow('Invalid backup download URL')
  })

  it.each([
    'javascript:alert(document.domain)',
    'data:text/html,<script>alert(document.domain)</script>',
  ])('rejects the entire multipart response when any part is unsafe: %s', async (url) => {
    get.mockResolvedValue({
      data: {
        url: 'https://storage.example/backups/fallback.sql.gz',
        parts: [
          { index: 1, size_bytes: 100, url: 'https://storage.example/backups/part-1' },
          { index: 2, size_bytes: 50, url },
        ],
      },
    })

    await expect(getDownloadURL('multipart')).rejects.toThrow('Invalid backup download URL')
  })

  it('rejects an unsafe top-level URL even when every part is safe', async () => {
    get.mockResolvedValue({
      data: {
        url: 'javascript:alert(1)',
        parts: [{ index: 1, size_bytes: 100, url: 'https://storage.example/backups/part-1' }],
      },
    })

    await expect(getDownloadURL('multipart')).rejects.toThrow('Invalid backup download URL')
  })

  it('rejects malformed multipart data instead of exposing an incomplete backup', async () => {
    get.mockResolvedValueOnce({ data: { parts: 'https://storage.example/backups/part-1' } })
    await expect(getDownloadURL('multipart')).rejects.toThrow('Invalid backup download parts')

    get.mockResolvedValueOnce({ data: { parts: [{ index: 1, size_bytes: 100 }] } })
    await expect(getDownloadURL('multipart')).rejects.toThrow('Invalid backup download URL')
  })
})
