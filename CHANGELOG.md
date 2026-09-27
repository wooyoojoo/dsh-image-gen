# Changelog

## 0.2.1 — 2026-09-27

打包与文档发布，**插件代码（`index.js`）与 0.2.0 完全一致**。

- 新增 **`install.cmd`**：一键安装/更新（幂等），**只有一个文件**。
  - 它是 `.cmd` 外壳 + **内嵌 PowerShell** 的多语言单文件：Windows 默认执行策略常是 `Restricted`，
    直接跑 `.ps1` 会被拒；`.cmd` 不受该策略约束，双击即可。
  - 内嵌的 PowerShell 用 `[IO.File]::ReadAllText`（.NET 默认 UTF-8）读取**本文件**再交给 `ScriptBlock` 执行 ——
    于是彻底不需要操心 BOM（无 BOM 的 `.ps1` 会被 PowerShell 5.1 按 ANSI 解码，中文串乱到破坏语法，这个坑实测踩过）。
  - 自动向上搜索 DSH 目录并**记住**（`$DSH_HOME/imagegen-install.json`），所以第一次给过 `-DshDir` 之后**零参数**即可；
    **自动套用 Windows 系统代理**（只对本次命令设 `HTTP(S)_PROXY`，不改全局 git 配置）；
    装完跑离线 smoke（31 项）+ `--dump-config` 复核；默认**暂停**以便双击时看到结果（`-NoPause` 关闭）。
- `files` 纳入 ~~`install.cmd`~~ → **最终不纳入**：pnpm 物化 git 依赖时把行尾写成 LF，
  而 LF-only 的批处理会被 `cmd.exe` 错位解析（实测 `+$m.Length)))" -Help was unexpected at this time`）。
  安装器改为"从 clone 出来的仓库里跑"，并用 `.gitattributes`（`*.cmd text eol=crlf`）钉住行尾。
- README 增加「一键安装 / 更新」章节（含 clone + 跑脚本的新设备流程）。

## 0.2.0 — 2026-09-27

首次进 git。相对 0.1.3 **只新增能力，未改既有行为**（`generations` 路径与旧参数完全兼容）。

### 新增

- **`/v1/images/edits` 支持**：调用时给 `image`（本地路径，1 张或数组，最多 8 张）+ 可选 `mask` → 走 multipart 编辑；
  不给 `image` 仍是 `/v1/images/generations`（JSON）。`baseUrl` 尾段自动推导（粘任一端点的完整地址都能互相换）。
- **透传参数**：`background`、`output_format`、`seed`、`input_fidelity`；以及**逃生口** `extra` / `providerOptions`
  （对象原样进请求体，显式参数优先；multipart 下结构化值自动 JSON 编码）。
- **`outputDir` 成为单次调用参数**（相对路径相对配置默认解析）。
- **配置层新增默认值**：`background`、`outputFormat`（单次参数覆盖）。
- 工具结果新增 `mode`（`generations`/`edits`）与 `inputImages`，便于确认实际走的是哪条路。
- `smoke.mjs`：31 项离线自检（端点推导 / 参数校验 / 两种请求体构造 / 对本地 stub 服务真跑两条路径 + 落盘字节比对），随包发布。

### 本机中继实测（`cf.api.fan` + `gpt-image-2.5-flare`）

- ✅ `background: "transparent"` 出**真透明底**（`alpha min=0`、四角全 0、不透明约 9%）。
- ✅ `n` 1–4、`outputDir`、`output_format`（png/webp）、非方形 `size`（如 `1536x1024`）均生效。
- ✅ `image` → `/images/edits` 可用；输入图的透明底会保留。
- ⚠️ `quality` 枚举只有 `low`/`medium`/`high`/`auto`（**最高 `high`**）；`low` 明显降质。
- ⚠️ `mask` 能上传但**模型不遵守**：带/不带 mask 的两次编辑轮廓 IoU 为 0.888 vs 0.893。
- ❌ `seed`、`input_fidelity` 被该中继拒收（报错原文见 README 的「本机中继实测」一节）。

### 校验

- `node smoke.mjs` → **31/31**
- `pnpm dsh --profile web --dump-config` → `imagegen` 层正常解析
- 真实调用：generations（透明底 + `n=2`）与 edits（`image` + `mask`）两条路径均通过

### 已知缺口

- 客户端半边（`client.js`）本轮未改动，也**未被 `smoke.mjs` 覆盖** —— 原先 `scratch-plugin/` 里那份 smoke 会在 VM 中加载并驱动卡片渲染，该文件随源目录丢失；回迁后建议补回。
