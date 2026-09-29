# 精灵图工具

六个零构建、独立运行的脚本，把"精灵图"从"看着差不多"变成可复现的流水线：**量测 → 单帧手术 → 切片归一化 → 尺度归一化 → 拼动图**。它们服务的是插件本身不做的那一段：模型只负责画，几何与时序交给程序。`frames.mjs` 是动图编码器共用的帧处理模块（收集/加载/裁剪/曝光表/交付清单），GIF 与 APNG 两个写出器都基于它。

动画方法论（on-twos、曝光表怎么排、smear 怎么写、冲击反馈该放哪、尺度归一化、坑清单）另见 **[../docs/on-twos.md](../docs/on-twos.md)**。

脚本只用环境里已有的 `sharp`（见 [sharp.mjs](sharp.mjs)），不需要构建，也不需要 `npm install` 到本仓库：

```sh
# DSH 检出自带 sharp，用 --dsh 指过去即可
node tools/probe-sheet.mjs sheet.png 3 2 --dsh="D:/DeepSeek Harness/deepseek-harness"
```

`sharp` 解析顺序：本树的 `import 'sharp'` → `--dsh=<dir>` 的 pnpm store → `$DSH_DIR` → 当前目录。都找不到时报错会直接告诉你两条出路，而不是抛 `MODULE_NOT_FOUND`。

## probe-sheet.mjs —— 精灵图体检

```sh
node tools/probe-sheet.mjs <image> <cols> <rows>
```

输出五组量，回答"一眼看不出来"的问题：

| 行 | 含义 | 为什么需要它 |
|---|---|---|
| `FILE` / `GRID` | 格式、尺寸、`hasAlpha`、每格尺寸 | 先确认拿到的是不是带 alpha 的 PNG |
| `ALPHA` | `min`/`max`、全透明占比、全不透明占比 | **中继返回的透明图 `max` 恒为 254、`fullyOpaque` 恒为 0.00%**：alpha 是软的，要硬边素材必须自己阈值化 |
| `CORNER` | 四角 alpha | 快速判断底是否干净；偶发一个 `=1` 的像素 |
| `ROW n` | 每格墨迹覆盖率 + 艺术**包围盒 w×h** | 空洞格、爆格、以及"**模型总把角色放大到填满格子**"这一系统性行为 |
| `SEAM` | 每条内部分界线上压着多少不透明像素 | 预测"按 1/N 硬切"会不会切到画 |

局限：只看 alpha 几何，**不判断画得好不好**（表情、结构、朝向都得人眼）。它也曾漏掉一次"贴帧重影"——残影把包围盒撑大而不是报错，补救办法见 `frame-tool.mjs` 的粘贴自检。

## frame-tool.mjs —— 单帧手术

```sh
node tools/frame-tool.mjs crop  <sheet> <cols> <rows> <index> <out>
node tools/frame-tool.mjs paste <sheet> <cols> <rows> <index> <frame> <out>
```

`index` 是 0 基、行优先。用途是**只改一帧**：裁出不满意的格子 → 单独重画（把裁下来的格子当参考图喂给模型，锁住姿态与角度，只改要改的部分）→ 贴回原图。其余格子一个像素不动。

`paste` 的顺序是关键：

1. 新帧 `contain` 缩放到格子尺寸（透明补边）；
2. **先把整格擦成全透明**（`composite` + `blend: 'dest-out'`）；少了这步，旧帧会从新帧的透明区域里透出来，看上去就是**重影**；
3. 再贴新帧；
4. **自检**：统计"结果是 opaque、但新帧是 transparent"的像素数并打印，正常应为 `0`。

局限：不做缩放归一化。单帧重画的角色若与邻帧大小不同，贴回去就是不同大小——那属于 [slice.mjs](slice.mjs) 的活。

## slice.mjs —— 切片与归一化

```sh
node tools/slice.mjs <sheet> <cols> <rows> <outDir> [--cuts=gap|nominal] [--anchor=feet|box] [--canvas=640]
```

产出的东西：`frame-<n>.png`、`contact-strip.png`（六帧并排，一眼验收）、`SLICE.txt`（刀口记录）。

流程与取舍：

1. 从 alpha 算出每列/每行的墨迹剖面；
2. 每个标称分界线在 ±48px 窗口内，**优先取 ≥8px 真空隙的中点**；找不到真空隙就退化为"**窗口内墨迹最少的那一行/列**"（并列时选离标称最近的那条），并把**切掉多少像素如实打印**（例如 `CUT y 1: nominal 512 -> 521 (least-ink fallback, splits 36px of artwork)`）——它不假装干净；
3. 每帧 trim 到包围盒 → 判定**锚点** → 把锚点钉到画布固定位置、不缩放（同一张图内部比例自洽，重采样只会引入模糊）；
4. 装不下就**报错停下**，绝不静默裁切。

**刀口模式**：

| 模式 | 适用 | 行为 |
|---|---|---|
| `gap`（默认） | **抠好的角色表**（有透明背景） | 在标称线附近找空隙，找不到就用墨迹最少的线 |
| `nominal` | **不透明场景表**（照片/背景填满格子） | 直接用标称栅格。这类表**每条线都是满墨**，找空隙没有意义 —— 实测还会因为并列最小而把栅格拖歪 48px |

**锚点模式**（决定了动起来有没有"抽搐"）：

| 模式 | 锚点 | 后果 |
|---|---|---|
| `feet`（默认） | **脚底接触点**：先用"墨迹最密的竖列"定位身体中轴，再在中轴 ±15% 宽度窗口内找最低不透明像素（窗口天然排除甩到身侧的盆），最后用底部 10% 带内的水平质心定 x | 道具甩到身侧时人物**不跟着跑**，视点固定 |
| `box` | 整幅包围盒的底边与水平中心 | 道具甩出去会把人物一起拖走 |

实测同一张六帧图：`box` 模式下脚底锚点在画布上散布 (258,607)…(298,607)，**x 抖动 56px**（约为角色宽度的 9%，头会跟着晃）；`feet` 模式下六帧全部落在 `(320,608)`，是构造上归零。脚本会打印每帧的锚点与跨帧抖动，`SLICE.txt` 也记录一份。

**场景表要点**：`--cuts=nominal --anchor=box`，并且因为切片器强制 32px 边距，画布要开到"格子尺寸 + 64"（512 格 → `--canvas=576`）；后面拼动图时用 `--trim` 把那圈透明边裁掉即可。`feet` 锚点假设的是"抠好的立绘 + 地面接触点"，整格都是墨迹时它会算错。

## make-gif.mjs —— 拼动图（自带 GIF 编码器）

```sh
node tools/make-gif.mjs --out=anim.gif --delay=9 --trim frames/
```

不依赖 ffmpeg，也不依赖任何 GIF 库：**中位切分量化**（15 位直方图 → 255 色全局调色板）、**GIF 的 LZW 变长编码**、**GIF89a 动画结构**（Netscape 循环块 + 每帧图形控制扩展 + disposal=2 逐帧清屏）都在这一个文件里。

| 参数 | 默认 | 含义 |
|---|---|---|
| `--out=` | 必填 | 输出文件 |
| `--delay=` | 10 | 所有帧统一的停留时间，单位 1/100 秒（`9` ≈ 11fps） |
| `--delays=` | 关 | **逐帧停留时间**，逗号分隔、数量必须等于帧数（如 `16,9,15,5,13,22`）；数量不符直接报错 |
| `--loop=` | 0 | 循环次数，`0` = 无限循环 |
| `--scale=` | 1 | 最近邻整数放大（像素/矢量素材都不要用双线性） |
| `--trim` | 关 | 按所有帧的**并集包围盒**裁掉空白边距，各帧相对位置不变 |
| `--alpha=` | 128 | alpha 二值化阈值 |
| `--manifest=` | 关 | 另写一份 `exposure.json` 交付清单：每帧的 **24fps 格数** + 画布 + 裁剪框 |

位置参数可以是多张 PNG，也可以是一个目录（自动按 `frame-<n>.png` 的数字顺序取）。

**节奏比帧数重要。** 六帧素材靠停留时间就能做出打击感，同一组帧实测：

| 帧 | 停留 | 意图 |
|---|---|---|
| 1 起手待机 | 16 | 站稳，让观众看到"要打了" |
| 2 抬盆 | 9 | 上举加速，比两头都快 |
| 3 举顶 | 15 | **预备停顿**（anticipation hold） |
| 4 挥下 | 5 | **出手那一帧要快** |
| 5 命中 | 13 | **命中定帧**（hit stop） |
| 6 收势 | 22 | 缓慢回待机，接上循环 |

总长 0.80s；拿 `--delay=13` 的均匀版（0.78s，总长几乎一样）并排看，差别就全在节奏上。

**和手绘 "on twos" 的关系。** 24fps 时间轴下，"on ones" = 每格一张新画（24 张/秒），"on twos" = 每两格一张（12 张/秒），"on threes" = 8 张/秒。`--delays` 其实就是一张**曝光表**：`20,7,28,5,18,30`（单位 1/100 秒）换算成 24fps 的格数是 4.8 / 1.7 / 6.7 / 1.2 / 4.3 / 7.2 —— 起手停 5 格、抬盆 2 格、举顶停 7 格、**挥下 1 格（on ones）**、命中停 4 格、收势 7 格。

行业惯例不是"全片 on twos"，而是**逐张决定曝光格数**：对话 on twos、停顿 on threes~fours、极快动作临时切 on ones。所以六帧素材 ≈ 0.5 秒的 on-twos 作画量（12 张/秒 × 0.5s），要把动作做长靠的是**停顿**，不是加画；要更狠就**抽掉中间画**（直接从预备姿势跳到命中姿势，手绘里叫 no in-between）。

⚠️ 浏览器会把**小于 2 的延迟**钳制成 100ms，所以"快帧"不要给 0/1，稳妥起见 ≥5。

**GIF 的硬限制**：只有"完全不透明"和"完全透明"两种，**没有半透明**。所以抗锯齿边缘必须按 `--alpha` 二值化（默认 128），边缘会比 PNG 略硬——这是格式限制，不是编码器的问题。想让边缘柔和，得让帧先对着一个背景色预乘再量化。

写完会用 sharp 回读一次自检：`VERIFY format=gif 523x508 pages=6 (ok)`。实测六帧 523×508、`delay=9`、4167 个原色压到 255 色后约 **508 KB**。

## make-apng.mjs —— 拼动图（无损、精确时序）

```sh
node tools/make-apng.mjs --out=anim.png --exposures=5,2,7,1,1,4,5 --trim frames/
```

GIF 有两个硬伤，APNG 正好都补上：

| | GIF | APNG |
|---|---|---|
| 延迟单位 | 1/100 秒（**表达不了 24fps 网格**，1/24s 除不尽） | **分数** `delay_num/delay_den`，`1/24` 直接写，零误差 |
| 透明度 | 只有全透明/全不透明，抗锯齿边缘必须二值化 | **真半透明**（RGBA 原样保留） |
| 颜色 | 256 色调色板量化 | **无损** |
| 体积 | 小（实测 645 KB） | 大（实测 2.7 MB，约 4×） |

`--exposures=` 用的是动画师的单位：**每张画停几个 24fps 格**，写进文件时就是精确的分数，所以一张 24fps 的曝光表可以**原样**进文件。参数还有 `--plays=`（0 = 无限）、`--delays=`/`--delay=`、`--scale=`、`--trim`、`--alpha=`、`--manifest=`（写交付清单）。

每帧以整幅画布、`blend_op=SOURCE`、`dispose_op=NONE` 写出，等于**直接替换上一帧**（精灵动画的正确行为）。写完做两重自检：

```
VERIFY apng 697x587 format=png frames declared=7 fcTL=7 sequence=0,1,3,5,7,9,11
       — structure ok, last frame decoded back byte-identical ok
```

- **结构**：分块顺序、`acTL` 声明帧数、`fcTL` 数量、序号（首帧是 `fcTL(0)+IDAT`，之后 `fcTL(1)+fdAT(2)`、`fcTL(3)+fdAT(4)`…，所以 `fcTL` 序号是 0 与奇数）；
- **数据**：把文件里最后一帧的 `fdAT` 解压、反滤波，与源像素**逐字节比对**。

⚠️ `sharp` 只读 APNG 的静帧、不报帧数（`pages=undefined`），所以自检不依赖它；**浏览器原生支持 APNG 动画**。引擎交付仍建议 PNG 序列 + 曝光表 JSON，APNG 当预览。

## normalize.mjs —— 把单独生成的帧对齐到序列的尺度

```sh
node tools/normalize.mjs <frame> --to=<邻居帧.png>[,...] [--feature=face|silhouette] [--out=scaled.png]
```

**为什么需要它**：换帧用的补充帧（smear、受击、道具变化）通常是单独生成的，模型会按自己的构图把它画满画布 —— 实测出现过角色比序列帧**大 1.5–1.9 倍**的情况，插进去就是"瞬间膨胀"。

**为什么要选对特征**：默认用 `--feature=face`，即**最大的肤色连通域（脸）**。它对手臂、道具、拖影都免疫；而任何剪影类指标在 smear 帧上都会失真 —— 实测 smear 的头发被速度拖到 897px 宽，而同序列只有 335px，指标量的是"拖影"不是"角色"。`--feature=silhouette` 用艺术高度，只在**姿态与参考完全一致**时才安全。

工具会打印双方的测量值、参考中位数与得到的系数；`--out=` 才真正写出缩放后的帧。**数值只能保证量级，务必再拼条带与邻居对比一眼**。实测复现：impact 帧对命中帧 → `x0.6672`。

## library.mjs —— 资源归档与画廊登记

```sh
node tools/make-gif.mjs  --out=anim.gif --set=hair-ascend --publish frames/
node tools/make-apng.mjs --out=anim.png --set=hair-ascend --publish --manifest=exposure.json frames/
```

**解决的问题**：画廊只列插件索引（`$DSH_HOME/imagegen/images.json`）里的记录，而 `tools/` 产出的文件不会自己进索引 —— 于是动图既不出现在画廊里，位置也跟静态图天各一方。

带 `--set=<集名>` 时，输出落到资源根下的 `animations/<集名>/`；`--publish` 再把帧复制进去，并**追加一条画廊记录**（`mode: "animation"`、`animationId`、帧数、总格数、时长、清单路径）：

```
<资源根>/animations/hair-ascend/
   hair-ascend.gif            1.7 MB
   hair-ascend.apng.png       4.6 MB
   hair-ascend.exposure.json  交付清单
   frames/frame-01..12.png    帧，随动画一起归档
```

**资源根怎么定**（`--into=auto`，默认）：**优先用配置里的 `outputDir`**（插件页填的那个），其次跟随**最新一条静态图**记录所在目录 —— 并在回退时**剥掉 `sessions/<id>` 一层**，这样动画永远不会嵌进某个会话的目录里；最后才是当前目录。`auto` 也**不跟随已发布的动画**（否则会一层层套进自己的子目录）。

**放哪儿最稳**：画廊的图片路由是普通读文件，**没有工作区边界**，所以资源根可以放在检出目录之外（例如 `D:\dsh-art`），静态图与动画就都不会随重拉仓库消失。插件那边还会在每个资源根下按会话隔离一层：`sessions/s-<会话 id 后 12 位>/`。

## strip.mjs —— 把任意几帧拼成一条对比带

```sh
node tools/strip.mjs --out=compare.png 邻居1.png 缩放后的帧.png 邻居2.png
```

底对齐横向拼接，用来给 `normalize.mjs` 收尾：**数值只能保证量级，眼睛才能确认**缩放对不对（例如单帧重画的角色是否与邻帧同高、脚是否在同一条线上）。

## relocate.mjs —— 把散落的资源搬进统一根

```sh
node tools/relocate.mjs --dry-run      # 先看计划
node tools/relocate.mjs                # 真搬
```

配置资源根之前生成的图，落在"当时从哪个目录启动"的地方，于是一个人的图会散在好几处（实测 6 处：检出、桌面、`~/.dsh/imagegen-output`……）。这个脚本把它们搬进统一根并**改写索引**：

- 属于已发布动画的文件保留 `animations/<集名>/` 结构；
- 其余进 `legacy/<原目录名>/`，**保留来源**（`legacy\desktop\`、`legacy\.artifacts\`…）；
- 逐文件**复制 → 校验尺寸 → 再删源**，跨盘也安全；**每条记录搬完就回写索引**，中断不会留下指向空文件的记录。

实测：43 条记录 / 55 个文件 / 68 MB 落到 `D:\dsh-art`，0 条残留。

## 一次典型流程

```
生成整张 ──► probe-sheet（透明？出格？比例一致？）
                │
                ├─ 某帧不满意 ──► crop ──► 单独重画 ──► paste（残影自检 0）──► probe-sheet 复验
                │
                └─ 全部满意 ──► slice ──► frame-1..n.png ──► make-gif ──► anim.gif（预览，小）
                                                          ├─► make-apng ──► anim.png（预览，无损精确）
                                                          │        └─► --manifest=exposure.json（引擎读的曝光表）
                                                          └─► 打包成图集（TexturePacker / Unity / Godot）
```

单独生成的补充帧（smear / 受击 / 道具变化）在进序列前先过一道尺度归一化：

```
单独生成 ──► normalize.mjs --to=邻居帧.png --out=scaled.png ──► strip.mjs 拼条带人眼复核 ──► 进序列
```

## 交付形态：为什么最后还要打包成图集

切片产出的是**散图**，适合制作阶段逐帧迭代；游戏运行时通常还要用 TexturePacker、Unity Sprite Atlas、Godot AtlasTexture 之类的工具合成**一张图集 + 一份坐标表**——一张纹理一次绑定、天然合批，切帧只是换 UV 子矩形。打包时记得留 1–2px padding/bleed，避免相邻帧在双线性采样时互相渗色。
