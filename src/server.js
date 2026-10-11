/**
 * Minimal, dependency-free MCP (Model Context Protocol) server core.
 *
 * Implements the JSON-RPC 2.0 method surface that MCP clients need:
 *   initialize, notifications/initialized, ping, tools/list, tools/call
 *
 * Tools are plain objects: { name, title, description, inputSchema, handler }
 * where `handler(args, ctx)` resolves to either a string, an object that is
 * JSON-stringified, or { content, isError } for full control.
 */

export const LATEST_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

const JSONRPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

export class McpError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/** Throw from a tool handler to return a tool-level error (not a protocol error). */
export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

function toTextResult(value) {
  if (value && typeof value === 'object' && Array.isArray(value.content)) return value;
  const text =
    typeof value === 'string'
      ? value
      : value === undefined
        ? 'OK'
        : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

export class McpServer {
  constructor({ name, version, title, instructions, tools = [] }) {
    this.name = name;
    this.version = version;
    this.title = title;
    this.instructions = instructions;
    this.tools = tools;
    this.toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
    this.negotiatedVersion = LATEST_PROTOCOL_VERSION;
    this.initialized = false;
  }

  /** Returns a JSON-RPC response object, or null for notifications. */
  async handleMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return errorResponse(null, JSONRPC_ERRORS.INVALID_REQUEST, 'Invalid JSON-RPC message');
    }
    if (message.jsonrpc !== '2.0') {
      return errorResponse(
        message.id ?? null,
        JSONRPC_ERRORS.INVALID_REQUEST,
        'Bad or missing JSON-RPC version in message',
      );
    }

    const hasId = Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== null;
    const { method, params = {} } = message;

    if (typeof method !== 'string') {
      return hasId
        ? errorResponse(message.id, JSONRPC_ERRORS.INVALID_REQUEST, 'Missing method')
        : null;
    }

    try {
      const result = await this.#dispatch(method, params);
      if (!hasId) return null; // notification: no reply, even on success
      return { jsonrpc: '2.0', id: message.id, result: result ?? {} };
    } catch (error) {
      if (!hasId) {
        if (process.env.MINDPLUS_MCP_DEBUG) {
          process.stderr.write(`[mindplus-mcp] notification ${method} failed: ${error.message}\n`);
        }
        return null;
      }
      if (error instanceof McpError) {
        return errorResponse(message.id, error.code, error.message, error.data);
      }
      return errorResponse(message.id, JSONRPC_ERRORS.INTERNAL_ERROR, error.message);
    }
  }

  async #dispatch(method, params) {
    switch (method) {
      case 'initialize':
        return this.#initialize(params);
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/roots/list_changed':
        return null;
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: this.tools.map(publicTool) };
      case 'tools/call':
        return this.#callTool(params);
      default:
        throw new McpError(JSONRPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  #initialize(params) {
    const requested = params?.protocolVersion;
    this.negotiatedVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION;
    this.initialized = true;
    return {
      protocolVersion: this.negotiatedVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: this.name,
        version: this.version,
        ...(this.title ? { title: this.title } : {}),
      },
      ...(this.instructions ? { instructions: this.instructions } : {}),
    };
  }

  async #callTool(params) {
    const name = params?.name;
    if (typeof name !== 'string') {
      throw new McpError(JSONRPC_ERRORS.INVALID_PARAMS, 'tools/call requires a "name"');
    }
    const tool = this.toolsByName.get(name);
    if (!tool) {
      throw new McpError(JSONRPC_ERRORS.INVALID_PARAMS, `Unknown tool: ${name}`);
    }
    const args = params.arguments ?? {};
    try {
      const value = await tool.handler(args, { server: this });
      const result = toTextResult(value);
      return { content: result.content, ...(result.isError ? { isError: true } : {}) };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  }
}

function publicTool(tool) {
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}

function errorResponse(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

export { JSONRPC_ERRORS };
