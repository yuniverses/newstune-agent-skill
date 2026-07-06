#!/usr/bin/env node

// Background journal judge/writer (spec B3). Spawned detached by
// journal_gate.mjs. Assembles session context, asks the configured LLM engine
// whether the session is worth recording, writes the entry file plus
// project.md, and reports back to the gate via mark-recorded/mark-skipped.
// This process must never crash loudly: every failure is logged and exits 0.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);

const DEFAULT_ENGINE_TIMEOUT_MS = 5 * 60 * 1000;
const TRANSCRIPT_TAIL_BYTES = 30000;
const ENTRY_TYPES = new Set(['decision', 'pivot', 'milestone', 'progress', 'incident']);

// Same charset journal_gate.mjs enforces: no path separators or dots, so a
// slug can never write outside the journal root or projects dir.
const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// Two-stage judgment prompt (zh-TW), per spec B3. The runtime context is
// appended below this constant before the engine call.
const JUDGMENT_PROMPT = `你是一個工程專案日誌的判斷與撰寫助手。以下提供某個專案最近一次工作 session 的脈絡（對話節錄、git 紀錄、既有日誌）。請執行兩階段任務：

第一階段——判斷這次 session 是否值得寫入專案日誌：
- 值得記錄：方向性或架構決策、技術選型轉向與其原因、里程碑（功能完成、部署、發布）、重大踩坑與其根因、範圍或產品決策的變化。
- 不值得記錄：例行小修小補、純問答或查資料、沒有結論的進行中工作。

第二階段——輸出結果。只輸出一個 JSON 物件，不要輸出任何其他文字，也不要使用 markdown code fence：
- 值得記錄時輸出：
{"record": true, "entry": {"type": "decision|pivot|milestone|progress|incident 擇一", "title": "簡短具體的標題", "why": "為什麼做這個決定或發生這件事", "impact": "對專案的影響", "refs": ["相關 commit hash"], "tags": ["主題標籤"], "body": "以繁體中文撰寫的 markdown 正文，2 至 6 段，記錄脈絡、決策內容、取捨與後續事項"}, "projectConcept": "（僅在脈絡顯示 project.md 不存在時提供此欄位）以繁體中文撰寫的專案概念說明 markdown，包含專案目的、技術棧、目前狀態"}
- 不值得記錄時輸出：
{"record": false, "reason": "一句話說明為何不記"}

規則：
- title 必須具體（例如「改用 launchd 取代 cron 排程」，而非「更新程式碼」）。
- refs 只放脈絡中真實出現的 commit hash；沒有就給空陣列。
- 若脈絡中已包含 project.md 內容，省略 projectConcept 欄位。`;

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
  stream.write(`NewsTune 專案日誌判斷層（journal record，通常由 journal_gate 在背景啟動）

用法：
  node scripts/journal_record.mjs --project <slug> --cwd <path> --transcript <path>

選項：
  --engine claude|codex   覆寫 config.json 的判斷引擎
  --engine-cmd "<cmd>"    覆寫整個引擎指令（除錯／測試用；prompt 會附為最後一個參數）
  --timeout-ms N          引擎逾時，預設 300000

環境變數：
  NEWSTUNE_AGENT_CONFIG_DIR     config 目錄（預設 ~/.config/newstune-agent）
  NEWSTUNE_JOURNAL_ROOT         覆寫 config 的 journalRoot
  NEWSTUNE_RECORD_ENGINE_CMD    等同 --engine-cmd
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

function appendLog(line) {
  try {
    const logsDir = path.join(getConfigDir(), 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(path.join(logsDir, 'journal.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Never let logging break the background process.
  }
}

function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function loadConfig() {
  const raw = readJsonFile(path.join(getConfigDir(), 'config.json'));
  if (!raw) return null;
  return {
    engine: raw.engine === 'codex' ? 'codex' : 'claude',
    journalRoot: process.env.NEWSTUNE_JOURNAL_ROOT || String(raw.journalRoot || ''),
  };
}

function loadProjectState(slug) {
  return readJsonFile(path.join(getConfigDir(), 'projects', `${slug}.state.json`)) || {};
}

// --- context assembly -------------------------------------------------------

function readTranscriptTail(transcriptPath, maxBytes = TRANSCRIPT_TAIL_BYTES) {
  const stat = fs.statSync(transcriptPath);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function extractTextBlocks(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block.text === 'string') return block.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

// Lenient jsonl reader: works with Claude Code transcripts and Codex rollout
// files; falls back to the raw tail when no structured turns are found.
function extractConversation(rawTail) {
  const turns = [];
  for (const line of rawTail.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const candidates = [obj?.message, obj?.payload, obj];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      let role = candidate.role;
      if (role !== 'user' && role !== 'assistant' && (obj?.type === 'user' || obj?.type === 'assistant')) {
        role = obj.type;
      }
      if (role !== 'user' && role !== 'assistant') continue;
      const text = extractTextBlocks(candidate.content).trim();
      if (text) turns.push(`${role}: ${text}`);
      break;
    }
  }
  if (!turns.length) return rawTail.slice(-15000);
  return turns.join('\n\n').slice(-25000);
}

function collectGitLog(cwd, sinceIso) {
  const args = ['-C', cwd, 'log', '--stat', '--format=%h %ad %s', '--date=short'];
  if (sinceIso) args.push(`--since=${sinceIso}`);
  else args.push('-n', '20');
  const res = spawnSync('git', args, { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  if (res.status !== 0) return '';
  return String(res.stdout || '').slice(0, 8000);
}

function readRecentEntries(entriesDir, count = 2) {
  let files = [];
  try {
    files = fs
      .readdirSync(entriesDir)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, count);
  } catch {
    return [];
  }
  const chunks = [];
  for (const name of files) {
    try {
      chunks.push(`### ${name}\n${fs.readFileSync(path.join(entriesDir, name), 'utf8')}`);
    } catch {
      // Skip unreadable entries.
    }
  }
  return chunks;
}

function buildContext({ cwd, transcriptPath, projectDir, sinceIso }) {
  const projectMdPath = path.join(projectDir, 'project.md');
  let projectMd = null;
  try {
    projectMd = fs.readFileSync(projectMdPath, 'utf8');
  } catch {
    projectMd = null;
  }
  const recentEntries = readRecentEntries(path.join(projectDir, 'entries'));
  const gitLog = collectGitLog(cwd, sinceIso);
  const conversation = extractConversation(readTranscriptTail(transcriptPath));

  const sections = [
    '=== 脈絡開始 ===',
    '## project.md（既有專案概念）',
    projectMd ? projectMd.slice(0, 6000) : '（project.md 不存在——若判定值得記錄，請提供 projectConcept 欄位）',
    '## 最近的日誌 entries（最多 2 則）',
    recentEntries.length ? recentEntries.join('\n\n') : '（尚無任何 entry）',
    `## git log（${sinceIso ? `自上次記錄 ${sinceIso} 以來` : '最近 20 筆'}）`,
    gitLog || '（無 git 紀錄或此目錄不是 git repo）',
    '## session 對話節錄（結尾段）',
    conversation,
    '=== 脈絡結束 ===',
  ];
  return { context: sections.join('\n\n'), projectMdExists: projectMd !== null };
}

// --- engine dispatch --------------------------------------------------------

function runEngine({ engine, engineCmd, prompt, timeoutMs }) {
  const env = { ...process.env, NEWSTUNE_JOURNAL_SKIP: '1' };
  const spawnOptions = { encoding: 'utf8', env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 };

  if (engineCmd) {
    const parts = String(engineCmd).split(/\s+/).filter(Boolean);
    if (!parts.length) throw new Error('engine-cmd 是空字串');
    const res = spawnSync(parts[0], [...parts.slice(1), prompt], spawnOptions);
    if (res.error) throw res.error;
    if (res.status !== 0) throw new Error(`engine-cmd 結束碼 ${res.status}：${String(res.stderr || '').slice(0, 500)}`);
    return String(res.stdout || '');
  }

  if (engine === 'codex') {
    const tmpFile = path.join(os.tmpdir(), `newstune-journal-${process.pid}-${Date.now()}.txt`);
    try {
      const res = spawnSync(
        'codex',
        ['exec', '--skip-git-repo-check', '-s', 'read-only', '--output-last-message', tmpFile, prompt],
        spawnOptions,
      );
      if (res.error) throw res.error;
      let out = '';
      try {
        out = fs.readFileSync(tmpFile, 'utf8');
      } catch {
        out = '';
      }
      if (!out && res.status !== 0) throw new Error(`codex exec 結束碼 ${res.status}：${String(res.stderr || '').slice(0, 500)}`);
      return out || String(res.stdout || '');
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // tmpfile may not exist.
      }
    }
  }

  const res = spawnSync('claude', ['--bare', '-p', prompt], spawnOptions);
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`claude 結束碼 ${res.status}：${String(res.stderr || '').slice(0, 500)}`);
  return String(res.stdout || '');
}

// Lenient parse: find the first balanced JSON object anywhere in the output.
export function extractFirstJsonObject(text) {
  const s = String(text || '');
  for (let start = s.indexOf('{'); start !== -1; start = s.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < s.length; i += 1) {
      const ch = s[i];
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
            return JSON.parse(s.slice(start, i + 1));
          } catch {
            break; // Malformed candidate; try the next opening brace.
          }
        }
      }
    }
  }
  return null;
}

// --- entry writing ----------------------------------------------------------

function kebabTitle(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'entry';
}

function yamlScalar(value) {
  return JSON.stringify(String(value ?? ''));
}

function yamlStringList(values) {
  const list = Array.isArray(values) ? values : [];
  return `[${list.map((v) => JSON.stringify(String(v))).join(', ')}]`;
}

function writeEntryFile(projectDir, entry) {
  const entriesDir = path.join(projectDir, 'entries');
  fs.mkdirSync(entriesDir, { recursive: true });
  const dateKey = localDateKey();
  const base = `${dateKey}_${kebabTitle(entry.title)}`;
  let fileName = `${base}.md`;
  for (let n = 2; fs.existsSync(path.join(entriesDir, fileName)); n += 1) {
    fileName = `${base}-${n}.md`;
  }
  const type = ENTRY_TYPES.has(entry.type) ? entry.type : 'progress';
  const frontmatter = [
    '---',
    `date: ${dateKey}`,
    `type: ${type}`,
    `title: ${yamlScalar(entry.title)}`,
    `why: ${yamlScalar(entry.why)}`,
    `impact: ${yamlScalar(entry.impact)}`,
    `refs: ${yamlStringList(entry.refs)}`,
    `tags: ${yamlStringList(entry.tags)}`,
    '---',
  ].join('\n');
  const body = String(entry.body || '').trim();
  const filePath = path.join(entriesDir, fileName);
  fs.writeFileSync(filePath, `${frontmatter}\n\n${body}\n`);
  return filePath;
}

function maybeWriteProjectMd(projectDir, projectConcept) {
  const projectMdPath = path.join(projectDir, 'project.md');
  if (fs.existsSync(projectMdPath)) return null;
  const concept = String(projectConcept || '').trim();
  if (!concept) return null;
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(projectMdPath, `${concept}\n`);
  return projectMdPath;
}

function callGate(subcommand, slug) {
  const gateScript = path.join(scriptDir, 'journal_gate.mjs');
  const res = spawnSync(process.execPath, [gateScript, subcommand, '--project', slug], {
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 15000,
  });
  if (res.status !== 0) {
    appendLog(`[record] warn project=${slug} 呼叫 gate ${subcommand} 失敗（結束碼 ${res.status}）`);
    return false;
  }
  return true;
}

// --- main -------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._[0] === 'help' || args.help) usage(0);

  const slug = String(args.project || '').trim();
  const cwd = String(args.cwd || '').trim();
  const transcriptPath = String(args.transcript || '').trim();
  if (!slug || !cwd || !transcriptPath) {
    appendLog('[record] error 原因：缺少 --project / --cwd / --transcript 參數');
    console.error(JSON.stringify({ error: '缺少 --project / --cwd / --transcript 參數' }));
    process.exit(0);
  }
  if (!SAFE_SLUG_RE.test(slug)) {
    appendLog(`[record] error 原因：不合法的 project slug（${slug}）`);
    console.error(JSON.stringify({ error: `不合法的 slug（僅接受小寫英數與連字號）：${slug}` }));
    process.exit(0);
  }

  // Release the gate's in-flight lock on every exit path — the 'exit' event
  // also fires on explicit process.exit() calls, unlike a finally block.
  process.on('exit', () => {
    try {
      fs.unlinkSync(path.join(getConfigDir(), 'projects', `${slug}.lock`));
    } catch {
      // No lock on manual invocation — fine.
    }
  });

  appendLog(`[record] start project=${slug} cwd=${cwd}`);

  const config = loadConfig();
  if (!config) {
    appendLog(`[record] error project=${slug} 原因：config.json 不存在或無法解析`);
    process.exit(0);
  }
  if (!config.journalRoot) {
    appendLog(`[record] error project=${slug} 原因：journalRoot 未設定`);
    process.exit(0);
  }

  const projectDir = path.join(config.journalRoot, slug);
  const state = loadProjectState(slug);
  const sinceIso = typeof state.lastRecordedAt === 'string' ? state.lastRecordedAt : null;

  const { context } = buildContext({ cwd, transcriptPath, projectDir, sinceIso });
  const prompt = `${JUDGMENT_PROMPT}\n\n${context}`;

  const engine = args.engine === 'codex' || args.engine === 'claude' ? args.engine : config.engine;
  const engineCmd = args['engine-cmd'] || process.env.NEWSTUNE_RECORD_ENGINE_CMD || '';
  const timeoutMs = Number(args['timeout-ms'] || DEFAULT_ENGINE_TIMEOUT_MS);

  const output = runEngine({ engine, engineCmd, prompt, timeoutMs });
  const result = extractFirstJsonObject(output);
  if (!result || typeof result.record !== 'boolean') {
    appendLog(`[record] error project=${slug} 原因：引擎輸出無法解析為判斷 JSON（前 200 字：${String(output).slice(0, 200).replace(/\s+/g, ' ')}）`);
    process.exit(0);
  }

  if (!result.record) {
    callGate('mark-skipped', slug);
    appendLog(`[record] judge-skip project=${slug} 原因：${String(result.reason || '（引擎未提供原因）').slice(0, 300)}`);
    console.log(JSON.stringify({ ok: true, project: slug, recorded: false, reason: result.reason || null }, null, 2));
    return;
  }

  const entry = result.entry && typeof result.entry === 'object' ? result.entry : null;
  if (!entry || !String(entry.title || '').trim()) {
    appendLog(`[record] error project=${slug} 原因：record=true 但 entry 缺 title`);
    process.exit(0);
  }

  const entryPath = writeEntryFile(projectDir, entry);
  const projectMdPath = maybeWriteProjectMd(projectDir, result.projectConcept);
  callGate('mark-recorded', slug);
  appendLog(`[record] recorded project=${slug} entry=${entryPath}${projectMdPath ? ` projectMd=${projectMdPath}` : ''}`);
  console.log(JSON.stringify({ ok: true, project: slug, recorded: true, entryPath, projectMdPath }, null, 2));
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
    // Background process: fail silent-but-logged, never crash to the console.
    appendLog(`[record] error ${error?.message || String(error)}`);
    try {
      console.error(JSON.stringify({ error: error?.message || String(error) }));
    } catch {
      // stderr is usually ignored anyway (spawned with stdio: 'ignore').
    }
    process.exit(0);
  });
}
