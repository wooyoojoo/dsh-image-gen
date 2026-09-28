# dsh-imagegen

一个独立于 DSH 仓库的 Harness 插件（bundle）：注册 `generate_image` 工具，用第三方 key 调用 OpenAI 兼容的生图接口，把图片落盘到工作区。

它 **只 import `node:` 内置模块**，不 import 任何 `@deepseek-ai/dsh-*` 包，也没有构建步骤 —— 源码即产物，所以 git / tarball / 目录链接三种装法跑的是同一份文件。取舍理由见文末「设计取舍」。

## 装一次，之后什么都不用加

仓库：**<https://github.com/wooyoojoo/dsh-image-gen>**

### 一键安装 / 更新（推荐）

**只有一个文件**：`install.cmd`（双击即可，或在终端里跑）。

```powershell
.\install.cmd                              # 装或更新到最新（幂等：重复跑就是更新）
.\install.cmd -Profile img                 # 装到别的 profile
.\install.cmd -Ref b398714                 # 固定到某个 sha（可复现）
.\install.cmd -DshDir D:\Git\deepseek-harness   # 显式指定 DSH 检出目录（给过一次就记住了）
.\install.cmd -Proxy http://127.0.0.1:20368     # 手动指定代理（none = 不用）
.\install.cmd -NoPause                     # 跑完不停（自动化调用用这个）
.\install.cmd -Help                        # 只看用法
```

**为什么是 `.cmd` 而不是 `.ps1`**（两个 Windows 特有的坑，都实测踩过）：

- 默认执行策略常是 `Restricted`，直接跑 `.ps1` 会被拒（`running scripts is disabled on this system`）；`.cmd` 不受该策略约束 → 双击就能用。
- PowerShell 5.1 把**无 BOM** 的 `.ps1` 按 ANSI 解码，中文串会乱到破坏语法解析（报的却是"缺闭合括号"，极易误诊）。
  这个文件把 PowerShell 代码**内嵌**在 `.cmd` 里，运行时用 `[IO.File]::ReadAllText`（.NET 默认 UTF-8）读自己再执行 → **BOM 这件事彻底不用管**。

> ⚠️ **这个文件必须保持 CRLF 行尾**：LF-only 的批处理会被 `cmd.exe` 错位解析（实测报 `+$m.Length)))" -Help was unexpected at this time`）。
> 所以 `.gitattributes` 里钉了 `*.cmd text eol=crlf`，而且**安装器故意不放进 npm 包** ——
> pnpm 物化 git 依赖时会把行尾写成 LF，那样包里就会是一份跑不起来的副本。
> **用法就是把它 clone 下来再跑**（仓库检出里一定是 CRLF）：
>
> ```powershell
> git clone https://github.com/wooyoojoo/dsh-image-gen
> cd dsh-image-gen
> .\install.cmd
> ```

脚本自己找 DSH 检出目录（`-DshDir` → 环境变量 `DSH_DIR` → **上次记住的**，记在 `$DSH_HOME/imagegen-install.json`，
**以后在哪跑都不用再给参数**），按需**套用 Windows 系统代理**（浏览器能上 GitHub 而 git 不能，就是因为它不读系统代理设置；
脚本只对本次命令设 `HTTP(S)_PROXY`，**不改你的全局 git 配置**），然后装/更新插件、跑一次离线 smoke 与 `--dump-config` 自检，
最后提示你**重启 DSH**。双击运行时窗口默认**暂停**等你按回车（否则跑完就关、看不到结果）。

> 非 Windows（macOS/Linux）用不了 `.cmd`：把内嵌的 PowerShell 段抽出来用 `pwsh` 跑，或直接用下面的手动命令（其实就一条 `pnpm`）。
> 脚本用 UTF-8 BOM 保存，Windows PowerShell 5.1 与 PowerShell 7 下中文都正常；非 Windows 上跳过注册表探测，代理用 `-Proxy` 指定。

### 手动命令

```powershell
# ① 从 git 装（推荐：pin 到 sha，任何机器一条命令，不需要构建许可）
pnpm dsh plugin --profile web add github:wooyoojoo/dsh-image-gen#<sha>

# ② 或用本地源码目录（改完即生效 —— 用**链接安装**时才成立）
pnpm dsh plugin --profile web add <plugin-source-dir>
#    代价：源目录不能搬走，搬了 profile 会加载失败

# ③ 或用 tarball（最稳，适合拷到离线机器）
cd <plugin-source-dir>
pnpm pack                                     # 产出 dsh-imagegen-0.3.0.tgz
pnpm dsh plugin --profile web add <plugin-source-dir>\dsh-imagegen-0.3.0.tgz
```

`<plugin-source-dir>` 是源码目录；本机当前克隆在 `D:\Git\dsh-image-gen`。**别把插件放进 harness 检出里** —— 那个路径不在它的 `.gitignore` 里。

装完按你平时的方式启动 GUI 即可，**不需要 `--patch`、不需要任何 flag**，工具在新会话里自动出现。想在独立 profile 里跑（和主环境隔离）：

```powershell
pnpm dsh --profile img --from-default-profile web
pnpm dsh plugin --profile img add github:wooyoojoo/dsh-image-gen#<sha>
pnpm dsh --profile img
```

### 改了代码之后怎么生效

`web` profile 会实时重载 patch **文件**，但 `index.js` / `client.js` 本身要重启才生效（内置组合里 `cordis-plugin-hmr` 是 disabled 的）：

- **只改 profile 的 patch 文件**（config 覆盖之类，`$DSH_HOME/profiles/web/cordis.patch.yml`）：存盘即生效，不用重启。
- **改了 `index.js` / `client.js`**：重启 `dsh web`。链接安装下读到的是源目录的文件；git 与 tarball 装进去的都是**打包快照**，得重新 pack + 重装（建议同时把 `package.json` 的 version 加一位，免得 pnpm 按同版本跳过）：

  ```powershell
  cd D:\Git\dsh-image-gen
  pnpm pack
  pnpm dsh plugin --profile web add .\dsh-imagegen-0.3.0.tgz
  ```

  profile 的 `package.json` 记的是 tarball 的**绝对路径**：别删、别移动，否则那里再跑 `pnpm install` 会失败（已装好的副本不受影响，照常启动）。

链接安装（`pnpm dsh plugin --profile web add D:\Git\dsh-image-gen`）省掉 pack + 重装这一步，代价是**源目录不能搬走** —— 搬了 profile 会加载失败。

## 配置 API key 和 endpoint

两个值都在**每次调用时**从凭据面读取，所以放一次就长期生效，轮换 key 或换中转也不用改配置。放在 `%USERPROFILE%\.dsh\.env`：

```ini
IMAGE_BASE_URL=https://relay.example.com/v1
IMAGE_API_KEY=sk-...
```

查找优先级（由 DSH 的凭据服务定义）：启动环境变量 > 存储的凭据文件（`~/.dsh/.credentials.yaml`，设置界面写的 key 落在这里）> 工作区 `.env` > `~/.dsh/.env`。`IMAGE_BASE_URL` 也可以直接写进 profile 的 `cordis.patch.yml`（见「配置字段」）。

**改完 `.env` 必须重启才生效。** DSH 在启动时把 `~/.dsh/.env` 和工作区 `.env` 快照进 launch environment（`credentials-local` 的 `.env` 回退读的是那份快照，不是每次读盘），运行中的进程读不到新值。已经配好之后再轮换 key 则是即时生效的 —— 那是凭据文件（有 watch），不是 `.env`。

**没配置也能正常启动**：工具照常出现在列表里，被调用时返回一条可操作的错误（说明该设哪个变量）。这是刻意的，和 `tool-web` 在 provider 不可用时的行为一致。

`baseUrl` 解析规则 —— 以下几种写法都指向同一个端点（`edits` 是同一个 base 的另一个尾段，粘贴任一端点的完整地址都能互相推导）：

| 写法 | 结果 |
|---|---|
| `https://relay.example.com` | `…/v1/images/generations` |
| `https://relay.example.com/v1` | `…/v1/images/generations` |
| `https://relay.example.com/openai/v1/` | `…/openai/v1/images/generations` |
| `https://relay.example.com/v1/images/generations` | 原样使用 |
| 上面任一写法 + 调用时给了 `image` | 同一个 base，尾段换成 `…/images/edits`（含"粘的是完整 generations 地址"那种写法） |

## 在 DSH 的「插件」页里管理

侧边栏「插件」→ 打开 **dsh-imagegen** 这一项，页面上有两块：

**① 配置区**（`plugins.bundle.config`）

| 控件 | 写到哪里 | 生效时机 |
|---|---|---|
| 请求地址、API KEY | 凭据存储 `~/.dsh/.credentials.yaml` | **下一次调用**，不用重启 |
| 模型 / 尺寸 / 质量 / 超时 / 输出目录 | `$DSH_HOME/imagegen/config.json` | **下一次调用**，不用重启 |
| （按钮）测试连接 | 不发请求给模型，只 `GET {base}/v1/models` | 立即 |

优先级：**插件页覆盖 > cordis 配置 > 内置默认**，每个字段下面都会写明它现在来自哪一层：

- 地址 / KEY 来自**启动环境变量**时显示**只读** —— 凭据面拒绝写入被启动环境遮住的值，硬写只会让人误会；被 profile 的 `config:` 固定住时同样只读，并直接说明「改 profile patch」。
- 五个覆盖字段显示「已在插件页覆盖」或「来自 profile 配置或内置默认」；**清空该输入框再保存 = 恢复下层值**。
- KEY **永远不回显**：只显示「已配置 / 未配置」，留空表示不修改；有已保存的 KEY 且可写时，多一个「清除已保存的 KEY」。

「测试连接」为什么是 `/v1/models`：这是能同时证明地址和 KEY 都通的最便宜请求。中继只实现图片端点、不实现 `/models` 时会返回 404/405，这时界面会**明确说"探测无法判定"**而不是报失败 —— 那种情况下请直接生成一张图来确认。

**② 已生成图片画廊**（`plugins.detail.section`，同一页往下滚）

每次生成都会往 `$DSH_HOME/imagegen/images.json` 追加一条记录（prompt、模型、尺寸、质量、模式、输入图、字节、宽高、附件 id，以及响应里的 `usage`），画廊按它倒序列出，每张图可以：

- **点击放大** —— 灯箱预览（复用仓库 UI 原语那套缩略图尺寸规则）
- **打开** —— 交给系统默认应用
- **定位** —— 在文件管理器中选中（Windows `explorer /select`，macOS `open -R`，Linux `xdg-open`）
- **复制路径**
- **再次编辑** —— 把 `{"prompt": …, "image": […]}` 这段 `generate_image` 参数复制到剪贴板，粘回输入框再说明要改什么（插件页不能替你调模型，这是刻意的）
- **删除** —— 两步确认，删文件 + 删索引记录，不可撤销

图片按 **id** 取（`GET /api/imagegen/image?id=…`），只服务索引里登记过的记录；索引最多保留最新 500 条，更早的文件留在磁盘上但不再列出。

记录里的 `usage` 直接来自响应体，只保留 `input_tokens` / `output_tokens` / `total_tokens` 与 `input_tokens_details` 这几个数值字段（服务方不回 `usage` 时这条记录就没有这个字段）。它记的是**那次调用**的用量：`n > 1` 时同一份会出现在该次调用的每条记录上，因为索引是按图存的、没有「调用」这一层。要比较档位成本，就用同一个 prompt 换 `quality` / `size` 各跑一次，对着这里的 `output_tokens` 看（画廊每张图的元信息里也会显示它）。

> 这一页的所有请求都走 `/api/imagegen/*`，位于连接层的认证围栏之下 —— 未认证请求拿到 401。
> `connection` 是**可选**依赖（挂在子 fiber 上），所以在没有 Web 组合的 headless profile 里，工具照常注册，只是没有这些路由。

## 配置字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | 无 | 显式 API 基址。给了就在**加载期**校验（格式错立刻报错）；不给则每次调用从 `baseUrlEnv` 解析 |
| `baseUrlEnv` | `IMAGE_BASE_URL` | 承载 API 基址的凭据名 |
| `apiKeyEnv` | `IMAGE_API_KEY` | 承载 key 的凭据名 |
| `apiKey` | 无 | 明文 key，仅调试；优先用 `apiKeyEnv` |
| `model` | `gpt-image-2.5-flare` | 生图模型 id |
| `size` | `1024x1024` | 传给接口的 `size` |
| `quality` | 不传 | 质量档。**本机中继只认 `low`/`medium`/`high`/`auto`（最高 `high`）** —— 传其它值会得到 `Invalid value: … Supported values are: …` 的 400。不传则由服务方决定（等于 `auto`） |
| `background` | 不传 | 透传字段的**默认值**（如 `transparent`）。单次调用的 `background` 覆盖它 |
| `outputFormat` | 不传 | 透传字段的默认值（`png`/`jpeg`/`webp`），落成请求里的 `output_format` |
| `timeoutMs` | `300000` | 单次调用预算。生图常见 30–120 秒，别调太小 |
| `outputDir` | `process.cwd()` | 图片保存目录，自动创建 |

其中 `model`、`size`、`quality`、`timeoutMs`、`outputDir` 五个可以在插件页改（见上一节），写进插件自己的覆盖文件，**优先级高于这张表里的 cordis 配置**；`baseUrl` / `apiKey` 也能在插件页改，但写的是凭据存储。每个字段在页面上都会标明当前来自哪一层。

要固定某台设备的值，在 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 里按 `id` 覆盖这一行 —— **覆盖是整行替换 config，不深合并**，必须重述该行所有键：

```yaml
- id: imagegen
  config:
    baseUrl: https://relay.example.com/v1
    apiKeyEnv: IMAGE_API_KEY
    model: gpt-image-2.5-flare
```

## generate_image 是工具，不是模型

这里有两层模型，别混：

- **决定"要不要生图"的模型**：你当前会话路由到的对话模型（DSH 里配的 DeepSeek 等）。它通过 **tool calling** 调用 `generate_image`，就像调用 `read_image`、`bash` 一样。
- **真正画图的模型**：上面配置表里的 `model` 字段，默认 `gpt-image-2.5-flare`，由第三方接口执行。它不在任何模型选择器里，因为它不是对话模型。

## 工具参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `prompt` | string，必填 | 画什么；给了 `image` 时是"要改什么" |
| `model` / `size` / `quality` | string | 与配置字段同名，单次调用覆盖 |
| `n` | integer 1–4 | 一次出几张 |
| `image` | string 或 string[] | **输入图路径**（本地文件）。给了任意一张就走 `…/images/edits`（multipart 上传），最多 8 张 |
| `mask` | string | 可选遮罩路径：**透明区域**才是会被重画的地方。必须同时给 `image` |
| `background` | string | 透传：`transparent` 要抠好的透明底（服务方支持才有效，通常配 png/webp） |
| `output_format` | string | 透传：`png` / `jpeg` / `webp` |
| `seed` | integer 或 string | 透传：服务方认 seed 时才有意义 |
| `input_fidelity` | string | 透传：例如 `high`，让结果尽量贴近输入图 |
| `extra` | object | **逃生口**：任意其它字段原样进请求体；同名时显式参数优先 |
| `providerOptions` | object | `extra` 的别名；两个都给时 `extra` 优先 |
| `outputDir` | string | 本次落盘目录；相对路径相对配置的 `outputDir` 解析 |

两个例子：

```jsonc
// ① 纯文生图 → POST …/v1/images/generations（JSON body）
{ "prompt": "a chubby grey fish hook, flat cartoon sticker, thick white outline",
  "background": "transparent", "n": 2 }

// ② 改图 → POST …/v1/images/edits（multipart：image + mask + 其余字段）
{ "prompt": "keep the exact curve, make the metal arm 40% thicker",
  "image": ["D:/art/hook.png"], "mask": "D:/art/hook-mask.png",
  "input_fidelity": "high", "output_format": "png", "outputDir": "assets/generated" }
```

**为什么 `image` 是路径而不是附件 id**：本包不 import 任何 DSH 包，读附件要走附件服务，会打破这个取舍。输入图请先落到本地磁盘再传路径（相对路径相对进程工作目录解析）。

**服务方差异**：`background` / `seed` / `input_fidelity` / `extra` 是**原样透传** —— 插件不判断服务方是否支持。若中转返回 4xx 且报文提到某个字段，那就是那一层不支持，去掉即可。

### 本机中继（`cf.api.fan` + `gpt-image-2.5-flare`）实测能力矩阵（2026-09）

真打了 7 次调用量出来的，不是照文档推的。换中继或换模型请重测：

| 能力 | 结果 |
|---|---|
| `background: "transparent"` | ✅ 真透明底（`alpha min=0`、四角全 0、不透明约 9%） |
| `n` 1–4 / `outputDir` / `output_format`（png、webp）/ 非方形 `size` | ✅ 全部生效 |
| `quality` | ✅ 生效，但**枚举只有 `low`/`medium`/`high`/`auto`（最高 `high`）**，且 `low` 降质明显（切割发毛、渐变起噪），只适合试形状 |
| `image` → `/images/edits`（multipart 上传） | ✅ 可用；输入图的透明底会保留 |
| `mask` | ⚠️ 能传上去，**但模型不听**：带/不带 mask 两次编辑的轮廓 IoU 是 0.888 vs 0.893 |
| `extra` / `providerOptions` | ✅ 确实到达线上（`extra:{seed:1}` 与具名 `seed` 报同一条错） |
| `seed` | ❌ `400 Unknown parameter: 'seed'`（generations 与 edits 都拒） |
| `input_fidelity` | ❌ `400 … does not support the 'input_fidelity' parameter` |

两条实践含义：**① 没有复现** —— `seed` 不可用，要比较就同一次多出几张；**② 编辑不是"局部重绘"** —— 实测相似度约 IoU 0.89，是"同一主体重画一遍"，`input_fidelity` 与 `mask` 都救不了。要"只改一处、其余逐像素不变"，请用确定性的程序化处理（裁剪 / 改色 / 形态学加粗），而不是让模型改图。

## 会话里显示图片

工具结果含两样东西：一段文本（路径清单），外加每张图一个 `{ type: 'image', attachment }` 块。这个块解决三件事：

- **模型看得到** —— 图片作为 tool-result 内容进入请求，模型不用再调 `read_image` 就能看到自己刚画的东西（文本模型路由会被 DSH 自动替换成占位符）。
- **可持久化、可重放** —— 图片提交进 DSH 的附件存储（内容寻址，`~/.dsh/attachments/v1/`），会话日志里存的是引用，重启与回放都在。
- **Web 端能拿到字节** —— 客户端按引用向会话请求图片，服务端会校验该附件确实被这个会话引用过。

文本里的路径按**正斜杠**拼（`D:/dir/image.png`）。Windows 原生反斜杠在 Markdown 里是转义序列：`\.` 会被还原成 `.`，
模型把原生路径粘进正文时，轻则指向一个不存在的文件（`/api/file` 404，界面显示"图片无法预览"），
重则整段 `![](...)` 压根不被解析、原样显示成文字。正斜杠在所有平台上指向同一个文件，`read_image` 与 `image`
参数也都认，所以**模型可见的文本统一用它**；结构化结果里的 `path` 保持原生拼写，供宿主侧打开 / 定位使用。

但**光有 image block 还不够**：内置的图片卡片把工具名写死了（`if (call?.name !== 'read_image') return null`），别的工具返回 image block 会落到通用卡片上、被 `JSON.stringify` 成原始 JSON。所以这个包还带一个**客户端半边** `client.js`，认领 `tool.call.toolview` 里 `generate_image` 这个键：

```js
ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
  { name: 'tool.call.toolview', key: 'generate_image' },
  GenerateImageRow,
))
```

卡片用 `props.loadImage(attachment)` 换成 object URL 自己渲染 `<img>` —— **不声明 `tool.call.images` 子槽**（那个已被 `read_image` 占用，第二个声明会在加载时抛错，等于启动失败）。

`client.js` 一共认领三个键：上面这个工具卡片，加上插件页的 `plugins.bundle.config`（key = `dsh-imagegen`）与 `plugins.detail.section`（画廊，只在 subject 是本 bundle 时渲染）。后两个是 `ui-plugin-manager` 自己声明的槽位，所以第三方 bundle 不用改 DSH 就能挂上去。

它是**手写产物、没有构建步骤**：浏览器端只执行 `window.__ModuleLoader__.load({ id, factory })` 这种 classic script，格式就是仓库里 `packages/client/tsdown.client.ts` 产出的那套，所以脱离仓库也能零工具链发布；代价是要写 `React.createElement` 而不是 JSX。认领了这个键，这个工具的**所有**状态就都由这张卡片负责（包括进行中和失败），所以卡片同时处理 running / 无附件 / 加载失败三种情况。卡片里少量文案是硬编码英文，没走仓库的 locale 字典 —— 那由 `verify-client-ui-i18n` 管，本包不在该门禁范围内。

## 自检

离线（不需要 endpoint、不需要 key，网络被 stub 掉）：

```powershell
cd <本包目录>
node smoke.mjs          # 或 pnpm test
```

覆盖（**70 项**）：

- **纯函数**：端点解析（含 generations ↔ edits 推导）、参数校验（`image`/`mask`/`background`+`jpeg` 冲突/`extra` 合并/未知参数拒绝）、两种请求体构造、模型可见文本里的路径拼法、响应用量字段的读取与清洗。
- **对本地 stub 服务真跑一遍 `execute`**：JSON 与 multipart 两条路 + 落盘字节比对 + 读不到文件/非图片的报错 + 索引记录内容（含 `usage`）。
- **插件页那一面**：状态目录与覆盖文件的读写与清洗、凭据的写/清除/被启动环境遮挡或被 profile 固定时的拒绝、图片索引、**全部 8 条路由**（含「按 id 而非路径取图」和「open/reveal 对未知 id 不启动任何进程」）、连通性探测的三种结果。
- **客户端半边**：把 `client.js` 放进 `node:vm`、按模块加载器的方式执行，用桩 React 驱动 `apply`，校验三处注册的名称/key/id 与译文字典，并渲染每个界面的首屏状态 —— 这同时证明**拿不到 `ui-primitives` 时会退回原生元素而不是加载失败**。

> ⚠️ 仍然没有被自动化覆盖的是**真实 DOM 里的交互**（点击、灯箱、剪贴板、文件管理器定位）—— 本机没有浏览器自动化，这部分只能在真实 GUI 里看。
> 跑 smoke **不需要** key、不需要 endpoint，也不会碰你真实的 `~/.dsh/imagegen`：它在开头就把 `DSH_HOME` 指向临时目录，结束时还原。

升级 DSH 之后按顺序跑，哪步红就是哪层的问题：

1. 上面的 smoke —— 插件本体行为，含客户端半边的加载与首屏渲染
2. `pnpm dsh --profile web --dump-config` —— 组合树仍能解析，`imagegen` 层还在
3. 启动后让模型调一次 `generate_image`，再打开插件页看一眼配置区与画廊

改动 `client.js` 后要额外确认一件事：**客户端半边写坏会让整个 GUI 起不来**（`dsh.client` 声明了却找不到 `./client` 时，加载期就报错），所以改完先跑 smoke、再单独启动一次 `dsh web` 确认能起来、最后才让 GUI 重启。

第 1 步绿、第 2/3 步红，说明 DSH 侧的加载契约变了，改 `index.js` 里对应的调用即可：工具是 `ctx.tools.register`，插件页那两块是 `ctx.inject(['connection'], …)` 里的 `connection.fetch.register` 和 `client.js` 里的三处 `ctx.slots.register`。

## 移植到其它设备

新设备上只需要再写一次 `~/.dsh/.env`，装法用上面「手动命令」里的任一种（tarball 最稳，git 可 pin 到 tag 或 sha）。

git 和 tarball 都不需要 pnpm 的 `allowBuilds` 放行，因为包里没有 `prepare`、也没有 TypeScript 源码 —— 拉下来就是可执行文件。这是刻意的：那条放行等于允许包在本机安装时执行代码。

## 设计取舍

- **零 `@deepseek-ai/dsh-*` 运行时导入。** 用 `ctx.tools.register()` + 原始 JSON Schema，而不是 `defineTool`；用自己写的 `resolveConfig`/`parseArgs`，而不是 Schemastery 的 `Config`。DSH 是 pre-stable，这样升级最多是注册契约变，不会连模块解析一起挂。
- **无构建步骤。** 纯 ESM JS，源码即产物。
- **endpoint 和 key 都在调用时解析。** 自包含的错误（显式 baseUrl 格式错、config 字段类型错）在加载期就报错；只有凭据面能给的值留到调用时，因为它们本来就会轮换。
- **凭据请求 `redirect: 'error'`。** 不把 `Bearer` 自动转发到别的 origin。
- **UI 挂在既有槽位上，不碰 DSH 源码。** 配置区与画廊认领的是 `ui-plugin-manager` 自己声明的槽位，控件来自 shell 预置的 `ui-primitives`（拿不到就退回原生元素）。代价是样式只能用内联样式而不是 CSS Modules，文案走自己注册的 `ctx.locale` 命名空间而不是仓库的类型化字典。
- **能改的值分两处存，各按各的语义来。** 地址和 KEY 交给凭据面（`set`/`unset`，有 watch、下一步调用就生效，且 `describe` 从不回显密钥）；其余五个字段写插件自己的 JSON 覆盖文件。没有为了「统一」把密钥塞进配置文件。
- **不给插件页开任意路径读取。** 图片只按索引里的 id 取，页面拿不到「读任意文件」的能力。

## 已知限制

- 只支持 OpenAI 兼容的 `POST {base}/v1/images/generations` 与 `POST {base}/v1/images/edits`；Gemini 原生（nano banana）、以及各家私有形态仍需另加请求/响应分支。
- **编辑的输入图只支持本地文件路径**（PNG/JPEG/WebP/GIF），不支持 DSH 附件 id；`mask` 一般要求与第一张图同尺寸同格式。
- `background` / `seed` / `input_fidelity` / `extra` 是**盲透传**：插件不知道服务方认不认，报错原样带回来。
- 结果**同时**给出文件路径和 image 块：模型不用再调 `read_image` 就能看到刚画的图；只有路由不吃图片（收到 DSH 的占位符）时才需要 `read_image`，而它要求当前路由模型声明图片输入。
- 用 Node `fs` 直接写盘，不走 `ctx.fs` 的沙箱策略；写入位置完全由 `outputDir`（配置、插件页覆盖或单次参数）决定。
- **画廊没有真缩略图**：不引图像解码库，缩略图就是原图字节 + `loading="lazy"` + `private, max-age=31536000, immutable`。一页 24 张时只请求可见的那几张，但输出目录里全是几 MB 的大图、又一次性列几百张时会比较费流量。
- 索引最多保留最新 **500** 条；更早的图片仍在磁盘上，只是不再出现在画廊里（也不占索引体积）。
- **插件页界面的交互行为没有自动化测试**（点击、灯箱、剪贴板、系统定位），只有加载与首屏渲染被 VM 覆盖；真要改动它们，请在真实 GUI 里过一遍。
- 只服务**生成流程写出来的**图片：手工放进输出目录的文件不会进索引，因而也不在画廊里。
