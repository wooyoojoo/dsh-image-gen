# Changelog

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
