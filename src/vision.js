/**
 * Vision recognition framework for mindplus-mcp.
 *
 * The core idea: a screenshot is handed to a multimodal model together with a
 * description of what to find, and the model answers with coordinates. This
 * module owns everything between "here is a PNG" and "here is a point on
 * screen" — provider selection, prompt construction, tolerant response parsing
 * and coordinate mapping — so the tool layer stays thin.
 *
 * Providers are pluggable:
 *   openai      any OpenAI-compatible /chat/completions endpoint with images
 *   anthropic   the Anthropic Messages API
 *   ollama      a local Ollama server (/api/chat, `images: [base64]`)
 *   command     any CLI you already have: argv template with {image}/{prompt}
 *   none        disabled — the local matchers in image.js still work
 *
 * Configuration is read from env vars, then a JSON file, then explicit
 * overrides (see resolveVisionConfig).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export class VisionError extends Error {}
export class VisionNotConfiguredError extends VisionError {}

/** Every knob, its env var, and its default. */
export const VISION_ENV = {
  provider: 'MINDLINK_VISION_PROVIDER',
  baseUrl: 'MINDLINK_VISION_BASE_URL',
  apiKey: 'MINDLINK_VISION_API_KEY',
  model: 'MINDLINK_VISION_MODEL',
  command: 'MINDLINK_VISION_COMMAND',
  timeoutMs: 'MINDLINK_VISION_TIMEOUT_MS',
  maxWidth: 'MINDLINK_VISION_MAX_WIDTH',
  headers: 'MINDLINK_VISION_HEADERS',
};

const PRESETS = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', style: 'openai' },
  anthropic: { baseUrl: 'https://api.anthropic.com', model: 'claude-3-5-sonnet-latest', style: 'anthropic' },
  ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'llava', style: 'ollama' },
  command: { style: 'command' },
  none: { style: 'none' },
};

const DEFAULTS = {
  provider: 'none',
  baseUrl: undefined,
  apiKey: undefined,
  model: undefined,
  command: undefined,
  timeoutMs: 60000,
  maxWidth: 1400,
  headers: {},
};

function parseJsonEnv(value, label) {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new VisionError(`${label} is not valid JSON: ${error.message}`);
  }
}

/**
 * Merge a config layer, ignoring null/undefined values.
 *
 * This matters because a JSON config file naturally contains `"model": null`
 * for "not set", and assigning null would defeat the per-provider preset
 * (the preset is only applied when the key is still undefined).
 *
 * Keys starting with `_` are treated as comments — JSON has no comment syntax,
 * so `"_readme": [...]` is the usual way to document a config file.
 */
function mergeLayer(config, layer) {
  for (const [key, value] of Object.entries(layer ?? {})) {
    if (key.startsWith('_')) continue;
    if (value === null || value === undefined) continue;
    config[key] = value;
  }
}

/**
 * Resolve the vision configuration.
 * Precedence: defaults < config file < environment < explicit overrides.
 */
export function resolveVisionConfig({ env = process.env, file, overrides = {} } = {}) {
  const config = { ...DEFAULTS, headers: { ...DEFAULTS.headers } };

  const filePath = file ?? env.MINDLINK_VISION_CONFIG;
  if (filePath) {
    if (!fs.existsSync(filePath)) {
      throw new VisionError(`vision config file not found: ${filePath}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      throw new VisionError(`vision config file is not valid JSON (${filePath}): ${error.message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new VisionError(`vision config file must contain a JSON object (${filePath})`);
    }
    mergeLayer(config, parsed);
  }

  for (const [key, name] of Object.entries(VISION_ENV)) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    if (key === 'timeoutMs' || key === 'maxWidth') config[key] = Number(raw);
    else if (key === 'headers') config.headers = { ...config.headers, ...parseJsonEnv(raw, name) };
    else config[key] = raw;
  }

  mergeLayer(config, overrides);
  if (config.headers === undefined || config.headers === null || typeof config.headers !== 'object') config.headers = {};

  const preset = PRESETS[config.provider];
  if (!preset) {
    throw new VisionError(
      `unknown vision provider "${config.provider}" (expected one of: ${Object.keys(PRESETS).join(', ')})`,
    );
  }
  if (config.baseUrl === undefined) config.baseUrl = preset.baseUrl;
  if (config.model === undefined) config.model = preset.model;
  config.style = preset.style;
  if (config.provider === 'command' && !config.command) {
    throw new VisionError('the "command" vision provider needs MINDLINK_VISION_COMMAND (or --vision-command)');
  }
  if (config.provider !== 'none' && config.provider !== 'command' && config.provider !== 'ollama' && !config.apiKey) {
    throw new VisionError(
      `the "${config.provider}" vision provider needs an API key — set ${VISION_ENV.apiKey} ` +
        '(or pass --vision-api-key / put it in the vision config file)',
    );
  }
  if (typeof config.timeoutMs !== 'number' || !Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    config.timeoutMs = DEFAULTS.timeoutMs;
  }
  return config;
}

/** A config summary that is safe to show a user (the key is redacted). */
export function describeVisionConfig(config) {
  const key = config.apiKey;
  return {
    provider: config.provider,
    model: config.model ?? null,
    baseUrl: config.baseUrl ?? null,
    command: config.command ?? null,
    timeoutMs: config.timeoutMs,
    maxWidth: config.maxWidth,
    apiKey: key ? `${String(key).slice(0, 4)}…${String(key).slice(-2)} (${String(key).length} chars)` : null,
    configured: config.provider !== 'none',
  };
}

// ---------------------------------------------------------------------------
// prompt + response handling
// ---------------------------------------------------------------------------

export const GROUNDING_SCHEMA = `{
  "found": true,
  "label": "short name of what you found",
  "x": 123,            // centre X in pixels of the image you were given
  "y": 456,            // centre Y in pixels of the image you were given
  "width": 80,         // optional bounding box width
  "height": 24,        // optional bounding box height
  "confidence": 0.0,   // 0..1
  "reasoning": "one short sentence",
  "alternatives": [ { "label": "...", "x": 0, "y": 0, "confidence": 0.0 } ]
}`;

export function buildGroundingPrompt({ instruction, width, height, mode = 'point', extra }) {
  const lines = [
    'You are a precise GUI grounding engine. You are given one screenshot of a computer screen.',
    `The image is ${width} x ${height} pixels.`,
    '',
    `TARGET: ${instruction}`,
  ];
  if (extra) lines.push('', `CONTEXT: ${extra}`);
  lines.push('');
  if (mode === 'list') {
    lines.push(
      'Find EVERY element matching the target.',
      'Reply with ONLY a JSON object (no markdown fence, no prose):',
      '{"found":true,"elements":[{"label":"...","x":0,"y":0,"width":0,"height":0,"confidence":0.0}],"reasoning":"..."}',
      'If nothing matches, reply {"found":false,"elements":[],"reasoning":"..."}.',
    );
  } else if (mode === 'describe') {
    lines.push(
      'Describe the screen contents that matter for the target, then give the best match.',
      'Reply with ONLY a JSON object (no markdown fence, no prose):',
      GROUNDING_SCHEMA,
      'If the target is not present, reply {"found":false,"reasoning":"..."}.',
    );
  } else {
    lines.push(
      'Return the single best match. x/y must be the CENTRE of the element, in pixels of the image above,',
      'with the origin at the top-left corner. Do not normalise the coordinates.',
      'Reply with ONLY a JSON object (no markdown fence, no prose):',
      GROUNDING_SCHEMA,
      'If the target is not present, reply {"found":false,"reasoning":"..."}.',
    );
  }
  return lines.join('\n');
}

export function buildActionPrompt({ goal, history = [], width, height, allowed = [], step = 1, maxSteps = 8 }) {
  const actions = allowed.length
    ? allowed
    : ['click', 'double_click', 'right_click', 'move', 'drag', 'scroll', 'type', 'key', 'wait', 'done', 'fail'];
  const lines = [
    'You are driving a Windows desktop one action at a time to accomplish a goal.',
    `The image is ${width} x ${height} pixels (origin top-left, pixel coordinates, not normalised).`,
    `GOAL: ${goal}`,
    `This is step ${step} of at most ${maxSteps}.`,
  ];
  if (history.length) {
    lines.push('', 'ACTIONS ALREADY TAKEN:');
    for (const item of history.slice(-10)) lines.push(`  ${item}`);
  }
  lines.push(
    '',
    `Allowed actions: ${actions.join(', ')}.`,
    'Reply with ONLY a JSON object (no markdown fence, no prose):',
    '{"action":"click","x":0,"y":0,"text":"","keys":"","reason":"why this action"}',
    'Fields by action: click/double_click/right_click/move/scroll need x,y (scroll also wants "delta");',
    'drag needs x,y,toX,toY; type needs text; key needs keys like "ctrl+s"; wait needs "ms".',
    'Use "done" when the goal is achieved and "fail" when it cannot be achieved.',
    'Never invent coordinates: pick them from what you can actually see in the image.',
  );
  return lines.join('\n');
}

/** Pull the first balanced JSON object out of a model reply (fences tolerated). */
export function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index += 1) {
    const ch = candidate[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function numberOrNull(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** Normalise whatever the model said into a predictable shape. */
export function parseGroundingResponse(text, { mode = 'point' } = {}) {
  const json = extractJson(text);
  if (!json) {
    return { found: false, raw: text, error: 'the model did not return a JSON object' };
  }
  const confidence = numberOrNull(json.confidence);
  if (mode === 'list') {
    const elements = Array.isArray(json.elements) ? json.elements : [];
    return {
      found: json.found !== false && elements.length > 0,
      elements: elements
        .map((item) => ({
          label: item.label ?? null,
          x: numberOrNull(item.x),
          y: numberOrNull(item.y),
          width: numberOrNull(item.width),
          height: numberOrNull(item.height),
          confidence: numberOrNull(item.confidence),
        }))
        .filter((item) => item.x !== null && item.y !== null),
      reasoning: json.reasoning ?? null,
      raw: json,
    };
  }
  const x = numberOrNull(json.x);
  const y = numberOrNull(json.y);
  const alternatives = Array.isArray(json.alternatives)
    ? json.alternatives
        .map((item) => ({
          label: item.label ?? null,
          x: numberOrNull(item.x),
          y: numberOrNull(item.y),
          confidence: numberOrNull(item.confidence),
        }))
        .filter((item) => item.x !== null && item.y !== null)
    : [];
  return {
    found: json.found !== false && x !== null && y !== null,
    label: json.label ?? null,
    x,
    y,
    width: numberOrNull(json.width),
    height: numberOrNull(json.height),
    confidence,
    reasoning: json.reasoning ?? null,
    alternatives,
    raw: json,
  };
}

export function parseActionResponse(text) {
  const json = extractJson(text);
  if (!json || !json.action) {
    return { action: 'fail', reason: 'the model did not return a JSON action object', raw: text };
  }
  return {
    action: String(json.action).toLowerCase(),
    x: numberOrNull(json.x),
    y: numberOrNull(json.y),
    toX: numberOrNull(json.toX),
    toY: numberOrNull(json.toY),
    text: json.text === undefined ? null : String(json.text),
    keys: json.keys === undefined ? null : String(json.keys),
    delta: numberOrNull(json.delta),
    ms: numberOrNull(json.ms),
    reason: json.reason ?? null,
    raw: json,
  };
}

// ---------------------------------------------------------------------------
// coordinate mapping
// ---------------------------------------------------------------------------

/**
 * Map a point from the *sent image* space back to screen pixels.
 *
 * `transform` describes how the screenshot was derived:
 *   { offsetX, offsetY, scale }  where scale = sentImageWidth / capturedWidth
 * (a downscaled image has scale < 1, so screen = offset + imagePoint / scale).
 */
export function toScreenPoint(point, transform) {
  const scale = transform?.scale && transform.scale > 0 ? transform.scale : 1;
  return {
    x: Math.round((transform?.offsetX ?? 0) + point.x / scale),
    y: Math.round((transform?.offsetY ?? 0) + point.y / scale),
  };
}

export function toScreenBox(box, transform) {
  if (!box || box.width === undefined || box.height === undefined) return null;
  const scale = transform?.scale && transform.scale > 0 ? transform.scale : 1;
  const topLeft = toScreenPoint({ x: box.x, y: box.y }, transform);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: Math.round(box.width / scale),
    height: Math.round(box.height / scale),
  };
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

/**
 * Split a command template into argv, honouring quotes.
 * Windows paths contain backslashes, so backslashes inside quotes stay literal
 * and only `\"` escapes a quote.
 */
export function tokenizeCommand(template) {
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  for (let index = 0; index < template.length; index += 1) {
    const ch = template[index];
    if (quote) {
      if (ch === '\\' && template[index + 1] === quote) {
        current += quote;
        index += 1;
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || current.length) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started || current.length) tokens.push(current);
  return tokens.filter((token) => token.length > 0);
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  return undefined;
}

async function readError(response) {
  let body = '';
  try {
    body = (await response.text()).slice(0, 600);
  } catch {
    /* ignore */
  }
  return `${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`;
}

export class VisionClient {
  constructor(config) {
    this.config = config;
  }

  get available() {
    return this.config.provider !== 'none';
  }

  get description() {
    return describeVisionConfig(this.config);
  }

  /** Send one image + prompt, return the model's raw text answer. */
  async complete({ prompt, imageBase64, mediaType = 'image/png', imagePath }) {
    if (!this.available) {
      throw new VisionNotConfiguredError(
        'no vision provider is configured — set MINDLINK_VISION_PROVIDER (openai | anthropic | ollama | command) ' +
          'and its credentials, or pass --vision-provider on the command line. ' +
          'The local matchers (image_find, pixel_find) work without any model.',
      );
    }
    switch (this.config.style) {
      case 'openai':
        return this.#completeOpenAi({ prompt, imageBase64, mediaType });
      case 'anthropic':
        return this.#completeAnthropic({ prompt, imageBase64, mediaType });
      case 'ollama':
        return this.#completeOllama({ prompt, imageBase64 });
      case 'command':
        return this.#completeCommand({ prompt, imageBase64, imagePath });
      default:
        throw new VisionError(`provider style "${this.config.style}" is not implemented`);
    }
  }

  async #post(url, headers, body) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: timeoutSignal(this.config.timeoutMs),
      });
    } catch (error) {
      const cause = error?.cause?.message ?? error.message;
      throw new VisionError(`vision request to ${url} failed: ${cause}`);
    }
    if (!response.ok) throw new VisionError(`vision endpoint returned ${await readError(response)}`);
    try {
      return await response.json();
    } catch (error) {
      throw new VisionError(`vision endpoint returned invalid JSON: ${error.message}`);
    }
  }

  async #completeOpenAi({ prompt, imageBase64, mediaType }) {
    const url = `${String(this.config.baseUrl).replace(/\/+$/, '')}/chat/completions`;
    const payload = {
      model: this.config.model,
      temperature: 0,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
          ],
        },
      ],
    };
    const json = await this.#post(url, { authorization: `Bearer ${this.config.apiKey}`, ...this.config.headers }, payload);
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) => part?.text ?? '').join('');
    throw new VisionError(`unexpected OpenAI response shape: ${JSON.stringify(json).slice(0, 300)}`);
  }

  async #completeAnthropic({ prompt, imageBase64, mediaType }) {
    const url = `${String(this.config.baseUrl).replace(/\/+$/, '')}/v1/messages`;
    const payload = {
      model: this.config.model,
      max_tokens: 1024,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    };
    const json = await this.#post(
      url,
      { 'x-api-key': this.config.apiKey, 'anthropic-version': '2023-06-01', ...this.config.headers },
      payload,
    );
    const blocks = json?.content;
    if (Array.isArray(blocks)) return blocks.map((block) => block?.text ?? '').join('');
    throw new VisionError(`unexpected Anthropic response shape: ${JSON.stringify(json).slice(0, 300)}`);
  }

  async #completeOllama({ prompt, imageBase64 }) {
    const url = `${String(this.config.baseUrl).replace(/\/+$/, '')}/api/chat`;
    const payload = {
      model: this.config.model,
      stream: false,
      format: 'json',
      options: { temperature: 0 },
      messages: [{ role: 'user', content: prompt, images: [imageBase64] }],
    };
    const json = await this.#post(url, { ...this.config.headers }, payload);
    const content = json?.message?.content;
    if (typeof content === 'string') return content;
    throw new VisionError(`unexpected Ollama response shape: ${JSON.stringify(json).slice(0, 300)}`);
  }

  async #completeCommand({ prompt, imageBase64, imagePath }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mindplus-vision-'));
    const promptFile = path.join(tmp, 'prompt.txt');
    const imageFile = imagePath ?? path.join(tmp, 'image.png');
    fs.writeFileSync(promptFile, prompt, 'utf8');
    if (!imagePath) fs.writeFileSync(imageFile, imageBase64 ? Buffer.from(imageBase64, 'base64') : Buffer.alloc(0));

    const template = Array.isArray(this.config.command) ? this.config.command : tokenizeCommand(String(this.config.command));
    const args = template.map((token) =>
      String(token)
        .replaceAll('{image}', imageFile)
        .replaceAll('{prompt}', promptFile)
        .replaceAll('{model}', this.config.model ?? ''),
    );
    const [command, ...rest] = args;
    const result = await new Promise((resolve) => {
      const child = spawn(command, rest, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        resolve({ code: null, stdout, stderr: `${stderr}\ntimed out after ${this.config.timeoutMs}ms` });
      }, this.config.timeoutMs);
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr: error.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    if (result.code !== 0) {
      throw new VisionError(`vision command exited with ${result.code}: ${result.stderr.trim().slice(0, 400)}`);
    }
    return result.stdout;
  }

  /** Find one element (or list several) described in plain language. */
  async locate({ instruction, imageBase64, imagePath, width, height, mode = 'point', extra }) {
    const prompt = buildGroundingPrompt({ instruction, width, height, mode, extra });
    const raw = await this.complete({ prompt, imageBase64, imagePath });
    return parseGroundingResponse(raw, { mode });
  }

  /** Ask the model what to do next, for the step-wise automation loop. */
  async nextAction({ goal, history, width, height, allowed, step, maxSteps, imageBase64, imagePath }) {
    const prompt = buildActionPrompt({ goal, history, width, height, allowed, step, maxSteps });
    const raw = await this.complete({ prompt, imageBase64, imagePath });
    return parseActionResponse(raw);
  }
}

export function createVisionClient(config) {
  return new VisionClient(config);
}
