#!/usr/bin/env node

// Install/uninstall/pause/resume/status/schedule/unschedule for the project
// journal subsystem (spec B4). Safely merges our hook entries into Claude Code
// settings.json and Codex hooks.json: entries are identified by the absolute
// path of journal_gate.mjs inside the command string, so install is idempotent
// and uninstall removes only our entries. Every modified file is backed up to
// <file>.bak-newstune first. All filesystem targets are overridable for tests.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const gateScriptPath = path.join(scriptDir, 'journal_gate.mjs');
const gateCommand = `node "${gateScriptPath}"`;

const CONFIG_DEFAULTS = { cooldownHours: 4, maxPerDay: 3, minTranscriptBytes: 20000 };
const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const PLIST_LABEL_PREFIX = 'com.newstune.podcast.';

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
  stream.write(`NewsTune 專案日誌安裝器（journal setup）

用法：
  node scripts/journal_setup.mjs install --journal-root <path> [--engine claude|codex] [--targets claude,codex]
  node scripts/journal_setup.mjs uninstall [--targets claude,codex]
  node scripts/journal_setup.mjs pause
  node scripts/journal_setup.mjs resume
  node scripts/journal_setup.mjs status
  node scripts/journal_setup.mjs schedule --project <slug> [--cadence weekly|daily] [--day sun] [--time 09:00] [--engine claude|codex] [--model opus] [--no-load]
  node scripts/journal_setup.mjs unschedule --project <slug> [--no-load]
  node scripts/journal_setup.mjs onboarding status      # 本機是否已完成首次介紹（含機器指紋比對）
  node scripts/journal_setup.mjs onboarding complete    # 標記本機已完成首次介紹

路徑覆寫（測試必用，避免碰真實設定檔）：
  --claude-settings-path <path>   預設 ~/.claude/settings.json
  --codex-hooks-path <path>       預設 ~/.codex/hooks.json
  --launch-agents-dir <path>      預設 ~/Library/LaunchAgents
  NEWSTUNE_AGENT_CONFIG_DIR       config 目錄（預設 ~/.config/newstune-agent）
  NEWSTUNE_SETUP_SKIP_LAUNCHCTL=1 等同 --no-load（不呼叫 launchctl）
`);
  process.exit(exitCode);
}

function fail(message) {
  console.error(JSON.stringify({ error: message }, null, 2));
  process.exit(1);
}

// Same charset journal_gate.mjs's deriveProjectSlug produces: no path
// separators or dots, so a slug can never escape the journal root, the
// LaunchAgents dir, or inject structure into the plist label.
const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function requireSafeSlug(args) {
  const slug = String(args.project || '').trim();
  if (!slug) fail('缺少 --project <slug>');
  if (!SAFE_SLUG_RE.test(slug)) fail(`不合法的 --project slug（僅接受小寫英數與連字號）：${slug}`);
  return slug;
}

function expandHome(value) {
  const str = String(value || '');
  if (str === '~') return os.homedir();
  if (str.startsWith('~/')) return path.join(os.homedir(), str.slice(2));
  return str;
}

function getConfigDir() {
  return process.env.NEWSTUNE_AGENT_CONFIG_DIR || path.join(os.homedir(), '.config', 'newstune-agent');
}

function getConfigPath() {
  return path.join(getConfigDir(), 'config.json');
}

function getClaudeSettingsPath(args) {
  return path.resolve(expandHome(args['claude-settings-path'] || path.join(os.homedir(), '.claude', 'settings.json')));
}

function getCodexHooksPath(args) {
  return path.resolve(expandHome(args['codex-hooks-path'] || path.join(os.homedir(), '.codex', 'hooks.json')));
}

function getLaunchAgentsDir(args) {
  return path.resolve(expandHome(args['launch-agents-dir'] || path.join(os.homedir(), 'Library', 'LaunchAgents')));
}

function shouldSkipLaunchctl(args) {
  return Boolean(args['no-load']) || process.env.NEWSTUNE_SETUP_SKIP_LAUNCHCTL === '1';
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
    // Logging is best-effort.
  }
}

// Backs up the existing file to <file>.bak-newstune, then writes.
function writeJsonWithBackup(filePath, json) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let backup = null;
  if (fs.existsSync(filePath)) {
    backup = `${filePath}.bak-newstune`;
    fs.copyFileSync(filePath, backup);
  }
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
  return backup;
}

function loadHooksTarget(filePath, label) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) return {};
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    fail(`${label} 不是有效的 JSON，為避免破壞既有設定已中止：${filePath}`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    fail(`${label} 的頂層不是 JSON 物件，已中止：${filePath}`);
  }
  return json;
}

function isOurHookItem(item) {
  return Boolean(item) && typeof item.command === 'string' && item.command.includes(gateScriptPath);
}

// Claude settings hooks: { hooks: { Stop: [ { matcher?, hooks: [ {type, command, ...} ] } ] } }
function claudeListHasOurs(list) {
  return (Array.isArray(list) ? list : []).some((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : []).some(isOurHookItem));
}

function claudeHookEntry(matcher) {
  return {
    ...(matcher !== undefined ? { matcher } : {}),
    hooks: [{ type: 'command', command: gateCommand, async: true, timeout: 10 }],
  };
}

function mergeClaudeSettings(settingsPath) {
  const json = loadHooksTarget(settingsPath, 'Claude settings.json');
  json.hooks = json.hooks && typeof json.hooks === 'object' && !Array.isArray(json.hooks) ? json.hooks : {};
  let changed = false;
  if (!claudeListHasOurs(json.hooks.Stop)) {
    json.hooks.Stop = Array.isArray(json.hooks.Stop) ? json.hooks.Stop : [];
    json.hooks.Stop.push(claudeHookEntry(undefined));
    changed = true;
  }
  if (!claudeListHasOurs(json.hooks.PostToolUse)) {
    json.hooks.PostToolUse = Array.isArray(json.hooks.PostToolUse) ? json.hooks.PostToolUse : [];
    json.hooks.PostToolUse.push(claudeHookEntry('Bash(git commit *)'));
    changed = true;
  }
  if (!changed) return { path: settingsPath, changed: false, backup: null };
  const backup = writeJsonWithBackup(settingsPath, json);
  return { path: settingsPath, changed: true, backup };
}

function removeFromClaudeSettings(settingsPath) {
  const json = readJsonFile(settingsPath);
  if (!json || !json.hooks || typeof json.hooks !== 'object') return { path: settingsPath, changed: false, removed: 0 };
  let removed = 0;
  for (const eventName of Object.keys(json.hooks)) {
    const list = json.hooks[eventName];
    if (!Array.isArray(list)) continue;
    json.hooks[eventName] = list
      .map((entry) => {
        if (!entry || !Array.isArray(entry.hooks)) return entry;
        const kept = entry.hooks.filter((item) => {
          if (isOurHookItem(item)) {
            removed += 1;
            return false;
          }
          return true;
        });
        if (kept.length === entry.hooks.length) return entry;
        return kept.length ? { ...entry, hooks: kept } : null;
      })
      .filter(Boolean);
  }
  if (!removed) return { path: settingsPath, changed: false, removed: 0 };
  const backup = writeJsonWithBackup(settingsPath, json);
  return { path: settingsPath, changed: true, removed, backup };
}

// Codex hooks: { hooks: { Stop: [ {type, command, ...} ] } } (flat command entries).
function codexListHasOurs(list) {
  return (Array.isArray(list) ? list : []).some(isOurHookItem);
}

function mergeCodexHooks(hooksPath) {
  const json = loadHooksTarget(hooksPath, 'Codex hooks.json');
  json.hooks = json.hooks && typeof json.hooks === 'object' && !Array.isArray(json.hooks) ? json.hooks : {};
  if (codexListHasOurs(json.hooks.Stop)) return { path: hooksPath, changed: false, backup: null };
  json.hooks.Stop = Array.isArray(json.hooks.Stop) ? json.hooks.Stop : [];
  json.hooks.Stop.push({ type: 'command', command: gateCommand, async: true, timeout: 10 });
  const backup = writeJsonWithBackup(hooksPath, json);
  return { path: hooksPath, changed: true, backup };
}

function removeFromCodexHooks(hooksPath) {
  const json = readJsonFile(hooksPath);
  if (!json || !json.hooks || typeof json.hooks !== 'object') return { path: hooksPath, changed: false, removed: 0 };
  let removed = 0;
  for (const eventName of Object.keys(json.hooks)) {
    const list = json.hooks[eventName];
    if (!Array.isArray(list)) continue;
    json.hooks[eventName] = list.filter((item) => {
      if (isOurHookItem(item)) {
        removed += 1;
        return false;
      }
      return true;
    });
  }
  if (!removed) return { path: hooksPath, changed: false, removed: 0 };
  const backup = writeJsonWithBackup(hooksPath, json);
  return { path: hooksPath, changed: true, removed, backup };
}

function parseTargets(args) {
  const targets = String(args.targets || 'claude,codex')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  for (const target of targets) {
    if (target !== 'claude' && target !== 'codex') fail(`不支援的 target：${target}（可用：claude, codex）`);
  }
  return targets;
}

// --- subcommands ------------------------------------------------------------

function installCommand(args) {
  const targets = parseTargets(args);
  const existing = readJsonFile(getConfigPath()) || {};
  const journalRootArg = args['journal-root'] ? path.resolve(expandHome(args['journal-root'])) : '';
  const journalRoot = journalRootArg || String(existing.journalRoot || '');
  if (!journalRoot) fail('首次安裝需要 --journal-root <path>');
  const engineArg = args.engine ? String(args.engine) : '';
  if (engineArg && engineArg !== 'claude' && engineArg !== 'codex') fail('--engine 只接受 claude 或 codex');
  const config = {
    enabled: existing.enabled === false ? false : true,
    journalRoot,
    engine: engineArg || (existing.engine === 'codex' ? 'codex' : 'claude'),
    cooldownHours: existing.cooldownHours ?? CONFIG_DEFAULTS.cooldownHours,
    maxPerDay: existing.maxPerDay ?? CONFIG_DEFAULTS.maxPerDay,
    minTranscriptBytes: existing.minTranscriptBytes ?? CONFIG_DEFAULTS.minTranscriptBytes,
  };
  fs.mkdirSync(path.join(getConfigDir(), 'projects'), { recursive: true });
  fs.mkdirSync(path.join(getConfigDir(), 'logs'), { recursive: true });
  fs.mkdirSync(journalRoot, { recursive: true });
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`);

  const hooks = {};
  if (targets.includes('claude')) hooks.claude = mergeClaudeSettings(getClaudeSettingsPath(args));
  if (targets.includes('codex')) hooks.codex = mergeCodexHooks(getCodexHooksPath(args));

  appendLog(`[setup] install targets=${targets.join(',')} journalRoot=${journalRoot} engine=${config.engine}`);
  console.log(JSON.stringify({ ok: true, configPath: getConfigPath(), config, gateCommand, hooks }, null, 2));
}

function uninstallCommand(args) {
  const targets = parseTargets(args);
  const hooks = {};
  if (targets.includes('claude')) hooks.claude = removeFromClaudeSettings(getClaudeSettingsPath(args));
  if (targets.includes('codex')) hooks.codex = removeFromCodexHooks(getCodexHooksPath(args));
  appendLog(`[setup] uninstall targets=${targets.join(',')}`);
  console.log(JSON.stringify({ ok: true, configKept: fs.existsSync(getConfigPath()), hooks }, null, 2));
}

function setEnabled(enabled) {
  const config = readJsonFile(getConfigPath());
  if (!config) fail(`找不到 config.json（${getConfigPath()}）——請先執行 install`);
  config.enabled = enabled;
  fs.writeFileSync(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
  appendLog(`[setup] ${enabled ? 'resume' : 'pause'}`);
  console.log(JSON.stringify({ ok: true, enabled }, null, 2));
}

function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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
    const state = readJsonFile(path.join(projectsDir, name)) || {};
    const dateCounts = state.dateCounts && typeof state.dateCounts === 'object' ? state.dateCounts : {};
    return {
      slug,
      lastRecordedAt: state.lastRecordedAt || null,
      lastSkippedAt: state.lastSkippedAt || null,
      todayCount: Number(dateCounts[localDateKey()] || 0),
    };
  });
}

function listSchedules(launchAgentsDir) {
  let files = [];
  try {
    files = fs.readdirSync(launchAgentsDir).filter((name) => name.startsWith(PLIST_LABEL_PREFIX) && name.endsWith('.plist'));
  } catch {
    return [];
  }
  return files.map((name) => ({
    slug: name.slice(PLIST_LABEL_PREFIX.length, -'.plist'.length),
    label: name.slice(0, -'.plist'.length),
    plist: path.join(launchAgentsDir, name),
  }));
}

function statusCommand(args) {
  const claudeSettingsPath = getClaudeSettingsPath(args);
  const codexHooksPath = getCodexHooksPath(args);
  const claudeJson = readJsonFile(claudeSettingsPath);
  const codexJson = readJsonFile(codexHooksPath);
  const out = {
    ok: true,
    configDir: getConfigDir(),
    config: readJsonFile(getConfigPath()),
    hooks: {
      claude: {
        path: claudeSettingsPath,
        exists: fs.existsSync(claudeSettingsPath),
        stopInstalled: claudeListHasOurs(claudeJson?.hooks?.Stop),
        postToolUseInstalled: claudeListHasOurs(claudeJson?.hooks?.PostToolUse),
      },
      codex: {
        path: codexHooksPath,
        exists: fs.existsSync(codexHooksPath),
        stopInstalled: codexListHasOurs(codexJson?.hooks?.Stop),
      },
    },
    projects: listProjectStates(),
    schedules: listSchedules(getLaunchAgentsDir(args)),
  };
  console.log(JSON.stringify(out, null, 2));
}

// --- launchd scheduling -----------------------------------------------------

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function resolveBinary(name) {
  const res = spawnSync('/usr/bin/which', [name], { encoding: 'utf8', timeout: 5000 });
  const resolved = String(res.stdout || '').trim().split('\n')[0];
  return resolved || name;
}

// Scheduled runs pin an explicit model (default 'sonnet'): without --model,
// claude -p uses the user's default model — often a top-tier one whose usage
// limit the nightly automation then silently burns through (observed: a 09:00
// run died with "You've reached your Fable 5 limit", exit 1, no episode).
const DEFAULT_SCHEDULE_MODEL = 'opus';

function buildScheduleProgramArguments(engine, slug, scheduleModel) {
  // zh-TW prompt: this is what the headless engine receives on each scheduled run.
  const prompt = `使用 newstune-agent-api skill，為專案「${slug}」執行排程集數流程：先用 scripts/episode_from_journal.mjs collect 收集素材，依 Continuity Contract 撰寫本集腳本，再用 submit 送出生成並輪詢到完成。排程模式規則：不要詢問使用者任何問題；若素材不足（自上期以來沒有值得成集的 entries 或 commits），跳過本期並將原因記錄到日誌。`;
  const engineArgs = engine === 'codex'
    ? [resolveBinary('codex'), 'exec', '--skip-git-repo-check', '--full-auto', prompt]
    : [resolveBinary('claude'), '-p', prompt, '--model', scheduleModel || DEFAULT_SCHEDULE_MODEL, '--dangerously-skip-permissions'];
  // Wrap in sh so a failing run surfaces as a macOS notification instead of
  // dying silently in the log (the user only notices when an episode never
  // appears). Engine args are passed positionally — nothing is interpolated
  // into the shell script, so prompt/slug content can't inject.
  const notifyScript = 'rc=0; "$@" || rc=$?; '
    + `if [ "$rc" -ne 0 ]; then /usr/bin/osascript -e "display notification \\"排程集數生成失敗（exit $rc）— 詳見 schedule.${slug}.err.log\\" with title \\"NewsTune 排程\\"" || true; fi; `
    + 'exit "$rc"';
  return ['/bin/sh', '-c', notifyScript, 'newstune-schedule', ...engineArgs];
}

function buildPlist({ label, programArguments, calendar, environment, workingDirectory, stdoutPath, stderrPath }) {
  const argStrings = programArguments.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n');
  const calendarEntries = Object.entries(calendar)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key><integer>${Number(value)}</integer>`)
    .join('\n');
  const envEntries = Object.entries(environment)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argStrings}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
${calendarEntries}
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>WorkingDirectory</key><string>${xmlEscape(workingDirectory)}</string>
  <key>StandardOutPath</key><string>${xmlEscape(stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(stderrPath)}</string>
</dict>
</plist>
`;
}

function parseTimeOption(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '09:00'));
  if (!match) fail('--time 格式必須是 HH:MM，例如 09:00');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) fail('--time 超出範圍（小時 0-23、分鐘 0-59）');
  return { hour, minute };
}

function scheduleCommand(args) {
  const slug = requireSafeSlug(args);
  const cadence = String(args.cadence || 'weekly');
  if (cadence !== 'weekly' && cadence !== 'daily') fail('--cadence 只接受 weekly 或 daily');
  const { hour, minute } = parseTimeOption(args.time);
  const calendar = { Hour: hour, Minute: minute };
  if (cadence === 'weekly') {
    const day = String(args.day || 'sun').toLowerCase();
    if (!(day in WEEKDAYS)) fail(`--day 只接受 ${Object.keys(WEEKDAYS).join('/')}`);
    calendar.Weekday = WEEKDAYS[day];
  }

  const config = readJsonFile(getConfigPath()) || {};
  const engineArg = args.engine ? String(args.engine) : '';
  if (engineArg && engineArg !== 'claude' && engineArg !== 'codex') fail('--engine 只接受 claude 或 codex');
  const engine = engineArg || (config.engine === 'codex' ? 'codex' : 'claude');
  const scheduleModel = String(args.model || config.scheduleModel || DEFAULT_SCHEDULE_MODEL);

  const journalRoot = process.env.NEWSTUNE_JOURNAL_ROOT || String(config.journalRoot || '');
  const workingDirectory = journalRoot ? path.join(journalRoot, slug) : os.homedir();
  if (journalRoot) fs.mkdirSync(workingDirectory, { recursive: true });

  const logsDir = path.join(getConfigDir(), 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const environment = {
    NEWSTUNE_JOURNAL_SKIP: '1',
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    ...(process.env.NEWSTUNE_AGENT_CONFIG_DIR ? { NEWSTUNE_AGENT_CONFIG_DIR: process.env.NEWSTUNE_AGENT_CONFIG_DIR } : {}),
    ...(process.env.NEWSTUNE_JOURNAL_ROOT ? { NEWSTUNE_JOURNAL_ROOT: process.env.NEWSTUNE_JOURNAL_ROOT } : {}),
  };

  const label = `${PLIST_LABEL_PREFIX}${slug}`;
  const launchAgentsDir = getLaunchAgentsDir(args);
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  const plistPath = path.join(launchAgentsDir, `${label}.plist`);
  const plist = buildPlist({
    label,
    programArguments: buildScheduleProgramArguments(engine, slug, scheduleModel),
    calendar,
    environment,
    workingDirectory,
    stdoutPath: path.join(logsDir, `schedule.${slug}.log`),
    stderrPath: path.join(logsDir, `schedule.${slug}.err.log`),
  });
  fs.writeFileSync(plistPath, plist);

  let loaded = 'skipped';
  if (!shouldSkipLaunchctl(args)) {
    const uid = process.getuid();
    // Unload any previous version first so re-schedule picks up the new plist.
    spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore', timeout: 15000 });
    const bootstrap = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { encoding: 'utf8', timeout: 15000 });
    if (bootstrap.status === 0) {
      loaded = 'bootstrap';
    } else {
      const load = spawnSync('launchctl', ['load', plistPath], { encoding: 'utf8', timeout: 15000 });
      loaded = load.status === 0 ? 'load' : 'failed';
    }
    if (loaded === 'failed') {
      appendLog(`[setup] schedule project=${slug} launchctl 載入失敗（plist 已寫入 ${plistPath}）`);
    }
  }

  appendLog(`[setup] schedule project=${slug} cadence=${cadence} engine=${engine} loaded=${loaded}`);
  console.log(JSON.stringify({ ok: loaded !== 'failed', project: slug, label, plist: plistPath, cadence, calendar, engine, loaded }, null, 2));
  if (loaded === 'failed') process.exit(1);
}

function unscheduleCommand(args) {
  const slug = requireSafeSlug(args);
  const label = `${PLIST_LABEL_PREFIX}${slug}`;
  const plistPath = path.join(getLaunchAgentsDir(args), `${label}.plist`);

  let unloaded = 'skipped';
  if (!shouldSkipLaunchctl(args)) {
    const uid = process.getuid();
    const bootout = spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { encoding: 'utf8', timeout: 15000 });
    if (bootout.status === 0) {
      unloaded = 'bootout';
    } else {
      const unload = spawnSync('launchctl', ['unload', plistPath], { encoding: 'utf8', timeout: 15000 });
      unloaded = unload.status === 0 ? 'unload' : 'not_loaded';
    }
  }

  let removed = false;
  try {
    fs.unlinkSync(plistPath);
    removed = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  appendLog(`[setup] unschedule project=${slug} unloaded=${unloaded} removed=${removed}`);
  console.log(JSON.stringify({ ok: true, project: slug, label, plist: plistPath, unloaded, removed }, null, 2));
}

// --- onboarding --------------------------------------------------------------

function getStatePath() {
  return path.join(getConfigDir(), 'state.json');
}

// Stable per-machine fingerprint. On macOS the IOPlatformUUID survives
// hostname changes; hostname is the fallback elsewhere. This is what lets the
// first-run introduction re-trigger when the config dir was migrated or
// synced from another computer instead of being created on this one.
function currentMachine() {
  let id = '';
  let model = '';
  if (process.platform === 'darwin') {
    const ioreg = spawnSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5000 });
    const match = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(String(ioreg.stdout || ''));
    if (match) id = match[1];
    const sysctl = spawnSync('sysctl', ['-n', 'hw.model'], { encoding: 'utf8', timeout: 5000 });
    if (sysctl.status === 0) model = String(sysctl.stdout || '').trim();
  }
  return {
    id: id || null,
    hostname: os.hostname(),
    model: model || null,
    platform: process.platform,
    osRelease: os.release(),
  };
}

// true/false when comparable; null for a legacy marker without machine info.
function isSameMachine(stored, current) {
  if (!stored || typeof stored !== 'object') return null;
  if (stored.id && current.id) return stored.id === current.id;
  return stored.hostname === current.hostname;
}

function onboardingStatus() {
  const state = readJsonFile(getStatePath());
  const machine = currentMachine();
  if (!state || state.onboarded !== true) {
    console.log(JSON.stringify({
      onboarded: false,
      reason: state ? 'state.json 存在但未標記 onboarded' : 'state.json 不存在（本機第一次使用）',
      machine,
    }, null, 2));
    return;
  }
  const matches = isSameMachine(state.machine, machine);
  const onboarded = matches !== false; // legacy markers without machine info stay onboarded
  console.log(JSON.stringify({
    onboarded,
    ...(matches === false
      ? { reason: 'state.json 記錄的是另一台機器（config 目錄可能被遷移或同步），視為本機第一次使用' }
      : {}),
    onboardedAt: state.onboardedAt || null,
    recordedMachine: state.machine || null,
    machine,
  }, null, 2));
}

function onboardingComplete() {
  const machine = currentMachine();
  const statePath = getStatePath();
  const prev = readJsonFile(statePath) || {};
  const state = {
    ...prev,
    onboarded: true,
    version: 2,
    onboardedAt: new Date().toISOString(),
    machine,
  };
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  appendLog(`[setup] onboarding-complete machine=${machine.hostname}${machine.model ? `(${machine.model})` : ''}`);
  console.log(JSON.stringify({ ok: true, statePath, state }, null, 2));
}

function onboardingCommand(args) {
  const sub = String(args._[1] || 'status');
  if (sub === 'status') return onboardingStatus();
  if (sub === 'complete') return onboardingComplete();
  fail('onboarding 只接受 status 或 complete');
}

// --- main -------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'status';
  if (command === 'help' || args.help) usage(0);
  if (command === 'install') return installCommand(args);
  if (command === 'uninstall') return uninstallCommand(args);
  if (command === 'pause') return setEnabled(false);
  if (command === 'resume') return setEnabled(true);
  if (command === 'status') return statusCommand(args);
  if (command === 'schedule') return scheduleCommand(args);
  if (command === 'unschedule') return unscheduleCommand(args);
  if (command === 'onboarding') return onboardingCommand(args);
  usage(1);
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
    console.error(JSON.stringify({ error: error?.message || String(error) }, null, 2));
    process.exit(1);
  });
}
