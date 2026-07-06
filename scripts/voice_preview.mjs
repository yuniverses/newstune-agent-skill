#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadStoredCredentials, maskApiKey } from './credentials.mjs';

const credentialsScriptPath = fileURLToPath(new URL('./credentials.mjs', import.meta.url));

const DEFAULT_SAMPLE_TEXT = '這是一段 NewsTune 語音試聽。請確認聲音、語氣和節奏是否適合這個 Podcast。';

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`NewsTune voice preview helper

Usage:
  node scripts/voice_preview.mjs list [--language zh-TW] [--playable-only]
  node scripts/voice_preview.mjs sample --voice <referenceId> [--text "..."] [--open]

Options:
  --voice <referenceId>        Voice referenceId to preview.
  --text <text>                Sample text for /api/v1/tts fallback.
  --backend <backend>          TTS backend override. Default: voice backend or fish.
  --force-tts                  Ignore previewUrl and render a fresh /api/v1/tts sample.
  --open                       Open the preview URL with the OS default player/browser.
  --timeout-ms <number>        Polling timeout for /api/v1/jobs/{jobId}. Default: 120000.
  --json                       Print full JSON.

The helper uses the local credential cache and never prints the raw API key.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') usage(0);
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    index += 1;
  }
  return out;
}

function requireCredentials() {
  const credentials = loadStoredCredentials();
  if (!credentials.apiKey) {
    throw new Error(`No NewsTune API key is configured. Store one with:

node ${credentialsScriptPath} set --key 'nt_live_...'
`);
  }
  return {
    apiKey: credentials.apiKey,
    apiKeyMasked: maskApiKey(credentials.apiKey),
    baseUrl: credentials.baseUrl.replace(/\/$/, ''),
  };
}

async function apiRequest(credentials, method, path, body, headers = {}) {
  const res = await fetch(`${credentials.baseUrl}${path}`, {
    method,
    headers: {
      'X-NT-API-Key': credentials.apiKey,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(json?.error || `HTTP_${res.status}`);
    error.status = res.status;
    error.body = json;
    throw error;
  }
  return json;
}

function matchesLanguage(voice, language) {
  if (!language) return true;
  const wanted = String(language).toLowerCase();
  const values = [
    voice.language,
    voice.titleLanguage,
    ...(Array.isArray(voice.languages) ? voice.languages : []),
    ...(Array.isArray(voice.titleLanguages) ? voice.titleLanguages : []),
  ].map((value) => String(value || '').toLowerCase()).filter(Boolean);
  return values.some((value) => value === wanted || value.startsWith(wanted.split('-')[0]));
}

async function listVoices(credentials, options) {
  const data = await apiRequest(credentials, 'GET', '/api/v1/voices');
  let voices = Array.isArray(data.voices) ? data.voices : [];
  if (options.language) voices = voices.filter((voice) => matchesLanguage(voice, options.language));
  if (options['playable-only']) voices = voices.filter((voice) => String(voice.previewUrl || '').trim());
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ apiKeyMasked: credentials.apiKeyMasked, voices }, null, 2)}\n`);
    return;
  }
  for (const voice of voices) {
    const preview = voice.previewUrl ? 'preview' : 'no-preview';
    const language = voice.language || (Array.isArray(voice.languages) ? voice.languages.join(',') : '');
    process.stdout.write(`${voice.name || 'Unnamed'} | ${voice.referenceId} | ${voice.backend || 'fish'} | ${language || 'unknown-language'} | ${preview}\n`);
  }
}

function openUrl(url) {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.unref();
}

function extractAudioUrl(job) {
  const result = job?.result || {};
  return result.mergedUrl
    || result.merged
    || result.url
    || result.audioUrl
    || result.ttsAudio?.merged
    || result.ttsAudio?.mergedMp3
    || '';
}

async function pollJob(credentials, jobId, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const data = await apiRequest(credentials, 'GET', `/api/v1/jobs/${encodeURIComponent(jobId)}`);
    const job = data.job || {};
    if (job.status === 'succeeded') return job;
    if (job.status === 'failed') {
      throw new Error(job.error || 'TTS preview job failed');
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

async function sampleVoice(credentials, options) {
  const referenceId = String(options.voice || '').trim();
  if (!referenceId) throw new Error('--voice is required');

  const data = await apiRequest(credentials, 'GET', '/api/v1/voices');
  const voice = (Array.isArray(data.voices) ? data.voices : [])
    .find((item) => String(item.referenceId || '').trim() === referenceId);
  if (!voice) throw new Error(`Voice not found or not accessible: ${referenceId}`);

  const previewUrl = String(voice.previewUrl || '').trim();
  if (previewUrl && !options['force-tts']) {
    if (options.open) openUrl(previewUrl);
    process.stdout.write(`${JSON.stringify({
      source: 'previewUrl',
      referenceId,
      name: voice.name || '',
      url: previewUrl,
    }, null, 2)}\n`);
    return;
  }

  const text = String(options.text || DEFAULT_SAMPLE_TEXT).trim();
  const idempotencyKey = `voice-preview-${referenceId}-${Date.now()}`;
  const queued = await apiRequest(credentials, 'POST', '/api/v1/tts', {
    text,
    voice: {
      referenceId,
      backend: options.backend || voice.backend || 'fish',
    },
  }, { 'Idempotency-Key': idempotencyKey });
  const job = await pollJob(credentials, queued.jobId, Number(options['timeout-ms'] || 120000));
  const url = extractAudioUrl(job);
  if (!url) throw new Error(`Job ${queued.jobId} succeeded but did not return an audio URL`);
  if (options.open) openUrl(url);
  process.stdout.write(`${JSON.stringify({
    source: 'tts_render',
    referenceId,
    name: voice.name || '',
    jobId: queued.jobId,
    url,
    result: options.json ? job.result : undefined,
  }, null, 2)}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = options._[0] || 'list';
  const credentials = requireCredentials();
  if (command === 'list') {
    await listVoices(credentials, options);
    return;
  }
  if (command === 'sample') {
    await sampleVoice(credentials, options);
    return;
  }
  usage(1);
}

main().catch((error) => {
  console.error(error?.message || String(error));
  if (error?.body) console.error(JSON.stringify(error.body, null, 2));
  process.exit(1);
});
