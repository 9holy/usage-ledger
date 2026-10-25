# 来源与许可范围 / Provenance and License Scope

保留已确认来源与原条款，**不把全项目重新授权为 MIT**，也不对用户参考图授予任意用途权利。This notice preserves original terms; it neither grants a blanket MIT license nor unrestricted rights to supplied reference art.

## Sub2API

前端在 [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api) 相关代码基础上继续开发。继承代码及适用修改保留原 LGPL-3.0 条款与归属。原内核基线见 `CORE_VERSION`、`UPSTREAM_SUB2API_COMMIT`；本包不捆绑后端二进制。

The frontend derives from relevant Sub2API code; inherited code and applicable modifications retain original LGPL-3.0 terms and attribution. Baseline markers do not mean a backend binary is bundled.

- [Upstream license](https://github.com/Wei-Shaw/sub2api/blob/main/LICENSE).
- Preserved texts: [LGPL-3.0](LICENSES/Sub2API-LGPL-3.0.txt) and referenced [GPL-3.0](LICENSES/GPL-3.0.txt).
- `public/source-icons/sub2api.svg`: upstream frontend logo, a source identifier rather than endorsement.

## CLIProxyAPI Management Center

`public/source-icons/cliproxyapi.jpg` 来自 Router-For.ME 的 [Management Center logo](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/main/logo.jpg)，内容未修改，仅识别来源。

Copyright (c) 2026 Router-For.ME. The [upstream MIT license](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/main/LICENSE) is preserved in [LICENSES/CLIProxy-Management-Center-MIT.txt](LICENSES/CLIProxy-Management-Center-MIT.txt). Its permission covers that upstream material, not every file here. No external management app/server/plugin DLL is bundled.

## Cockpit Tools Icon

`public/source-icons/cockpit.png` 来自 [jlcodes99/cockpit-tools](https://github.com/jlcodes99/cockpit-tools)，复制为来源标识，图像内容未修改。上游 [README 许可声明](https://github.com/jlcodes99/cockpit-tools#许可证) 采用 CC BY-NC-SA 4.0，商业用途要求另获书面授权。本包不捆绑 Cockpit 应用。

Attributed to jlcodes99 / Cockpit Tools, the unchanged source icon retains upstream noncommercial/share-alike terms, without commercial permission or endorsement. Read the [original notice](https://github.com/jlcodes99/cockpit-tools#许可证) and [CC BY-NC-SA 4.0 legal text](LICENSES/CC-BY-NC-SA-4.0.txt), also linked by [Creative Commons](https://creativecommons.org/licenses/by-nc-sa/4.0/). The original warranty disclaimers remain applicable. This does not automatically relicense unrelated code.

## 应用和信息图 / App and Infographic Artwork

- `public/usage-ledger.png` is the project-supplied approved mark; `src-tauri/icons/` contains generated platform sizes.
- `src/assets/usage/` and `src/features/cost-center/components/assets/` contain current runtime artwork/materials, including project-specific generated/edited visuals based on user-supplied task references.
- The user supplied reference images as authorized inputs for this project's visual work. This records task provenance, not unrestricted third-party commercial/relicensing rights. No blanket asset license is granted here.
- Unused original reference PNGs and private/native validation captures are not exported. Actual runtime assets remain included; publication does not replace approved art.
- `docs/screenshots/` contains current-version synthetic DEMO renders; see its [provenance note](docs/screenshots/README.md).

任务参考的授权不等于替所有原作者授予新的商用或再授权权利。素材与继承代码的许可分别保留；文件级声明继续适用。

## Dependencies

Vue, Tauri, Chart.js, Three.js, Lucide, LobeHub, SQLite and other dependencies retain their respective copyright/licenses. Exact versions appear in `pnpm-lock.yaml` and `src-tauri/Cargo.lock`. Installed dependency/build directories are not shipped; retain dependency notices in binary distributions.

未被上述条款或文件级声明覆盖的独立新增内容，不通过本说明额外授予统一许可。This inventory does not invent an umbrella license for independently added material; public availability and permission to reuse are different.
