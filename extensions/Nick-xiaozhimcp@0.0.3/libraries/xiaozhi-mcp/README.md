# xiaozhi-mcp库

ESP32 虾哥小智平台MCP客户端库，用于通过MCP插件将ESP32设备接入虾哥小智平台，支持工具注册和调用，可通过小智AI音箱控制设备。

## 功能特点
- 支持WebSocket和WebSocket Secure (WSS)连接
- 自动重连机制，确保连接稳定性
- 支持JSON-RPC协议通信
- 工具注册和调用系统
- 灵活的回调函数机制
- 支持ESP32平台

## 安装指南

### 方法1：通过Arduino库管理器
1. 打开Arduino IDE
2. 点击"工具" -> "管理库..."
3. 在搜索框中输入"xiaozhi_mcp"
4. 点击"安装"按钮

### 方法2：手动安装
1. 下载本库的ZIP文件
2. 打开Arduino IDE
3. 点击"草图" -> "导入库" -> "添加.ZIP库..."
4. 选择下载的ZIP文件

## 快速开始

以下是一个完整的使用示例，展示如何连接到MCP服务器并注册工具：

```cpp
#include <WiFi.h>
#include <xiaozhi_mcp.h>

// WiFi配置
const char* ssid = "your-ssid";
const char* password = "your-password";

// MCP服务器配置
const char* mcpEndpoint = "ws://your-mcp-server:port/path";

// 创建WebSocketMCP实例
WebSocketMCP mcpClient;

// 连接状态回调函数
void onConnectionStatus(bool connected) {
  if (connected) {
    Serial.println("[MCP] 已连接到服务器");
    // 连接成功后注册工具
    registerMcpTools();
  } else {
    Serial.println("[MCP] 与服务器断开连接");
  }
}

// 工具回调函数 - 控制LED
ToolResponse ledControl(const String& params) {
  // 解析参数
  ToolParams toolParams(params);
  if (!toolParams.isValid()) {
    return ToolResponse(true, "无效的参数");
  }

  // 获取LED状态参数
  String state = toolParams.getString("state");
  if (state.isEmpty()) {
    return ToolResponse(true, "缺少state参数");
  }

  // 控制LED
  if (state == "on") {
    digitalWrite(LED_BUILTIN, HIGH);
    return ToolResponse(false, "LED已打开");
  } else if (state == "off") {
    digitalWrite(LED_BUILTIN, LOW);
    return ToolResponse(false, "LED已关闭");
  } else {
    return ToolResponse(true, "无效的state值，只能是'on'或'off'");
  }
}

// 注册MCP工具
void registerMcpTools() {
  // 注册LED控制工具
  mcpClient.registerTool(
    "led_control",
    "控制ESP32板载LED",
    "{\"type\":\"object\",\"properties\":{\"state\":{\"type\":\"string\",\"description\":\"LED状态: on/off\"}},\"required\":[\"state\"]}",
    ledControl
  );

  // 注册一个简单工具（简化版）
  mcpClient.registerSimpleTool(
    "say_hello",
    "向指定名称的人问好",
    "name",
    "要问候的人的名字",
    "string",
    [](const String& params) {
      ToolParams p(params);
      String name = p.getString("name");
      return ToolResponse(false, "你好, " + name + "!");
    }
  );
}

void setup() {
  Serial.begin(115200);

  // 初始化LED引脚
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);

  // 连接WiFi
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("WiFi连接成功");

  // 初始化MCP客户端
  if (mcpClient.begin(mcpEndpoint, onConnectionStatus)) {
    Serial.println("MCP客户端初始化成功");
  } else {
    Serial.println("MCP客户端初始化失败");
  }
}

void loop() {
  // 处理MCP客户端事件
  mcpClient.loop();
  delay(10);
}
```

## 使用说明

### 1. 连接到MCP服务器

1. 配置WiFi网络信息
2. 设置MCP服务器端点URL
3. 创建`WebSocketMCP`实例
4. 调用`begin()`方法初始化并连接到服务器
5. 在`loop()`函数中调用`mcpClient.loop()`处理事件

### 2. 注册工具

工具是设备提供给MCP服务器的功能接口，可以通过以下两种方式注册：

#### 方法1：完整注册（带详细参数定义）
```cpp
mcpClient.registerTool(
  "tool_name",
  "工具描述",
  "{\"type\":\"object\",\"properties\":{\"param1\":{\"type\":\"string\"}},\"required\":[\"param1\"]}",
  toolCallback
);
```

#### 方法2：简化注册（适用于单参数工具）
```cpp
mcpClient.registerSimpleTool(
  "tool_name",
  "工具描述",
  "param_name",
  "参数描述",
  "param_type",
  toolCallback
);
```

### 3. 工具回调函数

工具回调函数接收参数并返回响应：
```cpp
ToolResponse toolCallback(const String& params) {
  // 解析参数
  ToolParams toolParams(params);
  if (!toolParams.isValid()) {
    return ToolResponse(true, "无效的参数");
  }

  // 处理业务逻辑
  // ...

  // 返回结果
  return ToolResponse(false, "操作成功");
}
```

### 4. 与小智AI音箱交互

1. 确保设备已成功连接到MCP服务器
2. 在小智AI音箱上唤醒并说出指令，例如："小智，让我的ESP32打开LED"
3. 音箱会将指令发送到MCP服务器
4. 服务器会调用设备上注册的相应工具
5. 设备执行工具并返回结果
6. 音箱会播报执行结果

### 5. 调试技巧

1. 使用`Serial.println()`输出调试信息
2. 检查WiFi连接是否正常
3. 确认MCP服务器地址和端口是否正确
4. 查看串口输出的错误信息
5. 确保工具注册代码在连接成功后调用

## API参考

### WebSocketMCP类

#### 构造函数
```cpp
WebSocketMCP();
```

#### 初始化方法
```cpp
bool begin(const char *mcpEndpoint, ConnectionCallback connCb = nullptr);
```
- `mcpEndpoint`: WebSocket服务器地址(ws://host:port/path)
- `connCb`: 连接状态变化回调函数
- 返回值: 初始化是否成功

#### 发送消息
```cpp
bool sendMessage(const String &message);
```
- `message`: 要发送的JSON字符串
- 返回值: 发送是否成功

#### 工具注册
```cpp
bool registerTool(const String &name, const String &description, const String &inputSchema, ToolCallback callback);
bool registerSimpleTool(const String &name, const String &description, const String &paramName, const String &paramDesc, const String &paramType, ToolCallback callback);
```
- `name`: 工具名称
- `description`: 工具描述
- `inputSchema`: JSON格式的输入参数定义
- `callback`: 工具回调函数
- 返回值: 注册是否成功

#### 工具管理
```cpp
bool unregisterTool(const String &name);
void clearTools();
size_t getToolCount();
```

#### 连接状态
```cpp
bool isConnected();
void disconnect();
```

### ToolResponse类

用于创建工具调用响应：
```cpp
// 创建文本响应
ToolResponse(bool isError, const String& message);

// 创建JSON响应
ToolResponse(const String& json, bool isError = false);

// 从JSON对象创建响应
static ToolResponse fromJson(const JsonObject& json, bool error = false);
```

### ToolParams类

用于解析工具参数：
```cpp
ToolParams(const String& json);
bool isValid() const;
String getString(const String& key) const;
int getInt(const String& key, int defaultValue = 0) const;
bool getBool(const String& key, bool defaultValue = false) const;
float getFloat(const String& key, float defaultValue = 0.0f) const;
```

## 示例

- **BasicExample**: 基本连接和工具注册示例
- **SmartSwitchExample**: 智能开关控制示例

## 相关项目
如果您需要更完整的智能家居解决方案，推荐关注 ha-esp32 项目
- 在ESP32中实现HomeAssistant，对接小米、小度、涂鸦、天猫精灵等平台
- 提供MCP接口，支持大模型调用，统一控制家庭设备
- 项目地址：https://gitee.com/panzuji/ha-esp32

## 版本历史
- v1.0.0: 初始版本，支持基本的WebSocket连接和工具注册功能

## 许可证
xiaozhi-mcp 库采用 GNU 通用公共许可证 v3.0 (GPLv3) 授权。

GPLv3 是一种 copyleft 开源软件许可证，允许您自由地使用、复制、修改、合并、发布和分发软件，但有以下条件：
1. 任何修改后的作品也必须使用 GPLv3 许可证发布
2. 必须保留原始版权和许可证声明
3. 如果您分发二进制形式的软件，必须同时提供对应的源代码

本软件按"原样"提供，不提供任何明示或暗示的担保，包括但不限于适销性、特定用途适用性和非侵权性的担保。在任何情况下，作者或版权持有人均不对任何索赔、损害或其他责任负责，无论是在合同诉讼、侵权诉讼或其他诉讼中，这些责任可能因软件或软件的使用或其他交易而产生。

有关 GPLv3 的完整文本，请访问 https://www.gnu.org/licenses/gpl-3.0.html