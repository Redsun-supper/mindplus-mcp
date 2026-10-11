# 界面识别与点击 —— 设计与实现

这份文档讲的是 mindplus-mcp 里 GUI 自动化那一层：**为什么这么设计、坐标怎么算、提示词契约是什么、边界在哪**。
用法（怎么调、典型序列）在 [README](../README.md#界面识别与点击)，这里讲的是内部。

---

## 1. 为什么和 mind-link 那套分开

mind-link 提供的是「Mind+ 内部的通道」（串口、child_process、ssh、MQTT、UDP、node-pty、fs）。它**没有**截屏和键鼠注入，而且它随 Mind+ 的启动而存在——Mind+ 关了它就没了。

GUI 自动化是另一件事：目标是**桌面本身**，包括 Mind+ 之外的任何程序。所以这一层：

- 不经过 mind-link，直接在本机起一个进程做 Win32 调用；
- **Mind+ 没开也能用**；
- 只依赖 Windows 自带的 Windows PowerShell 5.1（`System.Drawing` + P/Invoke），**零 npm 依赖**，和项目其余部分一致。

```
tools.js ──► automation.js ──┬──► gui.js ──► (stdio JSON-lines) ──► gui-host.ps1 ──► Win32
                             │                                        │
                             ├──► vision.js ──► HTTP/CLI ──► 多模态模型
                             │
                             └──► image.js（纯 JS：PNG 编解码 + 匹配/找色）
```

---

## 2. 为什么是**常驻** PowerShell 进程

`Add-Type` 每次都要调 csc 编译 C#，冷启动 1~2 秒。一次「截图 → 找按钮 → 点它」如果每步都重启进程，光启动就 3 秒起，而视觉循环动辄七八步。

所以 `gui-host.ps1` 是一个**常驻进程**，用一行一个 JSON 对象的方式在 stdin/stdout 上说话：

```
node → {"id":7,"cmd":"capture","args":{"x":0,"y":0,"width":400,"height":300,"path":"...","format":"png"}}
node ← {"id":7,"ok":true,"result":{"x":0,"y":0,"width":400,"height":300,"path":"...","bytes":11362}}
```

- C# 只编译一次，之后每次调用就是一次方法调用。
- 启动后先吐一行 `{"ready":true,"awareness":"per-monitor-v2","pid":1234}`，Node 侧等这行才算就绪。
- 进程死了（比如弹了 UAC 导致输入队列被挂住）自动重启，等待中的请求全部 reject，不会静默挂死。
- `GuiHost#request` 有超时；`stop()` 会先 `stdin.end()` 让脚本自己退出（脚本里 `ReadLine()` 返回 `null` 就 break），1.5 秒还没退再 kill。

**踩过的坑**：`Add-Type` 把编译警告当**错误**。C# 里一个没用到的私有字段（`private static int _shcoreTried;`）就足以让整个主机起不来。所以那段 C# 必须零警告——用的是 C# 5 语法（PowerShell 5.1 带的是老 csc，没有字符串插值、没有 `?.`、没有表达式体成员）。

---

## 3. 坐标模型（最容易出错的地方）

三层坐标，必须一路换算清楚：

```
屏幕物理像素  ←(A)→  截图 PNG 像素  ←(B)→  发给模型的图像像素
```

- **(A) 恒等**：只要进程是 DPI 感知的，`CopyFromScreen` 拿到的就是物理像素，`SendInput` 用的也是物理像素，一一对应。
- **(B) 缩放**：截图发给模型前会按 `maxWidth` 缩小（默认 1400），省 token 也省时间。

`automation.js` 把这个关系收在一个 `transform` 里：

```js
transform = { offsetX: region.x, offsetY: region.y, scale: sentWidth / regionWidth }
```

模型返回的是**它看到的那张图**的像素坐标，换算回屏幕：

```
screenX = offsetX + imageX / scale
screenY = offsetY + imageY / scale
```

`vision.js` 的 `toScreenPoint()` / `toScreenBox()` 就干这个，`scale` 缺省为 1（不缩放时等价于直接加偏移）。

### DPI 感知

Windows 上一个 DPI-unaware 进程看到的是**被系统缩放过的虚拟坐标**：`GetSystemMetrics` 返回 1707×960（150% 缩放时），`CopyFromScreen` 截到的是模糊的放大图。这时截图和点击**仍然自洽**（都走同一套虚拟坐标），但图像质量差、坐标空间和别的工具对不上。

所以启动 PowerShell 时设了 `__COMPAT_LAYER=HIGHDPIAWARE`（进程启动时由系统 shim 赋予 DPI 感知），C# 里再试一次 `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`。

`screen_info` 会把最终拿到的 `awareness` 报出来。本机实测是 `per-monitor-v2 (reported=2)`，副屏 150% 缩放下 `scale` 正确报为 1.5。

### 多显示器

`SendInput` 的绝对坐标是**跨整个虚拟桌面归一化**到 0..65535 的，必须带 `MOUSEEVENTF_VIRTUALDESK`，否则副屏（可能是负坐标）点不到：

```
nx = round((x - vx) * 65535 / (vw - 1))    // vx/vw = SM_XVIRTUALSCREEN / SM_CXVIRTUALSCREEN
flags = MOVE | ABSOLUTE | VIRTUALDESK
```

本机虚拟桌面是 4480×1440（主屏 2560×1440 + 副屏 1920×1080 @150%），实测点击落点准确。

---

## 4. 识别框架的两条腿

### 4.1 本地（`image.js`）——不需要模型，通常也更准

| 能力 | 实现 | 复杂度 |
|---|---|---|
| `decodePng` / `encodePng` | `node:zlib` + 手写 PNG 解析（IHDR/PLTE/IDAT、五种滤波器、位深 1/2/4/8/16、色彩类型 0/2/3/4/6） | 一次性 |
| `templateMatch` | 滑动窗口 SAD + **提前退出** + 非极大值抑制 | 见下 |
| `findColor` | 逐像素比较 + 外接矩形 / 质心 / 命中数 | O(n) |
| `resize` | 盒式滤波（降采样时比最近邻干净） | O(n) |
| `annotate` | 在副本上画十字和框，供人核对 | O(边框) |

模板匹配的性能陷阱：2560×1440 的屏幕配 50×50 的模板是 **35 亿次**像素比较，纯 JS 直接卡死。做法是：

1. 先算一个「预算」`budget = (1 - minScore) * 255 * 3 * templatePixels`；
2. 累加 SAD 时一旦超过 budget 立刻跳出——绝大多数位置在头几个像素就被淘汰；
3. 默认 `stride=2`（模板 ≥ 24px 时），命中后再由调用方决定要不要精修；
4. 结果做 NMS（重叠的中心距小于半个模板就丢弃），避免同一个按钮刷屏。

### 4.2 模型（`vision.js`）——描述式

提供者是可插拔的，风格有四种实现：`openai`（任何 OpenAI 兼容的 `/chat/completions`）、`anthropic`（Messages API）、`ollama`（本地 `/api/chat`）、`command`（你自己的 CLI）。

`command` 这一种是关键：**它让整个框架可以脱离任何具体厂商**，也让它可测——

```
--vision-command '"node" "my-vision.mjs" "{image}" --prompt "{prompt}"'
```

服务器把提示词写进临时文件、把图写成 PNG，用 argv 模板替换 `{image}` / `{prompt}` 后直接 `spawn`（**不走 shell**，所以路径里的空格和特殊字符不会出事；argv 模板用引号感知的 `tokenizeCommand` 切分，因为 Windows 路径里全是反斜杠）。你的脚本往 stdout 打一个 JSON 就算模型返回。

### 4.3 提示词契约

模型必须回**纯 JSON**。为了让它照做，提示词里给死模式：

```
TARGET: <你要找的东西>
The image is 1920 x 1080 pixels.
...
Return the single best match. x/y must be the CENTRE of the element, in pixels of the image above,
with the origin at the top-left corner. Do not normalise the coordinates.
Reply with ONLY a JSON object (no markdown fence, no prose):
{
  "found": true,
  "label": "...", "x": 123, "y": 456,
  "width": 80, "height": 24,
  "confidence": 0.0,
  "reasoning": "...",
  "alternatives": [ ... ]
}
```

三个刻意的决定：

1. **要像素坐标，不要归一化坐标。** 模型对"图宽 1920"这种显式信息给绝对像素往往比给 0~1 更准，而且省掉一次乘法引入的舍入。
2. **要它说 `found: false`。** 没有出口的话，模型会硬凑一个坐标出来——那比明确说"没找到"危险得多。
3. **要 `alternatives`。** 拿不到主目标时，次优候选能直接用来兜底，不用再问一遍。

回复解析用 `extractJson()`：先剥 ```` ```json ```` 围栏，再找**第一个括号配平**的 `{...}`（带字符串/转义状态机，所以 `{"a":"}"}` 这种不会被截断）。模型前言后语随便写，只要 JSON 在里面就能捞出来。解析不出来就返回 `{found:false, error:...}`——**不抛异常**，因为"模型没按格式回"是预期内的失败模式，不是程序错误。

### 4.4 决策式提示词（`vision_act` 用）

同一套机制，换一个输出契约：给目标、历史动作、允许的动作集，让它回一个动作对象。

```
GOAL: 打开扩展面板并搜索 DHT11
This is step 3 of at most 6.
ACTIONS ALREADY TAKEN:
  step 1: clicked at (120,340)
  step 2: typed "DHT11"
Allowed actions: click, type, key, wait, done, fail.
Reply with ONLY a JSON object: {"action":"click","x":0,"y":0,"text":"","keys":"","reason":"..."}
Use "done" when the goal is achieved and "fail" when it cannot be achieved.
Never invent coordinates: pick them from what you can actually see in the image.
```

最后那句是防幻觉的关键——模型很容易"我记得那里应该有个按钮"。

---

## 5. 视觉循环的边界

`runVisionLoop()` 每轮：**抓屏 → 问模型 → 执行 → 记进 history → 下一轮**。看着简单，但每一条都是安全边界：

| 限制 | 为什么 |
|---|---|
| `maxSteps`（默认 8） | 不设上限的视觉循环 = 机器无限点下去 |
| `allowed` 白名单 | 默认允许全部，但调用方可以只给 `click`/`type`/`wait`/`done`，把 `drag`、`key` 挡在外面 |
| `dryRun` | 走完整循环但**不注入任何输入**，而且只走一步就停——用来看"它第一步想干什么" |
| `settleMs` | 每个动作后等界面反应（默认 600ms），否则下一张截图还是旧界面 |
| `done` / `fail` 终止 | 模型自己说结束；说了不算，也要落在白名单里 |
| 单步异常即停 | 某个动作抛错就退出循环并把错误带回去，不带着错误状态继续点 |
| 全程留证 | 每步都返回：截图路径、决策、理由、实际执行的坐标/文本 |

history 会喂回模型（只保留最近 10 条），所以它能知道自己已经试过什么——这是避免"点同一个地方八次"的唯一办法。

**一个诚实的说明**：这一层没有做「验证」（点完之后确认目标真的变了）。`screen_wait_change` 是给你手动补这一步用的，但循环本身不强制。真正的鲁棒做法是别用 `vision_act`——知道步骤时用 `image_find` + `mouse_click`，确定性高得多。

---

## 6. `gui-host.ps1` 里的 Win32 细节

### 鼠标

统一走 `SendInput`（`mouse_event` 已废弃，很多现代程序不认）。移动用绝对坐标 + `VIRTUALDESK`；点击是 `MoveAbsolute` 之后再 `LEFTDOWN`/`LEFTUP`。

`mouse_move` 的 `durationMs` 用 ease-in-out 插值（`steps = durationMs / 12`）——瞬间跳过去有些控件（尤其是拖拽目标）不认。

`mouse_drag` 的顺序是：移到起点 → 停 30ms → 按下 → 停 30ms → 插值滑到终点 → 停 30ms → 松开。这几个停顿是必须的，很多程序需要看到"按下"状态稳定存在才认为这是拖拽。

### 键盘

`keyboard_type` 走 `KEYEVENTF_UNICODE`（`wVk=0`，`wScan=字符`），所以**中文、emoji 都能打**，不受键盘布局影响。`\n` 和 `\t` 特判成 `VK_RETURN` / `VK_TAB`，因为 Unicode 注入控制字符没有意义。

`keyboard_press` 把 `ctrl+shift+s` 拆开：先按顺序按下所有键，再逆序松开。方向键、Insert/Delete/Home/End/PgUp/PgDn、右 Ctrl/Alt、Win、小键盘除号、PrintScreen 这些需要 `KEYEVENTF_EXTENDEDKEY`，否则会被当成小键盘上对应的键。键名表里还有 `vk:0x41` 这种直接给虚拟键码的逃生口。

### 窗口

`EnumWindows` 后按「Alt-Tab 规则」过滤：可见、有标题、`GetWindow(GW_OWNER) == 0`、且未被 DWM cloaked（`DwmGetWindowAttribute(DWMWA_CLOAKED)`）。最后一条很重要——UWP 应用会留一堆 cloaked 的幽灵窗口，不过滤的话列表里全是空壳。

`GetWindowTextW` 有个坑：**传 `null` 缓冲区查长度在 .NET Framework 的 `StringBuilder` 封送下不工作**（返回 0），必须老老实实分配缓冲区。这是实际调试出来的——一开始所有窗口标题都是空字符串。

`window_activate` 里 `SetForegroundWindow` 经常被拒（只有前台进程有权设置前台窗口）。兜底手段是 `AttachThreadInput` 借前台线程的输入队列，操作完再 detach。返回值里带**实际是否抢到前台**，因为这事 Windows 说了算，不是我们说了算。

### 剪贴板

`System.Windows.Forms.Clipboard` 要求 STA 线程，而 PowerShell 主线程的套间状态不保证。所以每次操作都**起一个临时 STA 线程**，做完 `Join()` 回来，异常带出来再抛。

### 错误消息

PowerShell 会把 .NET 调用包一层 `MethodInvocationException`，消息是本机化的样板文字（中文系统上就是「使用"2"个参数调用"KeyPress"时发生异常:…」）。所以 catch 里优先取 `InnerException.Message`——那才是 C# 里抛出的真话。

---

## 7. 安全边界（请认真读）

这一层等于**把键盘和鼠标交给了调用方**。它和 `run_command` 是同一量级的权限，甚至更隐蔽（命令至少留下日志）。

- **`dryRun` 是给自动化流程用的刹车**，不是安全机制——真正的边界在 MCP 客户端那边（工具白名单、人工确认）。
- **`--transport http --host 0.0.0.0` 会把键鼠控制暴露给整个局域网**，而且这个服务器**没有任何鉴权**。别这么干。
- **UIPI**：目标程序以管理员运行时，非管理员进程注入的输入会被**静默丢弃**（点了没反应，不报错）。要操作这类窗口，MCP 客户端本身也得提权。
- **`vision_act` 是"尽力而为"**：模型会犯错。别拿它去操作有破坏性的界面（删除、支付、格式化），除非你已经用 `allowed` 把动作收窄、并且盯着每一步。
- 截图会落盘到 `--shot-dir`（默认 `%TEMP%\mindplus-mcp\shots`），只保留最近 200 张。**如果屏幕上有敏感信息，注意这个目录**；发给视觉模型时也意味着这些内容出了本机。

---

## 8. 怎么测的

`test/gui-smoke.mjs`（30 项）在真实桌面上跑，但刻意避开了不确定性：

- **不点任何东西**：所有点击/拖拽/滚轮都用 `dryRun`；
- **跑完还原**：光标移回原位、剪贴板写回原内容、截图目录整个删掉；
- **模板匹配是确定性的**：从同一张截图里裁出模板再找回去，断言坐标精确等于 `(150, 110)` 且 `score === 1`。这一条同时覆盖了 PNG 解码 → 裁剪 → 编码 → 解码 → 模板匹配 → 坐标映射整条链路；
- **视觉链路不需要 key**：`test/fixtures/fake-vision.mjs` 假装成模型（它会检查自己收到的图非空、提示词里有 `TARGET:`/`GOAL:`），于是 provider 接线、提示词拼装、JSON 解析、坐标换算、annotated 出图全部被真实覆盖；
- **失败路径也测**：没有 provider 时 `vision_locate` 必须报出可操作的错误（并且提示 `image_find` 可以替代）、未知键名要报错、模板比搜索区大要报"找不到"而不是乱猜。

`vision_*` 接**真实**模型的行为**没有测过**（本机没配 key，也没有在跑的 Ollama）。首次使用请先 `vision_config{test:true}`。
