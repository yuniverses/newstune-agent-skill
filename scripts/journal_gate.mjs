#!/usr/bin/env node

// Deterministic journal gate (spec B2). Runs as a Stop hook: reads the hook
// payload from stdin, applies fast local checks (no network, no LLM, <100ms),
// and either silently skips (logging the reason) or spawns journal_record.mjs
// detached. Also exposes state subcommands used by the record layer.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);

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
  stream.write(`NewsTune 專案日誌閘門（journal gate）

用法：
  node scripts/journal_gate.mjs                      # 預設模式：從 stdin 讀 hook JSON（Stop hook 用）
  node scripts/journal_gate.mjs status [--json]      # 顯示 config 與各專案狀態
  node scripts/journal_gate.mjs mark-recorded --project <slug>
  node scripts/journal_gate.mjs mark-skipped --project <slug>

環境變數：
  NEWSTUNE_AGENT_CONFIG_DIR    config 目錄（預設 ~/.config/newstune-agent）
  NEWSTUNE_JOURNAL_SKIP=1      防遞迴：設定時閘門一律跳過
  NEWSTUNE_GATE_RECORD_SCRIPT  覆寫要 spawn 的 record 腳本路徑（測試用）
`);
  process.exit(exitCode);
}

function getConfigDir() {
  return process.env.NEWSTUNE_AGENT_CONFIG_DIR || path.join(os.homedir(), '.config', 'newstune-agent');
}

function readJsonFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function loadConfig() {
  const raw = readJsonFile(path.join(getConfigDir(), 'config.json'));
  if (!raw) return null;
  const num = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
  return {
    enabled: raw.enabled === true,
    journalRoot: process.env.NEWSTUNE_JOURNAL_ROOT || String(raw.journalRoot || ''),
    engine: raw.engine === 'codex' ? 'codex' : 'claude',
    cooldownHours: num(raw.cooldownHours, 4),
    maxPerDay: num(raw.maxPerDay, 3),
    minTranscriptBytes: num(raw.minTranscriptBytes, 20000),
  };
}

function appendLog(line) {
  try {
    const logsDir = path.join(getConfigDir(), 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(path.join(logsDir, 'journal.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging must never break the gate.
  }
}

function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function kebabCase(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function deriveProjectSlug(cwd) {
  const remote = spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 3000 });
  if (remote.status === 0) {
    const url = String(remote.stdout || '').trim();
    const tail = url.split(/[/:]/).filter(Boolean).pop() || '';
    const name = kebabCase(tail.replace(/\.git$/i, ''));
    if (name) return name;
  }
  const hash = crypto.createHash('sha256').update(String(cwd)).digest('hex').slice(0, 6);
  const base = kebabCase(path.basename(String(cwd))) || 'project';
  return `${base}-${hash}`;
}

function projectStatePath(slug) {
  return path.join(getConfigDir(), 'projects', `${slug}.state.json`);
}

// Matches everything deriveProjectSlug can produce; excludes path separators
// and dots, so a slug can never escape the projects/ or journal directories.
const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

const IN_FLIGHT_LOCK_STALE_MS = 15 * 60 * 1000;

function inFlightLockPath(slug) {
  return path.join(getConfigDir(), 'projects', `${slug}.lock`);
}

// Atomic create ('wx'). A fresh lock means a record run is already in flight
// for this project — Stop and the git-commit PostToolUse hook can both fire in
// one session, and cooldown state only updates after the judge finishes, so
// without this lock both would spawn a judge. Stale locks (record crashed
// before releasing) expire after IN_FLIGHT_LOCK_STALE_MS.
function acquireInFlightLock(slug) {
  const lockPath = inFlightLockPath(slug);
  const payload = `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`;
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, payload, { flag: 'wx' });
    return true;
  } catch (error) {
    if (!error || error.code !== 'EEXIST') return false;
  }
  try {
    if (Date.now() - fs.statSync(lockPath).mtimeMs < IN_FLIGHT_LOCK_STALE_MS) return false;
    fs.unlinkSync(lockPath);
    fs.writeFileSync(lockPath, payload, { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function loadProjectState(slug) {
  const raw = readJsonFile(projectStatePath(slug)) || {};
  return {
    lastRecordedAt: typeof raw.lastRecordedAt === 'string' ? raw.lastRecordedAt : null,
    lastSkippedAt: typeof raw.lastSkippedAt === 'string' ? raw.lastSkippedAt : null,
    dateCounts: raw.dateCounts && typeof raw.dateCounts === 'object' ? raw.dateCounts : {},
  };
}

function saveProjectState(slug, state) {
  const filePath = projectStatePath(slug);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function pruneDateCounts(dateCounts, keepDays = 14) {
  const cutoff = localDateKey(new Date(Date.now() - keepDays * 24 * 3600 * 1000));
  for (const key of Object.keys(dateCounts)) {
    if (key < cutoff) delete dateCounts[key];
  }
}

function readStdinText() {
  try {
    if (process.stdin.isTTY) return '';
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Tolerates both Claude Code and Codex stop payload shapes; missing fields fall back.
function parseHookPayload(text) {
  let payload = {};
  try {
    payload = JSON.parse(text);
  } catch {
    payload = {};
  }
  if (!payload || typeof payload !== 'object') payload = {};
  return {
    cwd: String(payload.cwd || payload.workspace_root || payload.working_directory || process.cwd()),
    transcriptPath: String(payload.transcript_path || payload.transcriptPath || payload.transcript || payload.rollout_path || ''),
    sessionId: String(payload.session_id || payload.sessionId || payload.thread_id || ''),
  };
}

function gateSkip(reason) {
  appendLog(`[gate] skip ${reason}`);
  process.exit(0);
}

function runGate() {
  // 1. Config exists and enabled.
  const configDirExists = fs.existsSync(getConfigDir());
  const config = loadConfig();
  if (!config) {
    // No config at all: stay fully silent unless the config dir already exists.
    if (configDirExists) appendLog('[gate] skip 原因：config.json 不存在或無法解析');
    process.exit(0);
  }
  if (!config.enabled) gateSkip('原因：journal 功能已停用（enabled=false）');

  // 2. Recursion guard.
  if (process.env.NEWSTUNE_JOURNAL_SKIP === '1') gateSkip('原因：NEWSTUNE_JOURNAL_SKIP=1（防遞迴）');

  // 3. Resolve cwd and derive the project slug.
  const payload = parseHookPayload(readStdinText());
  const cwd = payload.cwd;
  let cwdIsDir = false;
  try {
    cwdIsDir = fs.statSync(cwd).isDirectory();
  } catch {
    cwdIsDir = false;
  }
  if (!cwdIsDir) gateSkip(`原因：cwd 不存在或不是資料夾（${cwd}）`);
  const slug = deriveProjectSlug(cwd);

  // 4. Transcript exists and is large enough.
  if (!payload.transcriptPath) gateSkip(`project=${slug} 原因：hook payload 缺 transcript 路徑`);
  let transcriptSize = -1;
  try {
    transcriptSize = fs.statSync(payload.transcriptPath).size;
  } catch {
    transcriptSize = -1;
  }
  if (transcriptSize < 0) gateSkip(`project=${slug} 原因：transcript 檔不存在（${payload.transcriptPath}）`);
  if (transcriptSize < config.minTranscriptBytes) {
    gateSkip(`project=${slug} 原因：transcript 太小（${transcriptSize} < ${config.minTranscriptBytes} bytes）`);
  }

  // 5. Cooldowns (full cooldown after a record, half after a judged skip).
  const state = loadProjectState(slug);
  const now = Date.now();
  const cooldownMs = config.cooldownHours * 3600 * 1000;
  const recordedAt = state.lastRecordedAt ? Date.parse(state.lastRecordedAt) : NaN;
  if (Number.isFinite(recordedAt) && now - recordedAt < cooldownMs) {
    gateSkip(`project=${slug} 原因：冷卻中（距上次記錄 ${Math.round((now - recordedAt) / 60000)} 分鐘 < ${config.cooldownHours} 小時）`);
  }
  const skippedAt = state.lastSkippedAt ? Date.parse(state.lastSkippedAt) : NaN;
  if (Number.isFinite(skippedAt) && now - skippedAt < cooldownMs / 2) {
    gateSkip(`project=${slug} 原因：略過後冷卻中（距上次判斷略過 ${Math.round((now - skippedAt) / 60000)} 分鐘 < ${config.cooldownHours / 2} 小時）`);
  }

  // 6. Daily cap.
  const todayCount = Number(state.dateCounts[localDateKey()] || 0);
  if (todayCount >= config.maxPerDay) {
    gateSkip(`project=${slug} 原因：已達當日上限（${todayCount}/${config.maxPerDay}）`);
  }

  // 7. In-flight lock (released by journal_record on exit, or by staleness).
  if (!acquireInFlightLock(slug)) {
    gateSkip(`project=${slug} 原因：已有 journal_record 進行中（in-flight lock）`);
  }

  // All checks passed: hand off to the background record layer and return immediately.
  const recordScript = process.env.NEWSTUNE_GATE_RECORD_SCRIPT || path.join(scriptDir, 'journal_record.mjs');
  const child = spawn(
    process.execPath,
    [recordScript, '--project', slug, '--cwd', cwd, '--transcript', payload.transcriptPath],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  appendLog(`[gate] pass project=${slug} transcriptBytes=${transcriptSize} → 已在背景啟動 journal_record`);
  process.exit(0);
}

function requireProject(args) {
  const slug = String(args.project || '').trim();
  if (!slug) {
    console.error(JSON.stringify({ error: '缺少 --project <slug>' }));
    process.exit(1);
  }
  if (!SAFE_SLUG_RE.test(slug)) {
    console.error(JSON.stringify({ error: `不合法的 slug（僅接受小寫英數與連字號）：${slug}` }));
    process.exit(1);
  }
  return slug;
}

function markRecorded(args) {
  const slug = requireProject(args);
  const state = loadProjectState(slug);
  const now = new Date();
  const key = localDateKey(now);
  state.lastRecordedAt = now.toISOString();
  state.dateCounts[key] = Number(state.dateCounts[key] || 0) + 1;
  pruneDateCounts(state.dateCounts);
  saveProjectState(slug, state);
  appendLog(`[gate] mark-recorded project=${slug} todayCount=${state.dateCounts[key]}`);
  console.log(JSON.stringify({ ok: true, project: slug, lastRecordedAt: state.lastRecordedAt, todayCount: state.dateCounts[key] }, null, 2));
}

function markSkipped(args) {
  const slug = requireProject(args);
  const state = loadProjectState(slug);
  state.lastSkippedAt = new Date().toISOString();
  pruneDateCounts(state.dateCounts);
  saveProjectState(slug, state);
  appendLog(`[gate] mark-skipped project=${slug}`);
  console.log(JSON.stringify({ ok: true, project: slug, lastSkippedAt: state.lastSkippedAt }, null, 2));
}

function listProjectStates() {
  const projectsDir = path.join(getConfigDir(), 'projects');
  let files = [];
  try {
    files = fs.readdirSync(projectsDir).filter((name) => name.endsWith('.state.json'));
  } catch {
    return [];
  }
  return files.map((name) => {
    const slug = name.replace(/\.state\.json$/, '');
    const state = loadProjectState(slug);
    return {
      slug,
      lastRecordedAt: state.lastRecordedAt,
      lastSkippedAt: state.lastSkippedAt,
      todayCount: Number(state.dateCounts[localDateKey()] || 0),
    };
  });
}

function statusCommand(args) {
  const config = loadConfig();
  const out = {
    configDir: getConfigDir(),
    configured: Boolean(config),
    enabled: config ? config.enabled : false,
    journalRoot: config ? config.journalRoot || null : null,
    engine: config ? config.engine : null,
    cooldownHours: config ? config.cooldownHours : null,
    maxPerDay: config ? config.maxPerDay : null,
    minTranscriptBytes: config ? config.minTranscriptBytes : null,
    projects: listProjectStates(),
  };
  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  const lines = [
    `config 目錄：${out.configDir}`,
    `已設定：${out.configured ? '是' : '否'}；啟用：${out.enabled ? '是' : '否'}`,
    `journal root：${out.journalRoot || '（未設定）'}；判斷引擎：${out.engine || '（未設定）'}`,
    `冷卻 ${out.cooldownHours ?? '-'} 小時；每日上限 ${out.maxPerDay ?? '-'}；transcript 門檻 ${out.minTranscriptBytes ?? '-'} bytes`,
    `專案數：${out.projects.length}`,
    ...out.projects.map((p) => `  - ${p.slug}：上次記錄 ${p.lastRecordedAt || '無'}；上次略過 ${p.lastSkippedAt || '無'}；今日 ${p.todayCount} 筆`),
  ];
  console.log(lines.join('\n'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || '';
  if (command === 'help' || args.help) usage(0);
  if (command === 'status') return statusCommand(args);
  if (command === 'mark-recorded') return markRecorded(args);
  if (command === 'mark-skipped') return markSkipped(args);
  if (command) usage(1);
  return runGate();
}

function isMainModule() {
  try {
    return scriptPath === fs.realpathSync(path.resolve(process.argv[1] || ''));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    // The gate runs inside a Stop hook: never fail loudly, never block the CLI.
    appendLog(`[gate] error ${error?.message || String(error)}`);
    process.exit(0);
  });
}
