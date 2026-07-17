---
name: newstune-agent-api
description: "Use when an agent needs NewsTune's API-key Agent API to validate access, inspect credits, manage hosts or accessible voices, create or continue podcast series and episodes, render TTS, preview an exact publishing scope, preserve/enable/disable RSS, or troubleshoot access. Also use for automatic project journals, turning development progress into episodes, and recurring scheduled podcast generation."
---

# NewsTune Agent API

Use NewsTune's API key API as an external agent, not as a logged-in browser user. The production base URL is:

```text
https://api.newstune.app
```

> Script and reference paths in this document (`scripts/foo.mjs`, `references/foo.md`) are relative to this skill's directory. Resolve them against the skill's base directory reported when the skill is invoked.

## Product Capability Frame

NewsTune is not only a one-off audio rendering tool. Treat it as a long-running AI content system that can turn sources, editorial rules, hosts, voices, schedules, and publishing settings into an ongoing podcast/content series. When a user has not provided a concrete API task, explain the practical capabilities before choosing endpoints:

- Create a private or public podcast series.
- Use built-in, owned, public, adopted, external, or cloned voices through hosts.
- Generate an episode from agent-provided material with `material_to_podcast`.
- Render a locally/agent-written script into an episode with `script_to_audio`.
- Render standalone voice audio with `POST /api/v1/tts`.
- Preview and publish an exact episode scope, configure RSS with `rssAction: "preserve" | "enable" | "disable"`, and prepare the feed for distribution only when explicitly requested.
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

Before every `POST /api/v1/hosts`, `POST /api/v1/series`, `POST /api/v1/series/{seriesId}/episodes`, or `POST /api/v1/tts` that spends credits, show a final confirmation summary and wait for approval. Include title/topic, use case, source summary, source privacy policy, host IDs, voice reference IDs, generation mode, visibility/RSS, every non-empty proposed `customPrompts` field for series creation, and known credit implications.

## Persistent Series Production Brief

Before creating a series, convert every confirmed interview decision into a detailed, self-contained `customPrompts` object. Treat this as the durable operating manual for the series, not a short style label and not temporary conversation memory. Another AI on another device should be able to continue the show consistently after reading the series detail alone.

Use all eight fixed fields:

- `gatherContent`: source acquisition method; named source types; required/preferred/background/excluded sources; language/region; freshness, update cadence, citation requirements, and local/cloud privacy boundaries.
- `generatePlan`: series mission, audience, use case, episode-selection rules, recurring segments, duration and cadence, novelty, and how to avoid repeating prior episodes.
- `conductResearch`: questions to answer, evidence and verification standards, primary/authoritative source priority, required documents/data/quotes, conflicting-source handling, and provenance.
- `generateScript`: language, tone, narrative angle, host roles and interaction, structure, pacing, listener knowledge, required/prohibited content, terminology treatment, and calls to action.
- `supplementScript`: background, definitions, examples, opposing views, transitions, summaries, and accessibility checks to add without changing the series identity.
- `deeperResearch`: triggers for deeper research, evidence gaps, timelines, original quotations, causal/impact analysis, and stopping criteria.
- `generateFinalScript`: non-negotiable final checks for factual consistency, attribution, privacy, length, host consistency, ending style, and release readiness.
- `generateCoverImage`: durable visual identity, subject matter, composition, colors, text policy, elements to avoid, and episode-to-episode consistency.

Preserve concrete user wording and edge cases when they affect production. Do not reduce requirements to vague phrases such as "professional" or "in depth", and do not invent decisions the user did not make. Do not store passwords, API keys, raw private documents, or unrelated private data; store reusable source descriptions, handling rules, and privacy boundaries instead.

Send the approved object as `customPrompts` in `POST /api/v1/series`. To revise an existing API-created series, show the changed fields and obtain confirmation before `PATCH /api/v1/series/{seriesId}/custom-prompts`; an empty string clears that field.

Before generating every episode, fetch `GET /api/v1/series/{seriesId}` and read every non-empty `customPrompts` field. For `material_to_podcast`, NewsTune's pipeline applies the stored prompts, but the submitted brief and sources must still match them. For `script_to_audio`, the external agent must apply the stored sourcing, planning, research, script, supplement, and final-script rules while writing the final transcript; NewsTune only renders the supplied script. Also read recent episodes when continuity or non-repetition matters. If a new episode request conflicts with the stored brief, ask whether it is a one-episode exception or a permanent series change; never silently overwrite the series instructions.

If the API reports insufficient credits, show the current balance and required amount, confirm that no write or debit occurred, and stop. Do not retry, switch accounts, bypass billing, or direct the user to buy credits, upgrade, subscribe, or open a payment link. Begin any later attempt with a fresh credit check and confirmation only after the balance has independently changed.

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
   They should log in, create a key, copy the one-time secret, and store it from their own local terminal with hidden input:
   ```bash
   node scripts/credentials.mjs set
   ```
   Never ask the user to paste the secret into the AI conversation. After the helper confirms it saved `~/.config/newstune/credentials.json`, the user only needs to say that local setup is complete.
   Do not ask for Auth0 JWTs, cookies, browser session tokens, or the non-secret key ID shown in the existing-key list.
3. Verify access with `GET /api/v1/me`, then check available credits with `GET /api/v1/credits`.
4. If the user request is not already decision-complete, run the Demand Interview Contract and build a SourceManifest before creating resources.
5. Discover reusable inputs before creating content:
   - `GET /api/v1/hosts?source=all`
   - `GET /api/v1/voices`
   - Page through `GET /api/v1/series?limit=100&offset=0`, replacing `offset` with every returned `nextOffset` until it is `null`; then use `GET /api/v1/series/{seriesId}` to reuse an existing series instead of creating a duplicate and read its persistent `customPrompts` before preparing any episode.
   - `GET /api/v1/series/{seriesId}/episodes` and `GET /api/v1/series/{seriesId}/episodes/{episodeNumber}` for prior-episode summaries, scripts, and topics when continuity matters.
   - When intentionally supporting an older NewsTune deployment, a route-level 404 may be handled with the local `podcast.json`/`ledger.json` fallback. On the current API, a 404 after successful authentication normally means the requested owned resource does not exist; do not create a duplicate without confirming.
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
10. Never print or persist raw API keys in logs, markdown, issue comments, or generated files. The only approved persistent location is the shared private credential cache at `~/.config/newstune/credentials.json` created by `scripts/credentials.mjs`, or a path explicitly supplied through `NEWSTUNE_CREDENTIALS_PATH`.

## Exact Publishing Contract

For a public series launch or a multi-episode publishing change, use the two-step `POST /api/v1/series/{seriesId}/publish-exact` flow documented in `references/api-v1.md`. First send `dryRun: true`, then show the selected episodes and titles, already-public episodes that remain public, `publicEpisodeNumbersAfterAction`, `webPublicEpisodeNumbersAfterAction`, `rssEpisodeNumbersAfterAction`, titled `rssEpisodesAfterAction`, `futurePublicEpisodeNumbersAfterAction`, every titled/status-bearing entry in `futurePublicEpisodesAfterAction`, final public slug, `seoTitle`, `seoDescription`, complete RSS action/metadata, and any masked owner contact whose `ownerEmailWillBePublic` flag is true. Explain that future-public episodes are still generating but may become public automatically when they finish, and obtain explicit approval for both immediate and future effects. Execute with identical publishing inputs, the returned `revision` as `expectedRevision`, and a caller-chosen stable `Idempotency-Key` reused for retries.

Always send one explicit RSS action. Use `rssAction: "preserve"` unless the user specifically asks to enable or disable the feed. Never turn an omitted RSS preference into `disable`. Any stale revision requires a new preview and a new approval. Enabling a NewsTune feed is not the same as submitting it to Spotify, Apple Podcasts, YouTube, or another directory; the account owner must complete each external platform's login, verification, and terms.

## Project Journal

The journal subsystem records notable engineering sessions (decisions, pivots, milestones, incidents) into per-project markdown entries, then feeds them into podcast episodes. It has three layers:

1. **Gate** — `scripts/journal_gate.mjs`. A deterministic Stop hook: no network, no LLM, under 100ms. Reads the hook payload from stdin, applies config/cooldown/size checks, then either skips silently (reason appended to `logs/journal.log`) or spawns the record layer detached. Subcommands: `status [--json]`, `mark-recorded --project <slug>`, `mark-skipped --project <slug>`.
2. **Record** — `scripts/journal_record.mjs`. Background judge/writer spawned by the gate. Assembles session context (transcript tail, git log since the last record, recent entries, `project.md`), asks the configured engine (`claude` or `codex`) whether the session is worth recording, and writes the entry file plus `project.md` when missing. It never crashes loudly; every failure is logged.
3. **Setup** — `scripts/journal_setup.mjs`. `install`/`uninstall` (safe hook merge into Claude/Codex settings with `.bak-newstune` backups), `pause`/`resume`, `status`, and `schedule`/`unschedule` for launchd.

`scripts/episode_from_journal.mjs` bridges journal to NewsTune episodes with `bind`/`collect`/`submit`/`publish`/`status`.

Read `references/journal.md` for the full specification: data layout, entry frontmatter schema, judging criteria, hook payload shapes, launchd details, and troubleshooting.

## Scheduled & Manual Episode Generation

Manual and scheduled generation follow the same flow; only the trigger differs.

1. Bind the journal project to a NewsTune series once:
   ```bash
   node scripts/episode_from_journal.mjs bind \
     --project <slug> --series-id <seriesId>
   ```
   If deliberately connecting to a known older deployment without the read endpoint, pass `--snapshot-json` with the `POST /api/v1/series` response. On the current API, prefer the live series read.
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

Episode visibility: scheduled/manual episodes submitted into a **public** series default to `public` — a public show's episodes should air by default. Everything else defaults to `private`. Override per run with `--visibility public|private` on `submit`, or persistently by setting `episodeVisibility` in the project's `podcast.json` (flag > `podcast.json` > series default). Publishing an episode retroactively (or unpublishing one) uses:

```bash
node scripts/episode_from_journal.mjs publish --project <slug> --episode <n> [--private]
```

`publish` prints the episode's `publicSlug` and full `publicUrl` (`https://podcast.newstune.app` + `/zh-tw` for `zh`/`zh-TW`/`zh-Hant*` series — not `zh-Hans`/`zh-CN` — + `/episode/<publicSlug>/`) and syncs `ledger.json` (unpublish clears the slug). It requires `publish:write`. Its 404 degradation exists only for compatibility with known older deployments; on the current API, first verify the series and episode IDs because 404 normally means the owned resource was not found.

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

1. `GET /api/v1/series/{seriesId}` — series settings: language, style, perspective, `episodeFormat`, `targetDurationMinutes`, `hostIds`. Use `seriesSnapshot` from `podcast.json` only as a compatibility fallback for a known older deployment, not as proof that a current-API 404 is a deployment gap.
2. `GET /api/v1/hosts?source=all` — each host's persona (`style`, `bio`). Keep the hosts' role division, tone, and catchphrases consistent with those personas throughout the script.
3. `GET /api/v1/series/{seriesId}/episodes` — prior episode summaries. On 404, fall back to the local `ledger.json` (`collect` already does this automatically).

While writing:

- Resolve every live `hostId` to its current host name and use only those names in `Name: dialogue` speaker labels (matching is case-insensitive). Never copy a retired speaker name from an older episode or local template.
- Keep the opening and closing rituals consistent with previous episodes.
- Call back to the previous episode naturally instead of starting cold.
- Do not re-explain points already covered in prior summaries; build on them.
- Match the length to `episodeFormat` and `targetDurationMinutes`.

On submit, `--summary` is mandatory: it backfills the server (`summary` on the episode) and the local `ledger.json`, giving future episodes dual-side memory even when one side is unavailable. The submit helper re-reads the live series and host library, rejects unknown speaker labels before any paid API call, and sends the verified `hostIds` with the episode request.

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

For `voice_select`, include `selectionCount: 1` for a solo host or `selectionCount: 2` for a two-host format. The NewsTune UI keeps the choices pending until the user confirms the complete set.

An accessible voice returned by NewsTune may be browsed, previewed, and selected even when it is public/community content or its display name refers to a celebrity or public figure. Do not infer missing permission or block selection solely from the identity or name. Give a short reminder that availability does not imply endorsement and that the voice must not be used deceptively or unlawfully. Voice selection is separate from uploading a sample to clone a new voice; cloning still uses NewsTune's recording, rights acknowledgement, and consent flow.

The helper creates `POST /api/v1/handoffs`, opens the returned `openUrl`, then polls `GET /api/v1/handoffs/{handoffId}` until the web UI completes, cancels, fails, or expires. Creating the handoff or opening its URL proves only that the interactive flow was prepared. Claim completion only from a terminal `completed` response and its returned result; for voice selection or cloning, re-list accessible voices/hosts before using the result, and never infer that a series binding occurred unless NewsTune explicitly reports it. The URL contains only an opaque handoff ID. It must never contain raw API keys, JWTs, local source content, or private files.

Use direct Public API calls instead of handoff when the user has already confirmed all required fields and no browser interaction is needed. Examples: creating a private series from confirmed host IDs, queuing `script_to_audio`, queuing `material_to_podcast`, polling jobs, rendering standalone TTS, or running the exact publish preview/execute flow. A `series_settings` handoff may open interactive publishing controls, but it is not an exact-publish approval token and must not be described as published until the web result and a fresh series read confirm the change.

### Guidance deep links (no handoff needed)

When you only need to point the user at a UI — no machine-readable result to poll — link directly instead of creating a handoff. The web app opens the matching interface automatically, and these links survive the login redirect, so they are safe to send to logged-out users:

- `https://podcast.newstune.app/beta/#api-keys` — API key management modal
- `https://podcast.newstune.app/beta/#voice-clone` — voice cloning (microphone) flow
- `https://podcast.newstune.app/beta/#host-create` — create a new host
- `https://podcast.newstune.app/beta/#agent-skills` — Agent Skills install instructions

Prefer a web handoff when you need to receive the result (selected voice/host IDs, created series) back in the conversation.

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

If the user wants a custom host, use the voice workflow first: list voices, search/adopt a community voice if needed, or open the secure cloning handoff for a consented user sample when interactive recording/upload is required. After a handoff completes, re-list accessible voices and hosts; only then create or select a host using a confirmed accessible voice and use that host ID in the series. Never claim that opening a handoff bound a voice to a series.

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

The existing-key list shows only a non-secret key identifier. That identifier is not enough for API calls. The user must copy the one-time secret from the creation popup and run `scripts/credentials.mjs set` in their own terminal; its input is hidden and the secret must never be pasted into AI chat. Future runs should reuse the shared local cache automatically.

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
NEWSTUNE_API_BASE_URL='https://api.newstune.app' \
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
