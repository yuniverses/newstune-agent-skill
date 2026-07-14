#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStoredCredentials } from './credentials.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const TERMINAL = new Set(['completed', 'cancelled', 'expired', 'failed']);
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 2000;

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      result._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    i += 1;
  }
  return result;
}

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`NewsTune Agent web handoff helper

Usage:
  node scripts/web_handoff.mjs voice_clone [--input-json '{"voiceName":"My Voice"}']
  node scripts/web_handoff.mjs create --action series_create --input-json '{"message":"AI weekly"}'
  node scripts/web_handoff.mjs poll --handoff-id handoff_xxx
  node scripts/web_handoff.mjs cancel --handoff-id handoff_xxx

Options:
  --input-json JSON        Handoff input object.
  --input-file PATH        Read handoff input JSON from a file.
  --ttl-seconds N          Handoff expiry window. Default is backend default.
  --timeout-ms N           Polling timeout. Default 900000.
  --interval-ms N          Polling interval. Default 2000.
  --no-open                Do not open the browser.
  --no-poll                Return immediately after creating the handoff.
  --app-window             On macOS, try opening Chrome in app-window mode.
  --base-url URL           Override NewsTune backend base URL for this run.

The helper reads the cached NewsTune API key via scripts/credentials.mjs and never prints the raw key.
`);
  process.exit(exitCode);
}

function readInput(args) {
  if (args['input-json']) {
    const parsed = JSON.parse(String(args['input-json']));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--input-json must be a JSON object');
    return parsed;
  }
  if (args['input-file']) {
    const parsed = JSON.parse(fs.readFileSync(String(args['input-file']), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--input-file must contain a JSON object');
    return parsed;
  }
  return {};
}

async function requestJson(baseUrl, apiKey, path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-NT-API-Key': apiKey,
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const error = new Error(json?.error || json?.message || `HTTP_${res.status}`);
    error.status = res.status;
    error.body = json;
    throw error;
  }
  return json;
}

function openUrl(url, appWindow = false) {
  if (process.platform === 'darwin') {
    if (appWindow) {
      const chrome = spawnSync('open', ['-na', 'Google Chrome', '--args', `--app=${url}`], { stdio: 'ignore' });
      if (chrome.status === 0) return { opened: true, mode: 'chrome_app_window' };
    }
    const opened = spawnSync('open', [url], { stdio: 'ignore' });
    return { opened: opened.status === 0, mode: 'default_browser' };
  }
  if (process.platform === 'win32') {
    const opened = spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    return { opened: opened.status === 0, mode: 'default_browser' };
  }
  const opened = spawnSync('xdg-open', [url], { stdio: 'ignore' });
  return { opened: opened.status === 0, mode: 'default_browser' };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollHandoff({ baseUrl, apiKey, handoffId, timeoutMs, intervalMs }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const data = await requestJson(baseUrl, apiKey, `/api/v1/handoffs/${encodeURIComponent(handoffId)}`);
    const handoff = data.handoff;
    if (TERMINAL.has(handoff?.status)) return handoff;
    await sleep(intervalMs);
  }
  throw Object.assign(new Error('HANDOFF_POLL_TIMEOUT'), { code: 'HANDOFF_POLL_TIMEOUT' });
}

function loadCredentials(args) {
  const stored = loadStoredCredentials();
  const apiKey = process.env.NEWSTUNE_API_KEY || stored.apiKey;
  if (!apiKey) throw new Error('No NewsTune API key configured. Run scripts/credentials.mjs set in your local terminal.');
  return {
    apiKey,
    baseUrl: String(args['base-url'] || process.env.NEWSTUNE_API_BASE_URL || stored.baseUrl).replace(/\/$/, ''),
  };
}

async function createHandoff(args) {
  const action = String(args.action || args._[0] || '').trim();
  if (!action || action === 'create') throw new Error('Handoff action is required. Example: web_handoff.mjs voice_clone');
  const { apiKey, baseUrl } = loadCredentials(args);
  const body = {
    action,
    input: readInput(args),
    ...(args['ttl-seconds'] ? { ttlSeconds: Number(args['ttl-seconds']) } : {}),
  };
  const created = await requestJson(baseUrl, apiKey, '/api/v1/handoffs', { method: 'POST', body });
  const openResult = args['no-open'] ? { opened: false, mode: 'disabled' } : openUrl(created.openUrl, Boolean(args['app-window']));
  if (args['no-poll']) {
    return { ...created, open: openResult };
  }
  const handoff = await pollHandoff({
    baseUrl,
    apiKey,
    handoffId: created.handoffId,
    timeoutMs: Number(args['timeout-ms'] || DEFAULT_TIMEOUT_MS),
    intervalMs: Number(args['interval-ms'] || DEFAULT_INTERVAL_MS),
  });
  return { handoffId: created.handoffId, openUrl: created.openUrl, open: openResult, handoff };
}

async function pollCommand(args) {
  const handoffId = String(args['handoff-id'] || args._[1] || '').trim();
  if (!handoffId) throw new Error('--handoff-id is required');
  const { apiKey, baseUrl } = loadCredentials(args);
  const handoff = await pollHandoff({
    baseUrl,
    apiKey,
    handoffId,
    timeoutMs: Number(args['timeout-ms'] || DEFAULT_TIMEOUT_MS),
    intervalMs: Number(args['interval-ms'] || DEFAULT_INTERVAL_MS),
  });
  return { handoffId, handoff };
}

async function cancelCommand(args) {
  const handoffId = String(args['handoff-id'] || args._[1] || '').trim();
  if (!handoffId) throw new Error('--handoff-id is required');
  const { apiKey, baseUrl } = loadCredentials(args);
  return requestJson(baseUrl, apiKey, `/api/v1/handoffs/${encodeURIComponent(handoffId)}/cancel`, { method: 'POST', body: {} });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'help';
  if (command === 'help' || args.help) usage(0);
  const out = command === 'poll'
    ? await pollCommand(args)
    : command === 'cancel'
      ? await cancelCommand(args)
      : await createHandoff({ ...args, action: command === 'create' ? args.action : command });
  console.log(JSON.stringify(out, null, 2));
}

if (scriptPath === path.resolve(process.argv[1] || '')) {
  main().catch((error) => {
    console.error(JSON.stringify({
      error: error?.message || String(error),
      status: error?.status,
      details: error?.body,
    }, null, 2));
    process.exit(1);
  });
}
