# 源包隐私边界 / Source Release Privacy Boundary

## 导出范围 / Export Scope

0.2.23 按 `scripts/export-source-release.mjs` 的明确源码/构建/文档白名单导出。`SOURCE_MANIFEST.json` 记录版本、策略、逐文件路径、长度与 SHA-256。源包不是原工作目录的整盘副本。

The 0.2.23 snapshot uses the explicit source/build/document allowlist in `scripts/export-source-release.mjs`. Its manifest records version, policy, paths, lengths and SHA-256 digests. It is not a copy of the developer's whole working directory.

不导出 / Not exported:

- `.git`、提交/分支/作者元数据 / Git history, refs and author metadata.
- 内部交接、审计、计划、真实截图与私人验证产物 / Internal handoffs, audits, plans, real captures and private evidence.
- 本机连接/运行配置、账号文件、凭据、签名私钥 / Machine configuration, account files, credentials and signing private keys.
- 数据库、日志、备份、缓存、依赖及构建目录 / Databases, logs, backups, caches, installed dependencies and build outputs.
- 外部服务、应用或插件可执行文件 / External service/application/plugin binaries.

配置表单、占位 key、合成身份及公开 updater 验签公钥不是运行凭据。导出检查针对发布候选文件，不读取凭据文件或生产数据库。模式扫描不是任意未来内容绝对无秘密的保证。

Source form fields, placeholder keys, synthetic fixture identities and public updater verification keys are not runtime credentials. Checks inspect publication candidates, not user credential files or production databases. Pattern inspection is bounded evidence, not an absolute security guarantee.

## 配图 / Images

`docs/screenshots/` 包含 2026-10-26（Asia/Taipei）从 0.2.23 当前组件生成的虚构 DEMO 图，演示时钟固定在 2026-10-18。账号、地址、会话、用量与金额均为示例。不使用可移除遮罩掩盖真实敏感原图，不伪造外部 CLIProxy 管理实例。

Current-version documentation captures contain invented identities, addresses, sessions, usage and money. Their capture version/date and privacy diagnostics are in `capture-manifest.json`. No real sensitive image is concealed with removable overlays, and no separate CLIProxy management service is fictionalized as a published screenshot.

复现工具使用独立浏览器上下文，仅允许自身回环资源，拒绝未知 IPC，不转发到桌面实例。私人截图和审计证据不属于公开清单。

The reproduction helper uses a fresh browser context, permits its own loopback resources and rejects unknown IPC instead of forwarding to a desktop instance. Private captures and audit evidence are not exported.

## 运行时 / Runtime

应用按启用功能访问本地工具记录、账号/额度、应用账本及已配置服务；价格、汇率、更新和手动检查可涉及网络。源包不含这些用户数据，不表示运行应用无需权限或网络。

Enabled features read local tool records, account/quota state, application ledgers and configured services. Pricing, exchange rates, updates and manual checks may use the network. Excluding user data from the archive does not make the running app data-free or network-free.

真实本地数据诊断仅在显式设置 `USAGE_LEDGER_REAL_DATA_AUDIT=1` 时启用，不应在公共 CI、共享日志或截图任务中开启。主动上游探测/模型调用应在理解费用后执行。

Real-local-data diagnostics require explicit opt-in and must not run in public CI/shared logs/captures. Operators should understand possible charges before initiating upstream probes/model calls.

## 既有仓库历史 / Existing History

干净 ZIP 不会清除既有仓库的分支、旧提交、Release、Actions 或附件。可见性是独立决定，不能仅凭源包检查切换公开。本交付不初始化 Git、不提交/推送/改写历史或更改可见性。

A clean ZIP does not clean an existing repository's branches, commits, releases, Actions or attachments. Visibility is a separate decision; this snapshot alone is not clearance to toggle it. Preparation does not initialize Git, commit, push, rewrite history or change visibility.
