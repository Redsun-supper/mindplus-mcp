# mindplus-mcp

**让 AI 直接操作 DFRobot Mind+，也能直接操作你的桌面。** 一个零依赖的 MCP 服务器，把 Mind+ 变成 67 个可以被智能体调用的工具，其中 23 个是**界面识别与点击**能力。

Mind+ 每次启动都会拉起自己的本地服务 `mind-link`（`127.0.0.1:19302` 控制口、`:19303` 传输口，说的是标准 JSON-RPC 2.0 over WebSocket）。本服务器把这些通道包装成 MCP 工具，于是 **DSH / Claude Desktop / Claude Code / Cursor / VS Code / Windsurf** 等任何 MCP 客户端都能直接：列串口、开串口连接、读写文件、跑命令、调用 Mind+ 内置的 `arduino-cli`、开伪终端、SSH 登录行空板、收发 MQTT 与 UDP。

在此之上还有一层**独立于 Mind+ 的 GUI 自动化**（Windows）：截图 → 识别 → 点击 / 拖动 / 输入。识别分两条路——**本地匹配**（模板匹配、找色，不需要任何模型）和**视觉模型**（截图发给多模态模型，模型给出坐标，服务器换算回屏幕坐标再点击）。

```
┌──────────────┐   MCP (stdio / Streamable HTTP / SSE)   ┌───────────────┐
│  MCP 客户端   │ ◄─────────────────────────────────────► │ mindplus-mcp  │
│ (DSH / AI)   │                                          │  (本服务器)    │
└──────────────┘                                          └───┬───────┬───┘
                                                              │       │
                            JSON-RPC 2.0 over WebSocket       │       │  JSON-lines over stdio
                                                              │       │
                                                      ┌───────▼──┐  ┌─▼──────────────┐
                                                      │ mind-link │  │ gui-host.ps1   │
                                                      │ (Mind+ 子进程)│  │ (PowerShell+C#)│
                                                      └───────┬──┘  └─┬──────────────┘
                                                              │       │
                        串口 / child_process / ssh /           │       │  SendInput / CopyFromScreen /
                        MQTT / UDP / node-pty / fs            │       │  EnumWindows / clipboard
                                                              │       │
                                                      ┌───────▼───────▼───┐      ┌─────────────────┐
                                                      │  硬件 / 工具链 / 桌面 │      │ 视觉模型（可选）  │
                                                      └───────────────────┘      └─────────────────┘
```

---

> ## ⚠️ 先读这一段
>
> **这不是一个"安全"的工具，它是一个本地特权自动化桥。** 装上它并启用它，等于把**本机的命令执行、整个文件系统、键盘鼠标、串口与开发板、SSH 凭据、屏幕与剪贴板**一并交给调用它的 AI 客户端。
>
> 它**没有鉴权、没有沙箱、没有确认弹窗**，也不会判断你有没有权限去操作那个文件 / 那台机器 / 那个窗口。详见下文「[安全须知：它强制接管了什么](#安全须知它强制接管了什么)」与「[免责声明](#免责声明)」。
>
> **请只在你拥有且可控的环境里使用。目标设备不属于你时，先取得明确授权。**

---

## ⚠️ 安全须知：它强制接管了什么

### 注意事项

这是一个**功能完整、边界清晰、且刻意不做防护**的项目。它的设计目标是"让智能体真正能把事做完"，因此每一个可能阻碍自动化的环节都被拿掉了：不弹确认、不做白名单、不设沙箱、不问身份。

能力上它和「一个以你的身份登录、并且你不在场时替你操作电脑的远程会话」等价。安装它是一次**明确的授权动作**——请按这个量级对待。

### 此项目强力做到了什么

先说它硬做成了什么，因为下面的警告才有分量：

1. **零运行时依赖**：`node_modules` 删掉照跑。串口之外的传输全靠 Node ≥ 22 的原生能力（全局 `WebSocket`、`node:zlib`），GUI 那层靠 Windows 自带的 PowerShell 5.1 + C# P/Invoke。
2. **把 mind-link 逆向干净了**：对照 bundle 原文 + 运行中的服务逐条验证，7 条子协议的方法表、参数形状、通知名全部实证，包括几个上游自身的缺陷（`e.messgae` 拼写错误、UDP `open` 通知挂在错误的时机上）。
3. **67 个工具覆盖 7 条通道 + 桌面**：串口、`child_process`、文件、`arduino-cli`、node-pty、SSH、MQTT、UDP，外加 16 个 GUI 工具与 7 个识别工具。
4. **三种传输**：stdio、Streamable HTTP、旧版 HTTP+SSE——刻意对齐了 Mind+ 自家 `mcpserver` 扩展能吐出的形态。
5. **在 Windows 上零依赖做 GUI 自动化**：不装任何东西就有截屏、`SendInput` 键鼠注入、窗口枚举、剪贴板，并且真的拿到了 **per-monitor-v2 DPI 感知**（混合缩放的双屏下坐标依然准确）。
6. **自己写了一套识别框架**：纯 JS 的 PNG 编解码（`node:zlib`）、带提前退出的模板匹配、找色、差异检测，以及一个不绑定厂商的可插拔视觉提供者（`openai` / `anthropic` / `ollama` / 任意 CLI）。
7. **75 项端到端测试**：包含真实桌面（全部点击走 `dryRun`）、真实 Mind+、以及一个假视觉模型，因此视觉链路不需要 API key 也能回归。

### 强制接管了什么

| 接管对象 | 通过哪些工具 | 实际意味着什么 |
|---|---|---|
| **本机命令执行** | `run_command`、`pty_open` | 执行任意命令、起任意交互式进程。无白名单、无参数校验，返回 stdout / stderr / 退出码 |
| **整个文件系统** | `fs_read_text` `fs_write_text` `fs_list_dir` `fs_stat` `fs_mkdir` `fs_remove` `fs_rename`、`download_file`、`unzip` | 任意路径读写删移。**无路径沙箱**，`fs_remove` 带 `recursive` 时等价于 `rm -rf` |
| **键盘与鼠标** | `keyboard_type` `keyboard_press` `mouse_move` `mouse_click` `mouse_drag` `mouse_scroll` `mouse_button` | 向**当前前台窗口**注入输入。等于替你操作这台电脑 |
| **你的屏幕** | `screen_capture` `screen_pixel` `screen_wait_change` | 全屏截取。密码框、聊天记录、私钥、任何可见内容都会被捕获 |
| **剪贴板** | `clipboard_read` `clipboard_write` | 剪贴板里常有密码、验证码、密钥 |
| **串口与开发板** | `serial_*`、`arduino_cli` | 往串口写任意字节；`arduino_cli upload` 能**烧录 MCU**，包括覆写 bootloader |
| **远端主机** | `ssh_connect` `ssh_exec` `ssh_shell_*` `ssh_sftp` | 用你提供的凭据登录并执行命令、读写文件。服务器**不判断你有没有那台机器的权限** |
| **网络** | `mqtt_*`、`udp_*` | 收发消息、开 UDP socket、开广播 |
| **窗口管理** | `window_list` `window_rect` `window_activate` | 枚举全部窗口、读取位置、把任意窗口拉到前台 |
| **你的隐私数据** | `vision_*` | **把屏幕截图发送到第三方多模态模型**——内容离开本机 |

### 暴力做了什么

以下都是**刻意的设计选择**，不是疏漏：

1. **无鉴权。** HTTP 模式没有 token、没有密码、没有 IP 白名单。`--host 0.0.0.0` 一旦开启，**局域网内任何设备**都能拿到上表全部能力。默认只绑 `127.0.0.1` 是唯一的防线，而它只是一行配置。
2. **无沙箱。** 文件路径不做归一化校验，命令不做白名单，串口 / 主机 / 端口全由调用方指定。
3. **无确认。** 工具调用直接执行。`run_command` 不会问"确定吗"，`fs_remove` 不会问"真要删吗"，`arduino_cli upload` 不会问"要烧哪块板"。
4. **常驻输入注入进程。** `gui-host.ps1` 长期持有 Win32 `SendInput`，它**不区分请求来自谁**——只要 MCP 客户端能发，它就会点。
5. **默认放开自主循环。** `vision_act` 的 `allowed` 默认是**全部动作**，只有调用方主动收窄才受限；`maxSteps` 也只是调用方传的参数，不传就是 8 步自主操作。
6. **默认写进所有客户端。** `install.mjs` 不带 `--target` 时会探测并写入本机**全部**已发现的 MCP 客户端配置（含 DSH 各 profile）。
7. **截图无排除机制。** 没有"遮挡某区域"或"跳过某窗口"的选项，抓到什么就是什么。
8. **凭据以明文参数传递。** SSH 密码 / 私钥作为工具参数出现，会留在客户端日志与会话记录里。

### 没有经过授权

- **不校验调用方身份。** 任何能连上这个 MCP 服务器的进程，都拥有上述全部能力。
- **不校验操作对象。** 路径、主机、端口、串口都由参数决定，服务器不做任何"你是否拥有它"的判断。
- **不向用户请求确认。** 没有交互式授权，没有审批队列，没有 dry-run 强制。
- **被操作的程序不会知道。** 通过 GUI 注入的点击，目标程序**无法区分"人在点"和"机器在点"**——这等于绕过了它自己全部的授权、审计与风控。
- **第三方数据在未授权的情况下外发。** 启用 `vision_*` 后，屏幕内容（可能包含**他人**的隐私、聊天、密钥）会被发送到模型提供方。
- **远端主机未授权。** `ssh_*` 只负责连接，不判断你对那台机器有没有权限。

### 免责声明

> 本项目按**"现状"（AS IS）**提供，不附带任何形式的明示或默示担保，包括但不限于对适销性、特定用途适用性及不侵权的担保。
>
> 使用本项目所产生的**全部风险与后果由使用者自行承担**。作者与贡献者**不对**下列任何情形负责：数据丢失或损坏、硬件或开发板损坏（含烧录失败导致的变砖）、账号或设备被封禁、隐私泄露、第三方索赔，以及任何直接、间接、附带、特殊或后果性损害。
>
> **本项目仅可用于合法用途**，且仅限于**你本人拥有或已获得明确书面授权的设备与系统**。严禁用于未授权访问、控制他人设备、绕过安全机制或任何违反当地法律法规的行为。
>
> 使用者有责任自行确保：① 你操作的目标设备归你所有或已获授权；② 你已取得被操作方的同意；③ 你的使用方式符合所在司法辖区的法律与目标服务的使用条款。
>
> **默认假设：你知道自己在做什么，并且你拥有你正在操作的东西。** 如果你不满足这两条，请不要安装。

---

## 它能做什么

| 你想干的事 | 用什么工具 |
|---|---|
| 读串口传感器 / 给开发板发指令 | `serial_list_ports` `serial_open` `serial_read` `serial_write` `serial_close` |
| 编译、烧录、装库、列板卡 | `arduino_cli`（自动带上 Mind+ 自己的配置，board/core/库与 Mind+ 一致） |
| 跑一条本机命令 | `run_command` |
| 开一个能交互的终端（REPL、带菜单的程序） | `pty_open` `pty_write` `pty_read` `pty_resize` `pty_kill` |
| 登录行空板（UNIHIKER）改文件、跑命令 | `ssh_connect` `ssh_exec` `ssh_shell_*` `ssh_sftp` `ssh_disconnect` |
| 读 / 写 / 移动 Mind+ 目录里的文件 | `fs_read_text` `fs_write_text` `fs_list_dir` `fs_stat` `fs_mkdir` `fs_remove` `fs_rename` |
| 抓扩展包 / 解压 | `download_file` `unzip` |
| 连 MQTT broker 收发消息 | `mqtt_connect` `mqtt_subscribe` `mqtt_publish` `mqtt_read` `mqtt_disconnect` |
| UDP 广播做设备发现 | `udp_open` `udp_bind` `udp_set_broadcast` `udp_send` `udp_read` `udp_close` |
| 看看现在有哪些会话活着 | `sessions_status` |
| **截屏、看屏幕分辨率与 DPI** | `screen_info` `screen_capture` `screen_pixel` `screen_wait_change` |
| **点鼠标 / 拖动 / 滚轮 / 打字** | `mouse_click` `mouse_drag` `mouse_scroll` `mouse_move` `mouse_button` `keyboard_type` `keyboard_press` |
| **找到按钮再点它（描述式）** | `vision_locate` → `vision_click`（截图发给多模态模型，模型给坐标，服务器点下去） |
| **找到按钮再点它（离线式）** | `image_find`（模板匹配） / `pixel_find`（找色）——**不需要任何模型** |
| **让它自己一步步完成任务** | `vision_act`（截图 → 决策 → 执行 → 再截图，带上限与 dryRun） |
| **管理窗口、读写剪贴板** | `window_list` `window_rect` `window_activate` `clipboard_read` `clipboard_write` |

---

## 前置条件

1. **DFRobot Mind+ 2.0.x 正在运行**（不是必须常驻——服务器照常能启动，只是 mind-link 那批工具会明确报错）
2. **Node.js ≥ 22**（用到内置的全局 `WebSocket`，无需 `npm install`，零运行时依赖）
3. **界面识别与点击需要 Windows**。它靠系统自带的 Windows PowerShell 5.1 + Win32（`SendInput` / `CopyFromScreen` / `EnumWindows`），不依赖 Mind+，也不需要装任何东西。macOS / Linux 上这 23 个工具会明确报「Windows-only」，其余 44 个照常可用。

先跑一下环境探测，确认桥接是通的：

```bash
node install.mjs --list        # 看看本机装了哪些 MCP 客户端
node src/index.js --help       # 看启动参数
node test/gui-smoke.mjs        # 界面识别与点击的端到端自检（不需要 Mind+）
node test/smoke.mjs            # mind-link 端到端跑一遍（需要 Mind+ 开着）
```

---

## 安装

### 方式 A：让智能体自动装（推荐）

仓库里带了一个 `install.mjs`，专门为**无人值守执行**设计：不提问、可重复执行、改任何文件前先备份、原子写入（临时文件 + rename，写崩了也不会把配置截断）。

```bash
node install.mjs                # 自动探测并注册到所有找到的客户端
node install.mjs --dry-run      # 只看计划，不动任何文件
node install.mjs --json         # 输出机器可读结果（智能体用这个）
```

**把下面这段话直接丢给你的智能体**（DSH / Claude Code / Cursor 里的 agent 都行）：

> 帮我把 mindplus-mcp 注册到我的 MCP 客户端里。
> 1. 先跑 `node install.mjs --list --json`，看清本机有哪些客户端和它们的配置文件；
> 2. 再跑 `node install.mjs --dry-run --json`，把计划告诉我；
> 3. 我确认后跑 `node install.mjs --json`；
> 4. 把结果里每个 `status` 和 `restart` 字段念给我听，并提醒我重启对应客户端。

智能体也可以完全绕开脚本，自己写配置——脚本的 `--print` 会输出三种格式的片段，直接抄即可；加 `--json` 则输出机器可读的 `snippets.standard` / `snippets.vscode` / `snippets.dsh`，智能体不必去解析文本：

```bash
node install.mjs --print
node install.mjs --print --json --server-args '--shot-dir "D:\shots"'
```

**选项**

| 选项 | 作用 |
|---|---|
| `--list` | 列出探测到的客户端与配置文件路径 |
| `--target <ids>` | 只处理指定客户端，逗号分隔（`claude-desktop,claude-code,cursor,vscode,windsurf,workbuddy,dsh:<profile>`） |
| `--config <path>` | 额外注册到一个自定义配置；`.json` 按 mcpServers 处理，`.yml`/`.yaml` 按 DSH patch 处理 |
| `--name <name>` | 服务名，默认 `mindplus` |
| `--node <path>` | 指定要注册的 node 可执行文件（默认用运行本脚本的那个） |
| `--server-args <args>` | **追加到 `--transport stdio` 之后的额外参数**，可重复。接受 JSON 数组或带引号的字符串，例如 `--server-args '--shot-dir "D:\shots" --vision-config "D:\vision.json"'`。用来把截图目录、视觉配置这类选项固化进注册项 |
| `--http` / `--host` / `--port` | 注册 HTTP 传输而不是 stdio |
| `--dry-run` | 只打印计划 |
| `--print` | 只打印配置片段（配 `--json` 输出机器可读形式） |
| `--json` | 机器可读输出 |
| `--uninstall` | 移除注册项 |
| `--no-backup` | 不生成 `.bak-<时间戳>` 备份 |

> `--server-args` 里的 Windows 路径要用引号包起来（路径里有空格和反斜杠）。它同时作用于 JSON 片段和 DSH 的 YAML 块。

退出码：`0` 成功，`1` 出错，`2` 没找到任何客户端。

脚本自己也会做基本体检：Node 版本、入口文件是否存在、Mind+ 是否在 `127.0.0.1:19302` 上监听（只是提醒，不阻断）。

### 方式 B：手动写配置

**Claude Desktop / Claude Code / Cursor / Windsurf**（写进各自的 `mcpServers`）：

```json
{
  "mcpServers": {
    "mindplus": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["E:\\porject\\mindplus-mcp\\src\\index.js", "--transport", "stdio"]
    }
  }
}
```

配置文件位置：

| 客户端 | 路径 |
|---|---|
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json`（macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`） |
| Claude Code | `~/.claude.json` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| VS Code (Copilot) | `%APPDATA%\Code\User\mcp.json` |
| WorkBuddy AI | `~/.workbuddy-ai/mcp.json`（注意**不是**带点前缀的 `.mcp.json`） |

> **WorkBuddy 需要额外一步：** 写入 `mcp.json` 只是登记，新服务器默认处于**未信任**状态，不会自动生效。写完后到 **连接器中心 → 右上角自定义连接器入口 → 点击 Trust** 启用它。

**WorkBuddy 的推荐条目**（把新能力的配置一起固化进去，改完需要重启 WorkBuddy 才会生效）：

```json
{
  "mcpServers": {
    "mindplus": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "E:\\porject\\mindplus-mcp\\src\\index.js",
        "--transport", "stdio",
        "--shot-dir", "C:\\Users\\<你>\\.workbuddy-ai\\mindplus-shots",
        "--vision-config", "C:\\Users\\<你>\\.workbuddy-ai\\mindplus-vision.json"
      ]
    }
  }
}
```

一条命令即可生成（会自动备份原文件）：

```bash
node install.mjs --target workbuddy --node "C:\Program Files\nodejs\node.exe" \
  --server-args '["--shot-dir","C:\\Users\\<你>\\AppData\\Local\\mindplus-mcp\\shots","--vision-config","C:\\Users\\<你>\\.workbuddy-ai\\mindplus-vision.json"]'
```

`--shot-dir` 让截图落在固定目录（默认是 `%TEMP%`，会被系统清理，不利于事后核对）；`--vision-config` 指向一个独立的小 JSON 文件，**把 API key 放在那里而不是 `mcp.json` 里**，也省得为了换模型去改客户端配置。

**VS Code** 的键名是 `servers` 而不是 `mcpServers`，并且要带 `type`：

```json
{
  "servers": {
    "mindplus": {
      "type": "stdio",
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["E:\\porject\\mindplus-mcp\\src\\index.js", "--transport", "stdio"]
    }
  }
}
```

**DSH** 在 profile 的补丁层 `~/.dsh/profiles/<profile>/cordis.patch.yml` 末尾追加：

```yaml
- id: mcp-mindplus
  name: "@deepseek-ai/dsh-mcp-client"
  config:
    serverName: mindplus
    transport: stdio
    command: "C:\\Program Files\\nodejs\\node.exe"
    args:
      - "E:\\porject\\mindplus-mcp\\src\\index.js"
      - "--transport"
      - "stdio"
    failOnStartupError: false
```

工具会以 `mcp__mindplus__<tool>` 出现在工具表里。**改完必须重启 DSH Host**——补丁文件只在启动时被组合进插件树，运行中的 Host 不会监听它的改动。

> DSH profile 里 `tool-plugin-manager` 若是 `disabled: true`，就没有 `plugin_manager` 工具可用，只能直接改补丁文件。

判断是否已加载：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'transport\s+stdio' } |
  Select-Object ProcessId, CommandLine
```

有输出 = 桥接进程已经被拉起来了。

---

## 启动参数

```bash
node src/index.js                                  # stdio（默认，MCP 客户端直接拉起）
node src/index.js --transport http --port 8848     # HTTP：Streamable HTTP + 旧版 SSE
```

| 参数 | 说明 | 默认 |
|---|---|---|
| `-t, --transport` | `stdio` 或 `http` | `stdio` |
| `--host` | HTTP 绑定地址 | `127.0.0.1` |
| `-p, --port` | HTTP 绑定端口 | `8848` |
| `--control-port` | mind-link 控制口 | `19302` |
| `--transmit-port` | mind-link 传输口 | `19303` |
| `--timeout-ms` | 默认 RPC 超时 | `30000` |
| `--shot-dir` | 截图落盘目录 | `%TEMP%\mindplus-mcp\shots` |

HTTP 模式同时提供 `POST /mcp`（Streamable HTTP）和 `GET /sse` + `POST /messages`（旧版 HTTP+SSE，也就是 Mind+ 自家 `mcpserver` 扩展能吐出的那两种形态）。

### 视觉识别的配置（全部可选）

**不配也能用**——`image_find` / `pixel_find` 是本地的，不需要模型。只有 `vision_locate` / `vision_click` / `vision_act` 需要一个多模态模型。

| 参数 | 环境变量 | 说明 |
|---|---|---|
| `--vision-provider` | `MINDLINK_VISION_PROVIDER` | `none` / `openai` / `anthropic` / `ollama` / `command`，默认 `none` |
| `--vision-model` | `MINDLINK_VISION_MODEL` | 模型 id |
| `--vision-base-url` | `MINDLINK_VISION_BASE_URL` | API 地址（可指向任何兼容端点） |
| `--vision-api-key` | `MINDLINK_VISION_API_KEY` | API key |
| `--vision-command` | `MINDLINK_VISION_COMMAND` | `command` 提供者的 argv 模板，用 `{image}` / `{prompt}` 占位 |
| `--vision-max-width` | `MINDLINK_VISION_MAX_WIDTH` | 发给模型前把截图缩到这个宽度（省 token），默认 `1400` |
| `--vision-timeout-ms` | `MINDLINK_VISION_TIMEOUT_MS` | 单次请求超时，默认 `60000` |
| `--vision-config` | `MINDLINK_VISION_CONFIG` | JSON 配置文件路径 |
| — | `MINDLINK_VISION_HEADERS` | 额外请求头，JSON 对象 |

优先级：**默认值 < 配置文件 < 环境变量 < 命令行参数**。配错了不会让服务器起不来——错误会被记下来，由 `vision_config` 工具报出来。

```bash
# OpenAI 兼容端点
node src/index.js --vision-provider openai --vision-api-key sk-... --vision-model gpt-4o-mini

# 本地 Ollama（不需要 key）
node src/index.js --vision-provider ollama --vision-model llava

# 任何自己的脚本：stdout 打印 JSON 即可
node src/index.js --vision-provider command \
  --vision-command '"C:\Program Files\nodejs\node.exe" my-vision.mjs "{image}" --prompt "{prompt}"'
```

---

## 工具一览（67 个）

### 环境与发现
| 工具 | 说明 |
|---|---|
| `info` | Mind+ 环境信息：HOMEDIR、LINKAPPROOT、网络接口、内置 arduino-cli 路径。**先调这个确认 Mind+ 在跑。** |
| `serial_list_ports` | 列出可见串口（path / manufacturer / friendlyName / pnpId） |

### 串口会话（跨调用保持连接）
| 工具 | 说明 |
|---|---|
| `serial_open` | 打开串口并保持（默认 9600 8N1），等待 mind-link 的 `open` 事件 |
| `serial_read` | 排空接收缓冲；同时返回 base64（无损）和 UTF-8 文本 |
| `serial_write` | 发送数据，`encoding: "base64"` 可发二进制 |
| `serial_status` | 当前所有串口会话的状态 |
| `serial_close` | 关闭会话并释放端口 |

### 进程与工具链
| 工具 | 说明 |
|---|---|
| `run_command` | 通过 mind-link 的 `child_process` 通道执行命令，返回 stdout / stderr / exit code |
| `arduino_cli` | 调用 Mind+ **内置**的 `arduino-cli.exe`，并自动注入 `--config-file <user data>/Arduino/arduino-cli.yaml`，让 board/core/库与 Mind+ 安装的完全一致 |

### 文件与传输
| 工具 | 说明 |
|---|---|
| `fs_read_text` / `fs_write_text` | 读写文本文件（支持 `%HOMEDIR%` / `%APPROOT%`） |
| `fs_list_dir` / `fs_stat` | 列目录 / 取状态（支持占位符） |
| `fs_mkdir` / `fs_remove` | 建目录 / 删除（支持占位符；`fs_remove` 删目录时 `recursive` 默认 false） |
| `fs_rename` | 移动 / 重命名（**不展开**占位符，须传绝对路径） |
| `download_file` | 用 mind-link 的下载器抓取 URL（**不展开**占位符；与 Mind+ 拉板卡/扩展同一条路径） |
| `unzip` | 解压 zip（**不展开**占位符） |

### 伪终端（node-pty 子协议，跨调用保持会话）
| 工具 | 说明 |
|---|---|
| `pty_open` | 在伪终端里启动程序（cmd.exe / powershell / python…），返回后输出异步到达 |
| `pty_read` | 排空输出；同时给出子进程退出码 |
| `pty_write` | 发送输入（含换行即回车提交） |
| `pty_resize` | 调整终端 cols / rows |
| `pty_pause` / `pty_resume` | node-pty 流控：暂停 / 恢复输出 |
| `pty_kill` | 终止进程并释放会话 |

### SSH（ssh 子协议，适合登录行空板 UNIHIKER）
| 工具 | 说明 |
|---|---|
| `ssh_connect` | 连接主机并等待 ssh2 的 `ready`；**必须给 `username`**（见「已知限制」） |
| `ssh_exec` | 远端执行命令，收集 stdout / stderr / exit code（带 pty） |
| `ssh_shell_open` / `ssh_shell_write` / `ssh_shell_read` | 交互式 shell 的开启 / 写入 / 读取 |
| `ssh_sftp` | 一个工具覆盖 SFTP 全部操作：`op` = `readdir`/`mkdir`/`rmdir`/`stat`/`unlink`/`rename`/`readfile`/`writefile` |
| `ssh_disconnect` | 断开连接（同时关闭 shell 与 SFTP 子系统） |

### MQTT（MQTT 子协议）
| 工具 | 说明 |
|---|---|
| `mqtt_connect` | 连接 broker（`mqtt://` / `mqtts://`），等 `connect` 或 broker 报错 |
| `mqtt_subscribe` / `mqtt_publish` | 订阅 / 发布 |
| `mqtt_read` | 排空收到的消息（`{topic, message}`） |
| `mqtt_disconnect` | 断开连接 |

### UDP（UDP 子协议）
| 工具 | 说明 |
|---|---|
| `udp_open` | 创建 socket（`udp4` / `udp6`） |
| `udp_bind` | 绑定本地端口；**bind 返回即视为就绪** |
| `udp_send` | 发送数据报（**只能发文本**，见「已知限制」） |
| `udp_set_broadcast` | 开 / 关 SO_BROADCAST（设备发现广播用） |
| `udp_read` | 排空收到的数据报（含 `rinfo`） |
| `udp_close` | 关闭 socket |

### 会话总览
| 工具 | 说明 |
|---|---|
| `sessions_status` | 一次性报告 serial / pty / ssh / mqtt / udp 五个通道的全部活跃会话 |

### 屏幕观察（Windows，不需要 Mind+）
| 工具 | 说明 |
|---|---|
| `screen_info` | 虚拟桌面边界、每台显示器的范围 / 工作区 / DPI / 缩放比、当前光标位置、截图目录、视觉提供者状态。**GUI 自动化的第一步。** |
| `screen_capture` | 截屏存成 PNG（全屏 / 区域 / 单个窗口），返回路径、尺寸、字节数；`inline:true` 时同时把图返回 |
| `screen_pixel` | 读某一点的像素颜色（`#RRGGBB`）——不需要模型就能断言界面状态 |
| `screen_wait_change` | 盯着一块区域，直到它与基线差异超过阈值或超时。适合动作之后的「等界面反应过来」 |

### 鼠标与键盘
| 工具 | 说明 |
|---|---|
| `mouse_move` | 移动光标，可带 `durationMs` 平滑滑行 |
| `mouse_click` | 移动到坐标并点击；`count:2` 是双击，`holdMs` 让按下状态保持一会 |
| `mouse_drag` | 按下 → 滑到目标 → 松开。拖窗口、拖滑块、拖 Mind+ 积木都靠它 |
| `mouse_scroll` | 滚轮，`deltaV` 正数向上，`deltaH` 横向 |
| `mouse_button` | 只按下或只松开（`mouse_button down` → `mouse_move` → `mouse_button up`） |
| `keyboard_type` | 注入文本（走 Unicode 通道，中文也能打）；`\n` 是回车，`\t` 是 Tab |
| `keyboard_press` | 组合键：`ctrl+shift+s` / `enter` / `alt+tab` / `f5` / `pageup`，也可用 `vk:0x41` 直接给虚拟键码 |

**所有输入类工具都支持 `dryRun`**：只报告"我打算做什么"（含解析出来的键码、目标坐标），不真的动手。

### 窗口与剪贴板
| 工具 | 说明 |
|---|---|
| `window_list` | 枚举顶层窗口（标题 / 进程 / 类名 / 位置尺寸），默认只给可见、有标题、非 owned、未被 DWM cloaked 的——正是你要点的那些 |
| `window_rect` | 按标题 / 标题片段 / 进程名 / `0x` 句柄查单个窗口的边界 |
| `window_activate` | 还原（若最小化）并聚焦窗口，返回**是否真的抢到了前台**（Windows 有时会拒绝） |
| `clipboard_read` / `clipboard_write` | 读写剪贴板文本——把不方便程序化取出的内容抠出来最快的方式 |

### 识别：本地（不需要任何模型）
| 工具 | 说明 |
|---|---|
| `image_find` | 模板匹配：把一张 PNG 在一张截图里找出来，返回最佳位置 + 候选 + 相似度（0~1）。`source` 可直接搜已保存的 PNG，`searchRegion` 可限定搜索范围 |
| `pixel_find` | 找色：按颜色（带容差）找出一片像素，返回外接矩形、质心、命中数量。指示灯、纯色状态块用它 |
| `image_crop` | 从 PNG 里裁一块出来（可缩放）。**用来把截图变成模板**，喂给 `image_find` 长期复用 |

### 识别：视觉模型（截图 → 模型 → 坐标）
| 工具 | 说明 |
|---|---|
| `vision_config` | 看当前配置（key 已打码）；`test:true` 会发一张 2×2 探针图验证端点真的通 |
| `vision_locate` | 截图 → 问模型「XXX 在哪」→ 返回**图像坐标**和换算后的**屏幕坐标**，并写一张带标记的 PNG 供你核对。`mode:"list"` 列出全部匹配 |
| `vision_click` | 上一步 + 点击，一次调用完成。`dryRun` 只看会点哪，`offsetX/Y` 可微调落点 |
| `vision_act` | 给一个自然语言目标，让它自己循环：看屏 → 决策 → 执行 → 再看屏，最多 `maxSteps` 步。每步的决策、理由、截图都会返回 |

---

## 典型用法

会话类工具是**跨调用保持**的：`serial_open` / `pty_open` / `ssh_connect` / `mqtt_connect` / `udp_open` 打开后，后续调用用同一个 id 继续操作，最后记得关掉。

**读一路串口数据**

```
info → serial_list_ports → serial_open{port:"COM3",baudRate:115200}
     → serial_read{port:"COM3",timeoutMs:2000} → serial_close{port:"COM3"}
```

**给开发板编译烧录**

```
info → arduino_cli{args:["board","list"]}
     → arduino_cli{args:["compile","--fqbn","arduino:avr:uno","%HOMEDIR%\\Desktop\\blink"]}
     → arduino_cli{args:["upload","-p","COM3","--fqbn","arduino:avr:uno","%HOMEDIR%\\Desktop\\blink"]}
```

**开一个交互式 Python REPL**

```
pty_open{id:"py",cmd:"python"} → pty_write{id:"py",data:"print(1+1)\n"}
→ pty_read{id:"py",timeoutMs:2000} → pty_kill{id:"py"}
```

**登录行空板改文件**

```
ssh_connect{id:"uni",host:"10.1.2.3",username:"root",password:"dfrobot"}
→ ssh_exec{id:"uni",cmd:"uname -a"}
→ ssh_sftp{id:"uni",op:"writefile",path:"/root/main.py",data:"print('hi')"}
→ ssh_disconnect{id:"uni"}
```

**UDP 广播做设备发现**

```
udp_open{id:"u"} → udp_bind{id:"u",port:9000} → udp_set_broadcast{id:"u",flag:true}
→ udp_send{id:"u",message:"MIND+_DISCOVER",port:9000,address:"255.255.255.255"}
→ udp_read{id:"u",timeoutMs:3000} → udp_close{id:"u"}
```

---

## 界面识别与点击

这一族**不需要 Mind+**，因为它是直接在桌面上操作的。三条路线，从最稳到最灵活：

### 路线一：模板匹配（最准，不需要模型）

先截一张图，从里面裁一个模板，以后就能反复找它：

```
screen_info
→ screen_capture{region:{x:0,y:0,width:800,height:600}}          # 拿到截图路径
→ image_crop{source:"<截图路径>",x:520,y:310,width:96,height:32,
             output:"C:\\templates\\ok-button.png"}               # 裁出"确定"按钮
→ image_find{template:"C:\\templates\\ok-button.png",
             region:{x:0,y:0,width:800,height:600}, minScore:0.98}
   ⇒ {"found":true,"score":1,"screenPoint":{"x":568,"y":326}, ...}
→ mouse_click{x:568,y:326}
```

`image_find` 直接带 `click:true` 可以省掉最后一步。相似度 0.98 以上基本就是像素级命中——**比让模型看图准得多**，界面没变就一直有效。

### 路线二：描述式（截图 → 模型 → 点击）

界面上没有稳定的图像特征时（文字按钮、状态随时变），用描述：

```
vision_click{instruction:"右上角那个绿色的上传按钮", dryRun:true}
   ⇒ 先看它打算点哪：{"screenPoint":{"x":1842,"y":47},"confidence":0.91,
                       "annotated":"...\\located-shot-....png"}
vision_click{instruction:"右上角那个绿色的上传按钮"}                # 确认后真点
```

`annotated` 那张 PNG 上画了十字和框，**点下去之前先看一眼**是最省事的排错方式。也可以让客户端自己看图：加 `inline:true`。

### 路线三：让它自己走（`vision_act`）

不知道要几步、中间要等界面反应时：

```
vision_act{goal:"打开扩展面板并搜索 DHT11", maxSteps:6, dryRun:true}
   ⇒ {"outcome":"dry-run","steps":[{"step":1,"decision":"click",
       "reason":"点左侧的扩展图标", ...}]}
vision_act{goal:"打开扩展面板并搜索 DHT11", maxSteps:6,
           allowed:["click","type","key","wait","done"]}
```

- **永远先 `dryRun:true` 看一眼它的第一步**，再放开跑。
- `allowed` 限定它能用的动作（比如只给 `click`/`type`/`wait`/`done`），把 `drag`、`key` 这种破坏性大的挡在外面。
- `maxSteps` 是硬上限——视觉循环不设上限就是"机器无限点下去"。

### 拖动、滚动、打字

```
# 把窗口从左上拖到中间
window_rect{window:"新建项目 - Python积木模式"}          ⇒ {"x":100,"y":80,"width":1200,"height":800}
mouse_drag{fromX:600,fromY:90,toX:900,toY:400,durationMs:400}

# 滚轮 + 快捷键
mouse_scroll{x:900,y:500,deltaV:-5}                     # 向下滚 5 格
keyboard_press{keys:"ctrl+s"}                            # 保存
keyboard_type{text:"hello 世界\n"}                       # 打字并回车

# 等界面反应过来再截图
screen_wait_change{region:{x:0,y:0,width:1200,height:800},timeoutMs:5000}
```

### 用剪贴板把内容抠出来

```
clipboard_write{text:"要粘贴的内容"}
mouse_click{x:800,y:600} → keyboard_press{keys:"ctrl+v"}
keyboard_press{keys:"ctrl+a"} → keyboard_press{keys:"ctrl+c"}
clipboard_read                                            ⇒ {"text":"...","length":123}
```

---

## 测试

```bash
node test/install-smoke.mjs   # 安装脚本（纯本地，不需要 Mind+，不动你的真实配置）
node test/gui-smoke.mjs       # 界面识别与点击（不需要 Mind+，不需要 API key）
node test/smoke.mjs           # stdio 端到端，含真实 mind-link 工具调用
node test/http-smoke.mjs      # Streamable HTTP + 旧版 SSE 两种传输
```

`smoke.mjs` 与 `http-smoke.mjs` 需要 **Mind+ 正在运行**。`gui-smoke.mjs` 会碰真实桌面，但**所有点击都用 `dryRun`**，跑完会把光标和剪贴板还原，截图落在临时目录。实测结果：

```
$ node test/install-smoke.mjs
PASS  json: adds the server entry / preserves existing servers / preserves indent
PASS  json: is idempotent / --dry-run writes nothing / uninstall removes only our entry
PASS  yaml: appends a DSH patch block / keeps the pre-existing block / is idempotent
PASS  yaml: uninstall strips our block / matches an indented block
PASS  --print emits all three snippets / --list reports the client map
PASS  --server-args: quoted string form keeps Windows paths intact
PASS  --server-args: JSON array form matches the string form
PASS  --server-args: repeatable and appended after --transport stdio
PASS  --server-args: absent by default / malformed JSON fails cleanly
PASS  --server-args: reaches the DSH YAML snippet too
PASS  unknown --target fails cleanly
22/22 checks passed

$ node test/gui-smoke.mjs
PASS  tools/list exposes the GUI + vision family — 67 tools, missing: none
PASS  screen_info reports monitors and DPI — 2 monitor(s), awareness=per-monitor-v2
PASS  screen_capture writes a PNG of the requested size — 11362 bytes
PASS  screen_pixel returns a hex colour — #EEEEEE
PASS  window_list enumerates and filters windows — 11 windows total
PASS  window_rect resolves a handle to bounds
PASS  mouse_move actually moves the cursor — {"x":2520,"y":1380} -> {"x":2524,"y":1384}
PASS  mouse_click / mouse_drag / mouse_scroll dryRun plans without acting
PASS  keyboard_press resolves a chord to virtual keys — [17,16,83]
PASS  keyboard_type dryRun counts characters — length=8
PASS  keyboard_press rejects an unknown key name
PASS  clipboard write/read round trip — wrote 32 chars, read back 32 chars
PASS  image_crop cuts a template PNG
PASS  image_find locates a template cut from the same screenshot — score=1
PASS  image_find maps the match back to screen coordinates — {"x":150,"y":110}
PASS  image_find reports a miss instead of guessing
PASS  image_find honours searchRegion
PASS  pixel_find finds the colour of a known pixel — count=13896
PASS  screen_wait_change times out cleanly when nothing moves — elapsed=933ms
PASS  vision_config reports provider=none / vision_locate explains why it cannot run
PASS  vision_config with a command provider probes successfully — probe=ok
PASS  vision_locate maps the model point to screen coordinates — {"x":40,"y":25}
PASS  vision_locate writes an annotated PNG and passes the prompt through
PASS  vision_click dryRun locates and plans without clicking
PASS  vision_act dryRun plans exactly one step and injects nothing
30/30 checks passed

$ node test/smoke.mjs
PASS  initialize — protocolVersion=2025-06-18 server=mindplus
PASS  tools/list — 67 tools
PASS  tools/call info / serial_list_ports / run_command
PASS  tools/call fs_write_text + fs_read_text
PASS  tools/call fs_mkdir + fs_rename + fs_stat + fs_remove
PASS  tools/call arduino_cli version + uses Mind+ config
PASS  tools/call serial_open fails fast on a bad port — elapsed=3ms
PASS  tools/call pty_open + pty_read — text: "\u001b[0m\u001b[0Kpty-ok…"
PASS  tools/call udp_open + udp_bind + udp_send + udp_read — text: "udp-smoke-ok"
PASS  tools/call ssh_connect fails fast — elapsed=4ms
PASS  tools/call mqtt_connect fails fast — elapsed=84ms
PASS  tools/call sessions_status / unknown tool reports an error
16/16 checks passed

$ node test/http-smoke.mjs
PASS  POST /mcp initialize            PASS  GET /sse opens an event stream
PASS  POST /mcp tools/list — 67 tools PASS  SSE endpoint event
PASS  POST /mcp tools/call info       PASS  POST /messages accepted
                                      PASS  SSE response for initialize
7/7 checks passed
```

界面那套为什么这么测：`image_find` 的用例是**从同一张截图里裁出模板再找回去**，期望坐标精确到 (150, 110)——这样 PNG 解码、裁剪、编码、模板匹配、坐标映射整条链路都被真实覆盖，而且**完全确定**，不依赖屏幕上碰巧有什么。视觉那套用 `test/fixtures/fake-vision.mjs` 假装成模型，所以**不需要 API key、不需要联网**也能验证 provider 接线、提示词拼装、JSON 解析和坐标换算。

---

## 常见问题

**工具调用报「Is Mind+ 2.0 running?」/ 连不上 127.0.0.1:19302**
Mind+ 没开。它启动时才拉起 `mind-link`。服务器本身不需要 Mind+ 就能启动，这是刻意的——否则会把 MCP 客户端的启动一起拖挂。

**MCP 客户端里看不到 `mcp__mindplus__*`**
stdio 服务器只在客户端启动时被拉起。改完配置**必须重启客户端**。DSH 还要确认补丁文件在正确的 profile 下。WorkBuddy 另需在连接器中心 Trust 一次。

**改了 `mcp.json` 的参数（`--shot-dir` / `--vision-config` 等）但没生效**
stdio 服务器是客户端启动时按当时的配置拉起的，进程不会热加载。改完 `mcp.json` 或视觉配置文件后，**重启客户端**（WorkBuddy 还要确认连接器仍处于启用状态）。想确认当前进程实际用的参数，调一次 `screen_info`——它会报出真实的 `shotDir` 和 `vision` 配置。

**`vision_locate` 说没有配置提供者**
`vision_*` 三个工具需要一个多模态模型；`image_find` / `pixel_find` 不需要。跑 `vision_config` 看当前状态，`vision_config{test:true}` 验证端点通不通。配置方式见上面「视觉识别的配置」——用 WorkBuddy 的话，改 `~/.workbuddy-ai/mindplus-vision.json` 里的 `provider` 即可，不用动 `mcp.json`。

**`ssh_connect` 卡到超时**
八成是漏了 `username`。ssh2 的 `Config` 缺字段会**同步抛错**，而 mind-link 会**静默丢弃**这条调用（不回复、不报错）。本服务器已把 `username` 设为必填并在客户端预检，但如果你传了别的畸形字段，仍会表现为超时。

**`ssh_connect` 只说"被拒绝或握手失败"，不给具体原因**
mind-link 的 `reportError` 读的是 `e.messgae`（拼写错误），所以 `error` 通知的 params 恒为 `undefined`。这是 mind-link 的锅，拿不到 `ECONNREFUSED` 之类的底层原因。

**`udp_send` 发二进制报错**
发不了。mind-link 把 `message` 原样交给 `dgram.send()`，而 JSON 承载不了 Buffer，`dgram.send` 又不接受普通数组。只能发文本；接收方向不受影响。

**HTTP 模式想给局域网用**
默认只绑 `127.0.0.1`，要显式 `--host 0.0.0.0`。**但该服务器没有任何鉴权**，而 `run_command` / `fs_*` / `ssh_*` / `mouse_*` / `keyboard_*` 等于把本机的命令执行、文件读写、**键鼠控制**直接暴露出去——请自行评估风险。

**`screen_*` / `mouse_*` 报「Windows-only」**
界面识别与点击走的是 Win32 + Windows PowerShell 5.1，只在 Windows 上可用。macOS / Linux 上这 23 个工具会明确报错，其余工具不受影响。

**截图是全黑的 / 点不到正确的位置**
三种常见原因：
1. **独占全屏的程序**（游戏、部分播放器）不会被 `CopyFromScreen` 抓到。窗口类工具可以试 `printWindow:true`（默认开）。
2. **多显示器不同缩放**。`screen_info` 里的 `awareness` 应该是 `per-monitor-v2`；如果显示 `system` 或 `unaware`，在缩放不是 100% 的显示器上坐标会有偏差。本项目已通过 `__COMPAT_LAYER=HIGHDPIAWARE` + 运行时设置尽量拿到 per-monitor-v2。
3. **目标程序以管理员身份运行**，而本服务器不是。Windows 的 UIPI 会**静默丢弃**低完整性进程发来的输入。解决办法是让 MCP 客户端也以管理员身份运行。

**`mouse_click` 点了但界面没反应**
先用 `screen_info` 看光标位置对不对，再用 `screen_capture{inline:true}` 看一眼实际画面。很多控件需要先聚焦窗口（`window_activate`）或需要按下状态保持一会（`holdMs:50`）。

**模型给的坐标总是偏一点**
先确认 `screen_info` 里的 `awareness` 是 `per-monitor-v2`。如果还偏，用 `vision_click` 的 `offsetX/offsetY` 做固定偏移补偿；或者干脆改用 `image_find`——模板匹配不受模型精度影响。

---

## 已知限制

> 这一节列的是**功能层面**的限制与未验证项。**权限与风险**（它接管了什么、没经过什么授权、免责声明）在开头的「[安全须知：它强制接管了什么](#安全须知它强制接管了什么)」一节。

- **界面自动化仅限 Windows**：靠 Win32 + Windows PowerShell 5.1 实现，没有 macOS / Linux 后端。
- **`vision_*` 的成功路径未实测**：本机没有配置任何视觉模型（也没有在跑的 Ollama），所以模型真实返回坐标的行为只做了协议层与接线层的验证——用 `test/fixtures/fake-vision.mjs` 假扮模型跑通了全链路，但**没有用真模型端到端跑过**。首次使用请先 `vision_config{test:true}`。
- **`vision_act` 是尽力而为**：模型可能点错、可能循环。请始终先 `dryRun`，并设 `maxSteps` 与 `allowed`。
- **多显示器混合缩放**：已尽量拿到 per-monitor-v2 DPI 感知，但如果你在 150% 缩放的副屏上遇到坐标偏移，请以 `screen_info` 报告的 `scale` 为准自行换算。
- **只读不到硬件**：`serial_*` 需要真实串口设备才会真正打开。打开失败会在数毫秒内返回错误；但**成功打开后与开发板收发数据**的行为尚未在本机验证。
- **成功的 SSH / MQTT 会话未实测**：本机没有可连的行空板，也没有 broker。失败路径都已实测，成功路径只做了协议层核对。
- **占位符不通用**：`fs_rename` / `download_file` / `unzip` 不展开 `%HOMEDIR%` / `%APPROOT%`，必须传绝对路径。
- **`udp_open` 的 `open` 通知不可信**：它是**首个数据报到达**时才触发的，不是 bind 成功时。以 `udp_bind` 的返回为准。
- **`download_file` 子协议未包装**：`download_file` 工具走的是控制口那条路，传输口带进度通知、可中止的那条仍是空白。
- **mind-link 端口是硬编码的**（`19302` / `19303`），`--control-port` / `--transmit-port` 只在 Mind+ 改变约定时才有用。
- 服务器假设 **`ws.protocol` 分流**这一实现细节稳定；它是逆向结论，不是公开契约。**Mind+ 升级后请重跑测试套件。**

---

## 目录结构

```
mindplus-mcp/
├── LICENSE            MIT
├── install.mjs        自动注册到本机所有 MCP 客户端（幂等 / 备份 / 原子写）
├── package.json
├── README.md
├── docs/
│   ├── PROTOCOL.md    逆向笔记：mind-link 完整协议表 + 逐条核验结论
│   └── AUTOMATION.md  界面识别与点击：架构、坐标模型、提示词契约、安全边界
├── src/
│   ├── index.js       CLI 入口与参数解析
│   ├── mindlink.js    mind-link 的 JSON-RPC / WebSocket 客户端
│   ├── sessions.js    五个传输口会话类（Serialport / node-pty / ssh / MQTT / UDP）
│   ├── tools.js       67 个工具的目录与实现
│   ├── gui.js         GUI 主机客户端（JSON-lines 驱动 PowerShell）
│   ├── gui-host.ps1   PowerShell + C# 的 Win32 内核（截屏 / SendInput / 窗口 / 剪贴板）
│   ├── image.js       零依赖 PNG 编解码 + 识别原语（模板匹配 / 找色 / 差异）
│   ├── vision.js      视觉识别框架（提供者 / 提示词 / 解析 / 坐标换算）
│   ├── automation.js  抓屏 → 识别 → 执行的编排与视觉循环
│   ├── server.js      MCP 协议核心（initialize / tools.list / tools.call）
│   └── transports.js  stdio、Streamable HTTP、旧版 HTTP+SSE
├── test/
│   ├── install-smoke.mjs 安装脚本（本地，不需要 Mind+）
│   ├── gui-smoke.mjs     界面识别与点击（本地，不需要 Mind+ 或 API key）
│   ├── smoke.mjs         mind-link stdio 端到端
│   ├── http-smoke.mjs    HTTP + SSE 端到端
│   └── fixtures/
│       └── fake-vision.mjs  假视觉模型，用来测 provider 接线
└── extensions/        逆向期间从扩展商店下载的官方扩展（证据留存）
    ├── DFRobot-mcpserver@0.0.3/      解包后的扩展（config.json / main.js）
    ├── DFRobot-mcpserver@0.0.4/
    ├── Nick-xiaozhimcp@0.0.3/
    └── *.zip                          原始扩展包
```

`extensions/` 只作为「Mind+ 的 MCP 扩展到底长什么样」的一手证据保留，运行时**完全不依赖**它——服务器是零依赖的，`src/` 之外的东西删掉也能照常跑。

---

## 许可

**MIT License** —— 全文见 [LICENSE](LICENSE)。

```
Copyright (c) 2026 mindplus-mcp contributors
```

你可以自由使用、修改、分发、商用，**唯一条件**是保留版权声明与许可声明。

> **署名是占位符。** `Copyright (c) 2026 mindplus-mcp contributors` 里的 `mindplus-mcp contributors` 换成你自己的名字或组织即可。
>
> **`package.json` 里保留了 `"private": true`。** 这是刻意的：这个包安装后会赋予**本机任意命令执行、文件读写与键鼠控制**能力，不适合作为公共 npm 包分发。要发布请自行移除该字段，并清楚你在把什么交给安装者。

### 许可 ≠ 免责

MIT 的 `AS IS` 条款与上面的「[免责声明](#免责声明)」是**叠加**的，不是互相替代：作者把代码交给你，但不对它做了什么负责。把它接上自动化流程、让它去点、去删、去烧录——**风险与责任都在你这边**。

---

## 深入

- **为什么不用 Mind+ 官方的 MCP 扩展？** 因为 Mind+ 2.0.7 根本没有「IDE 连接到任意 MCP 服务器」这个能力，官方那两个 MCP 扩展都是在"用户程序"层面工作的。详细考证见 [docs/PROTOCOL.md](docs/PROTOCOL.md)。
- **完整的协议表、参数形状、通知名、逐条核验结论** → [docs/PROTOCOL.md](docs/PROTOCOL.md)
- **界面识别与点击怎么设计的**（坐标模型、提示词契约、为什么用常驻 PowerShell、安全边界） → [docs/AUTOMATION.md](docs/AUTOMATION.md)
