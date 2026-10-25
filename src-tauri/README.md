# 用量账本原生桌面层

Tauri 2 / Rust 窗口、托盘、采集、SQLite 账本与查询接口。功能、隐私与配图见 [根目录说明](../README.md)。

## 运行与构建

从仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm exec tauri dev
```

本地无更新签名构建：

```powershell
pnpm exec tauri build --config src-tauri/tauri.local.conf.json
```

产物为 `target/release/console2api.exe` 和 `target/release/bundle/nsis/`。需要 Windows C++ 构建工具和 WebView2 Runtime。第三方服务在连接页配置，不随仓库打包。

当前应用标识与更新源沿用原项目。此私有快照未发布新更新包；本地配置只关闭更新签名产物生成，不把更新源改到新仓库。
