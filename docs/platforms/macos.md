# macOS on Apple Silicon and Intel

[English](#english) | [简体中文](#简体中文)

## English

[Project README](../../README.md) · [简体中文项目说明](../../README.zh-CN.md)

### Status

The repository contains a macOS source/configuration path for a universal Apple Silicon (`arm64`) and Intel (`x86_64`) build, with a minimum macOS version of 13.0. The macOS Tauri config uses native window decorations and `app`/`dmg` bundle targets. The source also includes Dock re-open handling and home-directory fallback. The existing Windows NSIS target is separate and unchanged.

This is source-level support, not a completed Mac release: no native Mac build or runtime test has been performed, and this source snapshot does not provide an actual `.app` or `.dmg`. The 28-image Windows DEMO gallery is not Mac screenshot or runtime proof. A standard hosted-runner workflow is configured on the independent branch `test/macos-free-20261026` for the approved public-repository path; its first run is pending, so neither architecture has a passing result yet.

### Requirements

- An Apple Silicon or Intel Mac running macOS 13.0 or newer
- Xcode Command Line Tools
- Node.js 22 LTS or a compatible newer version, pnpm 9.15.9, and stable Rust
- For the universal default, install both Rust targets; a single-architecture build needs only its matching target:

```sh
xcode-select --install
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm install --frozen-lockfile
```

The Mac build command must run on macOS; it does not cross-compile the Mac bundle from Windows.

### Source tests

```sh
pnpm desktop:test:mac
```

This Mac-only command runs the frontend type check, focused desktop/CLIProxy tests, and Rust tests. The Rust test process uses temporary isolated home and ledger directories. It does not open the GUI or make real-account calls. It does not validate packaged window behavior.

### Local universal build

```sh
pnpm desktop:build:mac
```

The command builds Tauri `app` and `dmg` bundles for `universal-apple-darwin`. It uses a test override with ad-hoc signing identity `-` and updater artifact creation disabled. It checks for both `arm64` and `x86_64`, verifies the app signature structure with `codesign`, and verifies the DMG with `hdiutil`. These checks do not replace launching the app on real Apple Silicon and Intel Macs.

For a local single-architecture build, pass an explicit target instead of using the universal default:

```sh
pnpm desktop:build:mac --target aarch64-apple-darwin
pnpm desktop:build:mac --target x86_64-apple-darwin
```

Ad-hoc signing does not require a paid Apple Developer account, Developer ID certificate, or notarization. It is not Developer ID signing and does not establish Gatekeeper trust; macOS may show a security warning when an app is moved or downloaded. Do not disable Gatekeeper or remove quarantine attributes to bypass that warning. Building or sharing an app outside the App Store does not require buying a certificate. Developer ID signing and notarization are a separate option for verified developer identity and smoother installation of public downloads.

### Free public CI test packages

The approved public-repository path uses standard GitHub-hosted macOS runners at no charge; ad-hoc test packaging does not require a paid Apple account or certificate. The workflow `.github/workflows/macos-test.yml` is configured on the independent branch `test/macos-free-20261026`. It is gated to the public `9holy/usage-ledger` repository and runs on pushes to `test/macos-*` branches. The Apple Silicon job uses `macos-15` (`arm64`); the Intel job uses `macos-15-intel` (`x86_64`). Each job runs source tests, builds one architecture-specific ad-hoc DMG, verifies its architecture/signature/DMG integrity, and launches the packaged app in the background with an isolated empty profile. Test artifacts are retained for three days.

The workflow is configured but has not run or passed yet; neither architecture is verified. These temporary DMGs are test artifacts, not a GitHub Release. The workflow does not add Developer ID signing or notarization and leaves the Windows target unchanged. Finder/Dock interaction, minimize/restore, 3D rendering, and real-upstream checks remain manual and pending.

### Data and integrations

The macOS code resolves the home directory through `HOME` with the existing fallback and retains the current data locations; it does not migrate history:

- Application ledger: `~/.local/share/2api-console`
- Codex: `~/.codex`
- Claude Code: `~/.claude`
- DeepSeek Harness: `~/.dsh`
- Antigravity/Cockpit: `~/.antigravity_cockpit`
- CLIProxyAPI: `~/.cli-proxy-api`

CLIProxyAPI usage is read from SQLite natively; Python is not required for that source. Antigravity app/IDE discovery is best-effort: it is limited to known current-user bundle locations and IPv4-loopback language-server process/listener metadata. This behavior is reverse-engineered, is not an official integration contract, and has not had real-Mac end-to-end validation.

The Mac Info.plist permits HTTP only for the app's `127.0.0.1` / `localhost` bridge, without disabling transport security globally. macOS can separately ask for local-network permission when connecting to a LAN service you configure.

### Manual Mac checks

After building locally, check the universal app on both Apple Silicon and Intel hardware using synthetic data only:

- Launch from Finder; close the main window and reopen from the Dock.
- Minimize with `Command-M`, restore the window, and quit with `Command-Q`.
- Check window dragging, full-screen behavior, and the Edit menu.
- Switch English/Chinese; open Monitor and Cost views and check the 3D visualization.
- Append synthetic usage, restart the app, and confirm the synthetic record remains visible.

These interactive checks remain pending even if the hosted jobs later pass. The CI workflow does not publish a GitHub Release or validate behavior against real upstream accounts.

## 简体中文

[English project README](../../README.md) · [项目中文说明](../../README.zh-CN.md)

### 状态

仓库已包含 macOS 源码与构建配置，可面向 Apple Silicon（`arm64`）和 Intel（`x86_64`）配置通用构建，最低 macOS 版本为 13.0。macOS 专用 Tauri 配置采用原生窗口装饰，并指定 `app`/`dmg` 打包目标。源码还包含 Dock 重新打开处理和主目录回退。现有 Windows NSIS 目标与之分离，保持不变。

这仅表示源码层已适配，并非 Mac 版本已构建或发布：尚未执行原生 Mac 构建或运行测试，本源码快照也不提供实际 `.app` 或 `.dmg`。现有 28 张 Windows DEMO 配图不是 Mac 截图或运行验证证据。独立分支 `test/macos-free-20261026` 已配置标准托管运行器工作流，面向获准的公开仓库路径；首次运行仍待执行，因此两个架构目前都没有通过结果。

### 环境要求

- Apple Silicon 或 Intel Mac，macOS 13.0 或更新版本
- Xcode Command Line Tools
- Node.js 22 LTS 或兼容的更新版本、pnpm 9.15.9、Rust stable
- 通用默认目标需安装两个 Rust 目标；单架构构建只需安装对应目标：

```sh
xcode-select --install
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm install --frozen-lockfile
```

Mac 构建命令必须在 macOS 上运行；不能从 Windows 交叉编译 Mac 应用包。

### 源码测试

```sh
pnpm desktop:test:mac
```

此 Mac 专用命令会运行前端类型检查、定向桌面/CLIProxy 测试和 Rust 测试。Rust 测试进程使用临时隔离的主目录和账本目录，不打开 GUI，也不调用真实账号。它不会验证打包后窗口的实际行为。

### 本地通用构建

```sh
pnpm desktop:build:mac
```

该命令为 `universal-apple-darwin` 构建 Tauri `app` 和 `dmg` 包。它使用测试覆盖配置、临时签名身份 `-`，并关闭 updater 产物生成。脚本会检查包中同时包含 `arm64` 与 `x86_64`，用 `codesign` 验证应用签名结构，并用 `hdiutil` 验证 DMG。这些检查不能代替在真实 Apple Silicon 与 Intel Mac 上启动应用。

若需在本地只构建一种架构，可传入显式目标，不使用默认通用目标：

```sh
pnpm desktop:build:mac --target aarch64-apple-darwin
pnpm desktop:build:mac --target x86_64-apple-darwin
```

免费本地签名（ad-hoc）不需要付费 Apple Developer 账号、Developer ID 证书或公证；但它不是 Developer ID 签名，也不代表通过 Gatekeeper 信任验证。移动或下载应用时，macOS 可能显示安全警告。不要关闭 Gatekeeper，也不要移除隔离属性来绕过警告。在 App Store 之外构建或分享应用，不必购买证书；若希望公开下载时显示可验证的开发者身份、减少系统拦截提示，再另行配置 Developer ID 签名和公证。

### 免费公开 CI 测试包

获准的公开仓库路径使用标准 GitHub 托管 macOS 运行器，不收取运行器费用；ad-hoc 测试打包不需要付费 Apple 账号或证书。工作流 `.github/workflows/macos-test.yml` 已配置在独立分支 `test/macos-free-20261026`。它仅对公开仓库 `9holy/usage-ledger` 开放，并在推送到 `test/macos-*` 分支时运行。Apple Silicon 任务使用 `macos-15`（`arm64`），Intel 任务使用 `macos-15-intel`（`x86_64`）。每个任务都会运行源码测试、构建一个单架构 ad-hoc DMG、验证架构/签名/DMG 完整性，并在隔离的空配置中后台启动应用。测试产物保留三天。

工作流已配置但尚未运行或通过，两个架构均无验证通过结果。这些临时 DMG 是测试产物，不是 GitHub Release。工作流不添加 Developer ID 签名或公证，也不更改 Windows 目标。Finder/Dock 交互、最小化与恢复、3D 渲染及真实上游检查仍需手动执行，目前待验证。

### 数据与集成

macOS 代码通过 `HOME` 及既有回退方式解析主目录，并沿用当前数据位置；不会迁移历史数据：

- 应用账本：`~/.local/share/2api-console`
- Codex：`~/.codex`
- Claude Code：`~/.claude`
- DeepSeek Harness：`~/.dsh`
- Antigravity/Cockpit：`~/.antigravity_cockpit`
- CLIProxyAPI：`~/.cli-proxy-api`

CLIProxyAPI 用量由原生 SQLite 读取；该数据源不需要 Python。Antigravity 应用/IDE 自动发现属于尽力而为：仅限当前用户已知的应用包位置，以及 IPv4 回环语言服务器进程/监听信息。该行为由逆向分析实现，不是官方集成契约，也尚未进行真实 Mac 端到端验证。

Mac 的 Info.plist 仅为应用自身的 `127.0.0.1` / `localhost` 桥接允许 HTTP，没有全局关闭传输安全检查。连接你配置的局域网服务时，macOS 还可能单独询问本地网络权限。

### Mac 手动检查

本地构建后，请只用虚构数据在 Apple Silicon 和 Intel 设备上分别检查：

- 从 Finder 启动；关闭主窗口后从 Dock 重新打开。
- 用 `Command-M` 最小化并恢复窗口，用 `Command-Q` 退出。
- 检查拖动窗口、全屏行为和 Edit 菜单。
- 切换中英文；打开监控与成本页面并检查 3D 图表。
- 添加虚构用量记录，重启应用并确认记录仍可见。

即使后续托管任务通过，上述交互检查仍待执行。CI 工作流不会发布 GitHub Release，也不会验证真实上游账号行为。
