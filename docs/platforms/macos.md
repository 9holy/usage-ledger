# macOS on Apple Silicon and Intel

[English](#english) | [简体中文](#简体中文)

## English

[Project README](../../README.md) · [简体中文项目说明](../../README.zh-CN.md)

### Status

macOS remains a preview target. See the v0.2.25 release's [BUILD-INFO.json](https://github.com/9holy/usage-ledger/releases/download/v0.2.25/BUILD-INFO.json) for source/build provenance. The configured minimum is macOS 13, but CI validation uses macOS 15. The release offers separate native `arm64` and `x86_64` DMGs; the default universal build is not validated. Packages use ad-hoc signing without Developer ID signing or notarization. Finder/Dock, full GUI, macOS 13, and real-account checks have not been checked. The Tauri config targets `app`/`dmg` with native window decorations, Dock re-open handling, and home-directory fallback; the Windows NSIS target is separate and unchanged.

The CI workflow does not publish GitHub Releases. The v0.2.25 release provides manual downloads only; no automatic updates are provided by this release. The source tree itself does not bundle an `.app` or `.dmg`. The 28-image Windows DEMO gallery is not Mac screenshot or runtime proof.

### Download and install v0.2.25

These are manual downloads from the [v0.2.25 release page](https://github.com/9holy/usage-ledger/releases/tag/v0.2.25). The packages are macOS previews; manual desktop testing is still incomplete.

- Apple Silicon (`arm64`): [Usage-Ledger_0.2.25_macos_arm64.dmg](https://github.com/9holy/usage-ledger/releases/download/v0.2.25/Usage-Ledger_0.2.25_macos_arm64.dmg)
- Intel (`x86_64`): [Usage-Ledger_0.2.25_macos_x64.dmg](https://github.com/9holy/usage-ledger/releases/download/v0.2.25/Usage-Ledger_0.2.25_macos_x64.dmg)

Choose using Apple menu > About This Mac: an M-series chip is `arm64`; an Intel processor is `x86_64`.

1. Back up important local data before first launch. The app reuses the existing home-directory paths and does not migrate history.
2. Download the DMG matching your processor.
3. Open the DMG, drag the app into `/Applications`, then launch it.
4. The app is ad-hoc signed, so macOS may show a developer verification warning. Continue only if you trust the source; do not disable Gatekeeper or remove quarantine attributes.

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

The Mac build scripts are included on `main`. See the v0.2.25 release's `BUILD-INFO.json` for source/build provenance. The release includes separate native architecture preview DMGs.

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

### CI build workflow

For the public `9holy/usage-ledger` repository, `.github/workflows/macos-test.yml` runs only on pushes to `test/macos-*`; pushes to `main` do not trigger it. Apple Silicon uses `macos-15` (`arm64`) and Intel uses `macos-15-intel` (`x86_64`). Each job runs source tests, builds a single-architecture ad-hoc DMG, checks architecture/signature/DMG integrity, and starts the packaged app in an isolated empty profile. CI artifacts are retained for three days. Both native architecture jobs passed for the current source commit. The workflow does not publish GitHub Releases; releases are prepared separately.

The architecture-specific packages are separate, not one universal binary. The default universal target and macOS 13 behavior are not validated. Ad-hoc packaging does not add Developer ID signing or notarization. Finder/Dock interaction, minimize/restore, full GUI/3D rendering, and real-upstream checks remain manual and pending.

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

For v0.2.25 source/build provenance, see the release's [BUILD-INFO.json](https://github.com/9holy/usage-ledger/releases/download/v0.2.25/BUILD-INFO.json). CI validation uses macOS 15 and does not establish behavior on the configured minimum macOS 13. Finder/Dock, full GUI/3D rendering, real-upstream integration, and the default universal binary remain unvalidated. Packages use ad-hoc signing without Developer ID signing or notarization; the workflow itself does not publish a GitHub Release. No automatic updates are provided by this release.

## 简体中文

[English project README](../../README.md) · [项目中文说明](../../README.zh-CN.md)

### 状态

macOS 仍为预览目标。源码与构建来源见 v0.2.25 Release 附带的 [BUILD-INFO.json](https://github.com/9holy/usage-ledger/releases/download/v0.2.25/BUILD-INFO.json)。配置的最低版本为 macOS 13，但 CI 验证使用 macOS 15。Release 提供分别构建的原生 `arm64` 与 `x86_64` DMG；默认通用构建尚未验证。安装包采用 ad-hoc 签名，没有 Developer ID 签名或公证。Finder/Dock、完整 GUI、macOS 13 和真实账号检查尚未检查。Tauri 配置仍以原生窗口装饰为 `app`/`dmg` 打包，保留 Dock 重新打开处理和主目录回退；Windows NSIS 目标独立且保持不变。

CI 工作流不会发布 GitHub Release。v0.2.25 Release 仅提供手动下载，不提供应用内自动更新。源码树本身不包含 `.app` 或 `.dmg`。Windows DEMO 配图不是 Mac 截图或运行验证证据。

### 下载并安装 v0.2.25

以下是从 [v0.2.25 Release 页面](https://github.com/9holy/usage-ledger/releases/tag/v0.2.25)手动下载的链接。macOS 安装包属于预览，人工桌面测试仍未完成。

- Apple Silicon（`arm64`）：[Usage-Ledger_0.2.25_macos_arm64.dmg](https://github.com/9holy/usage-ledger/releases/download/v0.2.25/Usage-Ledger_0.2.25_macos_arm64.dmg)
- Intel（`x86_64`）：[Usage-Ledger_0.2.25_macos_x64.dmg](https://github.com/9holy/usage-ledger/releases/download/v0.2.25/Usage-Ledger_0.2.25_macos_x64.dmg)

请在 Apple 菜单 > 关于本机中确认架构：M 系列芯片选择 `arm64`；Intel 处理器选择 `x86_64`。

1. 首次启动前备份重要本地数据。应用沿用现有主目录路径，不迁移历史数据。
2. 下载与处理器匹配的 DMG。
3. 打开 DMG，将应用拖入 `/Applications`，然后启动。
4. 应用采用 ad-hoc 签名，macOS 可能显示无法验证开发者的提示。只有信任来源时才继续；不要关闭 Gatekeeper，也不要移除隔离属性。

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

macOS 构建脚本已包含在 `main`。源码和构建来源见 v0.2.25 Release 附带的 `BUILD-INFO.json`。Release 包含分别构建的原生架构预览 DMG。

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

### CI 构建工作流

公开仓库 `9holy/usage-ledger` 的 `.github/workflows/macos-test.yml` 仅在推送到 `test/macos-*` 分支时运行；推送 `main` 不会触发。Apple Silicon 使用 `macos-15`（`arm64`），Intel 使用 `macos-15-intel`（`x86_64`）。每个任务都会运行源码测试、构建单架构 ad-hoc DMG、检查架构/签名/DMG 完整性，并在隔离的空配置中后台启动应用。CI 产物保留三天。当前源码提交的两个原生架构任务均已通过。该工作流不会发布 GitHub Release；Release 由维护者另行准备。

v0.2.25 Release 提供的是分别构建的原生架构 DMG，并非一个通用二合一包。默认通用目标和 macOS 13 行为尚未验证。ad-hoc 打包不添加 Developer ID 签名或公证。Finder/Dock 交互、最小化与恢复、完整 GUI/3D 渲染及真实上游检查仍需手动执行，尚未检查。

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

源码和构建来源见 v0.2.25 Release 附带的 [BUILD-INFO.json](https://github.com/9holy/usage-ledger/releases/download/v0.2.25/BUILD-INFO.json)。CI 使用 macOS 15；不证明配置最低版本 macOS 13 上的行为，也不验证 Finder/Dock、完整 GUI/3D 渲染、真实上游集成或默认通用二合一包。安装包使用 ad-hoc 签名，不包含 Developer ID 签名或公证；该构建工作流本身不会发布 GitHub Release，本版也不提供应用内自动更新。
