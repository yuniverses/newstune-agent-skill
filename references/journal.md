# Project Journal & Scheduled Episodes

Full specification for the journal subsystem summarized in SKILL.md (Project Journal, Scheduled & Manual Episode Generation, Continuity Contract). All scripts live in `scripts/` and are zero-dependency Node ESM.

## Architecture

Three layers plus an episode bridge:

| Layer | Script | Runs as | LLM | Purpose |
| --- | --- | --- | --- | --- |
| Gate | `journal_gate.mjs` | Stop hook (stdin JSON) | No | Deterministic checks under 100ms; spawns the record layer detached when all pass |
| Record | `journal_record.mjs` | Detached background process | Yes | Judges whether the session is worth recording; writes the entry + `project.md` |
| Setup | `journal_setup.mjs` | Manual CLI | No | Hook install/uninstall, pause/resume, status, launchd schedule/unschedule |
| Bridge | `episode_from_journal.mjs` | Manual CLI / scheduled run | No | `bind`/`collect`/`submit`/`publish`/`status`: journal → NewsTune episode |

The record layer sets `NEWSTUNE_JOURNAL_SKIP=1` in the engine environment, and scheduled launchd runs carry the same variable, so a recording or scheduled session can never trigger another recording (recursion guard).

## Data Layout

Config directory (`$NEWSTUNE_AGENT_CONFIG_DIR`, default `~/.config/newstune-agent`):

```text
state.json                    # onboarding marker with machine fingerprint (journal_setup.mjs onboarding status|complete)
config.json                   # { enabled, journalRoot, engine: "claude"|"codex",
                              #   cooldownHours: 4, maxPerDay: 3, minTranscriptBytes: 20000 }
projects/<slug>.state.json    # { lastRecordedAt, lastSkippedAt, dateCounts: {"2026-07-06": 2} }
logs/journal.log              # append-only run log (every skip reason, record, setup action)
logs/schedule.<slug>.log      # stdout of scheduled launchd runs (+ .err.log for stderr)
```

Journal root (`config.journalRoot`, overridable with `NEWSTUNE_JOURNAL_ROOT`), one folder per project:

```text
<journalRoot>/<project-slug>/
  project.md                          # project concept, generated on first recording
  podcast.json                        # series binding (see Podcast Binding below)
  ledger.json                         # locally-known episodes + lastCoveredAt
  entries/YYYY-MM-DD_<kebab-title>.md # journal entries; name collisions get a -2, -3... suffix
```

### Project slug derivation

- Git repo with an `origin` remote: repo name from the remote URL, `.git` stripped, kebab-cased (for example `Podcast_Search_MVP.git` → `podcast-search-mvp`).
- No remote: `<kebab folder basename>-<first 6 hex of sha256(cwd)>`, for example `myproj-c21ebe`.

The same derivation runs in the gate and must match the `--project` slug you pass to the other scripts. When unsure, check `logs/journal.log` — the gate logs `project=<slug>` on every pass/skip.

## Entry Frontmatter Schema

```markdown
---
date: 2026-07-06
type: decision            # one of: decision | pivot | milestone | progress | incident
title: "改用 launchd 取代 cron 排程"
why: "為什麼做這個決定或發生這件事"
impact: "對專案的影響"
refs: ["339bd93"]          # commit hashes that actually appear in the session context
tags: ["scheduling", "macos"]
---

繁體中文 markdown 正文，2 至 6 段。
```

Unknown `type` values are coerced to `progress` when written. `refs` and `tags` may be inline arrays (as above) or block lists; the bridge script parses both.

## Judging Criteria (mirrored from the engine prompt, zh-TW)

The record layer embeds a single two-stage judgment prompt. Its criteria, verbatim:

> 第一階段——判斷這次 session 是否值得寫入專案日誌：
> - 值得記錄：方向性或架構決策、技術選型轉向與其原因、里程碑（功能完成、部署、發布）、重大踩坑與其根因、範圍或產品決策的變化。
> - 不值得記錄：例行小修小補、純問答或查資料、沒有結論的進行中工作。

The engine must output exactly one JSON object (no code fence):

- Worth recording: `{"record": true, "entry": {"type": "...", "title": "...", "why": "...", "impact": "...", "refs": [...], "tags": [...], "body": "..."}, "projectConcept": "..."}` — `projectConcept` only when the context shows `project.md` does not exist yet.
- Not worth recording: `{"record": false, "reason": "..."}`.

Additional prompt rules: `title` must be concrete (「改用 launchd 取代 cron 排程」, not 「更新程式碼」); `refs` may only contain commit hashes that really appear in the context, else an empty array.

Context assembled for the engine: transcript tail (~30KB, lenient JSONL extraction of user/assistant turns), `git log --stat` since `lastRecordedAt` (or last 20 commits), the 2 most recent entries in full, and `project.md` if present.

Engine invocation (config `engine`):

- `claude`: `claude -p --model <engineModel> <prompt>`（不用 `--bare`——claude 2.1.202 起它連登入憑證都不載入，會得到 Not logged in；防遞迴靠 `NEWSTUNE_JOURNAL_SKIP=1`。判斷模型預設 `claude-haiku-4-5-20251001`，可用 config.json 的 `engineModel` 覆寫）
- `codex`: `codex exec --skip-git-repo-check -s read-only --output-last-message <tmpfile> <prompt>`

Both run with `NEWSTUNE_JOURNAL_SKIP=1` and a 5-minute default timeout (`--timeout-ms` to override).

## Gate Checks (in order)

Any failed check exits 0 silently and appends the reason to `logs/journal.log`:

1. `config.json` exists and `enabled: true`. (Fully silent — no log line — when the config dir itself does not exist, so non-users never get a `~/.config/newstune-agent` created for them.)
2. `NEWSTUNE_JOURNAL_SKIP` is not `1` (recursion guard).
3. The payload `cwd` exists and is a directory (slug is derived from it).
4. The transcript file exists and is at least `minTranscriptBytes` (default 20000).
5. Cooldown: `now - lastRecordedAt >= cooldownHours` (default 4h). After a judged skip, half the cooldown applies to `lastSkippedAt` so one uneventful session does not cause a chain of engine wake-ups.
6. Daily cap: today's `dateCounts` entry `< maxPerDay` (default 3; only actual recordings count).
7. In-flight lock: `projects/<slug>.lock` must not exist (or must be stale, >15 min). The Stop hook and the git-commit PostToolUse hook can both fire in one session, and cooldown state only updates after the judge finishes — the lock is what prevents a double judge run. `journal_record` releases it on every exit; a crashed run's lock simply expires.

All passed → acquires the lock, spawns `journal_record.mjs --project <slug> --cwd <cwd> --transcript <path>` detached and exits 0 immediately.

## Hook Payloads: Claude Code vs Codex

The gate tolerates both payload shapes; every field is optional with a fallback:

| Gate field | Claude Code Stop payload | Codex stop payload | Fallback when missing |
| --- | --- | --- | --- |
| `cwd` | `cwd` | `cwd` / `workspace_root` / `working_directory` | `process.cwd()` |
| `transcriptPath` | `transcript_path` | `transcript_path` / `rollout_path` (also accepts `transcriptPath` / `transcript`) | none — gate skips with a logged reason |
| `sessionId` | `session_id` | `session_id` / `thread_id` (also accepts `sessionId`) | empty string (informational only) |

### Scheduled-run model & failure notification

Scheduled launchd runs pin `--model` (default `sonnet`; override with `schedule --model <m>` or `scheduleModel` in config.json) so nightly automation neither burns nor gets blocked by the user's default top-tier model limit. The plist wraps the engine in `/bin/sh` so a non-zero exit posts a macOS notification (「NewsTune 排程」) instead of failing silently — the error detail stays in `logs/schedule.<slug>.err.log`. Note: the launchd context usually lacks macOS TCC permission for `~/Documents`; runs fall back to `gh` remote data for repo digests, so only pushed commits are visible to scheduled episodes unless the engine binary's app is granted Files-and-Folders access.

## Hook Installation

`journal_setup.mjs install` merges into both targets (select with `--targets claude,codex`, default both). Entries are identified by the absolute path of `journal_gate.mjs` inside the `command` string, which makes install idempotent and uninstall shape-safe. Every modified file is backed up to `<file>.bak-newstune` first.

Claude Code (`~/.claude/settings.json`):

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node \"<abs path>/journal_gate.mjs\"", "async": true, "timeout": 10 }] }
    ],
    "PostToolUse": [
      { "matcher": "Bash(git commit *)", "hooks": [{ "type": "command", "command": "node \"<abs path>/journal_gate.mjs\"", "async": true, "timeout": 10 }] }
    ]
  }
}
```

Codex (`~/.codex/hooks.json`, flat entries; `config.toml`'s `notify` is deliberately untouched — it is occupied by Computer Use):

```json
{
  "hooks": {
    "Stop": [
      { "type": "command", "command": "node \"<abs path>/journal_gate.mjs\"", "async": true, "timeout": 10 }
    ]
  }
}
```

`uninstall` removes only entries whose command contains the gate path; foreign hooks and `config.json` are preserved. Re-running `install` never duplicates entries.

## Podcast Binding and Ledger

`podcast.json` (written by `episode_from_journal.mjs bind`):

```json
{
  "seriesId": "srs_...",
  "seriesSnapshot": { "title": "...", "topic": "...", "language": "zh-TW", "hostIds": ["..."], "episodeFormat": "brief", "visibility": "public", "targetDurationMinutes": 10 },
  "cadence": "weekly",
  "mode": "script_to_audio",
  "materialConsent": false,
  "extraSources": [],
  "lastCoveredAt": null,
  "episodeVisibility": "public"
}
```

`seriesSnapshot.visibility` is persisted by `bind` (from `GET /api/v1/series/:id` or `--snapshot-json`). `episodeVisibility` is optional (`"public"` | `"private"`); when absent, `submit` falls back to the series default — **a public series airs its episodes by default** (`public`), any other series defaults to `private`. Full resolution order used by `submit`: `--visibility` flag → `episodeVisibility` → series default. `bind` prints the resolved default so the user knows what future submits will do.

`ledger.json` (appended by `submit` after the job reaches a terminal state):

```json
{
  "episodes": [
    { "episodeNumber": 3, "title": "...", "summary": "...", "highlights": ["..."], "topics": ["..."], "jobId": "...", "createdAt": "2026-07-06T...", "visibility": "public", "publicSlug": "my-episode-slug" }
  ],
  "lastCoveredAt": "2026-07-06T..."
}
```

`visibility` records what `submit` sent; `publicSlug` is present only once known — `submit` stores it when the create/job result carries one, and `publish` backfills it (the backend allocates public-series episode slugs after `audio_ready`).

`collect` selects entries dated after `lastCoveredAt` (ledger first, then podcast.json), orders `decision`/`pivot`/`milestone` first, adds a git digest (`--cwd` points at the code repo; non-git directories are tolerated), and prefers `GET /api/v1/series/{seriesId}/episodes` for `priorEpisodes` with a `ledger.json` fallback on 404. It performs no LLM calls — the invoking agent writes the script.

## launchd Scheduling (macOS)

`journal_setup.mjs schedule --project <slug> --cadence weekly|daily [--day sun..sat] [--time HH:MM] [--engine claude|codex]` writes:

- Plist: `~/Library/LaunchAgents/com.newstune.podcast.<slug>.plist` (label `com.newstune.podcast.<slug>`).
- `ProgramArguments`: the resolved engine binary running the scheduled-episode prompt headless — `claude -p <prompt> --dangerously-skip-permissions` or `codex exec --skip-git-repo-check --full-auto <prompt>`. The zh-TW prompt tells the engine to use this skill: collect → write per the Continuity Contract → submit, never ask questions, and skip the issue when material is insufficient.
- `StartCalendarInterval`: `Hour`/`Minute`, plus `Weekday` (0 = Sunday) for weekly cadence.
- `EnvironmentVariables`: `NEWSTUNE_JOURNAL_SKIP=1` plus a sane `PATH`; `NEWSTUNE_AGENT_CONFIG_DIR`/`NEWSTUNE_JOURNAL_ROOT` are propagated when set at schedule time.
- `WorkingDirectory`: `<journalRoot>/<slug>`; `StandardOutPath`/`StandardErrorPath`: `logs/schedule.<slug>.log` / `.err.log` in the config dir.

Loading: `launchctl bootstrap gui/$UID <plist>` with `launchctl load` as fallback; re-scheduling boots the old job out first so the new plist takes effect. `unschedule --project <slug>` runs `launchctl bootout` (fallback `unload`) and deletes the plist.

Inspect a live schedule:

```bash
launchctl print gui/$(id -u)/com.newstune.podcast.<slug>
```

## Environment Variables & Test Overrides

| Variable / flag | Applies to | Effect |
| --- | --- | --- |
| `NEWSTUNE_AGENT_CONFIG_DIR` | all scripts | Config directory (default `~/.config/newstune-agent`) |
| `NEWSTUNE_JOURNAL_ROOT` | gate/record/bridge/setup | Overrides `config.journalRoot` |
| `NEWSTUNE_JOURNAL_SKIP=1` | gate | Forces a skip (recursion guard; set for engines and scheduled runs) |
| `NEWSTUNE_API_BASE_URL` / `NEWSTUNE_API_KEY` | bridge | Override the credential cache for one run |
| `--claude-settings-path` / `--codex-hooks-path` | setup | Redirect hook files (tests must use these — never write the real ones) |
| `--launch-agents-dir` | setup | Redirect plist directory |
| `--no-load` / `NEWSTUNE_SETUP_SKIP_LAUNCHCTL=1` | setup | Write the plist without calling `launchctl` |
| `NEWSTUNE_GATE_RECORD_SCRIPT` | gate | Spawn a different record script (tests) |
| `--engine-cmd` / `NEWSTUNE_RECORD_ENGINE_CMD` | record | Replace the whole engine command (prompt appended as the last argv) |

## Troubleshooting

Everything the subsystem does is appended to one log:

```bash
tail -50 "${NEWSTUNE_AGENT_CONFIG_DIR:-$HOME/.config/newstune-agent}/logs/journal.log"
```

Log line prefixes: `[gate] skip ...` (with the zh-TW reason), `[gate] pass ...`, `[record] start/recorded/judge-skip/error ...`, `[setup] install/uninstall/schedule/...`.

Status checks:

```bash
node scripts/journal_gate.mjs status --json
node scripts/journal_setup.mjs status
node scripts/episode_from_journal.mjs status --project <slug>
```

Common situations:

- **Nothing is ever recorded**: check `journal_setup.mjs status` — is the hook installed (`stopInstalled: true`) and `config.enabled` true? Then check the log: most skips are cooldown, daily cap, or `transcript 太小` (session under `minTranscriptBytes`).
- **Recorded too often / too rarely**: tune `cooldownHours`, `maxPerDay`, `minTranscriptBytes` in `config.json` directly, or re-run `install` (existing values are preserved unless flags override them).
- **Temporarily stop journaling**: `journal_setup.mjs pause`, later `resume`. This flips `config.enabled`; hooks stay installed and cost <100ms per Stop.
- **Remove completely**: `journal_setup.mjs uninstall` (removes only our hook entries, keeps `config.json` and all journal data), plus `unschedule --project <slug>` per scheduled project. Restore any hook file from `<file>.bak-newstune` if needed.
- **Engine failures**: the record layer never crashes the CLI; look for `[record] error` lines (unparseable engine output, timeouts, missing binary). Verify the engine works headless: `claude -p 'hi'` or `codex exec --skip-git-repo-check -s read-only 'hi'`.
- **Scheduled run did nothing**: check `logs/schedule.<slug>.log` / `.err.log`, then `launchctl print gui/$(id -u)/com.newstune.podcast.<slug>`. A skipped issue for lack of material is expected behavior, not a failure.
- **Read endpoints return 404**: the backend deploy has not landed; `bind`/`collect` degrade to `podcast.json`/`ledger.json` automatically with a one-line stderr notice (see `references/api-v1.md`). `publish` degrades the same way when the visibility PATCH endpoint returns 404 (`{ "ok": false, "degraded": true, "reason": "ENDPOINT_NOT_DEPLOYED" }`); rerun after the deploy lands.
