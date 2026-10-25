export default {
  cliproxy: {
    nav: {
      dashboard: '概览',
      authFiles: '认证文件',
      config: '配置',
      apiKeys: 'API Keys',
      plugins: '插件',
      providerKeys: '提供商 Key',
      oauthAliases: 'OAuth 别名',
      oauthLogin: 'OAuth 登录',
      runtimeSettings: '运行时设置',
      logs: '日志',
      unifiedCost: '三端汇总',
    },
    dashboard: {
      title: 'CLI Proxy 概览',
      version: '最新版本',
      authFiles: '认证文件',
      routing: '路由策略',
      recentUsage: '最近用量(队列快照)',
      noUsage: '队列为空(无最近请求,或已被弹出)',
    },
    authFiles: {
      title: '认证文件',
      subtitle: '管理 CLI Proxy 的凭据文件(OAuth/Token/API Key)',
      empty: '无认证文件(在 CLIProxyAPI 配置 auth-dir 或上传凭据)',
    },
    config: {
      title: '配置',
      subtitle: '运行时配置(只读)与持久化 YAML(可编辑)',
      yamlHint: 'PUT 整体替换配置;格式错误返 400,校验失败返 422',
    },
    apiKeys: {
      title: 'API Keys',
      subtitle: '业务 API Key(/v1/* 端点认证用,见 config.yaml api-keys)',
    },
    plugins: {
      title: '插件',
      subtitle: '原生动态库插件(已注册/已配置/启用状态)',
      empty: '无插件(在 config.yaml 配置 plugins.dir)',
    },
    providerKeys: {
      title: '提供商 Key',
      subtitle: '7 类上游提供商凭据(gemini/codex/claude/xai/interactions/openai-compatibility/vertex)',
    },
    oauthAliases: {
      title: 'OAuth 别名',
      subtitle: 'OAuth 模型别名(vertex/aistudio/antigravity/claude/codex/kimi/xai)与排除模型',
    },
    runtimeSettings: {
      title: '运行时设置',
      subtitle: '单值运行时开关与参数(GET 展示 / PUT 修改)',
    },
    oauthLogin: {
      title: 'OAuth 登录',
      subtitle: '为上游提供商发起 OAuth 授权,获取凭据后写入 auth-files',
      start: '授权',
    },
    logs: {
      title: '日志',
      subtitle: '运行日志(cursor 分页)与错误请求日志文件',
      main: '运行日志',
      errorLogs: '错误请求日志文件',
    },
  },
}
