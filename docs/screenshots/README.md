# Documentation Screenshots

Current 0.2.24 production Vue components, captured on **2026-10-26 (Asia/Taipei)**:
14 English views (the documentation default) and the same 14 views in Chinese.
Every image uses invented DEMO data, with the fixture clock fixed at
**2026-10-18 16:00 Asia/Taipei**. No saved connections, credentials, local usage
logs, financial databases, or private desktop screenshots are read or published.

These are not real-accounting screenshots and do not prove production amounts,
data correctness, cost-trend/request-quality visual acceptance, or reference parity.
Version, capture time, locales, dimensions, privacy checks, and canvas checks are in
[capture-manifest.json](capture-manifest.json).

中文：以下为同一组 14 个当前组件视图的中英配图，全部采用虚构 DEMO 数据；
实际截图日期为 2026-10-26，演示时钟固定为 2026-10-18。不是实际账单、真实账号截图，
也不是费用趋势/请求质量效果图的视觉验收，不证明真实数据或金额正确。

## Gallery

Captured at 1600px wide, full page. English links come first; existing Chinese
filenames are preserved.

| View | English | 中文 |
| --- | --- | --- |
| Monitor: live overview | [English](monitor-overview-en.png) | [中文](monitor-overview.png) |
| Monitor: usage analysis | [English](monitor-analysis-en.png) | [中文](monitor-analysis.png) |
| Monitor: session details | [English](monitor-sessions-en.png) | [中文](monitor-sessions.png) |
| Monitor: session/subagent family | [English](monitor-session-family-en.png) | [中文](monitor-session-family.png) |
| Monitor: collection and pricing | [English](monitor-sources-en.png) | [中文](monitor-sources.png) |
| Connections: saved sources | [English](connect-saved-en.png) | [中文](connect-saved.png) |
| Connections: new connection | [English](connect-new-en.png) | [中文](connect-new.png) |
| Cost workspace: asset overview | [English](cost-overview-en.png) | [中文](cost-overview.png) |
| Cost workspace: account ranking | [English](cost-upstreams-en.png) | [中文](cost-upstreams.png) |
| Cost workspace: channel costs | [English](cost-oauth-en.png) | [中文](cost-oauth.png) |
| Cost workspace: API access | [English](cost-api-en.png) | [中文](cost-api.png) |
| Cost workspace: unified summary | [English](cost-unified-en.png) | [中文](cost-unified.png) |
| Cost workspace: cost ledger | [English](cost-finance-en.png) | [中文](cost-finance.png) |
| Cost workspace: data sources and history | [English](cost-governance-en.png) | [中文](cost-governance.png) |

## Reproduce

Reproduce from the repository root:

```powershell
node scripts/capture-readme-screenshots.mjs
```

The script uses the project's installed Vite/Vue and no new runtime dependency.
It requires an existing `playwright-core` installation in your tooling environment.
Alternatively, set `PLAYWRIGHT_MODULE` to that package's directory. Set
`BROWSER_EXECUTABLE` to a Chromium browser executable when not using the default
Windows Microsoft Edge location. Missing tooling stops with setup guidance.
It starts only an isolated loopback Vite preview, rejects unknown IPC, blocks
requests outside that preview, uses a fresh headless browser context per locale
with the locale stored before mount, and closes both
browser and server on completion or failure. Production source and dist are untouched.

The monitor screenshots cover the four real tabs plus session/subagent details.
Connect covers saved and new connection states. The cost workspace screenshots
cover its five primary views, the financial ledger, and data management.
The CLIProxy management iframe is intentionally omitted: its contents belong to
a separately connected live service and must not be replaced with fictional UI.
API access shows the legitimate no-key state rather than displaying a key.

Fixture module: `docs/demo/readme-fixtures.js`.

The demo clock is fixed at 2026-10-18 16:00 Asia/Taipei. The monitor illustrates
120 requests with 96 known-mode and 24 unknown-mode requests; group totals are
derived from the same proportions. Some source capabilities remain deliberately
unavailable in the fixture rather than presenting invented measurements as facts.
