#include <WiFi.h>
#include <WebSocketMCP.h>

#define LED_BUILTIN 2

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

// 注册MCP工具
void registerMcpTools() {
  // 注册一个简单的LED控制工具
  mcpClient.registerTool(
    "led_blink",
    "控制ESP32板载LED",
    "{\"type\":\"object\",\"properties\":{\"state\":{\"type\":\"string\",\"enum\":[\"on\",\"off\",\"blink\"]}},\"required\":[\"state\"]}",
    [](const String& args) {
      DynamicJsonDocument doc(256);
      deserializeJson(doc, args);
      String state = doc["state"].as<String>();
      
      if (state == "on") {
        digitalWrite(LED_BUILTIN, HIGH);
      } else if (state == "off") {
        digitalWrite(LED_BUILTIN, LOW);
      } else if (state == "blink") {
        for (int i = 0; i < 5; i++) {
          digitalWrite(LED_BUILTIN, HIGH);
          delay(200);
          digitalWrite(LED_BUILTIN, LOW);
          delay(200);
        }
      }
      
      return WebSocketMCP::ToolResponse("{\"success\":true,\"state\":\"" + state + "\"}");
    }
  );
  Serial.println("[MCP] LED控制工具已注册");
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  digitalWrite(LED_BUILTIN, LOW);

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
  
  // 其他代码...
  delay(10);
}