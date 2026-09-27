# dsh-imagegen

一个独立于 DSH 仓库的 Harness 插件（bundle）：注册 `generate_image` 工具，用第三方 key 调用 OpenAI 兼容的生图接口，把图片落盘到工作区。

它 **只 import `node:` 内置模块**，不 import 任何 `@deepseek-ai/dsh-*` 包，也没有构建步骤。这个取舍是为了让 DSH 升级和换设备都不影响它（见文末「设计取舍」）。

## 装一次，之后什么都不用加

仓库：**<https://github.com/wooyoojoo/dsh-image-gen>** —— 源码即产物，没有构建步骤，所以 git / tarball / 目录链接三种装法跑的是同一份文件。

### 一键安装 / 更新（推荐）

```powershell
# 装或更新到最新（幂等：重复跑就是更新）
pwsh -File install.ps1

# 常用变体
pwsh -File install.ps1 -Profile img                 # 装到别的 profile
pwsh -File install.ps1 -Ref b398714                 # 固定到某个 sha（可复现）
pwsh -File install.ps1 -DshDir D:\Git\deepseek-harness   # DSH 检出目录不在上层时显式指定
pwsh -File install.ps1 -Proxy http://127.0.0.1:20368     # 手动指定代理
```

脚本做四件事：① 找不到 DSH 目录时向上搜索（或用 `-DshDir` / 环境变量 `DSH_DIR`）；
② **自动套用 Windows 系统代理**（浏览器能上 GitHub 而 git 不能，就是因为 git 不读系统代理设置 ——
脚本只对本次命令设 `HTTP(S)_PROXY`，**不改你的全局 git 配置**）；③ 装完跑插件自带的**离线 smoke（31 项）**；
④ 再跑一次 `--dump-config` 确认 profile 组合树里 `imagegen` 层在位。最后会提示你**重启 DSH**。

> 脚本用 UTF-8 BOM 保存，所以在 Windows PowerShell 5.1 与 PowerShell 7 下中文都能正常显示；
> 非 Windows 上会跳过注册表探测（用 `-Proxy` 指定即可）。

### 手动命令（脚本做的事，或不想用脚本时）

```powershell
# ① 从 git 装（推荐：pin 到 sha，任何机器一条命令，不需要构建许可）
pnpm dsh plugin --profile web add github:wooyoojoo/dsh-image-gen#<sha>

# ② 或用本地源码目录（改完即生效 —— 用**链接安装**时才成立）
pnpm dsh plugin --profile web add <plugin-source-dir>
#    代价：源目录不能搬走，搬了 profile 会加载失败

# ③ 或用 tarball（最稳，适合拷到离线机器）
cd <plugin-source-dir>
pnpm pack                                     # 产出 dsh-imagegen-0.2.0.tgz
pnpm dsh plugin --profile web add <plugin-source-dir>\dsh-imagegen-0.2.0.tgz
```

`<plugin-source-dir>` 是源码目录；**本机当前克隆在** `D:\Git\dsh-image-gen`（历史：`~/.dsh/imagegen-src/dsh-imagegen` 是最早那份，原先的 `D:\Git\deepseek-harness\scratch-plugin\dsh-imagegen` 已删除，且那个路径**不在** harness 仓库的 `.gitignore` 里，别再往 harness 里放）。

装完之后就按你平时的方式启动 GUI，**不需要 `--patch`、不需要任何 flag**。工具在新会话里自动出现。

想在独立 profile 里跑（和主环境隔离）：

```powershell
pnpm dsh --profile img --from-default-profile web
pnpm dsh plugin --profile img add github:wooyoojoo/dsh-image-gen#<sha>
pnpm dsh --profile img
```

改代码时用 overlay（`web` profile 会实时重载 patch **文件**；改 `index.js` 本身要重启 —— 内置组合里 `cordis-plugin-hmr` 是 disabled 的）：

```powershell
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

### 改了源码之后怎么刷新已安装的副本

装进 profile 的是**打包快照**（git 与 tarball 都是），不是目录链接。改完 `index.js` 要重新 pack + 重装（建议同时把 `package.json` 的 version 加一位，避免 pnpm 按同版本跳过）：

```powershell
cd D:\Git\dsh-image-gen
pnpm pack
pnpm dsh plugin --profile web add .\dsh-imagegen-0.2.1.tgz
```

profile 的 `package.json` 记的是 tarball 的**绝对路径**，所以别删或移动那个 `.tgz`，否则 profile 里再跑 `pnpm install` 会失败（已经装好的副本不受影响，照常启动）。想省掉这一步就用链接安装：`pnpm dsh plugin --profile web add D:\Git\dsh-image-gen`，代价是**源目录不能搬走**，搬了 profile 会加载失败。

## 配置 API key 和 endpoint

两个值都在**每次调用时**从凭据面读取，所以放一次就长期生效，轮换 key 或换中转也不用改配置。放在 `%USERPROFILE%\.dsh\.env`：

```ini
IMAGE_BASE_URL=https://relay.example.com/v1
IMAGE_API_KEY=sk-...
```

查找优先级（由 DSH 的凭据服务定义）：启动环境变量 > 存储的凭据文件（`~/.dsh/.credentials.yaml`，设置界面写的 key 落在这里）> 工作区 `.env` > `~/.dsh/.env`。上面这个文件是最省事的写法；`IMAGE_BASE_URL` 也可以直接卸载 profile 的 `cordis.patch.yml` 里（见下）。

**改完 `.env` 必须重启才生效。** DSH 在启动时把 `~/.dsh/.env` 和工作区 `.env` 快照进 launch environment（`credentials-local` 的 `.env` 回退读的是那份快照，不是每次读盘），运行中的进程读不到新值。已经配好之后再轮换 key 则是即时生效的——那是凭据文件（有 watch），不是 `.env`。

**没配置也能正常启动**：工具照常出现在列表里，被调用时返回一条可操作的错误（说明该设哪个变量）。这是刻意的，和 `tool-web` 在 provider 不可用时的行为一致。

`baseUrl` 解析规则——以下是四种写法都指向同一个端点（`edits` 是同一个 base 的另一个尾段，粘贴任一端点的完整地址都能互相推导）：

| 写法 | 结果 |
|---|---|
| `https://relay.example.com` | `…/v1/images/generations` |
| `https://relay.example.com/v1` | `…/v1/images/generations` |
| `https://relay.example.com/openai/v1/` | `…/openai/v1/images/generations` |
| `https://relay.example.com/v1/images/generations` | 原样使用 |
| 上面任一写法 + 调用时给了 `image` | 同一个 base，尾段换成 `…/images/edits`（含"粘的是完整 generations 地址"那种写法） |

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

**为什么 `image` 是路径而不是附件 id**：本包只 import `node:` 内置模块，读附件要走 DSH 的附件服务，会把"零 `@deepseek-ai/dsh-*` 导入"这个取舍打破。所以输入图请先落到本地磁盘再传路径（相对路径相对进程工作目录解析）。

**服务方差异**：`background` / `seed` / `input_fidelity` / `extra` 是**原样透传**——插件不判断服务方是否支持。若中转返回 4xx 且报文提到某个字段，那就是那一层不支持，去掉即可；`mask` 一般要求与第一张图同尺寸同格式。

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

两条实践含义：**① 没有复现**——`seed` 不可用，要比较就同一次多出几张；**② 编辑不是"局部重绘"**——实测相似度约 IoU 0.89，是"同一主体重画一遍"，`input_fidelity` 与 `mask` 都救不了。要"只改一处、其余逐像素不变"，请用确定性的程序化处理（裁剪 / 改色 / 形态学加粗），而不是让模型改图。

## 会话里显示图片

工具结果含两样东西：一段文本（路径清单），外加每张图一个 `{ type: 'image', attachment }` 块。这一个块解决三件事：

- **模型看得到** —— 图片作为 tool-result 内容进入请求，模型不用再调 `read_image` 就能看到自己刚画的东西（文本模型路由会被 DSH 自动替换成占位符）。
- **可持久化、可重放** —— 图片提交进 DSH 的附件存储（内容寻址，`~/.dsh/attachments/v1/`），会话日志里存的是引用，重启与回放都在。
- **Web 端能拿到字节** —— 客户端按引用向会话请求图片，服务端会校验该附件确实被这个会话引用过。

但**光有 image block 还不够**：内置的图片卡片把工具名写死了（`if (call?.name !== 'read_image') return null`），别的工具返回 image block 会落到通用卡片上，被 `JSON.stringify` 成原始 JSON。所以这个包还带一个**客户端半边** `client.js`，认领 `tool.call.toolview` 里 `generate_image` 这个键：

```js
ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
  { name: 'tool.call.toolview', key: 'generate_image' },
  GenerateImageRow,
))
```

卡片用 `props.loadImage(attachment)` 换成 object URL 自己渲染 `<img>` —— **不声明 `tool.call.images` 子槽**（那个已被 `read_image` 占用，第二个声明会在加载时抛错，等于启动失败）。

`client.js` 是**手写的产物、没有构建步骤**：浏览器端只执行 `window.__ModuleLoader__.load({ id, factory })` 这种 classic script，格式就是仓库里 `packages/client/tsdown.client.ts` 产出的那套（banner + factory），所以脱离仓库也能零工具链发布。代价是要写 `React.createElement` 而不是 JSX，且不能用仓库的 tsdown 预置。

认领了这个键，这个工具的**所有**状态就都由这张卡片负责（包括进行中和失败），所以卡片同时处理 running / 无附件 / 加载失败三种情况。卡片里少量文案是硬编码英文，没走仓库的 locale 字典 —— 那是 `verify-client-ui-i18n` 管的事，这个包不在该门禁范围内。

## 自检

离线（不需要 endpoint、不需要 key，网络被 stub 掉）：

```powershell
cd <本包目录>
node smoke.mjs          # 或 pnpm test
```

覆盖：端点解析（含 generations ↔ edits 推导）、参数校验（`image`/`mask`/`background`+`jpeg` 冲突/`extra` 合并/未知参数拒绝）、两种请求体构造，以及**对本地 stub 服务真跑一遍 `execute`**（JSON 与 multipart 两条路 + 落盘字节比对 + 读不到文件/非图片的报错）。共 31 项。

> ⚠️ 这一版只覆盖**服务端半边**（`index.js`）。原先 `scratch-plugin/` 里那份 smoke 还会把 `client.js` 放进 VM、按模块加载器的方式执行并驱动卡片渲染；那份文件随源目录一起丢失了，**客户端半边目前只能靠启动 GUI 验证**。回迁到自己的仓库时建议补回来。

升级 DSH 之后按顺序跑，哪步红就是哪层的问题：

1. 上面的 smoke —— 插件本体行为，含客户端半边（在 VM 里按模块加载器的方式执行 `client.js`，驱动卡片渲染）
2. `pnpm dsh --profile web --dump-config` —— 组合树仍能解析，`imagegen` 层还在
3. 启动后让模型调一次 `generate_image`

改动 `client.js` 后要额外确认一件事：**客户端半边写坏会让整个 GUI 起不来**（`dsh.client` 声明了却找不到 `./client` 时，加载期就报错）。所以改完先跑 smoke，再单独启动一次 `dsh web` 确认能起来，最后才让 GUI 重启。

第 1 步绿、第 2/3 步红，说明 DSH 侧的加载契约变了，改 `index.js` 里对应的调用即可（只有一个：`ctx.tools.register`）。

## 移植到其它设备

```powershell
# tarball：最稳，不需要任何构建许可
pnpm pack
pnpm dsh plugin --profile web add .\dsh-imagegen-0.1.0.tgz

# git：可版本化，pin 到 tag 或 sha
pnpm dsh plugin --profile web add github:<you>/dsh-imagegen#<sha>

# npm：发布后
pnpm dsh plugin --profile web add dsh-imagegen
```

新设备上只需要再写一次 `~/.dsh/.env`。git 和 tarball 都不需要 pnpm 的 `allowBuilds` 放行，因为包里没有 `prepare`、也没有 TypeScript 源码 —— 拉下来就是可执行文件。这是刻意的：那条放行等于允许包在本机安装时执行代码。

## 设计取舍

- **零 `@deepseek-ai/dsh-*` 运行时导入。** 用 `ctx.tools.register()` + 原始 JSON Schema，而不是 `defineTool`；用自己写的 `resolveConfig`/`parseArgs`，而不是 Schemastery 的 `Config`。DSH 是 pre-stable，这样升级最多是注册契约变，不会连模块解析一起挂。
- **无构建步骤。** 纯 ESM JS，源码即产物：源检出、安装版 `dsh`、tarball 三种载体跑同一份文件。
- **endpoint 和 key 都在调用时解析。** 自包含的错误（显式 baseUrl 格式错、config 字段类型错）在加载期就报错；只有凭据面能给的值留到调用时，因为它们本来就会轮换。
- **凭据请求 `redirect: 'error'`。** 不把 `Bearer` 自动转发到别的 origin。
- **不做 UI 卡片。** 内置 Web 端不消费 host presenter，加专门卡片要写 Client 插件，先保持最小依赖面。

## 已知限制

- 只支持 OpenAI 兼容的 `POST {base}/v1/images/generations` 与 `POST {base}/v1/images/edits`；Gemini 原生（nano banana）、以及各家私有形态仍需另加请求/响应分支。
- **编辑的输入图只支持本地文件路径**（PNG/JPEG/WebP/GIF），不支持 DSH 附件 id；`mask` 一般要求与第一张图同尺寸同格式。
- `background` / `seed` / `input_fidelity` / `extra` 是**盲透传**：插件不知道服务方认不认，报错原样带回来。
- 结果以文件路径返回，看图要模型再调 `read_image`，而 `read_image` 要求当前路由模型声明图片输入。
- 用 Node `fs` 直接写盘，不走 `ctx.fs` 的沙箱策略；写入位置完全由 `outputDir`（配置或单次参数）决定。
- 客户端半边（`client.js`）本轮未改动，也就没有被 `smoke.mjs` 覆盖（见上一节）。
