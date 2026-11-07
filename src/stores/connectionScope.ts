import { getActiveConnection } from '@/api/url'

/** Cache identity excludes rotating JWTs and includes credentials that identify static-key sessions. */
export function connectionScopeKey(): string {
  const connection = getActiveConnection()
  const credential = connection?.type === 'sub2api' && connection.authMode === 'login'
    ? null
    : [connection?.apiKey, connection?.secretKey]
  // This key is kept in memory only. Changing a static key can change the account
  // or its permissions even when the saved connection ID and URL remain identical.
  return JSON.stringify(connection
    ? [connection.id, connection.type, connection.baseUrl, connection.costServiceUrl, connection.authMode, connection.email, credential]
    : null)
}
