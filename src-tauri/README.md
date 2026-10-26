# Native desktop layer

This directory contains the Tauri 2 / Rust window, tray, usage collectors, SQLite ledger, and native query interfaces. See the [project README](../README.md) for application features, screenshots, privacy, and licensing.

## Windows (existing target)

Run from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm exec tauri dev
pnpm exec tauri build --config src-tauri/tauri.local.conf.json
```

The existing Windows bundle target remains NSIS. The local Tauri override disables updater artifact generation; it does not publish an update. Outputs: `src-tauri/target/release/console2api.exe` and `src-tauri/target/release/bundle/nsis/`. Building requires Windows C++ Build Tools and the Microsoft Edge WebView2 Runtime.

## macOS (Apple Silicon and Intel)

The macOS configuration sets macOS 13.0 as the minimum and supports a universal `arm64`/`x86_64` app/DMG build, but the v0.2.25 release carries separate native-architecture preview DMGs. The universal default is not validated; CI validation uses macOS 15. The separate macOS configuration leaves the existing Windows NSIS target unchanged. A Mac host is required; these commands do not cross-compile the Mac bundle from Windows.

```sh
pnpm install --frozen-lockfile
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm desktop:test:mac
pnpm desktop:build:mac
```

`desktop:test:mac` runs a frontend type check, focused frontend tests, and Rust tests with isolated temporary data directories. It does not launch the GUI or make real-account calls. `desktop:build:mac` uses an ad-hoc signature and disables updater artifact creation; the build script checks both architectures, signature integrity, and DMG integrity. Ad-hoc signing is not Developer ID signing or notarization. See the v0.2.25 release's [BUILD-INFO.json](https://github.com/9holy/usage-ledger/releases/download/v0.2.25/BUILD-INFO.json) for source/build provenance; the release includes separate native-architecture preview DMGs. CI validation uses macOS 15; the configured macOS 13 minimum and default universal target are not validated. Finder/Dock, full GUI, and real-account checks have not been checked. See the [macOS build and verification guide](../docs/platforms/macos.md).

## Data and release boundaries

The application preserves its existing data identity. On macOS the ledger defaults to `~/.local/share/2api-console`; source integrations use their existing home-directory locations, including `~/.codex`, `~/.claude`, `~/.dsh`, `~/.antigravity_cockpit`, and `~/.cli-proxy-api`. No history migration is performed. CLIProxyAPI usage is read natively from SQLite, without Python.

Antigravity application/IDE discovery on macOS is best-effort, limited to known current-user bundle locations and IPv4-loopback language-server process/listener metadata. It is reverse-engineered rather than an official integration contract and has not had real-Mac end-to-end validation. Third-party services are configured in the application and are not bundled.

For the public `9holy/usage-ledger` repository, the Mac CI workflow runs only on pushes to `test/macos-*`; pushing `main` does not start it. It builds and tests but does not publish a GitHub Release. v0.2.25 downloads are manual only; no automatic updates are provided by this release. Ad-hoc packaging does not require a paid Apple Developer account, but distribution with Developer ID signing and notarization is a separate step.

## 原生桌面层

此目录包含 Tauri 2 / Rust 窗口、托盘、用量采集器、SQLite 账本与原生查询接口。应用功能、配图、隐私和许可请见[项目说明](../README.zh-CN.md)。

### Windows（现有目标）

在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm exec tauri dev
pnpm exec tauri build --config src-tauri/tauri.local.conf.json
```

现有 Windows 打包目标仍为 NSIS。本地 Tauri 覆盖配置会关闭应用内自动更新签名产物生成，但不会发布更新。产物：`src-tauri/target/release/console2api.exe` 和 `src-tauri/target/release/bundle/nsis/`。构建需要 Windows C++ Build Tools 与 Microsoft Edge WebView2 Runtime。

### macOS（Apple Silicon 与 Intel）

macOS 配置的最低系统版本为 macOS 13.0，并支持 `arm64`/`x86_64` 通用 app/DMG 构建；但 v0.2.25 Release 提供的是分别构建的原生架构预览 DMG。默认通用目标尚未验证，CI 验证使用 macOS 15。macOS 使用单独配置，现有 Windows NSIS 目标保持不变。必须在 Mac 上运行这些命令；不能从 Windows 交叉编译 Mac 应用包。

```sh
pnpm install --frozen-lockfile
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm desktop:test:mac
pnpm desktop:build:mac
```

`desktop:test:mac` 会运行前端类型检查、定向前端测试及使用临时隔离数据目录的 Rust 测试；不会打开 GUI，也不会调用真实账号。`desktop:build:mac` 使用临时签名并关闭应用内自动更新产物生成；构建脚本会检查两个架构、签名完整性及 DMG 完整性。临时签名不是 Developer ID 签名或公证。源码和构建来源见 v0.2.25 Release 附带的 [BUILD-INFO.json](https://github.com/9holy/usage-ledger/releases/download/v0.2.25/BUILD-INFO.json)；Release 提供分别构建的原生架构预览 DMG。CI 验证使用 macOS 15；配置的 macOS 13 最低版本和默认通用目标尚未验证。Finder/Dock、完整 GUI 和真实账号检查尚未检查。请见[macOS 构建与验证指南](../docs/platforms/macos.md)。

### 数据与发布边界

应用保留现有数据身份。macOS 上应用账本默认位于 `~/.local/share/2api-console`；各数据源沿用现有主目录位置，包括 `~/.codex`、`~/.claude`、`~/.dsh`、`~/.antigravity_cockpit` 和 `~/.cli-proxy-api`。不迁移历史数据。CLIProxyAPI 用量由原生 SQLite 读取，不需要 Python。

macOS 上的 Antigravity 应用/IDE 自动发现属于尽力而为，仅限当前用户已知的应用包位置，以及 IPv4 回环语言服务器进程/监听信息。此行为由逆向分析实现，并非官方集成契约；尚未进行真实 Mac 端到端验证。第三方服务需在应用内配置，不会随仓库打包。

公开仓库 `9holy/usage-ledger` 的 Mac CI 工作流仅在推送到 `test/macos-*` 分支时运行；推送 `main` 不会触发。工作流会构建和测试，但不会发布 GitHub Release。v0.2.25 仅提供手动下载，不提供应用内自动更新。临时签名不需要付费 Apple Developer 账号；使用 Developer ID 签名和公证正式分发需要另行配置。
