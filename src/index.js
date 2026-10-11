#!/usr/bin/env node
/**
 * mindplus-mcp — an MCP server that bridges DFRobot Mind+ 2.0.
 *
 *   node src/index.js                          # stdio (default), for DSH / Claude / any MCP client
 *   node src/index.js --transport http --port 8848
 *
 * HTTP mode serves BOTH modern Streamable HTTP (POST /mcp) and the legacy
 * HTTP+SSE transport that Mind+'s own "MCP服务器" (mcpserver) extension emits.
 */

import { McpServer } from './server.js';
import { MindPlusTools } from './tools.js';
import { serveStdio, serveHttp, log } from './transports.js';

const VERSION = '0.1.0';

function parseArgs(argv) {
  const options = {
    transport: 'stdio',
    host: '127.0.0.1',
    port: 8848,
    controlPort: undefined,
    transmitPort: undefined,
    timeoutMs: 30000,
    shotDir: undefined,
    visionConfigFile: undefined,
    vision: {},
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => {
      index += 1;
      return argv[index];
    };
    switch (token) {
      case '--transport':
      case '-t':
        options.transport = next();
        break;
      case '--host':
        options.host = next();
        break;
      case '--port':
      case '-p':
        options.port = Number(next());
        break;
      case '--control-port':
        options.controlPort = Number(next());
        break;
      case '--transmit-port':
        options.transmitPort = Number(next());
        break;
      case '--timeout-ms':
        options.timeoutMs = Number(next());
        break;
      case '--shot-dir':
        options.shotDir = next();
        break;
      case '--vision-config':
        options.visionConfigFile = next();
        break;
      case '--vision-provider':
        options.vision.provider = next();
        break;
      case '--vision-model':
        options.vision.model = next();
        break;
      case '--vision-base-url':
        options.vision.baseUrl = next();
        break;
      case '--vision-api-key':
        options.vision.apiKey = next();
        break;
      case '--vision-command':
        options.vision.command = next();
        break;
      case '--vision-max-width':
        options.vision.maxWidth = Number(next());
        break;
      case '--vision-timeout-ms':
        options.vision.timeoutMs = Number(next());
        break;
      case '--help':
      case '-h':
        process.stdout.write(
          [
            'mindplus-mcp — MCP server bridging DFRobot Mind+ 2.0 (mind-link)',
            '',
            'Usage: node src/index.js [options]',
            '',
            '  -t, --transport <stdio|http>   Transport to serve (default: stdio)',
            '      --host <host>              HTTP bind host (default: 127.0.0.1)',
            '  -p, --port <port>              HTTP bind port (default: 8848)',
            '      --control-port <port>      mind-link control port (default: 19302)',
            '      --transmit-port <port>     mind-link transmit port (default: 19303)',
            '      --timeout-ms <ms>          Default RPC timeout (default: 30000)',
            '',
            '  GUI automation:',
            '      --shot-dir <path>          Where screenshots are written',
            '                                 (default: %TEMP%\\mindplus-mcp\\shots)',
            '',
            '  Vision recognition (all optional; the local matchers need none of these):',
            '      --vision-config <file>     JSON config file (also MINDLINK_VISION_CONFIG)',
            '      --vision-provider <id>     none | openai | anthropic | ollama | command',
            '      --vision-model <name>      Model id',
            '      --vision-base-url <url>    API base URL',
            '      --vision-api-key <key>     API key',
            '      --vision-command <cmd>     argv template for the "command" provider,',
            '                                 with {image} and {prompt} placeholders',
            '      --vision-max-width <px>    Downscale screenshots before sending (default 1400)',
            '      --vision-timeout-ms <ms>   Per-request timeout (default 60000)',
            '',
            '  -h, --help                     Show this help',
            '',
            'Env equivalents: MINDLINK_VISION_PROVIDER, MINDLINK_VISION_MODEL,',
            'MINDLINK_VISION_BASE_URL, MINDLINK_VISION_API_KEY, MINDLINK_VISION_COMMAND,',
            'MINDLINK_VISION_MAX_WIDTH, MINDLINK_VISION_TIMEOUT_MS, MINDLINK_VISION_HEADERS.',
            '',
          ].join('\n'),
        );
        process.exit(0);
        break;
      default:
        log(`ignoring unknown argument: ${token}`);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

const mindplus = new MindPlusTools({
  host: options.host === '0.0.0.0' ? '127.0.0.1' : options.host,
  controlPort: options.controlPort,
  transmitPort: options.transmitPort,
  timeoutMs: options.timeoutMs,
  shotDir: options.shotDir,
  vision: options.vision,
  visionConfigFile: options.visionConfigFile,
});

const server = new McpServer({
  name: 'mindplus',
  title: 'DFRobot Mind+ 2.0',
  version: VERSION,
  instructions:
    'Controls and inspects a local DFRobot Mind+ 2.0 installation through its bundled mind-link service. ' +
    'Use the "info" tool first to confirm Mind+ is running (mind-link listens on 127.0.0.1:19302 and :19303 ' +
    'while Mind+ is open). Sessions opened by serial_open, pty_open, ssh_connect, mqtt_connect and udp_open stay ' +
    'alive across calls and are closed by the matching *_close / *_disconnect; sessions_status lists them all. ' +
    'File paths accept %HOMEDIR% (the user home) and %APPROOT% (the Mind+ Link root) on the fs_read_text / ' +
    'fs_write_text / fs_list_dir / fs_stat / fs_mkdir / fs_remove tools — fs_rename, download_file and unzip ' +
    'take literal paths only. ' +
    'GUI automation (Windows only) is a separate family that does not need Mind+: screen_info reports the ' +
    'monitor layout, screen_capture writes a PNG, and mouse_* / keyboard_* / window_* drive the desktop. ' +
    'Recognition comes in two flavours: the local matchers image_find (template matching) and pixel_find ' +
    '(colour search) need no model, while vision_locate / vision_click / vision_act send a screenshot to a ' +
    'multimodal model and turn its answer into coordinates — check vision_config first, since vision_* only ' +
    'works when a provider is configured. Prefer targeted tools over vision_act whenever the steps are known, ' +
    'and use dryRun to preview any click before making it.',
  tools: mindplus.tools,
});

const shutdown = async (signal) => {
  log(`received ${signal}, shutting down`);
  await mindplus.shutdown().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

if (options.transport === 'stdio') {
  serveStdio(server);
} else if (options.transport === 'http') {
  await serveHttp(server, { host: options.host, port: options.port });
} else {
  log(`unknown transport "${options.transport}" (expected "stdio" or "http")`);
  process.exit(2);
}
