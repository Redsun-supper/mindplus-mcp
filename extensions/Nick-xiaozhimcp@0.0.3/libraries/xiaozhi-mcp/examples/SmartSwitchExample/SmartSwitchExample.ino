#include <WiFi.h>
#include <WebSocketMCP.h>

// WiFi配置
const char* ssid = "your-ssid";
const char* password = "your-password";

// MCP服务器配置
const char* mcpEndpoint = "ws://your-mcp-server:port/path";

// 创建WebSocketMCP实例
WebSocketMCP mcpClient;

// 智能开关引脚定义
const int SWITCH_PINS[] = {1, 2, 3, 4, 5, 6};  // 开关输入引脚
const int RELAY_PINS[] = {21, 45, 46, 38, 39, 40};  // 继电器输出引脚
bool relayStates[6] = {false, false, false, false, false, false};  // 继电器状态
unsigned long lastDebounceTime[6] = {0};  // 上次防抖动时间
const unsigned long debounceDelay = 50;  // 防抖动延迟(毫秒)

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

// 继电器控制函数
void controlRelay(int relayIndex, bool state) {
  if (relayIndex >= 0 && relayIndex < 6) {
    relayStates[relayIndex] = state;
    digitalWrite(RELAY_PINS[relayIndex], state ? HIGH : LOW);
    Serial.printf("[继电器] 控制继电器%d: %s\n", relayIndex + 1, state ? "开" : "关");
  }
}

// 检查开关状态
void checkSwitches() {
  for (int i = 0; i < 6; i++) {
    int switchState = digitalRead(SWITCH_PINS[i]);
    unsigned long currentTime = millis();

    // 防抖动处理
    if (switchState != relayStates[i] && (currentTime - lastDebounceTime[i] > debounceDelay)) {
      lastDebounceTime[i] = currentTime;
      // 开关是低电平有效
      if (switchState == LOW) {
        controlRelay(i, !relayStates[i]);
      }
    }
  }
}

// 注册MCP工具
void registerMcpTools() {
  // 注册继电器控制工具
  mcpClient.registerTool(
    "relay_control",
    "控制六路继电器",
    "{\"type\":\"object\",\"properties\":{\"relayIndex\":{\"type\":\"integer\",\"minimum\":1,\"maximum\":6},\"state\":{\"type\":\"boolean\"}},\"required\":[\"relayIndex\",\"state\"]}",
    [](const String& args) {
      DynamicJsonDocument doc(256);
      deserializeJson(doc, args);
      
      int relayIndex = doc["relayIndex"].as<int>() - 1;  // 转换为0-based索引
      bool state = doc["state"].as<bool>();
      
      if (relayIndex >= 0 && relayIndex < 6) {
        controlRelay(relayIndex, state);
        return WebSocketMCP::ToolResponse("{\"success\":true,\"relayIndex\":" + String(relayIndex + 1) + ",\"state\":" + (state ? "true" : "false") + "}");
      } else {
        return WebSocketMCP::ToolResponse("{\"success\":false,\"error\":\"无效的继电器索引\"}", true);
      }
    }
  );
  Serial.println("[MCP] 继电器控制工具已注册");

  // 注册继电器状态查询工具
  mcpClient.registerTool(
    "relay_status",
    "查询六路继电器状态",
    "{\"type\":\"object\",\"properties\":{}}",
    [](const String& args) {
      String result = "{\"success\":true,\"relays\":[";
      for (int i = 0; i < 6; i++) {
        if (i > 0) result += ",";
        result += "{\"index\":" + String(i + 1) + ",\"state\":" + (relayStates[i] ? "true" : "false") + "}";
      }
      result += "]}";
      return WebSocketMCP::ToolResponse(result);
    }
  );
  Serial.println("[MCP] 继电器状态查询工具已注册");
}

void setup() {
  Serial.begin(115200);

  // 初始化开关引脚(输入上拉)
  for (int i = 0; i < 6; i++) {
    pinMode(SWITCH_PINS[i], INPUT_PULLUP);
  }

  // 初始化继电器引脚(输出，初始关闭)
  for (int i = 0; i < 6; i++) {
    pinMode(RELAY_PINS[i], OUTPUT);
    digitalWrite(RELAY_PINS[i], LOW);
    relayStates[i] = false;
  }

  // 连接WiFi
  Serial.print("连接到WiFi: ");
  Serial.println(ssid);
  WiFi.begin(ssid, password);
  
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  
  Serial.println("WiFi已连接");
  Serial.println("IP地址: " + WiFi.localIP().toString());

  // 初始化MCP客户端
  mcpClient.begin(mcpEndpoint, onConnectionStatus);
}

void loop() {
  // 处理MCP客户端事件
  mcpClient.loop();
  
  // 检查开关状态
  checkSwitches();
  
  delay(10);
}