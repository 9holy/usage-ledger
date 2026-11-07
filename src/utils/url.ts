/**
 * 验证并规范化 URL
 * 默认只接受绝对 URL（以 http:// 或 https:// 开头），可按需允许相对路径
 * @param value 用户输入的 URL
 * @returns 规范化后的 URL，如果无效则返回空字符串
 */
type SanitizeOptions = {
  allowRelative?: boolean
  allowDataUrl?: boolean
}

export function sanitizeUrl(value: string, options: SanitizeOptions = {}): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  if (options.allowRelative && trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return trimmed
  }

  // 允许 data:image/ 开头的 data URL（仅限图片类型）
  if (options.allowDataUrl && trimmed.startsWith('data:image/')) {
    return trimmed
  }

  // 只接受绝对 URL，不使用 base URL 来避免相对路径被解析为当前域名
  // 检查是否以 http:// 或 https:// 开头
  if (!trimmed.match(/^https?:\/\//i)) {
    return ''
  }

  try {
    const parsed = new URL(trimmed)
    const protocol = parsed.protocol.toLowerCase()
    if (protocol !== 'http:' && protocol !== 'https:') {
      return ''
    }
    return parsed.toString()
  } catch {
    return ''
  }
}

/** Validate an untrusted browser navigation target. QR payloads and the app's
 * explicitly constructed native deep links are not browser navigation URLs. */
export function sanitizeNavigationUrl(
  value: unknown,
  options: Pick<SanitizeOptions, 'allowRelative'> = {},
): string {
  if (typeof value !== 'string') return ''
  // Browsers strip some control characters and interpret backslashes as URL
  // separators. Reject these before checking a root-relative path or scheme.
  if (value.includes('\\')) return ''
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127) return ''
  }
  // Tauri uses hash history: router.resolve() returns a same-document route.
  const trimmed = value.trim()
  if (options.allowRelative && trimmed.startsWith('#/')) return trimmed
  const sanitized = sanitizeUrl(value, options)
  if (!sanitized || sanitized.startsWith('/')) return sanitized
  const parsed = new URL(sanitized)
  return parsed.username || parsed.password ? '' : sanitized
}
