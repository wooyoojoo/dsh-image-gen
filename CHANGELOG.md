# Changelog

## 0.5.1 — 2026-09-29

**`layout` 也适用于不透明场景图**。实战暴露的缺口：0.5.0 的布局文案里写死了「完全透明背景」，于是"一张老照片里头发飞起来"这类**保留背景**的动画没法用 `layout`，只能手写网格规范。

### 变更

- **`layoutClause(layout, { transparent })`** 按请求的 `background` 分支：
  - `background: "transparent"`（抠底立绘）→ 仍然要求"只有角色不透明、无填充背景、无格线边框"；
  - 未指定或其它值（不透明场景）→ 换成 **「背景是每一帧的一部分：所有格子保持相同的构图、镜头与场景，只改 prompt 指明会动的东西」**，并去掉"留边距"那句（场景图本就填满格子）。
- `composePrompt` 用 `request.background === 'transparent'` 决定分支。**这比原来更正确**：光靠文案本来也要不到 alpha，必须 `background: "transparent"` 服务方才真给透明；原来那句在不透明请求里描述的是没被要求的东西。
- **默认 `outputDir` 不再是 `process.cwd()`，改为 `<DSH_HOME>/imagegen/output`。** 实测证据：同一份索引里的图片散在 **6 个目录** —— 检出的 `.artifacts`（35 张）、**桌面**（3 张）、`.dsh-artifacts/…`（2 张）、`~/.dsh/imagegen-output`（1 张）等。根因是默认值取"启动时的当前目录"：从桌面启动器起来的会话把图放桌面，从检出启动的放检出，而**用户配置里根本没有 `outputDir`**（页面覆盖文件里只有 `quality` 与 `model`）。现在默认落在插件自己的目录下，与启动位置无关；`config` 的 `outputDir` 与插件页覆盖仍然优先，`buildStatus.defaults` 如实上报这个默认值。
- **状态接口逐字段上报来源**（`sources`）：`override` / `config` / `default`。插件页据此显示精确标签 —— 「已在插件页覆盖」/「来自 profile 配置（可在此覆盖）」/「内置默认值（profile 与本页都没配）」。此前后两种情况共用一句「来自 profile 配置或内置默认值」，实测把用户**从没配过**的目录显示成了他的配置（他以为桌面是配置，其实是启动目录）。
- **按会话隔离落盘**：每次生成写入 `<outputDir>/sessions/s-<会话 id 后 12 位>/`，记录里带 `session` 字段。**目录名用会话 id 而不是会话名** —— 标题是 `session/title` 事件、随时可改，用它当目录名会让改名变成"文件失联"；id 不变。`exec.agent.session.id` 就是那个稳定标识（没有会话上下文时——例如裸测试派发——不嵌套，写进指定目录）。
- **`tools/relocate.mjs`：一次性搬迁已有资源。** 把索引里散落在多处（检出、桌面、`~/.dsh/imagegen-output`……）的文件搬进统一资源根并改写索引：属于动画的保留 `animations/<集名>/`，其余进 `legacy/<原目录>/` 以保留来源。逐文件"复制 → 校验尺寸 → 再删源"，每条记录成功即回写索引，中断也不会留下指向空文件的记录。实测：43 条记录 / 55 个文件 / 68 MB 全部落到 `D:\dsh-art`，0 条残留。
- `tools/library.mjs` 的资源根解析调整：**优先用配置里的 `outputDir`**，其次才跟随最新静态图，并在回退时剥掉 `sessions/<id>` 一层（这样动画永远不会嵌进某个会话的目录里）。
- `layout` 的参数说明补上分支行为；`docs/on-twos.md` 同步。

### 工具

- **`tools/library.mjs`：资源归档与画廊登记。** `make-gif` / `make-apng` 新增 `--set=<集名>` / `--into=auto|<dir>` / `--publish`：带集名时输出落到 `<资源根>/animations/<集名>/`，`--publish` 再把帧收进该目录并追加一条画廊记录（`mode: "animation"` + `animationId` + 帧数/格数/时长/清单）。资源根默认跟随**最新一条静态图**所在目录 —— 只跟随静态图，否则动画会一层层套进自己的子目录（实现时踩到并已修）。此前 tools 产出的动图既不在画廊里、位置也和静态图分家。
- **`tools/slice.mjs` 修了一个真 bug**："最少墨迹"在**并列最小**时会选窗口里第一条，把栅格拖歪（实测 48px）→ 改为并列时取离标称最近的一条；并新增 `--cuts=nominal`，给"每条切线都是满墨"的不透明场景表直接用标称栅格。
- 画廊路由用的是普通读文件，**没有工作区边界**，所以资源根可以放在检出目录之外：把插件页的 `outputDir` 指到检出之外（例如 `D:/dsh-art`），静态图与动画就都不会随重拉仓库消失。

### 校验

- `node smoke.mjs` → **94/94**（新增五条：布局的场景分支、默认输出目录是插件状态目录、状态接口如实上报来源、会话各自成目录、无会话时不嵌套）
- 端到端实测：用这套分支跑通了 12 帧「头发整片升天再落到脸上」的 GIF（两张 3×2 精灵图，第二张靠 `animationRole: "frame"` 自动锚定第一张，记录里 `refs=key+pose`）
- 归档实测：`--set=hair-ascend --publish` 之后，索引里多了两条 `mode: "animation"` 记录（GIF 与 APNG 各一条，`animationId=hair-ascend`、12 帧、29 格、1.208s、各带 12 个帧文件），目录自包含（动图 + 清单 + `frames/`）

### 已知缺口

- 场景图切片要 `--cuts=nominal --anchor=box`（场景填满格子，没有间隙可找、脚底锚点也无从判断）。这两个开关已经在工具里，但**插件侧还不会自动选** —— 它记下了 `layout`，没记"这是场景表还是抠图表"。
- 画廊还不会**按 `animationId` 分组**：动画已经作为独立记录出现，但一套动画的帧序与总成本仍要自己数。

## 0.5.0 — 2026-09-29

**精灵图与动画工作流**：把「生成 2D 动作动画」这条路上反复手写的东西变成插件的参数与工具 —— 布局、动画集、参考图角色，加上 `tools/` 下六个零依赖脚本和一份方法论文档。

### 新增

- **`layout` 参数**：`2x2` / `3x2` / `4x2` / `2x3` / `6x1`。插件把网格、阅读顺序、透明底、「不许跨格」「不许出现格线/边框/字幕」等规则拼进 prompt（`layoutClause`），不必每次重写；单行布局会额外提示格子过窄（实测单行 6 帧每格仅 256px，接缝墨迹可达 178px）。
- **`animationSet` / `animationRole`**：`key`（定版帧）/ `frame` / `smear` / `vfx`。第一次用 `key` 建立动画集，之后同集的每一帧**自动**把定版帧挂成第一张参考图，并在 prompt 里声明它是「本集的定版帧：对齐镜头、比例、画风与构图，但不要抄它的姿势」。集与帧序号记在 `$DSH_HOME/imagegen/animations.json`；给未知集名会被直接拒绝（提示先出定版帧）。
- **`image` 支持角色**：`{ path, role }`，role ∈ `character` / `key` / `camera` / `proportions` / `pose` / `style` / `reference`。插件把它们写成一句 `Reference images, in order: 1) …`。动机是实测：未声明角色的镜头参考图会把它的画风、配色和背景一起带进来。
- **索引记录新字段**：`layout`、`referenceRoles`、`animationId` / `animationRole` / `frameIndex`，以及只在组合过 prompt 时才出现的 `promptSent` —— `prompt` 始终是调用者自己写的话。
- **`tools/`：六个零依赖脚本 + 共享模块**
  - `probe-sheet` —— alpha / 每格包围盒 / 接缝墨迹体检
  - `frame-tool` —— 单格裁/贴；粘贴前先擦格，并自检「上一版残留像素」为 0
  - `slice` —— 按空白找刀口 + trim + **脚底锚点**对齐（`--anchor`）+ `--canvas`，装不下就报错而不是裁切
  - `normalize` —— 单独生成的帧按**脸部连通域**对齐到序列尺度（剪影类指标在 smear 帧上会失真）
  - `make-gif` —— 自带 GIF 编码器：中位切分量化 + LZW + GIF89a 动画块，不需要 ffmpeg
  - `make-apng` —— 无损、真半透明、延迟是**精确分数**；自检到「把最后一帧解码回来逐字节相同」
  - `frames.mjs` —— 共享的收集/加载/裁剪/曝光表/交付清单
- **`--exposures=` 与 `--manifest=`**：用动画师的「格」（24fps）排节奏；`--manifest=exposure.json` 导出引擎直接读的交付清单（每帧格数 + 画布 + 裁剪框）。
- **`docs/on-twos.md`**：方法论文档 —— on-twos 与曝光表、打击感曲线、**AI 生成版的五条额外规则**（6 帧上限 / 快段只放一张画 / smear 的正误写法 / VFX 不烘焙进角色序列 / 单独帧必须归一化）、完整制作流程、成本参考、坑清单速查。

### 校验

- `node smoke.mjs` → **89/89**（新增 10 项：布局展开与未知布局、参考图角色与非法角色、动画集锁定与自动挂参考、未知集拒绝、`prompt` 与 `promptSent` 的分离）
- `node --check` 对 8 个工具脚本全部通过
- 实测回归：GIF 写出器改用共享 `frames.mjs` 之后，输出与重构前 **SHA-256 完全一致**
- 尺度归一化实测复现：单独生成的 impact 帧对命中帧 `x0.6672`
- 顺带修正 `install.cmd` 收尾提示里写死的「14 个参数」（已过期），改为按名字列出并指向 README

### 已知缺口

- **成套成本没有汇总**：单图 `usage` 已记录，「这一套动画花了多少」仍要人工累加；画廊按动画集聚合是客户端 `client.js` 的活，本轮没做。
- **量测能力留在 `tools/`**：插件零依赖是刻意设计，不值得为 alpha 统计引入 `sharp`；插件页只显示 relay 返回的元数据。
- **动画集只记录归属**，不校验播放顺序 —— 曝光表是交付物（`exposure.json`），不是插件状态。
- `tools/` 与 `docs/` **不进发布包**（`files` 未列），它们是仓库内的开发资产。

## 0.4.0 — 2026-09-29

**按 DSH 创造模式的插件规范收口**：去掉对 Harness 客户端包 `@deepseek-ai/dsh-client-ui-primitives` 的运行时 import，补齐灯箱缺掉的那一半行为，并让插件页的每个操作都能从对话里调用。

### 变更

- **客户端半边不再 import 任何 `@deepseek-ai/dsh-*` 包。** `Button` 与 `Input` 改成本包自带的控件：逐条照抄宿主 `ui-primitives` 的 `Button.tsx` / `Input.tsx` 与它们的 CSS module，类名加 `imagegen-` 前缀，颜色只引用 `--dsw-*` 令牌，样式元素随用到它的界面一起挂载（因此也随卸载消失）。原先「拿不到就退回原生元素」的防御一并删除 —— 它护得住「包不在」，护不住「包在但 prop 契约变了」，而后者会在渲染时抛异常、把这个槽位条目整个清空，连工具调用的失败状态一起消失。顺带删掉从未使用的 `Tag` 别名，并让 `variant` / `size` 不再被摊成 DOM 属性。
- **灯箱补齐宿主的行为**：打开时聚焦关闭按钮，Tab 圈在对话框内，关闭时把焦点还给打开它的控件；`role="dialog"` 现在**包住**图片与关闭按钮（此前它是个空盒子，两者是它的兄弟节点，`aria-modal` 因此名不副实）；Escape 改为捕获阶段监听并 `stopPropagation`。字面色值（`rgba(0,0,0,.72)`、`#fff` 等）换成 `--dsw-alias-bg-mask-1`、`--dsw-specific-input-major`、`--dsw-elevation-prominent`、`--dsw-focus-ring-*` 等令牌，明暗两套都由主题决定。
- **新增 `image_library` 工具**，把插件页的操作开放给 agent：`list` / `status` / `test` / `configure` / `delete` / `open` / `reveal`。页面与工具走同一组函数（新抽出的 operations 层：`listImages`、`deleteImage`、`handOffImage`、`testConnection`，加上原有的 `applyUpdate`、`buildStatus`），不存在两份实现；`opened`/`revealed` 这类只由页面完成的动作不需要工具。`configure` **拒绝**写 `baseUrl` 与 `apiKey`：端点与密钥只由用户写入。
- `apply` 现在注册两个工具；`generate_image` 自身的行为、参数与结果都没有变。

### 校验

- `node smoke.mjs` → **79/79**（新增 8 项：`image_library` 的 list / status / configure / 拒绝凭据 / 参数校验 / 按 id 删除 / 并发声明，以及「浏览器半边只向模块表请求 `react` 与 `react-dom`」——后者是硬约束，多要一个 specifier 就会让加载失败）
- `node --check` 对 `index.js`、`client.js`、`smoke.mjs` 全部通过

### 已知缺口

- 灯箱的焦点与 Tab 行为仍**没有自动化覆盖**（本机没有浏览器自动化）：VM 只验证了模块能加载、三处注册正确、每个界面首屏能渲染。这部分需要在真实 GUI 里过一眼。
- 样式仍以行内样式为主，只有控件与灯箱走了自带的类名；没有构建步骤就没有 CSS Modules。

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
