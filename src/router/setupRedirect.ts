export function resolveCompletedSetupRedirectPath(
  isAuthenticated: boolean,
  isAdmin: boolean,
  connectionType?: string,
): string {
  if (!isAuthenticated) {
    return '/login'
  }

  if (!isAdmin) {
    return '/dashboard'
  }

  // cliproxy 连接的 setup 完成后回 cliproxy 首页,避免二次跳转(互斥守卫兜底)
  return connectionType === 'cliproxy' ? '/cliproxy/dashboard' : '/admin/dashboard'
}
