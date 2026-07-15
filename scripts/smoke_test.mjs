#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { loadStoredCredentials, maskApiKey } from './credentials.mjs';

const credentialsScriptPath = fileURLToPath(new URL('./credentials.mjs', import.meta.url));

const cachedCredentials = loadStoredCredentials();
const baseUrl = (process.env.NEWSTUNE_API_BASE_URL || cachedCredentials.baseUrl || 'https://api.newstune.app').replace(/\/$/, '');
const apiKey = String(process.env.NEWSTUNE_API_KEY || cachedCredentials.apiKey || '').trim();
const createSeries = process.env.NEWSTUNE_CREATE_SMOKE_SERIES === 'true';
const testTtsReject = process.env.NEWSTUNE_TEST_TTS_REJECT === 'true';
const testTtsJobPoll = process.env.NEWSTUNE_TEST_TTS_JOB_POLL === 'true';
const testWebHandoff = process.env.NEWSTUNE_TEST_WEB_HANDOFF === 'true';

if (!apiKey) {
  console.error(`NEWSTUNE_API_KEY is required.

Open https://podcast.newstune.app/beta/#api-keys, create an API key, copy the one-time secret, then store it locally:

node ${credentialsScriptPath} set
`);
  process.exit(2);
}

async function request(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'X-NT-API-Key': apiKey,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

function assertOk(condition, label, result) {
  if (!condition) {
    console.error(JSON.stringify({ ok: false, failed: label, result }, null, 2));
    process.exit(1);
  }
}

const summary = { baseUrl, apiKeyMasked: maskApiKey(apiKey), checks: {} };

function chooseSmokeHostIds(hostsPayload) {
  const hosts = Array.isArray(hostsPayload?.hosts) ? hostsPayload.hosts : [];
  const ids = new Set(hosts.map((host) => String(host?.id || '').trim()).filter(Boolean));
  const zhDefaults = ['builtin_zh_kai', 'builtin_zh_luna'];
  if (zhDefaults.every((id) => ids.has(id))) return zhDefaults;
  return hosts
    .filter((host) => host?.ttsVoice?.referenceId)
    .map((host) => String(host.id || '').trim())
    .filter(Boolean)
    .slice(0, 2);
}

async function waitForJob(jobId, timeoutMs = 120000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const job = await request('GET', `/api/v1/jobs/${encodeURIComponent(jobId)}`);
    assertOk(job.status === 200 && job.body.job?.id, 'jobPoll', job);
    if (job.body.job.status === 'succeeded') return job.body.job;
    if (job.body.job.status === 'failed') assertOk(false, 'jobSucceeded', job);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  assertOk(false, 'jobPollTimeout', { jobId, timeoutMs });
}

const me = await request('GET', '/api/v1/me');
assertOk(me.status === 200 && me.body.userId, 'me', me);
summary.checks.me = me.status;
summary.userId = me.body.userId;
summary.scopes = me.body.apiKey?.scopes || [];

const credits = await request('GET', '/api/v1/credits');
assertOk(credits.status === 200 && typeof credits.body.totalAvailable === 'number', 'credits', credits);
summary.checks.credits = credits.status;
summary.totalAvailable = credits.body.totalAvailable;

const hosts = await request('GET', '/api/v1/hosts?source=all');
assertOk(hosts.status === 200 && Array.isArray(hosts.body.hosts), 'hosts', hosts);
summary.checks.hosts = hosts.status;
summary.hostCount = hosts.body.hosts.length;

const voices = await request('GET', '/api/v1/voices');
assertOk(voices.status === 200 && Array.isArray(voices.body.voices), 'voices', voices);
summary.checks.voices = voices.status;
summary.voiceCount = voices.body.voices.length;

if (testTtsReject) {
  const stamp = Date.now();
  const ttsReject = await request('POST', '/api/v1/tts', {
    text: 'This smoke check should reject an arbitrary voice reference.',
    voice: { referenceId: `newstune-smoke-not-allowed-${stamp}` },
  }, { 'Idempotency-Key': `tts-reject-${stamp}` });
  assertOk(ttsReject.status === 400 && ttsReject.body.error === 'VOICE_NOT_ACCESSIBLE', 'ttsReject', ttsReject);
  summary.checks.ttsReject = ttsReject.status;
}

if (testTtsJobPoll) {
  const stamp = Date.now();
  const voice = (voices.body.voices || []).find((item) => item?.referenceId);
  const tts = await request('POST', '/api/v1/tts', {
    text: 'NewsTune Agent API smoke test for TTS job polling.',
    voice: voice?.referenceId ? {
      referenceId: voice.referenceId,
      backend: voice.backend || 'fish',
    } : undefined,
  }, { 'Idempotency-Key': `tts-job-poll-${stamp}` });
  assertOk(tts.status === 202 && tts.body.jobId, 'ttsJobQueued', tts);
  const job = await waitForJob(tts.body.jobId);
  assertOk(Boolean(job.result?.mergedUrl || job.result?.mergedAssetId || job.result?.ttsAudio?.merged), 'ttsJobResult', job);
  summary.checks.ttsJobPoll = 200;
  summary.ttsJobId = tts.body.jobId;
  summary.ttsAudioUrl = job.result?.mergedUrl || job.result?.ttsAudio?.merged || null;
}

if (testWebHandoff) {
  const handoff = await request('POST', '/api/v1/handoffs', {
    action: 'api_keys',
    input: { smoke: true },
    ttlSeconds: 120,
  });
  assertOk(handoff.status === 201 && handoff.body.handoffId && handoff.body.openUrl, 'webHandoffCreate', handoff);
  const poll = await request('GET', `/api/v1/handoffs/${encodeURIComponent(handoff.body.handoffId)}`);
  assertOk(poll.status === 200 && poll.body.handoff?.status === 'pending', 'webHandoffPoll', poll);
  const cancel = await request('POST', `/api/v1/handoffs/${encodeURIComponent(handoff.body.handoffId)}/cancel`, {});
  assertOk(cancel.status === 200 && cancel.body.handoff?.status === 'cancelled', 'webHandoffCancel', cancel);
  summary.checks.webHandoff = 200;
  summary.handoffId = handoff.body.handoffId;
}

if (createSeries) {
  const stamp = Date.now();
  const hostIds = chooseSmokeHostIds(hosts.body);
  assertOk(hostIds.length > 0, 'chooseSmokeHosts', hosts);
  const create = await request('POST', '/api/v1/series', {
    title: `API Smoke Series ${stamp}`,
    topic: 'NewsTune Agent API smoke test',
    language: 'zh-TW',
    hostIds,
    colors: { primary: '#2563eb', accent: '#f97316' },
  }, { 'Idempotency-Key': `skill-smoke-series-${stamp}` });
  assertOk(create.status === 201 && create.body.series?.id, 'createSeries', create);
  summary.checks.createSeries = create.status;
  summary.seriesId = create.body.series.id;
  summary.hostIds = hostIds;
}

console.log(JSON.stringify(summary, null, 2));
