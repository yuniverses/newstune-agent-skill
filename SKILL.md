---
name: newstune-agent-api
description: "Use when an agent needs to integrate with NewsTune's public Agent API through an API key: validate keys, inspect credits, list/create hosts, list/adopt/clone voices, create podcast series, list series and episodes, queue material-to-podcast or script-to-audio episodes, render standalone TTS, publish series, enable RSS, or troubleshoot NewsTune API access. Also use when the user wants to track project progress with an automatic development journal (自動記錄專案進度、寫工程日誌), turn that journal into podcast episodes about their project, or set up recurring scheduled episode generation such as a weekly show from ongoing work (每週自動生成 podcast、排程集數)."
---

# NewsTune Agent API

Use NewsTune's API key API as an external agent, not as a logged-in browser user. The production base URL is:

```text
https://newstune-backend-fe0cc08f4613.herokuapp.com
```

> Script and reference paths in this document (`scripts/foo.mjs`, `references/foo.md`) are relative to this skill's directory. Resolve them against the skill's base directory reported when the skill is invoked.

## Product Capability Frame

NewsTune is not only a one-off audio rendering tool. Treat it as a long-running AI content system that can turn sources, editorial rules, hosts, voices, schedules, and publishing settings into an ongoing podcast/content series. When a user has not provided a concrete API task, explain the practical capabilities before choosing endpoints:

- Create a private or public podcast series.
- Use built-in, owned, public, adopted, external, or cloned voices through hosts.
- Generate an episode from agent-provided material with `material_to_podcast`.
- Render a locally/agent-written script into an episode with `script_to_audio`.
- Render standalone voice audio with `POST /api/v1/tts`.
- Publish a series, configure RSS, and prepare it for distribution only when explicitly requested.
- Automatically journal a development project's decisions and milestones, then turn that journal into recurring podcast episodes on a schedule (see Project Journal below).

## First-Run Onboarding

When this skill is invoked, first check whether this machine has already seen the introduction:

```bash
node scripts/journal_setup.mjs onboarding status
```

If `onboarded` is `true`, skip this section entirely. If it is `false` — no marker yet, or the marker's machine fingerprint (macOS hardware UUID / hostname) belongs to another computer because the config dir was migrated or synced — run onboarding once before the requested task:

1. Proactively introduce what the NewsTune Agent can do, organized around its three pillars (do this even if the user only asked for one narrow thing):
   - **聲音與主持人（複製聲音）** — clone the user's own voice through a browser handoff (microphone and consent stay in the web UI), search and adopt community/external voices, preview any voice, and build hosts with distinct personas on top of those voices.
   - **系列內容創作** — create private or public podcast series, generate episodes from agent-provided material (`material_to_podcast`) or locally written scripts (`script_to_audio`), render standalone TTS, and publish with RSS when explicitly requested.
   - **專案追蹤與排程** — install background hooks that automatically journal significant coding sessions (decisions, pivots, milestones — the why, not just the what), then turn that journal into podcast episodes, manually or on a weekly launchd schedule.
2. Ask with the environment's user-question/input module (fall back to concise chat questions):
   - Enable automatic project journaling? (yes/no)
   - Journal root directory for entry markdown files (for example `~/newstune-journal`).
   - Judgment engine: `claude` or `codex`.
   - Which CLIs to hook: `claude`, `codex`, or both.
3. If the user opts in, install with their answers:
   ```bash
   node scripts/journal_setup.mjs install \
     --journal-root ~/newstune-journal --engine claude --targets claude,codex
   ```
4. Mark onboarding done in both cases (opt-in or decline), so this machine is never asked again:
   ```bash
   node scripts/journal_setup.mjs onboarding complete
   ```
   The marker (`state.json`) records the machine fingerprint alongside the timestamp.

Then continue with whatever the user originally asked for.

## Demand Interview Contract

If the user asks generally to "make a podcast", "create a series", "use NewsTune", or gives a vague topic, do not immediately call creation APIs. First act like an editor/producer and clarify the content system the user wants.

Use the available user-question/input module when the environment provides one. Otherwise ask concise questions in chat. Ask at most two rounds; skip anything the user already answered.

Round 1 should clarify the editorial intent:

- Topic and the central question the podcast should answer.
- Target audience and how much they already know.
- Use case: internal update, public podcast, company/dev log, investor/customer education, social repurposing, research briefing, or another purpose.
- Language, tone, format, and desired output: ongoing series, one-off episode, script, audio, RSS-ready show, or TTS only.
- Whether this should be a one-time generation or a long-running content workflow.

Round 2 should clarify execution details:

- Source types: AI web research, specific URLs/RSS/YouTube, Notion/Google Docs/MCP tools, local folders, PDFs/text files, CLI output, developer logs, or user-pasted notes.
- Source policy: required/preferred/background/excluded sources, freshness expectation, whether citations are required, and whether sources will keep updating.
- For local folders/private files/CLI output: ask whether it is a one-time source pack or a folder that will keep receiving new files. Do not upload raw private local files to NewsTune by default.
- Hosts and voices: use existing hosts, create a new host, adopt/search external voices, clone a consented voice, or use built-in defaults.
- Generation mode and credit tradeoff:
  - `script_to_audio`: local/agent reads private sources and writes the final script; NewsTune only validates voices, renders TTS/audio, and creates the episode. Prefer this for local folders, private documents, CLI output, or when lower credits matter.
  - `material_to_podcast`: the agent provides shareable source material/brief; NewsTune cloud writes the podcast script and audio. Prefer this for higher-quality cloud generation when the user agrees the material can be sent.
  - `tts_render`: render standalone speech only; no full podcast or episode unless explicitly attached later.
- Visibility and distribution: default private; public, SEO fields, public slugs, and RSS require explicit intent and the relevant scopes.

Before every `POST /api/v1/hosts`, `POST /api/v1/series`, `POST /api/v1/series/{seriesId}/episodes`, or `POST /api/v1/tts` that spends credits, show a final confirmation summary and wait for approval. Include title/topic, use case, source summary, source privacy policy, host IDs, voice reference IDs, generation mode, visibility/RSS, and known credit implications.

## Source Manifest Contract

Represent user-provided sources as a SourceManifest before generation. Use:

```bash
node scripts/source_manifest.mjs \
  --source ./notes \
  --priority required \
  --freshness user_defined \
  --update-mode one_time
```

SourceManifest entries should capture `source_type`, `priority`, `trust_level`, `freshness_expectation`, `update_mode`, `must_cite`, `allowed_transformations`, and optional `topic_binding`.

If the manifest contains local folders, private files, PDFs, text files, CLI output, or developer logs, default to local/agent processing plus `script_to_audio`. Use `material_to_podcast` only after the user explicitly agrees to send the summarized material or selected excerpts to NewsTune cloud.

## Workflow

1. Check for a local cached API key first:
   ```bash
   node scripts/credentials.mjs status
   ```
   If it is configured, use the cached key. Do not ask the user for a new key.
2. If no key is cached, send the user this setup URL and ask them to create a NewsTune API key:
   ```text
   https://podcast.newstune.app/beta/#api-keys
   ```
   They should log in, create a key, copy the one-time secret from the popup, and paste it back. Then store it with:
   ```bash
   node scripts/credentials.mjs set --key 'nt_live_...'
   ```
   Do not ask for Auth0 JWTs, cookies, browser session tokens, or the non-secret key ID shown in the existing-key list.
3. Verify access with `GET /api/v1/me`, then check available credits with `GET /api/v1/credits`.
4. If the user request is not already decision-complete, run the Demand Interview Contract and build a SourceManifest before creating resources.
5. Discover reusable inputs before creating content:
   - `GET /api/v1/hosts?source=all`
   - `GET /api/v1/voices`
   - `GET /api/v1/series` and `GET /api/v1/series/{seriesId}` to reuse an existing series instead of creating a duplicate.
   - `GET /api/v1/series/{seriesId}/episodes` and `GET /api/v1/series/{seriesId}/episodes/{episodeNumber}` for prior-episode summaries, scripts, and topics when continuity matters.
   - These four read endpoints may return 404 until the backend deploy lands. Treat 404 as "not yet deployed": fall back to local snapshots (`podcast.json`, `ledger.json`) and continue instead of failing.
   - Read `references/api-v1.md` before using publishing, RSS, external voices, cloning, or episode generation.
6. Before creating any podcast series, choose hosts:
   - Prefer hosts returned with `sourceTag: "mine"`.
   - Built-in or public hosts are acceptable when the user confirms them.
   - Ask the user to confirm the selected host or host pair before calling `POST /api/v1/series`.
   - Send the confirmed IDs as `hostIds` in the series creation payload.
   - If the user does not choose, use the language defaults: `zh-TW` -> `["builtin_zh_kai", "builtin_zh_luna"]`; `en` -> `["builtin_en_marcus", "builtin_en_sarah"]`.
   - If no suitable host exists and the key has host/voice scopes, create a private host and attach an allowed voice; otherwise ask the user to create/select one in NewsTune.
7. Use `Idempotency-Key` for every POST that creates resources.
8. Create private content by default. Public visibility, public slugs, SEO fields, and RSS require explicit user intent and the scopes listed in `references/api-v1.md`.
9. Choose the generation mode:
   - `material_to_podcast`: NewsTune creates script and audio from agent-provided material.
   - `script_to_audio`: The caller supplies the script/transcript and NewsTune only renders voice/audio into an episode.
   - `POST /api/v1/tts`: standalone text-to-speech asset rendering.
10. Never print or persist raw API keys in logs, markdown, issue comments, or generated files. The only approved persistent location is the local private credential cache at `.private/credentials.json` created by `scripts/credentials.mjs`.

## Project Journal

The journal subsystem records notable engineering sessions (decisions, pivots, milestones, incidents) into per-project markdown entries, then feeds them into podcast episodes. It has three layers:

1. **Gate** — `scripts/journal_gate.mjs`. A deterministic Stop hook: no network, no LLM, under 100ms. Reads the hook payload from stdin, applies config/cooldown/size checks, then either skips silently (reason appended to `logs/journal.log`) or spawns the record layer detached. Subcommands: `status [--json]`, `mark-recorded --project <slug>`, `mark-skipped --project <slug>`.
2. **Record** — `scripts/journal_record.mjs`. Background judge/writer spawned by the gate. Assembles session context (transcript tail, git log since the last record, recent entries, `project.md`), asks the configured engine (`claude` or `codex`) whether the session is worth recording, and writes the entry file plus `project.md` when missing. It never crashes loudly; every failure is logged.
3. **Setup** — `scripts/journal_setup.mjs`. `install`/`uninstall` (safe hook merge into Claude/Codex settings with `.bak-newstune` backups), `pause`/`resume`, `status`, and `schedule`/`unschedule` for launchd.

`scripts/episode_from_journal.mjs` bridges journal to NewsTune episodes with `bind`/`collect`/`submit`/`status`.

Read `references/journal.md` for the full specification: data layout, entry frontmatter schema, judging criteria, hook payload shapes, launchd details, and troubleshooting.

## Scheduled & Manual Episode Generation

Manual and scheduled generation follow the same flow; only the trigger differs.

1. Bind the journal project to a NewsTune series once:
   ```bash
   node scripts/episode_from_journal.mjs bind \
     --project <slug> --series-id <seriesId>
   ```
   If the backend read endpoints are not deployed yet (404), pass `--snapshot-json` with the `POST /api/v1/series` response.
2. Collect the material pack. This is pure data assembly — no LLM call:
   ```bash
   node scripts/episode_from_journal.mjs collect \
     --project <slug> --cwd <code-repo-path>
   ```
3. Write the episode script yourself, as the agent, from the material pack. Follow the Continuity Contract below.
4. Submit and poll to a terminal state:
   ```bash
   node scripts/episode_from_journal.mjs submit \
     --project <slug> --script-file /path/to/script.txt \
     --title "<episode title>" --summary "<episode summary>" --topics a,b,c
   ```
   `submit` records the episode in `ledger.json`, advances `lastCoveredAt`, and appends a `type: progress` journal entry.

To run this on a schedule (macOS launchd):

```bash
node scripts/journal_setup.mjs schedule \
  --project <slug> --cadence weekly --day sun --time 09:00
node scripts/journal_setup.mjs unschedule --project <slug>
```

Scheduled-mode rules:

- Never ask the user questions; the run is headless.
- If material is insufficient (no worthwhile entries or commits since `lastCoveredAt`), skip this issue and log the reason instead of forcing a thin episode.
- `extraSources` entries that point at Linear, Notion, or similar systems are fetched through the session's MCP tools; the scripts never fetch them.

## Continuity Contract

Before writing any `script_to_audio` episode script, always do all three reads:

1. `GET /api/v1/series/{seriesId}` — series settings: language, style, perspective, `episodeFormat`, `targetDurationMinutes`, `hostIds`. On 404 (endpoint not deployed), use `seriesSnapshot` from `podcast.json`.
2. `GET /api/v1/hosts?source=all` — each host's persona (`style`, `bio`). Keep the hosts' role division, tone, and catchphrases consistent with those personas throughout the script.
3. `GET /api/v1/series/{seriesId}/episodes` — prior episode summaries. On 404, fall back to the local `ledger.json` (`collect` already does this automatically).

While writing:

- Keep the opening and closing rituals consistent with previous episodes.
- Call back to the previous episode naturally instead of starting cold.
- Do not re-explain points already covered in prior summaries; build on them.
- Match the length to `episodeFormat` and `targetDurationMinutes`.

On submit, `--summary` is mandatory: it backfills the server (`summary` on the episode) and the local `ledger.json`, giving future episodes dual-side memory even when one side is unavailable.

## Web Handoff Contract

Use web handoff when the agent needs the logged-in NewsTune UI to finish an interactive step: microphone recording, user consent, voice selection, host creation/selection, series creation with user review, publish/RSS settings, API key management, or opening a private podcast player. Do not try to collect microphone audio directly in the CLI when the browser UI can do it.

Recommended helper:

```bash
node scripts/web_handoff.mjs voice_clone \
  --input-json '{"voiceName":"My Podcast Voice"}' \
  --app-window
```

Supported actions:

- `voice_clone`
- `voice_select`
- `host_create`
- `host_select`
- `series_create`
- `series_settings`
- `episode_player`
- `api_keys`

The helper creates `POST /api/v1/handoffs`, opens the returned `openUrl`, then polls `GET /api/v1/handoffs/{handoffId}` until the web UI completes, cancels, fails, or expires. The URL contains only an opaque handoff ID. It must never contain raw API keys, JWTs, local source content, or private files.

Use direct Public API calls instead of handoff only when the user has already confirmed all required fields and no browser interaction is needed. Examples: creating a private series from confirmed host IDs, queuing `script_to_audio`, queuing `material_to_podcast`, polling jobs, or rendering standalone TTS.

## Host Selection Contract

Podcast generation requires at least one host with a usable TTS voice. A two-person episode should normally use two host IDs. Do not create a series with empty `hostIds` unless the user explicitly wants NewsTune's backend default hosts.

When writing a script for API calls, import the cached credential instead of asking again:

```js
// resolve from the skill directory
import { loadStoredCredentials } from './scripts/credentials.mjs';

const { apiKey, baseUrl } = loadStoredCredentials();
```

Use `apiKey` only in request headers. Do not print it.

Recommended sequence:

```bash
curl -s "$NEWSTUNE_API_BASE_URL/api/v1/hosts?source=all" \
  -H "X-NT-API-Key: $NEWSTUNE_API_KEY"
```

Then ask the user a short confirmation, for example:

```text
I found Kai and Luna as built-in zh-TW hosts. Can I use hostIds builtin_zh_kai and builtin_zh_luna for this series?
```

Create the series only after that confirmation:

```json
{
  "title": "Agent Briefing",
  "topic": "Weekly AI product updates",
  "language": "zh-TW",
  "hostIds": ["builtin_zh_kai", "builtin_zh_luna"],
  "episodeFormat": "brief",
  "visibility": "private"
}
```

If the user wants a custom host, use the voice workflow first: list voices, search/adopt a community voice if needed, or clone a consented user sample when `voices:clone` is available. After the voice is selected, create or select a host using that voice, then use that host ID in the series.

If NewsTune returns `TTS_VOICE_NOT_BOUND`, stop. Tell the user the series needs host IDs with bound voices, then retry only after the host configuration is fixed.

## Voice Preview Contract

Use API-key-only voice preview flows. Do not use JWT-only product routes such as `POST /api/voices/{referenceId}/preview`.

Recommended helper:

```bash
node scripts/voice_preview.mjs list --language zh-TW
```

If a voice has `previewUrl`, share or open that URL. If it does not and the user wants to hear it, ask for confirmation because this may spend TTS credits, then render a short sample:

```bash
node scripts/voice_preview.mjs sample \
  --voice allowed-voice-reference \
  --open
```

The helper calls `POST /api/v1/tts`, then polls `GET /api/v1/jobs/{jobId}` for the rendered audio URL.

## API Key Setup

The user must be logged into NewsTune and be on a tier with API access. The backend exposes key management at `/api/api-keys` behind normal app authentication:

- `GET /api/api-keys`: list keys without secrets.
- `POST /api/api-keys`: create a key and receive `secret` once.
- `DELETE /api/api-keys/:id`: revoke a key.

Open the authenticated frontend directly to the key management modal:

```text
https://podcast.newstune.app/beta/#api-keys
```

The existing-key list shows only a non-secret key identifier. That identifier is not enough for API calls. The user must copy the one-time secret from the creation popup and paste it to the agent once. Store it locally with `scripts/credentials.mjs set`; future runs should reuse the cached key automatically.

## Validation Script

Run the bundled smoke test after a user provides a key. It reads the local credential cache automatically:

```bash
node scripts/smoke_test.mjs
```

To override the cache for a single run:

```bash
NEWSTUNE_API_KEY='nt_live_...' node scripts/smoke_test.mjs
```

Optional flags:

```bash
NEWSTUNE_API_BASE_URL='https://newstune-backend-fe0cc08f4613.herokuapp.com' \
NEWSTUNE_CREATE_SMOKE_SERIES=true \
NEWSTUNE_TEST_TTS_REJECT=true \
NEWSTUNE_TEST_TTS_JOB_POLL=true \
NEWSTUNE_TEST_WEB_HANDOFF=true \
NEWSTUNE_API_KEY='nt_live_...' \
node scripts/smoke_test.mjs
```

`NEWSTUNE_CREATE_SMOKE_SERIES=true` leaves a private test series in the user's account by design. Use it only when the user wants an end-to-end create test.
`NEWSTUNE_TEST_TTS_JOB_POLL=true` queues standalone TTS and may spend credits; use it only when the user asks to verify rendering and job polling end to end.
`NEWSTUNE_TEST_WEB_HANDOFF=true` creates and cancels an `api_keys` handoff. It does not spend credits and does not open the browser.
