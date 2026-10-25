export default {
  cliproxy: {
    nav: {
      dashboard: 'Overview',
      authFiles: 'Auth Files',
      config: 'Config',
      apiKeys: 'API Keys',
      plugins: 'Plugins',
      providerKeys: 'Provider Keys',
      oauthAliases: 'OAuth Aliases',
      oauthLogin: 'OAuth Login',
      runtimeSettings: 'Runtime Settings',
      logs: 'Logs',
      unifiedCost: 'Unified Cost',
    },
    dashboard: {
      title: 'CLI Proxy Overview',
      version: 'Latest Version',
      authFiles: 'Auth Files',
      routing: 'Routing Strategy',
      recentUsage: 'Recent Usage (queue snapshot)',
      noUsage: 'Queue empty (no recent requests, or already popped)',
    },
    authFiles: {
      title: 'Auth Files',
      subtitle: 'Manage CLI Proxy credential files (OAuth/Token/API Key)',
      empty: 'No auth files (configure auth-dir in CLIProxyAPI or upload credentials)',
    },
    config: {
      title: 'Config',
      subtitle: 'Runtime config (read-only) and persisted YAML (editable)',
      yamlHint: 'PUT replaces config entirely; invalid format returns 400, validation failure 422',
    },
    apiKeys: {
      title: 'API Keys',
      subtitle: 'Business API Key (for /v1/* endpoints, see config.yaml api-keys)',
    },
    plugins: {
      title: 'Plugins',
      subtitle: 'Native dynamic library plugins (registered/configured/enabled)',
      empty: 'No plugins (configure plugins.dir in config.yaml)',
    },
    providerKeys: {
      title: 'Provider Keys',
      subtitle: '7 upstream provider credentials (gemini/codex/claude/xai/interactions/openai-compatibility/vertex)',
    },
    oauthAliases: {
      title: 'OAuth Aliases',
      subtitle: 'OAuth model aliases (vertex/aistudio/antigravity/claude/codex/kimi/xai) and excluded models',
    },
    runtimeSettings: {
      title: 'Runtime Settings',
      subtitle: 'Single-value runtime switches and parameters (GET view / PUT modify)',
    },
    oauthLogin: {
      title: 'OAuth Login',
      subtitle: 'Initiate OAuth for upstream providers; credentials written to auth-files',
      start: 'Authorize',
    },
    logs: {
      title: 'Logs',
      subtitle: 'Runtime logs (cursor pagination) and error request log files',
      main: 'Runtime Logs',
      errorLogs: 'Error Request Log Files',
    },
  },
}
