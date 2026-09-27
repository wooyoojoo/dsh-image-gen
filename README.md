# dsh-imagegen

一个独立于 DSH 仓库的 Harness 插件（bundle）：注册 `generate_image` 工具，用第三方 key 调用 OpenAI 兼容的生图接口，把图片落盘到工作区。

它 **只 import `node:` 内置模块**，不 import 任何 `@deepseek-ai/dsh-*` 包，也没有构建步骤。这个取舍是为了让 DSH 升级和换设备都不影响它（见文末「设计取舍」）。

## 装一次，之后什么都不用加

```powershell
cd D:\Git\deepseek-harness\scratch-plugin\dsh-imagegen
pnpm pack                                     # 产出 dsh-imagegen-0.1.0.tgz
cd D:\Git\deepseek-harness
pnpm dsh plugin --profile web add .\scratch-plugin\dsh-imagegen\dsh-imagegen-0.1.0.tgz
```

装完之后就按你平时的方式启动 GUI，**不需要 `--patch`、不需要任何 flag**。工具在新会话里自动出现。

想在独立 profile 里跑（和主环境隔离）：

```powershell
pnpm dsh --profile img --from-default-profile web
pnpm dsh plugin --profile img add .\scratch-plugin\dsh-imagegen\dsh-imagegen-0.1.0.tgz
pnpm dsh --profile img
```

改代码时用 overlay（`web` profile 会实时重载 patch **文件**；改 `index.js` 本身要重启，内置组合里 `cordis-plugin-hmr` 是 disabled 的）：

```powershell
pnpm dsh web --patch ./scratch-plugin/cordis.yml
```

### 改了源码之后怎么刷新已安装的副本

装进 profile 的是**打包快照**，不是目录链接。改完 `index.js` 要重新 pack + 重装（建议同时把 `package.json` 的 version 加一位，避免 pnpm 按同版本跳过）：

```powershell
cd D:\Git\deepseek-harness\scratch-plugin\dsh-imagegen
pnpm pack
cd D:\Git\deepseek-harness
pnpm dsh plugin --profile web add .\scratch-plugin\dsh-imagegen\dsh-imagegen-0.1.1.tgz
```

profile 的 `package.json` 记的是 tarball 的**绝对路径**，所以别删或移动那个 `.tgz`，否则 profile 里再跑 `pnpm install` 会失败（已经装好的副本不受影响，照常启动）。想省掉这一步就用链接安装：`pnpm dsh plugin --profile web add .\scratch-plugin\dsh-imagegen`，代价是**源目录不能搬走**，搬了 profile 会加载失败。

## 配置 API key 和 endpoint

两个值都在**每次调用时**从凭据面读取，所以放一次就长期生效，轮换 key 或换中转也不用改配置。放在 `%USERPROFILE%\.dsh\.env`：

```ini
IMAGE_BASE_URL=https://relay.example.com/v1
IMAGE_API_KEY=sk-...
```

查找优先级（由 DSH 的凭据服务定义）：启动环境变量 > 存储的凭据文件（`~/.dsh/.credentials.yaml`，设置界面写的 key 落在这里）> 工作区 `.env` > `~/.dsh/.env`。上面这个文件是最省事的写法；`IMAGE_BASE_URL` 也可以直接卸载 profile 的 `cordis.patch.yml` 里（见下）。

**改完 `.env` 必须重启才生效。** DSH 在启动时把 `~/.dsh/.env` 和工作区 `.env` 快照进 launch environment（`credentials-local` 的 `.env` 回退读的是那份快照，不是每次读盘），运行中的进程读不到新值。已经配好之后再轮换 key 则是即时生效的——那是凭据文件（有 watch），不是 `.env`。

**没配置也能正常启动**：工具照常出现在列表里，被调用时返回一条可操作的错误（说明该设哪个变量）。这是刻意的，和 `tool-web` 在 provider 不可用时的行为一致。

`baseUrl` 解析规则——以下是四种写法都指向同一个端点：

| 写法 | 结果 |
|---|---|
| `https://relay.example.com` | `…/v1/images/generations` |
| `https://relay.example.com/v1` | `…/v1/images/generations` |
| `https://relay.example.com/openai/v1/` | `…/openai/v1/images/generations` |
| `https://relay.example.com/v1/images/generations` | 原样使用 |

## 配置字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | 无 | 显式 API 基址。给了就在**加载期**校验（格式错立刻报错）；不给则每次调用从 `baseUrlEnv` 解析 |
| `baseUrlEnv` | `IMAGE_BASE_URL` | 承载 API 基址的凭据名 |
| `apiKeyEnv` | `IMAGE_API_KEY` | 承载 key 的凭据名 |
| `apiKey` | 无 | 明文 key，仅调试；优先用 `apiKeyEnv` |
| `model` | `gpt-image-2.5-flare` | 生图模型 id |
| `size` | `1024x1024` | 传给接口的 `size` |
| `quality` | 不传 | `low`/`medium`/`high`/`xhigh`/`max`/`auto`，不设就由服务方决定 |
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

工具参数：`prompt`（必填）、`model`、`size`、`quality`、`n`（1–4）。

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
node scratch-plugin/dsh-imagegen/smoke.mjs
```

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

- 只支持 OpenAI 兼容的 `POST {base}/v1/images/generations`；Gemini 原生（nano banana）需要另加请求/响应分支。
- 只有文生图，没有 `/images/edits`（参考图、局部重绘、mask）。
- 结果以文件路径返回，看图要模型再调 `read_image`，而 `read_image` 要求当前路由模型声明图片输入。
- 用 Node `fs` 直接写盘，不走 `ctx.fs` 的沙箱策略；写入位置完全由 `outputDir` 决定。
