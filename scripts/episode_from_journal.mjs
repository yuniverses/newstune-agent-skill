#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadStoredCredentials, maskApiKey, normalizeBaseUrl } from './credentials.mjs';

const scriptPath = fileURLToPath(import.meta.url);

const POLL_INTERVAL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 600000;
const VALID_MODES = ['script_to_audio', 'material_to_podcast'];
const VALID_VISIBILITIES = ['public', 'private'];
const PUBLIC_SITE_BASE_URL = 'https://podcast.newstune.app';
// Entries whose type appears earlier in this list are emitted first in the material pack.
const TYPE_RANK = { decision: 0, pivot: 1, milestone: 2 };
const DEFAULT_TYPE_RANK = 3;
const MAX_NOTABLE_SUBJECTS = 10;
const MAX_PRIOR_EPISODES = 20;

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`NewsTune journal → podcast 集數工具（bind / collect / submit / publish / status）

用法：
  node scripts/episode_from_journal.mjs bind --project <slug> --series-id <id> [--snapshot-json <json|檔案路徑>] [--cadence weekly] [--mode script_to_audio|material_to_podcast]
  node scripts/episode_from_journal.mjs collect --project <slug> [--since <ISO 時間>] [--cwd <專案程式碼目錄>]
  node scripts/episode_from_journal.mjs submit --project <slug> --script-file <path> --title <標題> --summary <摘要> [--topics a,b,c] [--host-guidance <文字>] [--visibility public|private] [--timeout-ms ${DEFAULT_TIMEOUT_MS}]
  node scripts/episode_from_journal.mjs publish --project <slug> --episode <n> [--private]
  node scripts/episode_from_journal.mjs status --project <slug>

子命令說明：
  bind     綁定 journal 專案到 NewsTune series：先呼叫 GET /api/v1/series/:id 取得快照；
           若後端回 404（端點尚未部署），改用 --snapshot-json（JSON 字串或檔案路徑，
           可直接貼 POST /api/v1/series 的回應）。結果寫入 <journalRoot>/<slug>/podcast.json，
           並回報未來 submit 預設使用的 episodeVisibility。
  collect  純資料彙整（不呼叫任何 LLM）：輸出素材包 JSON 到 stdout，內容包含
           lastCoveredAt 之後的 journal entries（decision/pivot/milestone 排前）、
           git 摘要（--cwd 指定 repo，預設目前目錄；非 git 專案容忍為空）、
           前集清單（優先 GET /api/v1/series/:id/episodes，404 時退回本地 ledger.json）、extraSources。
  submit   以 script_to_audio 模式提交完成的腳本（POST /api/v1/series/:id/episodes，
           帶 Idempotency-Key 與 summary/topics/hostGuidance），輪詢 job 到終態；
           成功後更新 ledger.json 與 lastCoveredAt，並在 entries/ 追加一則 type: progress 的「本集已生成」記錄。
           集數可見度解析順序：--visibility 旗標 → podcast.json 的 episodeVisibility →
           系列預設（公開系列的排程集數預設公開；私人系列預設私人）。
  publish  事後切換單集可見度（PATCH /api/v1/series/:id/episodes/:n/visibility，需 publish:write）：
           預設改為 public，帶 --private 則改回 private；成功時輸出 publicSlug 與 publicUrl，
           並回填 ledger.json。後端回 404 視為端點尚未部署，降級為提示而不失敗。
  status   輸出 podcast.json 與 ledger.json 摘要。

路徑解析（可供測試覆寫）：
  NEWSTUNE_AGENT_CONFIG_DIR   設定目錄（預設 ~/.config/newstune-agent）
  NEWSTUNE_JOURNAL_ROOT       journal 根目錄（優先於 config.json 的 journalRoot）
  NEWSTUNE_API_BASE_URL / NEWSTUNE_API_KEY   API 位址與金鑰（優先於本地 credential 快取）

本工具只輸出機器可讀 JSON 到 stdout；提示訊息一律走 stderr，且永不輸出完整 API key。
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
  const stored = loadStoredCredentials();
  const apiKey = String(process.env.NEWSTUNE_API_KEY || stored.apiKey || '').trim();
  const baseUrl = normalizeBaseUrl(process.env.NEWSTUNE_API_BASE_URL || stored.baseUrl);
  if (!apiKey) {
    throw new Error(`尚未設定 NewsTune API key。請先執行：

node ${path.join(path.dirname(scriptPath), 'credentials.mjs')} set --key 'nt_live_...'

（或以環境變數 NEWSTUNE_API_KEY 提供。）`);
  }
  return { apiKey, apiKeyMasked: maskApiKey(apiKey), baseUrl };
}

async function apiRequest(credentials, method, apiPath, body, headers = {}) {
  const res = await fetch(`${credentials.baseUrl}${apiPath}`, {
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

// A 404 means the read endpoint is not deployed yet (contract spec B0); a missing
// status means the fetch itself failed (unreachable host). Both degrade to local data.
function isEndpointGap(error) {
  return error?.status === 404 || error?.status === undefined;
}

async function pollJob(credentials, jobId, timeoutMs) {
  const startedAt = Date.now();
  for (;;) {
    const data = await apiRequest(credentials, 'GET', `/api/v1/jobs/${encodeURIComponent(jobId)}`);
    const job = data.job || {};
    if (job.status === 'succeeded') return job;
    if (job.status === 'failed') {
      const error = new Error(job.error || `集數生成 job 失敗（jobId: ${jobId}）`);
      error.job = job;
      throw error;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`等待 job ${jobId} 逾時（--timeout-ms ${timeoutMs}）。可稍後用 GET /api/v1/jobs/${jobId} 查詢狀態。`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// --- path resolution (spec B0/B1) ---

function expandHome(value) {
  const text = String(value || '');
  if (text === '~') return os.homedir();
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2));
  return text;
}

export function getConfigDir() {
  const override = String(process.env.NEWSTUNE_AGENT_CONFIG_DIR || '').trim();
  if (override) return path.resolve(expandHome(override));
  return path.join(os.homedir(), '.config', 'newstune-agent');
}

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export function resolveJournalRoot() {
  const override = String(process.env.NEWSTUNE_JOURNAL_ROOT || '').trim();
  if (override) return path.resolve(expandHome(override));
  const config = readJsonFile(path.join(getConfigDir(), 'config.json'), {});
  const configured = String(config?.journalRoot || '').trim();
  if (configured) return path.resolve(expandHome(configured));
  throw new Error(`找不到 journal root。請先執行 journal_setup.mjs install 建立 config.json，
或以環境變數 NEWSTUNE_JOURNAL_ROOT 指定路徑。`);
}

function resolveProjectDir(slug) {
  const value = String(slug || '').trim();
  if (!value) throw new Error('--project 為必填（journal 專案 slug）。');
  if (value.includes('/') || value.includes('\\') || value.includes('..')) {
    throw new Error('--project slug 不可包含路徑分隔符或 ".."。');
  }
  return { slug: value, projectDir: path.join(resolveJournalRoot(), value) };
}

function loadPodcastConfig(projectDir, slug) {
  const podcastPath = path.join(projectDir, 'podcast.json');
  const podcast = readJsonFile(podcastPath, null);
  if (!podcast || typeof podcast !== 'object' || !String(podcast.seriesId || '').trim()) {
    throw new Error(`專案 ${slug} 尚未綁定 series（缺少 ${podcastPath}）。請先執行：

node ${scriptPath} bind --project ${slug} --series-id <id>`);
  }
  return { podcast, podcastPath };
}

// --- minimal YAML frontmatter parser (hand rolled, entry files only; no deps) ---

function parseScalar(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function parseInlineValue(raw) {
  const value = String(raw || '').trim();
  if (value === '[]') return [];
  if (value.startsWith('[') && value.endsWith(']')) {
    // Naive comma split: journal entries only store simple scalars in inline lists.
    return value
      .slice(1, -1)
      .split(',')
      .map((part) => parseScalar(part))
      .filter((part) => part !== '');
  }
  return parseScalar(value);
}

export function parseFrontmatter(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  if ((lines[0] || '').trim() !== '---') return { data: {}, body: text };
  let closeIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      closeIndex = index;
      break;
    }
  }
  if (closeIndex === -1) return { data: {}, body: text };

  const data = {};
  let pending = null; // { key, used } — a "key:" line waiting for block-list items
  const finishPending = () => {
    if (pending && !pending.used) data[pending.key] = '';
    pending = null;
  };
  for (const line of lines.slice(1, closeIndex)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const listItem = line.match(/^\s+-\s*(.*)$/);
    if (listItem && pending) {
      if (!Array.isArray(data[pending.key])) data[pending.key] = [];
      data[pending.key].push(parseScalar(listItem[1]));
      pending.used = true;
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_][A-Za-z0-9_-]*)\s*:(.*)$/);
    if (!kv) continue;
    finishPending();
    const key = kv[1];
    const rawValue = kv[2].trim();
    if (!rawValue) {
      data[key] = [];
      pending = { key, used: false };
      continue;
    }
    data[key] = parseInlineValue(rawValue);
  }
  finishPending();

  const body = lines.slice(closeIndex + 1).join('\n').replace(/^\n+/, '');
  return { data, body };
}

function asString(value) {
  if (typeof value === 'string') return value.trim();
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return '';
  return String(value).trim();
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.map((item) => asString(item)).filter(Boolean);
  const single = asString(value);
  return single ? [single] : [];
}

// Date-only entry dates are treated as end-of-day UTC so that an entry written
// later on the same day as an episode submission still counts as uncovered material.
function entryTimestamp(dateText) {
  const value = asString(dateText);
  if (!value) return null;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? Date.parse(`${value}T23:59:59.999Z`)
    : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function loadJournalEntries(projectDir) {
  const entriesDir = path.join(projectDir, 'entries');
  let files = [];
  try {
    files = fs.readdirSync(entriesDir).filter((file) => file.endsWith('.md'));
  } catch {
    return [];
  }
  files.sort();
  const entries = [];
  for (const file of files) {
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(entriesDir, file), 'utf8');
    } catch {
      continue;
    }
    const { data, body } = parseFrontmatter(raw);
    const date = asString(data.date) || (file.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? null);
    entries.push({
      file,
      date: date || null,
      type: asString(data.type).toLowerCase() || null,
      title: asString(data.title) || file,
      why: asString(data.why) || null,
      impact: asString(data.impact) || null,
      refs: asStringArray(data.refs),
      tags: asStringArray(data.tags),
      body: body.trim(),
    });
  }
  return entries;
}

function selectEntries(entries, sinceMs) {
  const filtered = entries.filter((entry) => {
    if (sinceMs === null) return true;
    const ts = entryTimestamp(entry.date);
    // Entries without a parseable date cannot be proven covered — keep them.
    return ts === null || ts > sinceMs;
  });
  return filtered
    .map((entry, index) => ({ entry, index, ts: entryTimestamp(entry.date) }))
    .sort((a, b) => {
      const rankA = TYPE_RANK[a.entry.type] ?? DEFAULT_TYPE_RANK;
      const rankB = TYPE_RANK[b.entry.type] ?? DEFAULT_TYPE_RANK;
      if (rankA !== rankB) return rankA - rankB;
      if (a.ts !== b.ts) {
        if (a.ts === null) return 1;
        if (b.ts === null) return -1;
        return a.ts - b.ts;
      }
      return a.index - b.index;
    })
    .map((item) => item.entry);
}

// --- git digest (deterministic, tolerates non-git directories) ---

function collectGitDigest(cwd, sinceIso) {
  const args = ['-C', cwd, 'log', '--no-merges', '--format=%s'];
  if (sinceIso) args.push(`--since=${sinceIso}`);
  else args.push('-n', '50');
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) return { commitCount: 0, notable: [] };
  const subjects = String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const notable = [];
  const seen = new Set();
  for (const subject of subjects) {
    if (/^(wip\b|typo\b|fixup!|squash!|merge\b)/i.test(subject)) continue;
    if (seen.has(subject)) continue;
    seen.add(subject);
    notable.push(subject);
    if (notable.length >= MAX_NOTABLE_SUBJECTS) break;
  }
  return { commitCount: subjects.length, notable };
}

// --- series snapshot helpers ---

function buildSeriesSnapshot(series) {
  const source = series && typeof series === 'object' ? series : {};
  const snapshot = {
    title: asString(source.title) || null,
    topic: asString(source.topic) || null,
    language: asString(source.language) || null,
    hostIds: asStringArray(source.hostIds),
    episodeFormat: asString(source.episodeFormat) || null,
    visibility: normalizeVisibility(source.visibility),
  };
  const duration = Number(source.targetDurationMinutes);
  if (Number.isFinite(duration) && duration > 0) snapshot.targetDurationMinutes = duration;
  return snapshot;
}

export function extractScriptSpeakerNames(script) {
  const names = [];
  const seen = new Set();
  for (const line of String(script || '').split(/\n+/)) {
    const match = line.trim().match(/^([^:：]{1,50})[:：]\s*(.+)$/u);
    if (!match) continue;
    const name = match[1].trim();
    const normalized = name.toLocaleLowerCase();
    if (!name || seen.has(normalized)) continue;
    seen.add(normalized);
    names.push(name);
  }
  return names;
}

export function validateScriptSpeakers(script, hosts) {
  const availableHosts = Array.isArray(hosts) ? hosts : [];
  const expectedSpeakers = availableHosts
    .map((host) => asString(host?.name))
    .filter(Boolean);
  const expectedByName = new Map(
    expectedSpeakers.map((name) => [name.toLocaleLowerCase(), name]),
  );
  const scriptSpeakers = extractScriptSpeakerNames(script);
  const unknownSpeakers = scriptSpeakers.filter(
    (name) => !expectedByName.has(name.toLocaleLowerCase()),
  );
  if (unknownSpeakers.length) {
    throw new Error(
      `腳本主持人與系列設定不一致：找不到 ${unknownSpeakers.join('、')}；`
      + `本系列目前只能使用 ${expectedSpeakers.join('、')}。請先修正所有「主持人名稱:」標籤再提交。`,
    );
  }
  return { expectedSpeakers, scriptSpeakers };
}

async function resolveLiveSeriesHosts(credentials, podcast) {
  let series = null;
  try {
    const data = await apiRequest(
      credentials,
      'GET',
      `/api/v1/series/${encodeURIComponent(podcast.seriesId)}`,
    );
    series = data?.series || null;
  } catch (error) {
    if (!isEndpointGap(error)) throw error;
    process.stderr.write('[newstune] 無法讀取 live series，改用 podcast.json 的 seriesSnapshot 驗證主持人。\n');
    series = podcast.seriesSnapshot || null;
  }

  const hostIds = asStringArray(series?.hostIds);
  if (!hostIds.length) {
    throw new Error('系列沒有可用的 hostIds，為避免使用錯誤聲音，已停止提交。');
  }

  let hostData;
  try {
    hostData = await apiRequest(credentials, 'GET', '/api/v1/hosts?source=all');
  } catch (error) {
    throw new Error(`無法取得 live hosts，為避免使用錯誤聲音，已停止提交：${error?.message || error}`);
  }
  const allHosts = Array.isArray(hostData?.hosts) ? hostData.hosts : [];
  const byId = new Map(allHosts.map((host) => [asString(host?.id || host?._id), host]));
  const hosts = hostIds.map((id) => byId.get(id)).filter(Boolean);
  const missingHostIds = hostIds.filter((id) => !byId.has(id));
  if (missingHostIds.length) {
    throw new Error(`系列主持人無法解析：${missingHostIds.join('、')}。為避免 fallback 到錯誤聲音，已停止提交。`);
  }
  return { series, hostIds, hosts };
}

function normalizeVisibility(value) {
  const text = asString(value).toLowerCase();
  return VALID_VISIBILITIES.includes(text) ? text : null;
}

// Resolution order (documented in SKILL.md / references/journal.md):
// --visibility flag → podcast.json episodeVisibility → series default.
// A public show's scheduled episodes should air by default, so a public series
// snapshot defaults to 'public'; everything else defaults to 'private'.
function resolveEpisodeVisibility(args, podcast) {
  if (args && args.visibility !== undefined) {
    const flag = normalizeVisibility(args.visibility === true ? '' : args.visibility);
    if (!flag) throw new Error(`--visibility 必須是 ${VALID_VISIBILITIES.join(' 或 ')}。`);
    return { visibility: flag, source: 'flag' };
  }
  const configured = normalizeVisibility(podcast?.episodeVisibility);
  if (configured) return { visibility: configured, source: 'podcast.json' };
  const seriesVisibility = normalizeVisibility(podcast?.seriesSnapshot?.visibility);
  return {
    visibility: seriesVisibility === 'public' ? 'public' : 'private',
    source: 'series-default',
  };
}

function buildEpisodePublicUrl(language, publicSlug) {
  const slug = asString(publicSlug);
  if (!slug) return null;
  // Mirror the backend canonical rule (src/lib/publicRender/urls.mjs): only
  // zh / zh-tw* / zh-hant* map to the /zh-tw prefix; zh-Hans/zh-CN and
  // everything else use the English path.
  const lang = asString(language).toLowerCase();
  const isZhTw = lang === 'zh' || lang.startsWith('zh-tw') || lang.startsWith('zh-hant');
  const localePath = isZhTw ? '/zh-tw' : '';
  return `${PUBLIC_SITE_BASE_URL}${localePath}/episode/${encodeURIComponent(slug)}/`;
}

function loadSnapshotInput(rawInput) {
  const value = String(rawInput || '').trim();
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    try {
      parsed = JSON.parse(fs.readFileSync(path.resolve(expandHome(value)), 'utf8'));
    } catch {
      throw new Error('--snapshot-json 必須是 JSON 字串或指向 JSON 檔案的路徑（可直接貼 POST /api/v1/series 的回應）。');
    }
  }
  if (parsed && typeof parsed === 'object' && parsed.series && typeof parsed.series === 'object') {
    return parsed.series;
  }
  return parsed;
}

// --- subcommands ---

async function runBind(args) {
  const { slug, projectDir } = resolveProjectDir(args.project);
  const seriesId = String(args['series-id'] || '').trim();
  if (!seriesId) throw new Error('--series-id 為必填。');
  const credentials = requireCredentials();

  let snapshotSource = 'api';
  let seriesRaw = null;
  try {
    const data = await apiRequest(credentials, 'GET', `/api/v1/series/${encodeURIComponent(seriesId)}`);
    seriesRaw = data.series || null;
  } catch (error) {
    if (!isEndpointGap(error)) throw error;
    process.stderr.write('[newstune] 後端尚未部署 GET /api/v1/series/:id（404 或無法連線），改用 --snapshot-json 提供的系列快照。\n');
    if (args['snapshot-json'] === undefined || args['snapshot-json'] === true) {
      throw new Error(`後端讀取端點尚未部署，bind 需要 --snapshot-json。
請貼上 POST /api/v1/series 回應（或等後端部署後重試）：

node ${scriptPath} bind --project ${slug} --series-id ${seriesId} --snapshot-json '{"series":{...}}'`);
    }
    seriesRaw = loadSnapshotInput(args['snapshot-json']);
    snapshotSource = 'snapshot-json';
  }

  const modeArg = String(args.mode || '').trim();
  if (modeArg && !VALID_MODES.includes(modeArg)) {
    throw new Error(`--mode 必須是 ${VALID_MODES.join(' 或 ')}。`);
  }

  fs.mkdirSync(projectDir, { recursive: true });
  const podcastPath = path.join(projectDir, 'podcast.json');
  const existing = readJsonFile(podcastPath, null);
  const existingEpisodeVisibility = normalizeVisibility(existing?.episodeVisibility);
  const podcast = {
    seriesId,
    seriesSnapshot: buildSeriesSnapshot(seriesRaw),
    cadence: String(args.cadence || existing?.cadence || 'weekly').trim(),
    mode: modeArg || existing?.mode || 'script_to_audio',
    materialConsent: existing?.materialConsent === true,
    extraSources: Array.isArray(existing?.extraSources) ? existing.extraSources : [],
    lastCoveredAt: existing?.lastCoveredAt ?? null,
    ...(existingEpisodeVisibility ? { episodeVisibility: existingEpisodeVisibility } : {}),
  };
  writeJsonFile(podcastPath, podcast);

  const episodeVisibilityDefault = resolveEpisodeVisibility({}, podcast);
  process.stderr.write(`[newstune] 未帶 --visibility 時，未來 submit 的集數可見度預設為 ${episodeVisibilityDefault.visibility}`
    + `（來源：${episodeVisibilityDefault.source}）。可在 podcast.json 設定 episodeVisibility 覆寫。\n`);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    project: slug,
    source: snapshotSource,
    podcastPath,
    podcast,
    episodeVisibilityDefault: episodeVisibilityDefault.visibility,
    episodeVisibilityDefaultSource: episodeVisibilityDefault.source,
  }, null, 2)}\n`);
}

async function runCollect(args) {
  const { slug, projectDir } = resolveProjectDir(args.project);
  const credentials = requireCredentials();
  const { podcast } = loadPodcastConfig(projectDir, slug);
  const ledger = readJsonFile(path.join(projectDir, 'ledger.json'), null);

  let sinceIso = null;
  if (args.since !== undefined && args.since !== true) {
    const parsed = Date.parse(String(args.since));
    if (!Number.isFinite(parsed)) throw new Error('--since 必須是可解析的 ISO 時間字串。');
    sinceIso = new Date(parsed).toISOString();
  } else {
    sinceIso = asString(ledger?.lastCoveredAt) || asString(podcast.lastCoveredAt) || null;
  }
  const sinceMs = sinceIso ? Date.parse(sinceIso) : null;

  const entries = selectEntries(loadJournalEntries(projectDir), Number.isFinite(sinceMs) ? sinceMs : null);
  const gitCwd = path.resolve(expandHome(String(
    args.cwd !== undefined && args.cwd !== true ? args.cwd : process.cwd(),
  )));
  const gitDigest = collectGitDigest(gitCwd, sinceIso);

  let priorEpisodes = [];
  try {
    const data = await apiRequest(
      credentials,
      'GET',
      `/api/v1/series/${encodeURIComponent(podcast.seriesId)}/episodes?limit=${MAX_PRIOR_EPISODES}`,
    );
    priorEpisodes = Array.isArray(data.episodes) ? data.episodes : [];
  } catch (error) {
    if (!isEndpointGap(error)) throw error;
    process.stderr.write('[newstune] 後端尚未部署 GET /api/v1/series/:id/episodes（404 或無法連線），priorEpisodes 改用本地 ledger.json。\n');
    const ledgerEpisodes = Array.isArray(ledger?.episodes) ? ledger.episodes : [];
    priorEpisodes = ledgerEpisodes
      .slice()
      .sort((a, b) => Number(b?.episodeNumber || 0) - Number(a?.episodeNumber || 0))
      .slice(0, MAX_PRIOR_EPISODES);
  }

  process.stdout.write(`${JSON.stringify({
    project: slug,
    series: podcast.seriesSnapshot ?? null,
    entries,
    gitDigest,
    priorEpisodes,
    extraSources: Array.isArray(podcast.extraSources) ? podcast.extraSources : [],
  }, null, 2)}\n`);
}

function yamlScalar(value) {
  const text = String(value ?? '');
  if (/^[A-Za-z0-9 _\-./]+$/.test(text) && text.trim() === text && text !== '') return text;
  return JSON.stringify(text);
}

function writeProgressEntry(projectDir, { seriesId, episodeNumber, title, summary, topics, jobId, nowIso }) {
  const entriesDir = path.join(projectDir, 'entries');
  fs.mkdirSync(entriesDir, { recursive: true });
  const day = nowIso.slice(0, 10);
  const episodeLabel = episodeNumber === null ? '?' : String(episodeNumber);
  const slugBase = `${day}_podcast-episode-${episodeNumber === null ? 'x' : episodeNumber}`;
  let fileName = `${slugBase}.md`;
  let suffix = 2;
  while (fs.existsSync(path.join(entriesDir, fileName))) {
    fileName = `${slugBase}-${suffix}.md`;
    suffix += 1;
  }
  const lines = [
    '---',
    `date: ${day}`,
    'type: progress',
    `title: ${yamlScalar(`本集已生成：${title}`)}`,
    `why: ${yamlScalar('排程或手動觸發的集數生成已完成，記錄一筆以維持節目與 journal 的連續性。')}`,
    `impact: ${yamlScalar(`系列 ${seriesId} 新增第 ${episodeLabel} 集，摘要與主題已寫入 ledger.json。`)}`,
    'refs: []',
    'tags:',
    '  - podcast',
    '  - episode',
    '---',
    '',
    `本集已生成：「${title}」。`,
    '',
    `- 集數：第 ${episodeLabel} 集`,
    `- 摘要：${summary}`,
    ...(topics.length ? [`- 主題：${topics.join('、')}`] : []),
    `- Job ID：${jobId}`,
    `- 生成時間：${nowIso}`,
    '',
  ];
  const entryPath = path.join(entriesDir, fileName);
  fs.writeFileSync(entryPath, lines.join('\n'));
  return entryPath;
}

async function runSubmit(args) {
  const { slug, projectDir } = resolveProjectDir(args.project);
  const credentials = requireCredentials();
  const { podcast, podcastPath } = loadPodcastConfig(projectDir, slug);

  const scriptFile = String(args['script-file'] || '').trim();
  if (!scriptFile) throw new Error('--script-file 為必填（完成腳本的檔案路徑）。');
  let script = '';
  try {
    script = fs.readFileSync(path.resolve(expandHome(scriptFile)), 'utf8').trim();
  } catch {
    throw new Error(`讀不到腳本檔案：${scriptFile}`);
  }
  if (!script) throw new Error('腳本檔案是空的，無法提交。');

  const title = String(args.title || '').trim();
  if (!title) throw new Error('--title 為必填。');
  const summary = String(args.summary || '').trim();
  if (!summary) throw new Error('--summary 為必填（回填伺服器與 ledger 的雙邊記憶）。');
  const topics = typeof args.topics === 'string'
    ? args.topics.split(',').map((item) => item.trim()).filter(Boolean)
    : [];
  const hostGuidance = typeof args['host-guidance'] === 'string' ? args['host-guidance'].trim() : '';
  const timeoutMs = Number(args['timeout-ms'] || DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout-ms 必須是正整數。');
  const resolvedVisibility = resolveEpisodeVisibility(args, podcast);
  process.stderr.write(`[newstune] 本集 visibility=${resolvedVisibility.visibility}（來源：${resolvedVisibility.source}）。\n`);

  const liveHostConfig = await resolveLiveSeriesHosts(credentials, podcast);
  const speakerValidation = validateScriptSpeakers(script, liveHostConfig.hosts);
  process.stderr.write(
    `[newstune] 主持人驗證通過：hostIds=${liveHostConfig.hostIds.join(',')}；`
    + `scriptSpeakers=${speakerValidation.scriptSpeakers.join(',') || '(none)'}。\n`,
  );
  if (liveHostConfig.series) {
    podcast.seriesSnapshot = buildSeriesSnapshot(liveHostConfig.series);
  }

  const requestBody = {
    mode: 'script_to_audio',
    title,
    script,
    hostIds: liveHostConfig.hostIds,
    summary,
    visibility: resolvedVisibility.visibility,
    ...(topics.length ? { topics } : {}),
    ...(hostGuidance ? { hostGuidance } : {}),
  };
  // If the backend has not deployed summary/topics/hostGuidance yet it ignores the
  // unknown fields; the ledger update below still records them locally.
  let queued;
  try {
    queued = await apiRequest(
      credentials,
      'POST',
      `/api/v1/series/${encodeURIComponent(podcast.seriesId)}/episodes`,
      requestBody,
      { 'Idempotency-Key': `episode-journal-${slug}-${Date.now()}` },
    );
  } catch (error) {
    // 'public' requires the publish:write scope. When public was only the
    // series-derived DEFAULT (not an explicit --visibility flag or
    // podcast.json setting), a key without that scope must not brick
    // scheduled runs — fall back to private and say so. Explicit choices
    // still fail loudly.
    const scopeDenied = error?.status === 403
      && resolvedVisibility.visibility === 'public'
      && resolvedVisibility.source === 'series-default';
    if (!scopeDenied) throw error;
    process.stderr.write('[newstune] 金鑰缺 publish:write scope，公開系列的預設 public 已降級為 private 重試。'
      + `之後可換用含 publish:write 的金鑰並執行 publish --project ${slug} --episode <n> 補發佈。\n`);
    resolvedVisibility.visibility = 'private';
    resolvedVisibility.source = 'scope-fallback';
    queued = await apiRequest(
      credentials,
      'POST',
      `/api/v1/series/${encodeURIComponent(podcast.seriesId)}/episodes`,
      { ...requestBody, visibility: 'private' },
      { 'Idempotency-Key': `episode-journal-${slug}-${Date.now()}` },
    );
  }
  if (!queued?.jobId) {
    const error = new Error('後端未回傳 jobId，無法追蹤集數生成。');
    error.body = queued;
    throw error;
  }

  const job = await pollJob(credentials, queued.jobId, timeoutMs);
  const episodeNumberRaw = queued.episodeNumber ?? job?.result?.episodeNumber;
  const episodeNumber = Number.isFinite(Number(episodeNumberRaw)) && episodeNumberRaw !== null && episodeNumberRaw !== undefined
    ? Number(episodeNumberRaw)
    : null;
  const publicSlug = asString(queued.publicSlug || job?.result?.publicSlug || job?.result?.episode?.publicSlug) || null;
  if (resolvedVisibility.visibility === 'public' && !publicSlug) {
    process.stderr.write('[newstune] 後端尚未回傳本集 publicSlug（公開系列會在 audio_ready 後自動配發）。'
      + `之後可執行：node ${scriptPath} publish --project ${slug} --episode ${episodeNumber ?? '<n>'} 取得公開連結。\n`);
  }
  const nowIso = new Date().toISOString();

  const ledgerPath = path.join(projectDir, 'ledger.json');
  const ledger = readJsonFile(ledgerPath, null) || { episodes: [], lastCoveredAt: null };
  if (!Array.isArray(ledger.episodes)) ledger.episodes = [];
  ledger.episodes.push({
    episodeNumber,
    title,
    summary,
    highlights: topics,
    topics,
    jobId: String(queued.jobId),
    createdAt: nowIso,
    visibility: resolvedVisibility.visibility,
    ...(publicSlug ? { publicSlug } : {}),
  });
  ledger.lastCoveredAt = nowIso;
  writeJsonFile(ledgerPath, ledger);

  podcast.lastCoveredAt = nowIso;
  writeJsonFile(podcastPath, podcast);

  const entryPath = writeProgressEntry(projectDir, {
    seriesId: podcast.seriesId,
    episodeNumber,
    title,
    summary,
    topics,
    jobId: String(queued.jobId),
    nowIso,
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    project: slug,
    seriesId: podcast.seriesId,
    episodeNumber,
    episodeId: queued.episodeId ?? job?.result?.episodeId ?? null,
    jobId: String(queued.jobId),
    jobStatus: job.status,
    title,
    summary,
    topics,
    visibility: resolvedVisibility.visibility,
    visibilitySource: resolvedVisibility.source,
    publicSlug,
    publicUrl: resolvedVisibility.visibility === 'public'
      ? buildEpisodePublicUrl(podcast.seriesSnapshot?.language, publicSlug)
      : null,
    lastCoveredAt: nowIso,
    ledgerPath,
    entryPath,
  }, null, 2)}\n`);
}

async function runPublish(args) {
  const { slug, projectDir } = resolveProjectDir(args.project);
  const credentials = requireCredentials();
  const { podcast } = loadPodcastConfig(projectDir, slug);

  const episodeRaw = args.episode;
  const episodeNumber = Number(episodeRaw === true ? NaN : episodeRaw);
  if (!Number.isInteger(episodeNumber) || episodeNumber <= 0) {
    throw new Error('--episode 為必填，且必須是正整數（集數）。');
  }
  // parseArgs consumes a following token as the flag's value, so a typo like
  // `--private true` would otherwise silently PUBLISH. Accept only the bare
  // flag or an explicit true/false.
  let visibility = 'public';
  if (args.private !== undefined) {
    if (args.private === true || args.private === 'true') visibility = 'private';
    else if (args.private === 'false') visibility = 'public';
    else throw new Error('「--private」不接受其他值（直接寫 --private 即可）。');
  }

  let response;
  try {
    response = await apiRequest(
      credentials,
      'PATCH',
      `/api/v1/series/${encodeURIComponent(podcast.seriesId)}/episodes/${episodeNumber}/visibility`,
      { visibility },
    );
  } catch (error) {
    if (!isEndpointGap(error)) throw error;
    // Same 404-degradation convention as bind/collect: a 404 means the backend
    // deploy with this PATCH endpoint has not landed yet — degrade, don't fail.
    process.stderr.write('[newstune] 後端尚未部署 PATCH /api/v1/series/:id/episodes/:n/visibility（404 或無法連線）。'
      + '等後端部署後重跑同一指令即可。\n');
    process.stdout.write(`${JSON.stringify({
      ok: false,
      degraded: true,
      reason: 'ENDPOINT_NOT_DEPLOYED',
      // After the deploy lands, a 404 here can also mean EPISODE_NOT_FOUND /
      // SERIES_NOT_FOUND — surface the upstream error code so both stay distinguishable.
      upstreamError: asString(error?.body?.error) || null,
      project: slug,
      seriesId: podcast.seriesId,
      episodeNumber,
      requestedVisibility: visibility,
    }, null, 2)}\n`);
    return;
  }

  const episode = response?.episode && typeof response.episode === 'object' ? response.episode : {};
  const resultVisibility = normalizeVisibility(episode.visibility) || visibility;
  const publicSlug = asString(episode.publicSlug) || null;
  const publicUrl = resultVisibility === 'public'
    ? buildEpisodePublicUrl(podcast.seriesSnapshot?.language, publicSlug)
    : null;
  if (resultVisibility === 'public' && !publicSlug) {
    process.stderr.write('[newstune] 本集已設為 public，但 publicSlug 尚未配發（公開系列會在 audio_ready 後自動配發）。'
      + '稍後重跑 publish 取得公開連結。\n');
  }

  // Always sync the ledger — unpublish (visibility=private, slug null) must
  // also land, otherwise the entry keeps a stale "public" state.
  {
    const ledgerPath = path.join(projectDir, 'ledger.json');
    const ledger = readJsonFile(ledgerPath, null);
    if (ledger && Array.isArray(ledger.episodes)) {
      let updated = false;
      for (const entry of ledger.episodes) {
        if (Number(entry?.episodeNumber) === episodeNumber) {
          entry.visibility = resultVisibility;
          if (publicSlug) entry.publicSlug = publicSlug;
          else if (resultVisibility === 'private') delete entry.publicSlug;
          updated = true;
        }
      }
      if (updated) writeJsonFile(ledgerPath, ledger);
    }
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    project: slug,
    seriesId: podcast.seriesId,
    episodeNumber: Number.isFinite(Number(episode.episodeNumber)) ? Number(episode.episodeNumber) : episodeNumber,
    visibility: resultVisibility,
    publicSlug,
    publicUrl,
    status: asString(episode.status) || null,
  }, null, 2)}\n`);
}

function runStatus(args) {
  const { slug, projectDir } = resolveProjectDir(args.project);
  const podcast = readJsonFile(path.join(projectDir, 'podcast.json'), null);
  const ledger = readJsonFile(path.join(projectDir, 'ledger.json'), null);
  const episodes = Array.isArray(ledger?.episodes) ? ledger.episodes : [];
  process.stdout.write(`${JSON.stringify({
    ok: true,
    project: slug,
    projectDir,
    bound: Boolean(podcast && String(podcast.seriesId || '').trim()),
    podcast: podcast ?? null,
    ledger: {
      episodeCount: episodes.length,
      lastCoveredAt: ledger?.lastCoveredAt ?? podcast?.lastCoveredAt ?? null,
      latestEpisodes: episodes
        .slice()
        .sort((a, b) => Number(b?.episodeNumber || 0) - Number(a?.episodeNumber || 0))
        .slice(0, 5),
    },
  }, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || '';
  if (command === 'help' || args.help === true) usage(0);
  if (!command) usage(1);
  if (command === 'bind') return runBind(args);
  if (command === 'collect') return runCollect(args);
  if (command === 'submit') return runSubmit(args);
  if (command === 'publish') return runPublish(args);
  if (command === 'status') return runStatus(args);
  usage(1);
}

if (scriptPath === path.resolve(process.argv[1] || '')) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    if (error?.body) console.error(JSON.stringify(error.body, null, 2));
    process.exit(1);
  });
}
