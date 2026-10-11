# 逆向笔记与协议参考

> 日常使用请看 [README](../README.md)。这里是 `mindplus-mcp` 的**实现依据**。

所有结论都对照 `D:\Program Files\Mind+\apps\deps\mind-link\main.js`（v2.0.2，49 KB 单行 webpack bundle）原文逐条核验，并在运行中的 mind-link 上实测过。Mind+ 升级后请重跑测试套件。

---

## 为什么是这条路（Mind+ 2.0.7 的 MCP 现状）

Mind+ 2.0 的发布说明宣称引入了「智能体编辑器」和「MCP 库」。把扩展商店的索引全量拉下来核对后（python-block 327 个、upload 755 个、micropython-block 50 个、realtime 103 个扩展），与 MCP 相关的**只有两个**，而且都在"用户程序"层面：

| 扩展 | 模式 | 作者 | 实际行为 |
|---|---|---|---|
| `mcpserver`「MCP服务器」 | python-block | DFRobot | 让你写的 Mind+ **Python 程序变成 MCP 服务器**（`fastmcp` + `uvicorn`，传输只支持 `http` / `sse`） |
| `xiaozhimcp`「小智 MCP 客户端」 | upload | Nick | 让 **ESP32 程序当 MCP 客户端**（`libraries/xiaozhi-mcp/src/WebSocketMCP.cpp`）去连小智的 WebSocket MCP 服务 |

`mcpserver` 扩展生成的代码骨架（从 `main.js` 提取，原文）：

```python
from fastmcp import FastMCP
import uvicorn
from starlette.middleware.cors import CORSMiddleware

mcp = FastMCP("MCP Server")
# CORS: allow_origins=["*"], headers: content-type/authorization/
#        mcp-protocol-version/mcp-session-id, expose: mcp-session-id

# http 模式（默认）:  app = mcp.http_app(middleware=middleware)
# sse  模式:          app = mcp.http_app(transport="sse", path="/sse", middleware=middleware)

uvicorn.run(app, host="0.0.0.0", port=PORT)   # 端口积木默认 8005
```

积木共 6 个：`MCP服务器初始化` / `设置MCP服务通讯类型[http(默认)|sse]` / `启动MCP服务器 监听端口[8005]` /
`添加工具[NAME] 功能描述[DESC]` / `当工具[FUNC]被调用时` / `获取LLM返回得数据` / `返回给LLM结果[RESULT]`。

> ⚠️ 该扩展生成的每个工具签名都写死成 `def MCP_tool_<NAME>(value):` —— **只接收一个无类型参数 `value`**，
> `get_param_value` 直接返回标识符 `value`，没有参数 schema。

**结论：Mind+ 2.0.7 没有「IDE 连接到任意 MCP 服务器」的界面。** 它既不能把外部工具接进自己的编辑器，也没有可配置的 MCP 客户端列表。所以"控制 Mind+"这件事只能走它自己的本地 IPC——也就是 `mind-link`。

媒体宣传里的「智能体编辑器 / MCP 库」目前只落地成了扩展库里的 MCP 类扩展：

- 官方更新日志（[ReleaseLogs](https://mindplus.dfrobot.com.cn/mp2/SoftwareIntroduction/ReleaseLogs/)）从 V2.0.1 到 V2.0.7 **从未出现** MCP 或「智能体」；
- 官方文档站目录里没有任何 MCP / 智能体页面，扩展库章节只文档化了 3 个与 AI 推理相关的扩展；
- `resources/app.asar` 全文搜索 `MCP` / `mcpServers` / `智能体` / `模型上下文` 命中数为 **0**；
- DFRobot 的 GitHub 组织（200+ 仓库）没有 MCP/agent/LLM 仓库——社区侧的 `mindplus-hub` 是社区组织，不是官方。

**一处未验证的细节**：`http` 模式下 `mcp.http_app()` 没有传 `path`，Streamable HTTP 的实际挂载路径由 FastMCP 内部决定。本服务器同时接受 `POST /mcp` 和 `POST /`，因此两种可能都覆盖；但「Mind+ 的扩展确实监听在某个特定路径」这件事需要真正在 GUI 里跑一次扩展才能确认，此处不当作已证事实。

本项目的 HTTP/SSE 传输是按 FastMCP 的传输形态对齐设计的，所以同一个服务器既能被 DSH 用 stdio 消费，也能被 Mind+ 侧的 Python 程序用 `http`/`sse` 消费。

---

## 逆向得到的协议（已对照运行中的服务逐条验证）

`mind-link` 的 `main.js` 是一个 49 KB 的单行 webpack bundle（v2.0.2）。关键结论：

### 控制口 `19302` —— 一个连接一组方法

```
{"jsonrpc":"2.0","id":1,"method":"getHomedir"}        →  {"jsonrpc":"2.0","id":1,"result":"C:\\Users\\..."}
{"jsonrpc":"2.0","method":"data","params":"<base64>"}  ←  通知（无 id）
```

| 方法 | 参数 |
|---|---|
| `readFile` | `{path, encoding}` |
| `writeFile` | `{fileName, content, flag}` |
| `readdir` / `mkdir` / `rmdir` | `{path, options}` |
| `unlink` / `access` / `exists` / `stat` | `{path}` |
| `rename` / `writeImgFile` | 路径相关 |
| `serialList` | 无 |
| `getPathInfo` | 无 → `{HOMEDIR, LINKAPPROOT}` |
| `getHomedir` / `getNetworkInterfaces` | 无 |
| `downloadFile` | `{url, targetPath}` |
| `unzip` | `{zipFile, unzipPath}` |
| `openSelectFileDialog` / `openSelectDirectoryDialog` / `showMessageInMinkLink` / `reportVersion` / `startProxy` / `startAutoTest` | 界面与维护类 |

路径里的 `%HOMEDIR%` 和 `%APPROOT%` 由 mind-link 自己展开（`replacePath`：`%APPROOT%` = mind-link 进程的 cwd = mind-link 根目录）。

> ⚠️ 展开**只发生在** `readFile` / `writeFile` / `readdir` / `mkdir` / `rmdir` / `unlink` / `stat` / `writeImgFile` 这 8 个方法上。
> `rename`、`downloadFile`、`unzip` 直接拿原始字符串使用，**不展开**占位符——传给它们的路径必须是绝对路径。
> 另外 `replacePath` 是 `String.replace(字面量)`，**只替换第一次出现**，路径里出现两次 `%HOMEDIR%` 时第二个不会展开。

以上方法名与参数形状已逐条对照 `main.js`（v2.0.2）原文核验，见下文「验证状态」。

### 传输口 `19303` —— 按 **WebSocket 子协议名** 分流

`handleTransmitConnection(ws)` 直接看 `ws.protocol`：

| 子协议 | 方法 | 服务端推送的通知 |
|---|---|---|
| `Serialport` | `newSerialport({port,baudRate,dataBits,parity,stopBits})`、`open`、`set`、`update({baudRate})`、`write`、`close` | `open`、`data`（base64 字符串）、`close`、`error` |
| `child_process` | `spawn({cmd,args,options})`、`exec({cmd,options})`、`kill({signal})` | `stdoutData`、`stderrData`、`error`、`exit` |
| `node-pty` | `spawn({cmd,args,options})`、`write(<字符串>)`、`resize({cols,rows})`、`kill`、`pause`、`resume` | `data`（字符串）、`exit`（`{exitCode,signal}`） |
| `ssh` | `connect(<ssh2 Config>)`、`end`、`shell`、`shellWrite(<字符串>)`、`exec({cmd})`、`execWrite`、`execSignal(<signal>)`、`execClose`、`sftp`、`readdir({path})`、`mkdir({path})`、`rmdir({path})`、`stat({path})`、`unlink({path})`、`rename({oldPath,newPath})`、`readfile({path})`、`writefile({path,data,flag})` | `ready`、`error`（**params 恒为 `undefined`**，见下）、`close`、`shell-data`/`shell-close`、`exec-data`/`exec-stderr-data`/`exec-close` |
| `MQTT` | `connect({url,options})`、`subscribe({topic,options})`、`publish({topic,message,options})`、`end` | `connect`、`message`（`{topic,message}`）、`error`、`reconnect`、`offline`、`close` |
| `UDP` | `createSocket(<"udp4"｜"udp6">)`、`bindPort({port,ip})`、`sendUdpMessage({message,offset,length,port,address})`、`closeUdp`、`setBroadcast(<bool>)` | `open`（实为**首个数据报到达**时触发，不是 bind）、`message`（`{message:base64,rinfo}`）、`error`、`close` |
| `download_file` | `downloadFile`、`stopDownload` | 进度（**未包装**：`download_file` 工具走的是控制口那条路） |

子协议名不认识时，服务端回 `{error:'protocol "X" not support'}` 并断开。

### 验证状态

已逐条对照 `main.js`（v2.0.2）原文核验：

| 项 | 结论 |
|---|---|
| 控制口全部方法的参数形状 | ✅ 与本服务器实现一致：`rename`→`{oldPath,newPath}`、`writeFile`→`{fileName,content,flag}`、`mkdir`/`rmdir`→`{path,options}`、`downloadFile`→`{url,targetPath}`、`unzip`→`{zipFile,unzipPath}`、`stat`/`unlink`/`access`/`exists`→`{path}`、`readdir`→`{path,options}` |
| `%HOMEDIR%` / `%APPROOT%` 展开范围 | ✅ 仅 8 个 fs 方法，且只替换首次出现（见上文警告） |
| 串口打开失败的信号 | ✅ 坏端口发 `error` 通知（形如 `Error: Opening COM255: File not found`），随后 mind-link 销毁 WS；SerialPort 自身的 `close` 事件才发 `close` 通知 |
| `newSerialport` 参数 | ✅ 只取 `{port,baudRate,dataBits,parity,stopBits}` |
| `write` 的 `params` | ✅ 裸 base64 字符串 |
| Arduino 数据目录 | ✅ `<user data>/Arduino`，其中 `<user data>` = `%HOMEDIR%\AppData\Local\mind+`（Windows）、`~/Library/mind+`（macOS）、`~/.mind+`（Linux） |
| Mind+ 如何驱动 arduino-cli | ✅ 通过自带配置 `<user data>/Arduino/arduino-cli.yaml`（里面钉死 `directories.data` / `downloads` / `user`），**不是** `ARDUINO_DIRECTORIES_DATA` 环境变量 |
| node-pty / ssh / MQTT / UDP 的参数形状与通知名 | ✅ 全部对照 `main.js` 核验，并已包装成 44 个工具中的 26 个 |
| node-pty 实际行为 | ✅ 本机实测：`cmd.exe /c echo` 拿到输出与 `exitCode:0` |
| UDP 实际行为 | ✅ 本机实测：bind → send → 环回收到数据报 |
| MQTT 失败路径 | ✅ 本机实测：连接被拒时约 90ms 返回 broker 错误（`ECONNREFUSED`） |
| SSH 失败路径 | ✅ 本机实测：连接被拒时约 230ms 返回结构化错误 |
| **ssh2 的配置校验** | ⚠️ 缺 `username` 时 ssh2 的 `Config` **同步抛错**，mind-link 的 `didReceiveCall` 随之抛出、**整条调用被静默丢弃（永不回复）**——因此 `ssh_connect` 把 `username` 设为必填并在客户端预检 |
| ssh 的 `error` 通知 | ⚠️ bundle 里 `reportError(e){…e.messgae}` 拼写错误，params **恒为 `undefined`**，连接被拒时拿不到底层原因 |

仍未实测：**成功的** SSH 登录、**成功的** MQTT 会话（本机无 broker）、真实串口与开发板的收发。这三条都需要一台可连的行空板或一个 broker 才能覆盖。

### 三个必须知道的实现陷阱

1. **`write` 的 `params` 就是 base64 字符串本身**，不是对象：
   `t.write = function(e){ let i = Buffer.from(e, "base64"); ... }`
2. **`spawn` 是即发即忘**：RPC 立刻回 `result: null`，真正的 stdout/stderr/退出码全靠通知。`exec` 的应答与套接字销毁存在竞态，所以本项目一律用 `spawn` + 通知。
3. **终端事件后 mind-link 会自己销毁套接字**（`close(){ setTimeout(()=>this.dispose(), 1) }`）。因此控制口采用"一次调用一个连接"，串口则由本服务器持有长连接。
