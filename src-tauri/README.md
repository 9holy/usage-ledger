# Native desktop layer

This directory contains the Tauri 2 / Rust window, tray, usage collectors, SQLite ledger, and native query interfaces. See the [project README](../README.md) for application features, screenshots, privacy, and licensing.

## Windows (existing target)

Run from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm exec tauri dev
pnpm exec tauri build --config src-tauri/tauri.local.conf.json
```

The existing Windows bundle target remains NSIS. The local Tauri override disables updater artifact generation; it does not publish an update. Outputs: `src-tauri/target/release/console2api.exe` and `src-tauri/target/release/bundle/nsis/`. Building requires Windows C++ Build Tools and the Microsoft Edge WebView2 Runtime. To install the [v0.2.37 Windows package](https://github.com/9holy/usage-ledger/releases/download/v0.2.37/Usage-Ledger_0.2.37_windows_x64-setup.exe), back up important data, quit the existing app from its tray menu, and run the new installer over the existing installation. Keep the existing data; do not uninstall or delete the ledger to upgrade.

## macOS (Apple Silicon and Intel)

The macOS configuration sets macOS 13.0 as the minimum and supports a universal `arm64`/`x86_64` app/DMG build, but the v0.2.37 release carries separate native-architecture preview DMGs. The universal default is not validated; CI validation uses macOS 15. The separate macOS configuration leaves the existing Windows NSIS target unchanged. A Mac host is required; these commands do not cross-compile the Mac bundle from Windows.

```sh
pnpm install --frozen-lockfile
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm desktop:test:mac
pnpm desktop:build:mac
```

`desktop:test:mac` runs a frontend type check, focused frontend tests, and Rust tests with isolated temporary data directories. It does not launch the GUI or make real-account calls. `desktop:build:mac` uses an ad-hoc signature and disables updater artifact creation; the build script checks both architectures, signature integrity, and DMG integrity. Ad-hoc signing is not Developer ID signing or notarization. See the v0.2.37 release's [BUILD-INFO.json](https://github.com/9holy/usage-ledger/releases/download/v0.2.37/BUILD-INFO.json) for source/build provenance; the release includes separate native-architecture preview DMGs. CI validation uses macOS 15; the configured macOS 13 minimum and default universal target are not validated. Finder/Dock, full GUI, and real-account checks have not been checked. See the [macOS build and verification guide](../docs/platforms/macos.md).

## Data and release boundaries

The application preserves its existing data identity. On macOS the ledger defaults to `~/.local/share/2api-console`; source integrations use their existing home-directory locations, including `~/.codex`, `~/.claude`, `~/.dsh`, `~/.antigravity_cockpit`, and `~/.cli-proxy-api`. Required database migrations and evidence-based repairs run on startup without relocating these directories. CLIProxyAPI usage is read natively from SQLite, without Python. To upgrade on Mac, quit the app, open the DMG for your processor, and replace the application in `/Applications` while retaining its data.

Antigravity application/IDE discovery on macOS is best-effort, limited to known current-user bundle locations and IPv4-loopback language-server process/listener metadata. It is reverse-engineered rather than an official integration contract and has not had real-Mac end-to-end validation. Third-party services are configured in the application and are not bundled.

The main [Repository checks workflow](../.github/workflows/ci.yml) publishes a versioned Release from `main` only after frontend, headless, dependency, and all three native platform jobs succeed. Windows x64, macOS Apple Silicon, and macOS Intel each require native tests, an installer build, and package/startup verification. `fix/**` builds upload Actions artifacts without publishing. The separate [Mac preview workflow](../.github/workflows/macos-test.yml) still runs on `test/macos-*` branches and does not publish a Release. See [0.2.37 release notes](../docs/release/0.2.37.md), `BUILD-INFO.json`, and the linked Actions run for evidence; a pending run is not a pass.

v0.2.37 downloads are manual only; no updater `.sig` artifacts or `latest.json` automatic-update feed are published. Windows packages have no Authenticode publisher certificate. Mac packages use ad-hoc signing; Developer ID signing and notarization are not configured. Complete GUI, Finder/Dock, and real-account workflows remain outside the automated verification.

## 原生桌面层

此目录包含 Tauri 2 / Rust 窗口、托盘、用量采集器、SQLite 账本与原生查询接口。应用功能、配图、隐私和许可请见[项目说明](../README.zh-CN.md)。

### Windows（现有目标）

在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm exec tauri dev
pnpm exec tauri build --config src-tauri/tauri.local.conf.json
```

现有 Windows 打包目标仍为 NSIS。本地 Tauri 覆盖配置会关闭应用内自动更新签名产物生成，但不会发布更新。产物：`src-tauri/target/release/console2api.exe` 和 `src-tauri/target/release/bundle/nsis/`。构建需要 Windows C++ Build Tools 与 Microsoft Edge WebView2 Runtime。安装 [v0.2.37 Windows 包](https://github.com/9holy/usage-ledger/releases/download/v0.2.37/Usage-Ledger_0.2.37_windows_x64-setup.exe)前先备份重要数据，从托盘退出旧应用，再运行新安装包覆盖现有安装。保留原数据，不要为了更新先卸载或删除账本。

### macOS（Apple Silicon 与 Intel）

macOS 配置的最低系统版本为 macOS 13.0，并支持 `arm64`/`x86_64` 通用 app/DMG 构建；但 v0.2.37 Release 提供的是分别构建的原生架构预览 DMG。默认通用目标尚未验证，CI 验证使用 macOS 15。macOS 使用单独配置，现有 Windows NSIS 目标保持不变。必须在 Mac 上运行这些命令；不能从 Windows 交叉编译 Mac 应用包。

```sh
pnpm install --frozen-lockfile
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm desktop:test:mac
pnpm desktop:build:mac
```

`desktop:test:mac` 会运行前端类型检查、定向前端测试及使用临时隔离数据目录的 Rust 测试；不会打开 GUI，也不会调用真实账号。`desktop:build:mac` 使用临时签名并关闭应用内自动更新产物生成；构建脚本会检查两个架构、签名完整性及 DMG 完整性。临时签名不是 Developer ID 签名或公证。源码和构建来源见 v0.2.37 Release 附带的 [BUILD-INFO.json](https://github.com/9holy/usage-ledger/releases/download/v0.2.37/BUILD-INFO.json)；Release 提供分别构建的原生架构预览 DMG。CI 验证使用 macOS 15；配置的 macOS 13 最低版本和默认通用目标尚未验证。Finder/Dock、完整 GUI 和真实账号检查尚未检查。请见[macOS 构建与验证指南](../docs/platforms/macos.md)。

### 数据与发布边界

应用保留现有数据身份。macOS 上应用账本默认位于 `~/.local/share/2api-console`；各数据源沿用现有主目录位置，包括 `~/.codex`、`~/.claude`、`~/.dsh`、`~/.antigravity_cockpit` 和 `~/.cli-proxy-api`。必要的数据库迁移和有证据的修复在启动时执行，不搬移这些目录。CLIProxyAPI 用量由原生 SQLite 读取，不需要 Python。Mac 升级时退出应用，打开匹配处理器的 DMG，替换 `/Applications` 中的应用并保留数据。

macOS 上的 Antigravity 应用/IDE 自动发现属于尽力而为，仅限当前用户已知的应用包位置，以及 IPv4 回环语言服务器进程/监听信息。此行为由逆向分析实现，并非官方集成契约；尚未进行真实 Mac 端到端验证。第三方服务需在应用内配置，不会随仓库打包。

主 [Repository checks 工作流](../.github/workflows/ci.yml)只有在前端、headless、依赖检查及三个原生平台任务全部成功后，才从 `main` 发布对应版本的 Release。Windows x64、macOS Apple Silicon、macOS Intel 均需完成原生测试、安装包构建及包和启动验证；`fix/**` 构建只上传 Actions 产物。独立的 [Mac 预览工作流](../.github/workflows/macos-test.yml)仍由 `test/macos-*` 分支触发，不发布 Release。证据见 [0.2.37 发布说明](../docs/release/0.2.37.md)、`BUILD-INFO.json` 及关联 Actions 记录；等待中的任务不代表通过。

v0.2.37 仅提供手动下载，不发布 updater `.sig` 产物或 `latest.json` 自动更新清单。Windows 未配置 Authenticode 发布者证书；Mac 使用 ad-hoc 签名，未配置 Developer ID 签名或公证。完整 GUI、Finder/Dock 与真实账号流程不在自动化验证范围内。
