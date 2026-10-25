# Native desktop layer

This directory contains the Tauri 2 / Rust window, tray, usage collectors, SQLite ledger, and native query interfaces. See the [project README](../README.md) for application features, screenshots, privacy, and licensing.

## Windows (existing target)

Run from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm exec tauri dev
pnpm build:desktop
pnpm exec tauri build --config src-tauri/tauri.local.conf.json
```

The existing Windows bundle target remains NSIS. The local Tauri override disables updater artifact generation; it does not publish an update. Outputs: `src-tauri/target/release/console2api.exe` and `src-tauri/target/release/bundle/nsis/`. Building requires Windows C++ Build Tools and the Microsoft Edge WebView2 Runtime.

## macOS (Apple Silicon and Intel)

The macOS build path is source/configuration-adapted for a universal `arm64` and `x86_64` app/DMG with macOS 13.0 as the minimum version. The separate macOS configuration leaves the existing Windows NSIS target unchanged. A Mac host is required; these commands do not cross-compile the Mac bundle from Windows.

```sh
pnpm install --frozen-lockfile
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm desktop:test:mac
pnpm desktop:build:mac
```

`desktop:test:mac` runs a frontend type check, focused frontend tests, and Rust tests with isolated temporary data directories. It does not launch the GUI or make real-account calls. `desktop:build:mac` uses an ad-hoc signature and disables updater artifact creation; the build script checks both architectures, signature integrity, and DMG integrity. Ad-hoc signing is not Developer ID signing or notarization. No native Mac build/runtime test has been performed; this repository state does not include or claim a built `.app`/`.dmg`. See the [macOS build and verification guide](../docs/platforms/macos.md).

## Data and release boundaries

The application preserves its existing data identity. On macOS the ledger defaults to `~/.local/share/2api-console`; source integrations use their existing home-directory locations, including `~/.codex`, `~/.claude`, `~/.dsh`, `~/.antigravity_cockpit`, and `~/.cli-proxy-api`. No history migration is performed. CLIProxyAPI usage is read natively from SQLite, without Python.

Antigravity application/IDE discovery on macOS is best-effort, limited to known current-user bundle locations and IPv4-loopback language-server process/listener metadata. It is reverse-engineered rather than an official integration contract and has not had real-Mac end-to-end validation. Third-party services are configured in the application and are not bundled.

Cloud CI is not configured or run. Local build commands do not publish an installer or update. Ad-hoc packaging does not require a paid Apple Developer account, but distribution with Developer ID signing and notarization is a separate step.

## 原生桌面层

此目录包含 Tauri 2 / Rust 窗口、托盘、用量采集器、SQLite 账本与原生查询接口。应用功能、配图、隐私和许可请见[项目说明](../README.zh-CN.md)。

### Windows（现有目标）

在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm exec tauri dev
pnpm build:desktop
pnpm exec tauri build --config src-tauri/tauri.local.conf.json
```

现有 Windows 打包目标仍为 NSIS。本地 Tauri 覆盖配置会关闭 updater 签名产物生成，但不会发布更新。产物：`src-tauri/target/release/console2api.exe` 和 `src-tauri/target/release/bundle/nsis/`。构建需要 Windows C++ Build Tools 与 Microsoft Edge WebView2 Runtime。

### macOS（Apple Silicon 与 Intel）

macOS 构建路径已做源码与配置适配，目标为 `arm64` 与 `x86_64` 通用 app/DMG，最低系统版本为 macOS 13.0。macOS 使用单独配置，现有 Windows NSIS 目标保持不变。必须在 Mac 上运行这些命令；不能从 Windows 交叉编译 Mac 应用包。

```sh
pnpm install --frozen-lockfile
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm desktop:test:mac
pnpm desktop:build:mac
```

`desktop:test:mac` 会运行前端类型检查、定向前端测试及使用临时隔离数据目录的 Rust 测试；不会打开 GUI，也不会调用真实账号。`desktop:build:mac` 使用临时签名并关闭 updater 产物生成；构建脚本会检查两个架构、签名完整性及 DMG 完整性。临时签名不是 Developer ID 签名或公证。本仓库当前状态尚未执行原生 Mac 构建/运行测试，也未包含或声称已生成 `.app`/`.dmg`。请见[macOS 构建与验证指南](../docs/platforms/macos.md)。

### 数据与发布边界

应用保留现有数据身份。macOS 上应用账本默认位于 `~/.local/share/2api-console`；各数据源沿用现有主目录位置，包括 `~/.codex`、`~/.claude`、`~/.dsh`、`~/.antigravity_cockpit` 和 `~/.cli-proxy-api`。不迁移历史数据。CLIProxyAPI 用量由原生 SQLite 读取，不需要 Python。

macOS 上的 Antigravity 应用/IDE 自动发现属于尽力而为，仅限当前用户已知的应用包位置，以及 IPv4 回环语言服务器进程/监听信息。此行为由逆向分析实现，并非官方集成契约；尚未进行真实 Mac 端到端验证。第三方服务需在应用内配置，不会随仓库打包。

目前未配置或运行云端 CI。本地构建命令不会发布安装包或更新。临时签名不需要付费 Apple Developer 账号；使用 Developer ID 签名和公证正式分发需要另行配置。
