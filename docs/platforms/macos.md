# macOS on Apple Silicon and Intel

[English](#english) | [简体中文](#简体中文)

## English

[Project README](../../README.md) · [简体中文项目说明](../../README.zh-CN.md)

### Status

The repository contains a macOS source/configuration path for a universal Apple Silicon (`arm64`) and Intel (`x86_64`) build, with a minimum macOS version of 13.0. The macOS Tauri config uses native window decorations and `app`/`dmg` bundle targets. The source also includes Dock re-open handling and home-directory fallback. The existing Windows NSIS target is separate and unchanged.

Automated Apple Silicon and Intel CI builds have passed and produced temporary test packages, but this is not a formal Mac release. The source tree itself does not bundle an `.app` or `.dmg`. The 28-image Windows DEMO gallery is not Mac screenshot or runtime proof; interactive GUI and real-service validation remain pending.

### Download and install a CI test package

These are temporary architecture-specific test packages, not release downloads. GitHub sign-in is required to download an artifact ZIP. Artifacts expire after three days.

- [Apple Silicon (arm64) test package](https://github.com/9holy/usage-ledger/actions/runs/40232253195/artifacts/12613443475)
- [Intel (x86_64) test package](https://github.com/9holy/usage-ledger/actions/runs/40232253195/artifacts/12614221991)

Choose using Apple menu > About This Mac: an M-series chip is `arm64`; an Intel processor is `x86_64`.

1. Back up important local data before first launch. The app reuses the existing home-directory paths and does not migrate history.
2. Download the matching ZIP and extract it.
3. Open the DMG, drag the app into `/Applications`, then launch it.
4. The app is ad-hoc signed, so macOS may show a developer verification warning. Continue only if you trust the source; do not disable Gatekeeper or remove quarantine attributes.

If an artifact has expired, use the source-build instructions below. These packages are not published as a GitHub Release.

### Requirements

- An Apple Silicon or Intel Mac running macOS 13.0 or newer
- Xcode Command Line Tools
- Node.js 22 LTS or a compatible newer version, pnpm 9.15.9, and stable Rust
- For the universal default, install both Rust targets; a single-architecture build needs only its matching target:

```sh
xcode-select --install
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

The Mac build command must run on macOS; it does not cross-compile the Mac bundle from Windows.

### Build from source

The Mac build scripts are included on `main`. The earlier tested source remains on `test/macos-free-20261026`; its CI result does not validate subsequent performance changes.

```sh
git clone --branch main --single-branch https://github.com/9holy/usage-ledger.git
cd usage-ledger
pnpm install --frozen-lockfile
```

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

### Public CI test packages

The workflow `.github/workflows/macos-test.yml` is included with the source. For the public `9holy/usage-ledger` repository it runs only on pushes to `test/macos-*` branches, not `main`, using standard GitHub-hosted runners: `macos-15` (`arm64`) for Apple Silicon and `macos-15-intel` (`x86_64`) for Intel. Each job runs source tests, builds one architecture-specific ad-hoc DMG, verifies its architecture/signature/DMG integrity, and starts the packaged app in the background with an isolated empty profile. Artifacts are retained for three days.

The two jobs build separate native test DMGs, not a universal binary. They do not change the main branch or Windows target, add Developer ID signing/notarization, or publish a GitHub Release. Finder/Dock interaction, minimize/restore, 3D rendering, and real-upstream checks remain manual and pending.

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

After downloading the matching single-architecture test package or building locally, check the app on the corresponding Apple Silicon or Intel hardware using synthetic data only. The universal default remains unvalidated:

- Launch from Finder; close the main window and reopen from the Dock.
- Minimize with `Command-M`, restore the window, and quit with `Command-Q`.
- Check window dragging, full-screen behavior, and the Edit menu.
- Switch English/Chinese; open Monitor and Cost views and check the 3D visualization.
- Append synthetic usage, restart the app, and confirm the synthetic record remains visible.

These interactive checks remain pending; background startup is not a substitute for using Finder/Dock or checking rendered views on a real Mac.

### Verification boundary

The successful [CI run](https://github.com/9holy/usage-ledger/actions/runs/40232253195) built source commit [`90f1a43e8eb679c2874c90886ad0194468918f7d`](https://github.com/9holy/usage-ledger/commit/90f1a43e8eb679c2874c90886ad0194468918f7d), version 0.2.24. Both architecture jobs passed type checking, 20 focused frontend tests, 350 native tests, single-architecture package/signature/DMG checks, and isolated background startup; 14 opt-in real-data diagnostics remained ignored, and no real account calls were made. CI ran on macOS 15 only; it does not prove macOS 13 behavior, interactive Finder/Dock or 3D GUI behavior, real-upstream integration, or a universal binary. No GitHub Release, Developer ID signing, or notarization is included.

## 简体中文

[English project README](../../README.md) · [项目中文说明](../../README.zh-CN.md)

### 状态

仓库已包含 macOS 源码与构建配置，可面向 Apple Silicon（`arm64`）和 Intel（`x86_64`）配置通用构建，最低 macOS 版本为 13.0。macOS 专用 Tauri 配置采用原生窗口装饰，并指定 `app`/`dmg` 打包目标。源码还包含 Dock 重新打开处理和主目录回退。现有 Windows NSIS 目标与之分离，保持不变。

Apple Silicon 与 Intel 的自动 CI 构建均已通过并产出临时测试包，但这不是正式 Mac 版本发布。源码树本身不包含 `.app` 或 `.dmg`。现有 28 张 Windows DEMO 配图不是 Mac 截图或运行验证证据；交互 GUI 与真实服务验证仍待完成。

### 下载并安装 CI 测试包

这些是临时单架构测试包，不是正式发布下载。下载 GitHub Actions artifact ZIP 需要登录 GitHub；产物三天后过期。

- [Apple Silicon（arm64）测试包](https://github.com/9holy/usage-ledger/actions/runs/40232253195/artifacts/12613443475)
- [Intel（x86_64）测试包](https://github.com/9holy/usage-ledger/actions/runs/40232253195/artifacts/12614221991)

请在 Apple 菜单 > 关于本机中确认架构：M 系列芯片选择 `arm64`；Intel 处理器选择 `x86_64`。

1. 首次启动前备份重要本地数据。应用沿用现有主目录路径，不迁移历史数据。
2. 下载对应 ZIP 并解压。
3. 打开 DMG，将应用拖入 `/Applications`，然后启动。
4. 应用采用 ad-hoc 签名，macOS 可能显示无法验证开发者的提示。只有信任来源时才继续；不要关闭 Gatekeeper，也不要移除隔离属性。

产物过期后，请按下方源码构建说明自行构建。这些测试包不会作为 GitHub Release 发布。

### 环境要求

- Apple Silicon 或 Intel Mac，macOS 13.0 或更新版本
- Xcode Command Line Tools
- Node.js 22 LTS 或兼容的更新版本、pnpm 9.15.9、Rust stable
- 通用默认目标需安装两个 Rust 目标；单架构构建只需安装对应目标：

```sh
xcode-select --install
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

Mac 构建命令必须在 macOS 上运行；不能从 Windows 交叉编译 Mac 应用包。

### 从源码构建

macOS 构建脚本已包含在 `main`。此前通过测试的源码仍保留在 `test/macos-free-20261026`；其 CI 结果不代表此后的性能优化已经通过 Mac 验证。

```sh
git clone --branch main --single-branch https://github.com/9holy/usage-ledger.git
cd usage-ledger
pnpm install --frozen-lockfile
```

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

### 公开 CI 测试包

工作流 `.github/workflows/macos-test.yml` 已随源码提供。对公开仓库 `9holy/usage-ledger`，它仅在推送到 `test/macos-*` 分支时运行，推送 `main` 不会启动；使用标准 GitHub 托管运行器：Apple Silicon 使用 `macos-15`（`arm64`），Intel 使用 `macos-15-intel`（`x86_64`）。每个任务都会运行源码测试、构建一个单架构 ad-hoc DMG、验证架构/签名/DMG 完整性，并在隔离的空配置中后台启动应用。测试产物保留三天。

两个任务分别构建原生单架构测试 DMG，并非通用二合一包。它们不更改 main 分支或 Windows 目标，不添加 Developer ID 签名或公证，也不会发布 GitHub Release。Finder/Dock 交互、最小化与恢复、3D 渲染及真实上游检查仍需手动执行，目前待验证。

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

下载对应的单架构测试包或本地构建后，请只用虚构数据在相应的 Apple Silicon 或 Intel 设备上检查应用。默认通用目标仍未验证：

- 从 Finder 启动；关闭主窗口后从 Dock 重新打开。
- 用 `Command-M` 最小化并恢复窗口，用 `Command-Q` 退出。
- 检查拖动窗口、全屏行为和 Edit 菜单。
- 切换中英文；打开监控与成本页面并检查 3D 图表。
- 添加虚构用量记录，重启应用并确认记录仍可见。

以上交互检查仍待执行；后台启动不等于通过 Finder/Dock 使用或在真实 Mac 上检查图表渲染。

### 验证边界

成功的 [CI 运行](https://github.com/9holy/usage-ledger/actions/runs/40232253195)验证了源码提交 [`90f1a43e8eb679c2874c90886ad0194468918f7d`](https://github.com/9holy/usage-ledger/commit/90f1a43e8eb679c2874c90886ad0194468918f7d)，版本为 0.2.24。两个架构任务均通过类型检查、20 个定向前端测试、350 个原生测试、单架构打包/签名/DMG 检查和隔离后台启动；14 个可选真实数据诊断仍保持忽略，未调用真实账号。CI 仅在 macOS 15 上运行；不证明 macOS 13 行为、Finder/Dock 交互或 3D GUI、真实上游集成，也未验证通用二合一包。本次没有 GitHub Release、Developer ID 签名或公证。
