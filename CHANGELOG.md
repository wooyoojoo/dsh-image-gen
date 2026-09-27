# Changelog

## 0.3.0 — 2026-09-27

**插件页管理**：请求地址、API KEY 和已生成的图片都能在 DSH 侧边栏「插件」页里看和改，
不用再去翻 `~/.dsh/.env` 和输出目录。

### 新增

- **插件页配置区**（客户端 `plugins.bundle.config`，key = `dsh-imagegen`）：在这个 bundle 的详情页里
  显示并修改请求地址、API KEY，以及模型 / 尺寸 / 质量 / 超时 / 输出目录，外加一个「测试连接」。
  - 地址与 KEY 写进**凭据存储**（`~/.dsh/.credentials.yaml`）：下一次调用立即生效、不用重启，
    密钥不落进 profile；`describe` 只回报「是否已配置 / 来源 / 可否写入」，**从不回显密钥本身**。
  - 由启动环境提供的值会显示为只读（凭据面拒绝写入），由 profile `config` 固定住的值同样只读并说明原因。
  - 模型 / 尺寸 / 质量 / 超时 / 输出目录写进插件自己的覆盖文件 `$DSH_HOME/imagegen/config.json`，
    优先级为 **插件页覆盖 > cordis 配置 > 内置默认**，同样即时生效；清空并保存即恢复下层值。
    `timeoutMs` 也一并生效：工具声明的调用预算本来就是每次调用现读的。
- **已生成图片画廊**（客户端 `plugins.detail.section`）：同一页底部按时间倒序列出生成过的图片，
  每张有缩略图、原 prompt、模式 / 尺寸 / 体积 / 时间，操作有：点击放大（灯箱）、用系统应用打开、
  在文件管理器中定位、复制路径、把 `generate_image` 参数（prompt + image 路径）复制到剪贴板以便再次编辑、删除。
  - 生成时写一条索引记录（prompt / 模型 / 尺寸 / 质量 / 模式 / 输入图 / 字节 / 宽高 / 附件 id）到
    `$DSH_HOME/imagegen/images.json`（原子写，保留最新 500 条）。
- **主机侧认证路由**（`/api/imagegen/*`，注册在 Web 连接的精确路由表上）：
  `status` / `update` / `test` / `images` / `image` / `delete` / `open` / `reveal`。
  - 全部位于 `/api` 之下，因此先过连接层的 Host/Origin 围栏与浏览器 cookie 认证；
    **未认证请求得到 401**（已实测）。
  - **只按 id 取图，不接受调用方给的路径**：页面无法借这个插件读任意文件。
  - `connection` 是**可选**依赖，用 `ctx.inject(['connection'], …)` 挂在子 fiber 上，
    所以 headless profile 里工具照常注册、只是没有这些路由。
- `smoke.mjs`：31 → **68 项**。新增覆盖状态目录与覆盖文件、凭据读写与只读/固定值的拒绝路径、
  图片索引、全部 8 条路由（含「按 id 而非路径取图」与「open/reveal 对未知 id 不启动任何进程」）、
  连通性探测的三种结果、`apply` 的两种组合（**没有 Web connection 时工具照常注册**，有时挂上 8 条路由），
  以及**在 VM 里按模块加载器的方式执行 `client.js`**：
  驱动 `apply` 校验三处注册（名称 / key / id）、译文字典，并渲染每个界面的首屏状态。

### 校验

- `node smoke.mjs` → **68/68**
- 临时 profile 里真实启动 `dsh web`（`dsh plugin add D:\Git\dsh-image-gen` 链接安装）：
  - 启动成功 = `client.js` 与 `index.js` 都能被真实组合加载
  - `GET /api/imagegen/status` 未认证 → **401**；换取 cookie 后 → **200**，读到的正是本机真实凭据面
  - `POST /api/imagegen/test` → 真实探测 `https://cf.api.fan/v1/models` 得 **HTTP 200**
  - `update` 的非法地址 / 未知字段 → **400** 且不落盘；`image?id=nope` → **404**
  - 客户端 bundle 由 `/plugins/??dsh-imagegen/client.js` 送出，内容含新的两个 slot 注册
  - 验证结束后删除临时 profile；真实 `~/.dsh/.credentials.yaml` 与状态目录均未被改动

### 已知缺口

- **客户端界面的实际 DOM 渲染仍未经自动化验证**（本机没有浏览器自动化）。
  VM 覆盖到了「模块能加载、三处注册正确、每个界面首屏能渲染」，但点击、灯箱、剪贴板这些
  交互行为仍需在真实 GUI 里看一眼。
- **没有自带缩略图**：不引入图像解码库，缩略图就是原图字节 + `loading="lazy"` + 长缓存。
  一页 24 张时只请求可见的那几张；把输出目录指向巨型 PNG 且一次列出几百张会更费流量。

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
