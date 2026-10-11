#!/usr/bin/env node
/**
 * mindplus-mcp installer.
 *
 * Registers this MCP server with every MCP client it can find on this machine.
 * It is written to be run unattended by an agent, so it:
 *
 *   - never prompts and never blocks on stdin
 *   - is idempotent (re-running it replaces the entry instead of duplicating it)
 *   - backs up every file it touches before writing
 *   - writes atomically (temp file + rename), so a crash cannot truncate a config
 *   - can report machine-readable results with --json
 *
 *   node install.mjs                  detect every client and register there
 *   node install.mjs --dry-run        print the plan, change nothing
 *   node install.mjs --list           show which clients were detected
 *   node install.mjs --target cursor  restrict to one (or several) clients
 *   node install.mjs --print          print the snippets to paste by hand
 *   node install.mjs --json           machine-readable result
 *   node install.mjs --uninstall      remove the entry again
 *   node install.mjs --config <path>  register in an arbitrary JSON config
 *
 * Exit codes: 0 = ok, 1 = error, 2 = nothing detected / nothing to do.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, 'src', 'index.js');
const HOME = os.homedir();
const NODE_EXE = process.execPath;
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const MIN_NODE_MAJOR = 22;

const HELP = `mindplus-mcp installer

Usage: node install.mjs [options]

  --list                 list detected clients and exit
  --target <ids>         comma-separated client ids (see --list)
  --config <path>        also register in an arbitrary JSON config file
  --name <name>          server name to write (default: mindplus)
  --node <path>          node executable to register (default: the one running this script)
  --server-args <args>   extra arguments to append after "--transport stdio".
                         Repeatable. Accepts a JSON array or a quoted string, e.g.
                         --server-args '--shot-dir "C:\\shots"'
  --http                 register an HTTP transport instead of stdio
  --host <host>          HTTP host for --http (default: 127.0.0.1)
  --port <port>          HTTP port for --http (default: 8848)
  --dry-run              show what would change, write nothing
  --print                print the config snippets and exit
  --json                 emit a machine-readable result
  --uninstall            remove the entry instead of adding it
  --no-backup            skip the .bak-<timestamp> backup
  -h, --help             show this help
`;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    targets: null,
    configs: [],
    name: 'mindplus',
    node: null,
    serverArgs: [],
    http: false,
    host: '127.0.0.1',
    port: 8848,
    dryRun: false,
    print: false,
    json: false,
    list: false,
    uninstall: false,
    backup: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${token} requires a value`);
      return argv[index];
    };
    switch (token) {
      case '--target':
        options.targets = String(next())
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean);
        break;
      case '--config':
        options.configs.push(path.resolve(next()));
        break;
      case '--name':
        options.name = String(next());
        break;
      case '--node':
        options.node = path.resolve(next());
        break;
      case '--server-args':
        options.serverArgs.push(...splitArgs(next()));
        break;
      case '--http':
        options.http = true;
        break;
      case '--host':
        options.host = String(next());
        break;
      case '--port':
        options.port = Number(next());
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--print':
        options.print = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--list':
        options.list = true;
        break;
      case '--uninstall':
        options.uninstall = true;
        break;
      case '--no-backup':
        options.backup = false;
        break;
      case '--help':
      case '-h':
        process.stdout.write(HELP);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${token} (try --help)`);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// Client discovery
// ---------------------------------------------------------------------------

function dshProfileFiles() {
  const dir = path.join(HOME, '.dsh', 'profiles');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => path.join(dir, item.name, 'cordis.patch.yml'))
      .filter((file) => fs.existsSync(file));
  } catch {
    return [];
  }
}

function buildTargets() {
  const appData = process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming');
  const claudeDesktop =
    process.platform === 'win32'
      ? path.join(appData, 'Claude', 'claude_desktop_config.json')
      : process.platform === 'darwin'
        ? path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : path.join(HOME, '.config', 'Claude', 'claude_desktop_config.json');
  const vscode =
    process.platform === 'win32'
      ? path.join(appData, 'Code', 'User', 'mcp.json')
      : process.platform === 'darwin'
        ? path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
        : path.join(HOME, '.config', 'Code', 'User', 'mcp.json');

  const targets = [
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      kind: 'json',
      file: claudeDesktop,
      key: 'mcpServers',
      style: 'standard',
      restart: 'restart Claude Desktop',
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      kind: 'json',
      file: path.join(HOME, '.claude.json'),
      key: 'mcpServers',
      style: 'standard',
      restart: 'restart the claude CLI session',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      kind: 'json',
      file: path.join(HOME, '.cursor', 'mcp.json'),
      key: 'mcpServers',
      style: 'standard',
      restart: 'restart Cursor',
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      kind: 'json',
      file: path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),
      key: 'mcpServers',
      style: 'standard',
      restart: 'restart Windsurf',
    },
    {
      id: 'vscode',
      label: 'VS Code (Copilot)',
      kind: 'json',
      file: vscode,
      key: 'servers',
      style: 'vscode',
      restart: 'restart VS Code',
    },
    {
      // WorkBuddy reads ~/.workbuddy-ai/mcp.json (NOT the dot-prefixed
      // .mcp.json) and merges `mcpServers`. Writing the file is not enough:
      // a newly added server stays untrusted until the user enables it from
      // the custom-connector entry at the top-right of the connector page.
      id: 'workbuddy',
      label: 'WorkBuddy AI',
      kind: 'json',
      file: path.join(HOME, '.workbuddy-ai', 'mcp.json'),
      key: 'mcpServers',
      style: 'standard',
      restart: 'Connectors → custom connectors (top-right) → Trust',
    },
  ];

  for (const file of dshProfileFiles()) {
    targets.push({
      id: `dsh:${path.basename(path.dirname(file))}`,
      label: `DSH (${path.basename(path.dirname(file))} profile)`,
      kind: 'yaml',
      file,
      style: 'dsh',
      restart: 'restart the DSH Host (the patch file is only read at boot)',
    });
  }

  return targets;
}

// ---------------------------------------------------------------------------
// Entry shapes
// ---------------------------------------------------------------------------

/**
 * Split a --server-args value into argv. Accepts a JSON array or a string with
 * quotes, because Windows paths contain spaces and backslashes.
 */
function splitArgs(value) {
  const raw = String(value).trim();
  if (raw.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`--server-args is not valid JSON: ${error.message}`);
    }
    if (!Array.isArray(parsed)) throw new Error('--server-args JSON must be an array of strings');
    return parsed.map(String);
  }
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  for (let index = 0; index < raw.length; index += 1) {
    const ch = raw[index];
    if (quote) {
      if (ch === '\\' && raw[index + 1] === quote) {
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
  return tokens;
}

function stdioArgs(options) {
  return [ENTRY, '--transport', 'stdio', ...(options?.serverArgs ?? [])];
}

function entryFor(target, options) {
  const node = options.node ?? NODE_EXE;
  if (options.http) {
    return { type: 'http', url: `http://${options.host}:${options.port}/mcp` };
  }
  if (target.style === 'vscode') {
    return { type: 'stdio', command: node, args: stdioArgs(options) };
  }
  return { command: node, args: stdioArgs(options) };
}

function yamlBlock(options) {
  const quote = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const argLines = stdioArgs(options).map((arg) => `      - ${quote(arg)}`);
  return [
    `- id: mcp-${options.name}`,
    '  name: "@deepseek-ai/dsh-mcp-client"',
    '  config:',
    `    serverName: ${options.name}`,
    '    transport: stdio',
    `    command: ${quote(options.node ?? NODE_EXE)}`,
    '    args:',
    ...argLines,
    '    failOnStartupError: false',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function detectIndent(raw) {
  const match = /\n([ \t]+)"/.exec(raw);
  if (!match) return 2;
  return match[1].includes('\t') ? '\t' : match[1].length;
}

function backup(file, options) {
  if (!options.backup || !fs.existsSync(file)) return null;
  const target = `${file}.bak-${STAMP}`;
  fs.copyFileSync(file, target);
  return target;
}

function writeAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, contents, 'utf8');
  fs.renameSync(temp, file);
}

/** Escape a string so it can be embedded in a RegExp literally. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The patch-entry id this installer owns inside a DSH patch file. */
function yamlEntryId(options) {
  return `mcp-${options.name}`;
}

/**
 * Remove our `- id: mcp-<name>` block from a DSH patch file.
 *
 * The block may be INDENTED: DSH patch entries can live inside a top-level
 * `insert:` list, in which case the `- id:` line carries leading whitespace and
 * every line belonging to the entry is indented further than that. Matching on
 * indentation instead of assuming column 0 is what keeps a re-run from
 * appending a second copy next to the first.
 */
function stripYamlBlock(raw, options, hadTrailingNewline) {
  const id = yamlEntryId(options);
  const lines = raw.split('\n');
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    const marker = /^(\s*)- id:\s*(\S+)\s*$/.exec(lines[index]);
    if (!marker || marker[2] !== id) {
      kept.push(lines[index]);
      continue;
    }
    const indent = marker[1].length;
    let next = index + 1;
    while (next < lines.length) {
      const line = lines[next];
      if (line.trim() === '') {
        next += 1;
        continue;
      }
      if (/^\s*/.exec(line)[0].length > indent) {
        next += 1;
        continue;
      }
      break;
    }
    index = next - 1;
  }
  const text = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '');
  if (text === '') return '';
  // Preserve the original trailing-newline state so --uninstall is a true undo.
  return hadTrailingNewline ? `${text}\n` : text;
}

// ---------------------------------------------------------------------------
// Applying a target
// ---------------------------------------------------------------------------

function applyJson(target, options) {
  const exists = fs.existsSync(target.file);
  const raw = exists ? fs.readFileSync(target.file, 'utf8') : '';
  let data = {};
  if (raw.trim()) {
    data = JSON.parse(raw);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error('config root is not a JSON object');
    }
  }
  const indent = detectIndent(raw);
  if (!data[target.key] || typeof data[target.key] !== 'object' || Array.isArray(data[target.key])) {
    data[target.key] = {};
  }

  const had = Object.prototype.hasOwnProperty.call(data[target.key], options.name);
  if (options.uninstall) delete data[target.key][options.name];
  else data[target.key][options.name] = entryFor(target, options);

  if (options.uninstall && !had) return { status: 'unchanged', file: target.file };
  if (options.uninstall && Object.keys(data[target.key]).length === 0) delete data[target.key];

  const next = `${JSON.stringify(data, null, indent)}\n`;
  if (next === raw) return { status: 'unchanged', file: target.file };

  if (options.dryRun) {
    const verb = options.uninstall ? 'remove' : had ? 'update' : 'add';
    return { status: `would-${verb}`, file: target.file, preview: entryFor(target, options) };
  }

  const saved = backup(target.file, options);
  writeAtomic(target.file, next);
  JSON.parse(fs.readFileSync(target.file, 'utf8')); // verify we did not corrupt it
  return { status: options.uninstall ? 'removed' : had ? 'updated' : 'added', file: target.file, backup: saved };
}

function applyYaml(target, options) {
  const exists = fs.existsSync(target.file);
  const raw = exists ? fs.readFileSync(target.file, 'utf8') : '';
  // Match the marker at ANY indentation — DSH patch entries are often nested
  // inside a top-level `insert:` list.
  const marker = new RegExp(`^\\s*- id:\\s*mcp-${escapeRegExp(options.name)}\\s*$`, 'm');

  if (options.uninstall) {
    if (!marker.test(raw)) return { status: 'unchanged', file: target.file };
    const next = stripYamlBlock(raw, options, raw.endsWith('\n'));
    if (options.dryRun) return { status: 'would-remove', file: target.file };
    const saved = backup(target.file, options);
    writeAtomic(target.file, next);
    return { status: 'removed', file: target.file, backup: saved };
  }

  if (marker.test(raw)) return { status: 'unchanged', file: target.file };
  const separator = raw.length && !raw.endsWith('\n') ? '\n' : '';
  const next = `${raw}${separator}${yamlBlock(options)}`;
  if (options.dryRun) return { status: 'would-add', file: target.file };

  const saved = backup(target.file, options);
  writeAtomic(target.file, next);
  return { status: 'added', file: target.file, backup: saved };
}

// ---------------------------------------------------------------------------
// Environment probes
// ---------------------------------------------------------------------------

function probePort(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const options = (() => {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`install: ${error.message}\n`);
    process.exit(1);
  }
})();

const allTargets = buildTargets();
const report = {
  ok: true,
  node: process.versions.node,
  entry: ENTRY,
  entryExists: fs.existsSync(ENTRY),
  serverName: options.name,
  transport: options.http ? 'http' : 'stdio',
  mindplus: null,
  detected: [],
  results: [],
  notes: [],
};

if (options.print) {
  if (options.json) {
    // Machine-readable form, so an agent can inspect the exact argv it is about
    // to register without parsing the human-facing snippets below.
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          serverName: options.name,
          transport: options.http ? 'http' : 'stdio',
          node: options.node ?? NODE_EXE,
          entry: ENTRY,
          snippets: {
            standard: entryFor({ style: 'standard' }, options),
            vscode: entryFor({ style: 'vscode' }, options),
            dsh: yamlBlock(options),
          },
        },
        null,
        2,
      )}\n`,
    );
    process.exit(0);
  }
  const snippet = {
    mcpServers: { [options.name]: options.http ? entryFor({ style: 'standard' }, options) : entryFor({ style: 'standard' }, options) },
  };
  process.stdout.write(`# JSON (Claude Desktop / Claude Code / Cursor / Windsurf)\n${JSON.stringify(snippet, null, 2)}\n\n`);
  process.stdout.write(`# VS Code (uses "servers" + a "type" field)\n${JSON.stringify({ servers: { [options.name]: entryFor({ style: 'vscode' }, options) } }, null, 2)}\n\n`);
  process.stdout.write(`# DSH  ~/.dsh/profiles/<profile>/cordis.patch.yml\n${yamlBlock(options)}`);
  process.exit(0);
}

// Which targets exist on disk? (For --list we report even the ones that don't,
// so an agent can see the full map of possibilities.)
for (const target of allTargets) {
  const present = fs.existsSync(target.file);
  report.detected.push({ id: target.id, label: target.label, file: target.file, present });
}

if (options.list) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write('Detected MCP clients:\n');
    for (const item of report.detected) {
      process.stdout.write(`  ${item.present ? '[x]' : '[ ]'} ${item.id.padEnd(20)} ${item.file}\n`);
    }
    process.stdout.write('\n[x] = config file already exists, [ ] = will be created if targeted\n');
  }
  process.exit(0);
}

if (!report.entryExists) {
  report.ok = false;
  report.notes.push(`src/index.js not found next to install.mjs (${ENTRY})`);
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
  report.ok = false;
  report.notes.push(`Node ${MIN_NODE_MAJOR}+ is required (found ${process.versions.node})`);
}

// Pick the targets to act on.
// A --config path ending in .yml/.yaml is treated as a DSH-style patch file;
// anything else is treated as a JSON mcpServers config.
const extra = options.configs.map((file) => {
  const yaml = /\.ya?ml$/i.test(file);
  return {
    id: `custom:${path.basename(file)}`,
    label: yaml ? 'Custom DSH-style YAML' : 'Custom JSON config',
    kind: yaml ? 'yaml' : 'json',
    file,
    key: 'mcpServers',
    style: yaml ? 'dsh' : 'standard',
    restart: 'restart the client that owns this file',
  };
});
const candidates = [...allTargets, ...extra];

let chosen;
if (options.targets) {
  const known = new Set(candidates.map((target) => target.id));
  const unknown = options.targets.filter((id) => !known.has(id) && !id.startsWith('custom:'));
  if (unknown.length) {
    report.ok = false;
    report.notes.push(`unknown target(s): ${unknown.join(', ')} (see --list)`);
  }
  chosen = candidates.filter((target) => options.targets.includes(target.id));
} else {
  // Without --target, touch the clients that are actually installed, plus any
  // explicitly supplied --config files.
  chosen = candidates.filter((target) => fs.existsSync(target.file) || target.id.startsWith('custom:'));
}

if (!chosen.length) {
  report.notes.push('no MCP client config was found; use --config <path> or --target <id>');
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write('Nothing to do.\n');
    for (const note of report.notes) process.stdout.write(`note: ${note}\n`);
    process.stdout.write('Run `node install.mjs --list` to see the map, or pass --config <path>.\n');
  }
  process.exit(report.ok ? 2 : 1);
}

for (const target of chosen) {
  try {
    const result = target.kind === 'yaml' ? applyYaml(target, options) : applyJson(target, options);
    report.results.push({ id: target.id, label: target.label, restart: target.restart, ...result });
  } catch (error) {
    report.ok = false;
    report.results.push({ id: target.id, label: target.label, status: 'error', error: error.message, file: target.file });
  }
}

report.mindplus = await probePort('127.0.0.1', 19302);
if (!report.mindplus) {
  report.notes.push('Mind+ does not look like it is running (nothing on 127.0.0.1:19302); the server still starts, tools will error until Mind+ is open.');
}
if (!options.http) {
  report.notes.push('Restart the client after installing; stdio servers are only spawned at startup.');
}

if (options.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const verb = options.uninstall ? 'Uninstall' : options.dryRun ? 'Plan' : 'Install';
  process.stdout.write(`${verb} for "${options.name}" (${report.transport})\n`);
  process.stdout.write(`  node   : ${report.node}\n`);
  process.stdout.write(`  entry  : ${report.entry}\n`);
  process.stdout.write(`  Mind+  : ${report.mindplus ? 'running' : 'not detected on 127.0.0.1:19302'}\n\n`);
  for (const item of report.results) {
    process.stdout.write(`  ${item.status.padEnd(14)} ${item.id}  (${item.file})\n`);
    if (item.backup) process.stdout.write(`                 backup: ${item.backup}\n`);
    if (item.error) process.stdout.write(`                 error : ${item.error}\n`);
  }
  for (const note of report.notes) process.stdout.write(`\nnote: ${note}\n`);
}

process.exit(report.ok ? 0 : 1);
