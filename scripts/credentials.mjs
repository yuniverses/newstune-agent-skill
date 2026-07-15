#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const skillDir = path.resolve(path.dirname(scriptPath), '..');
const sharedCredentialsPath = path.join(os.homedir(), '.config', 'newstune', 'credentials.json');
const legacyCredentialsPath = path.join(skillDir, '.private', 'credentials.json');
const defaultBaseUrl = 'https://api.newstune.app';

export function getCredentialsPath() {
  return process.env.NEWSTUNE_CREDENTIALS_PATH || sharedCredentialsPath;
}

export function maskApiKey(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return '';
  if (key.length <= 16) return `${key.slice(0, 4)}...`;
  return `${key.slice(0, 12)}...${key.slice(-6)}`;
}

export function normalizeBaseUrl(value) {
  return String(value || defaultBaseUrl).trim().replace(/\/$/, '');
}

export function loadStoredCredentials() {
  const configuredPath = getCredentialsPath();
  const candidates = process.env.NEWSTUNE_CREDENTIALS_PATH
    ? [configuredPath]
    : [configuredPath, legacyCredentialsPath];
  for (const credentialsPath of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
      return {
        apiKey: String(parsed.apiKey || '').trim(),
        baseUrl: normalizeBaseUrl(parsed.baseUrl),
        updatedAt: parsed.updatedAt || null,
        path: credentialsPath,
        legacy: credentialsPath === legacyCredentialsPath,
      };
    } catch {}
  }
  return {
    apiKey: '',
    baseUrl: defaultBaseUrl,
    updatedAt: null,
    path: configuredPath,
    legacy: false,
  };
}

function ensurePrivateDirectory(credentialsPath) {
  const dir = path.dirname(credentialsPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Some filesystems do not support chmod. The credential file chmod below is still attempted.
  }
}

function looksLikeNewsTuneApiKey(apiKey) {
  return /^nt_(live|test)_[A-Za-z0-9_-]{8,}$/.test(apiKey);
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      result._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

async function readHiddenApiKey() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(String(chunk));
    return chunks.join('').trim();
  }
  if (typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Hidden terminal input is unavailable. Set NEWSTUNE_API_KEY locally and rerun this command.');
  }

  process.stdout.write('Paste the one-time NewsTune API key (input hidden): ');
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = Boolean(stdin.isRaw);
    let value = '';
    let settled = false;

    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write('\n');
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === '\u0003') {
          finish(new Error('Credential setup cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
        } else if (character >= ' ') {
          value += character;
        }
      }
    };

    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

function saveCredentials({ apiKey, baseUrl }) {
  const trimmedKey = String(apiKey || '').trim();
  if (!looksLikeNewsTuneApiKey(trimmedKey)) {
    throw new Error('The key does not look like a NewsTune API key. Expected a value starting with nt_live_ or nt_test_.');
  }

  const credentialsPath = getCredentialsPath();
  ensurePrivateDirectory(credentialsPath);
  const payload = {
    apiKey: trimmedKey,
    baseUrl: normalizeBaseUrl(baseUrl),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(credentialsPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(credentialsPath, 0o600);
  } catch {
    // See directory chmod note above.
  }
  return { ...payload, path: credentialsPath };
}

function printStatus(credentials = loadStoredCredentials()) {
  const configured = Boolean(credentials.apiKey);
  console.log(JSON.stringify({
    configured,
    path: credentials.path,
    baseUrl: credentials.baseUrl,
    apiKeyMasked: configured ? maskApiKey(credentials.apiKey) : null,
    updatedAt: credentials.updatedAt,
  }, null, 2));
}

function clearCredentials() {
  const credentialsPaths = process.env.NEWSTUNE_CREDENTIALS_PATH
    ? [getCredentialsPath()]
    : [getCredentialsPath(), legacyCredentialsPath];
  for (const credentialsPath of credentialsPaths) {
    try {
      fs.unlinkSync(credentialsPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  console.log(JSON.stringify({ cleared: true, paths: credentialsPaths }, null, 2));
}

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`NewsTune Agent API credential helper

Usage:
  node scripts/credentials.mjs status
  node scripts/credentials.mjs set [--base-url https://...]
  node scripts/credentials.mjs clear

The raw API key is stored in ~/.config/newstune/credentials.json with chmod 0600.
The set command asks for the key with hidden terminal input. Do not paste secrets into AI chat.
For non-interactive local automation, provide NEWSTUNE_API_KEY through the process environment.
Do not commit that file or paste its contents into generated documents.
`);
  process.exit(exitCode);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'status';

  if (command === 'help' || args.help) usage(0);
  if (command === 'status') {
    printStatus();
    return;
  }
  if (command === 'set') {
    const apiKey = args.key || process.env.NEWSTUNE_API_KEY || await readHiddenApiKey();
    const saved = saveCredentials({
      apiKey,
      baseUrl: args['base-url'] || process.env.NEWSTUNE_API_BASE_URL || defaultBaseUrl,
    });
    console.log(JSON.stringify({
      saved: true,
      path: saved.path,
      baseUrl: saved.baseUrl,
      apiKeyMasked: maskApiKey(saved.apiKey),
      updatedAt: saved.updatedAt,
    }, null, 2));
    return;
  }
  if (command === 'clear') {
    clearCredentials();
    return;
  }

  usage(1);
}

if (scriptPath === path.resolve(process.argv[1] || '')) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}
