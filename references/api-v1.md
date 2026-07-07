# NewsTune Agent API v1

Base URL:

```text
https://newstune-backend-fe0cc08f4613.herokuapp.com
```

Authentication:

```http
X-NT-API-Key: nt_live_...
Content-Type: application/json
Idempotency-Key: stable-operation-id
```

Never use the API key in a query string.

## Scopes

| Scope | Allows |
| --- | --- |
| `account:read` | `GET /api/v1/me` |
| `credits:read` | `GET /api/v1/credits` |
| `hosts:read` | `GET /api/v1/hosts` |
| `hosts:write` | `POST /api/v1/hosts` |
| `voices:read` | `GET /api/v1/voices`, `GET /api/v1/voices/external/models` |
| `voices:write` | Adopt an external voice with acknowledgement |
| `voices:clone` | Clone a user-provided audio sample |
| `series:read` | `GET /api/v1/series`, `GET /api/v1/series/{seriesId}` |
| `series:write` | Create series (also grants the `series:read` endpoints) |
| `episodes:read` | `GET /api/v1/series/{seriesId}/episodes`, `GET /api/v1/series/{seriesId}/episodes/{episodeNumber}` |
| `episodes:write` | Queue episodes (also grants the `episodes:read` endpoints) |
| `tts:render` | Standalone TTS rendering |
| `publish:write` | Public visibility, public slugs, SEO public surface |
| `rss:publish` | Enable or update RSS |

Read endpoints accept the read scope **or** the corresponding write scope (`series:read || series:write`, `episodes:read || episodes:write`), so keys issued before the read scopes existed keep working. A key with neither scope receives `403 { "error": "SCOPE_REQUIRED", "required": [...] }`, where `required` lists the acceptable (any-of) scopes.

## Safe Integration Rules

- Use `Idempotency-Key` on all creating POST requests. A concurrent duplicate may return `409 IDEMPOTENCY_REQUEST_IN_PROGRESS`; retry later with the same key to replay the completed result.
- When the user request is vague, do not create resources immediately. Run a short producer-style interview to clarify topic, audience, use case, source policy, host/voice, generation mode, and visibility.
- Treat user-provided sources as a SourceManifest with source type, priority, trust level, freshness expectation, update mode, citation requirement, allowed transformations, and provenance.
- Local folders, private files, PDFs, text files, CLI output, and developer logs default to local/agent processing plus `script_to_audio`. Send only summarized material or selected excerpts to `material_to_podcast` after explicit user approval.
- Before creating a podcast series, list/select hosts and ask the user to confirm the host IDs. Send those IDs as `hostIds` in `POST /api/v1/series`.
- Prefer owned hosts (`sourceTag: "mine"`). Built-in/public hosts can be used when the user approves them.
- If the user does not choose a host, use defaults by language: `zh-TW` -> `["builtin_zh_kai", "builtin_zh_luna"]`; `en` -> `["builtin_en_marcus", "builtin_en_sarah"]`.
- Do not queue podcast generation for a series with no usable host voice. `TTS_VOICE_NOT_BOUND` means the series needs hosts with bound voices before retrying.
- Default to private series and private episodes unless the user explicitly asks to publish.
- Any `visibility: "public"`, `publicSlug`, `seoTitle`, or `seoDescription` requires `publish:write`.
- RSS requires a public series and the `rss:publish` scope.
- Standalone TTS and script-to-audio only accept voices the caller may access: platform/builtin voices, user-owned voices, adopted external voices, or public/community voices. Arbitrary provider reference IDs are rejected.
- External voice adoption requires `voiceSourceAcknowledged: true`.
- Voice cloning requires active user voice consent and an audio upload.
- Credits are deducted for series creation, script-to-audio, and standalone TTS. Use `GET /api/v1/credits` before generation.
- API-key voice preview must use `GET /api/v1/voices` preview URLs or `POST /api/v1/tts` plus `GET /api/v1/jobs/{jobId}`. Do not use JWT-only `/api/voices/{referenceId}/preview`.

## Demand Interview and SourceManifest

Before choosing endpoints, gather enough information to make the request decision-complete:

- Podcast intent: topic, audience, use case, language, style, one-off vs ongoing series, output format.
- Sources: AI web search, specific URLs/RSS/YouTube, Notion/Google Docs/MCP tools, local folders, PDFs/text files, CLI output, developer logs, or pasted notes.
- Source policy: required/preferred/background/excluded sources, freshness expectation, whether citations are required, and whether the source keeps updating.
- Execution mode: local/agent script writing with `script_to_audio`, NewsTune cloud drafting with `material_to_podcast`, or standalone `tts_render`.
- Distribution: private by default; public/RSS only when explicitly requested.

Use the helper to produce a manifest for local or mixed sources:

```bash
node scripts/source_manifest.mjs \
  --source ./weekly-notes \
  --source https://example.com/feed.xml \
  --priority preferred \
  --freshness live \
  --update-mode watch
```

Example SourceManifest entry:

```json
{
  "source_id": "src_...",
  "source_type": "folder",
  "priority": "required",
  "trust_level": "high",
  "freshness_expectation": "live",
  "update_mode": "watch",
  "must_cite": true,
  "allowed_transformations": ["summarize", "quote_short_excerpts", "rewrite_as_podcast_script"],
  "path": "/absolute/local/path"
}
```

Final confirmation before any creating POST should include title/topic, use case, source summary, source privacy policy, host IDs, voice references, generation mode, visibility/RSS, and known credit implications.

## Key Management

Key management is for logged-in NewsTune users, not external agents.

Create a key from the authenticated app surface:

```text
https://podcast.newstune.app/beta/#api-keys
```

The existing-key list shows only a non-secret key identifier. Agents need the one-time `secret` shown immediately after creation. Store that secret in the local skill credential cache instead of source files or markdown:

```bash
node scripts/credentials.mjs set --key 'nt_live_...'
```

The backend API for the authenticated app is:

```http
POST /api/api-keys
Authorization: Bearer <app user token>
Content-Type: application/json

{
  "name": "My Agent",
  "scopes": ["account:read", "credits:read", "hosts:read", "voices:read", "series:write", "episodes:write", "tts:render"],
  "expiresAt": null
}
```

The response includes `secret` once. Store it securely.

## Core Checks

```bash
curl -s "$NEWSTUNE_API_BASE_URL/api/v1/me" \
  -H "X-NT-API-Key: $NEWSTUNE_API_KEY"

curl -s "$NEWSTUNE_API_BASE_URL/api/v1/credits" \
  -H "X-NT-API-Key: $NEWSTUNE_API_KEY"
```

## Jobs

Poll API-created jobs with the same API key that created them:

```http
GET /api/v1/jobs/{jobId}
```

Response:

```json
{
  "job": {
    "id": "...",
    "type": "api_tts_render",
    "status": "succeeded",
    "progress": 100,
    "step": "done",
    "result": {
      "mergedUrl": "https://...",
      "mergedAssetId": "asset_..."
    }
  }
}
```

Only the same API key that created the job can read it. A different key receives `403 JOB_FORBIDDEN`.

## Web Handoffs

Use handoffs when a step needs the authenticated NewsTune web UI: microphone recording, voice/host selection, host creation, series creation with user review, publish/RSS settings, API key management, or opening a private player.

Create a handoff:

```http
POST /api/v1/handoffs
X-NT-API-Key: nt_live_...
Content-Type: application/json

{
  "action": "voice_clone",
  "input": {
    "voiceName": "My Podcast Voice"
  },
  "ttlSeconds": 900
}
```

Response:

```json
{
  "handoffId": "handoff_...",
  "openUrl": "https://podcast.newstune.app/beta/#agent-handoff=handoff_...",
  "expiresAt": "2026-06-07T00:00:00.000Z",
  "handoff": {
    "id": "handoff_...",
    "action": "voice_clone",
    "status": "pending",
    "input": { "voiceName": "My Podcast Voice" }
  }
}
```

Poll the handoff:

```http
GET /api/v1/handoffs/{handoffId}
```

Cancel the handoff:

```http
POST /api/v1/handoffs/{handoffId}/cancel
```

Supported actions and minimum API key scopes:

| Action | Minimum scopes |
| --- | --- |
| `voice_clone` | `voices:clone` |
| `voice_select` | `voices:read` |
| `host_create` | `hosts:write` |
| `host_select` | `hosts:read` |
| `series_create` | `series:write` |
| `series_settings` | `series:write`; may also require `publish:write` or `rss:publish` when focused on publishing/RSS |
| `episode_player` | `account:read` |
| `api_keys` | `account:read` |

The web app completes the handoff with JWT-only product routes:

```http
GET /api/handoffs/{handoffId}
POST /api/handoffs/{handoffId}/complete
```

Agents should not call those JWT routes directly. They are only for the logged-in browser. The frontend verifies that the logged-in user owns the handoff before completing it.

Helper:

```bash
node scripts/web_handoff.mjs voice_clone \
  --input-json '{"voiceName":"My Podcast Voice"}' \
  --app-window
```

The helper opens the returned `openUrl` and polls until `completed`, `cancelled`, `expired`, or `failed`. It never prints the raw API key.

## Hosts

List hosts:

```http
GET /api/v1/hosts?source=all
```

Use returned `host.id` values when creating the series. For example, after the user confirms Kai and Luna:

```json
{
  "hostIds": ["builtin_zh_kai", "builtin_zh_luna"]
}
```

Create a host:

```http
POST /api/v1/hosts
Idempotency-Key: host-create-001

{
  "name": "Product Analyst",
  "style": "Calm, precise, skeptical",
  "bio": "Explains technical product updates",
  "visibility": "private",
  "ttsVoice": {
    "referenceId": "allowed-voice-reference",
    "backend": "fish"
  }
}
```

## Voices

List voices:

```http
GET /api/v1/voices
```

Search external Fish models:

```http
GET /api/v1/voices/external/models?page_size=10&title=Mandarin
```

Adopt an external voice:

```http
POST /api/v1/voices/external/use
Idempotency-Key: voice-use-001

{
  "referenceId": "provider-model-id",
  "name": "Narrator Voice",
  "backend": "fish",
  "voiceSourceAcknowledged": true
}
```

Clone a voice:

```bash
curl -s "$NEWSTUNE_API_BASE_URL/api/v1/voices/clone" \
  -H "X-NT-API-Key: $NEWSTUNE_API_KEY" \
  -F "title=My Private Voice" \
  -F "audio=@sample.wav;type=audio/wav"
```

## Series

### Read endpoints and the 404 deployment gap

The four read endpoints below (`GET /api/v1/series`, series detail, episode list, episode detail) are newer than the write endpoints. Until the backend deploy that includes them lands on production, they return `404`. Treat a `404` from these endpoints as "not yet deployed", not as an error: degrade to local caches (`podcast.json` `seriesSnapshot`, `ledger.json`), print a single stderr notice, and continue. `scripts/episode_from_journal.mjs` already implements this degradation for `bind` and `collect`.

List the caller's series (`series:read` or `series:write`):

```http
GET /api/v1/series?limit=50
```

`limit` defaults to 50, maximum 100. Sorted by `createdAt` descending. Only series owned by the key's user are returned. Missing fields are omitted from each item; dates are ISO strings.

```json
{
  "ok": true,
  "series": [
    {
      "id": "srs_...",
      "title": "Agent Briefing",
      "topic": "Weekly AI product updates",
      "language": "zh-TW",
      "episodeFormat": "brief",
      "visibility": "private",
      "hostIds": ["builtin_zh_kai", "builtin_zh_luna"],
      "createdAt": "2026-07-06T00:00:00.000Z",
      "updatedAt": "2026-07-06T00:00:00.000Z"
    }
  ]
}
```

Read one series (`series:read` or `series:write`):

```http
GET /api/v1/series/{seriesId}
```

```json
{
  "ok": true,
  "series": {
    "id": "srs_...",
    "title": "Agent Briefing",
    "topic": "Weekly AI product updates",
    "style": "Conversational podcast",
    "perspective": "Balanced explainer",
    "includeOpposingViewpoint": false,
    "depthVsBreadth": 3,
    "targetDurationMinutes": 10,
    "episodeFormat": "brief",
    "language": "zh-TW",
    "hostIds": ["builtin_zh_kai", "builtin_zh_luna"],
    "visibility": "private",
    "createdAt": "2026-07-06T00:00:00.000Z"
  }
}
```

Optional fields when present: `publicSlug`, `rss` (summary only: `{ "enabled": true, "url": "/api/series/{seriesId}/rss" }`; `url` is `null` while disabled), `seriesDNA`, `sourcePolicy`. Internal fields such as `customPrompts` are never returned.

Ownership is enforced without leaking existence: both a nonexistent series and another user's series return `404 SERIES_NOT_FOUND`.

Create a private series:

```http
POST /api/v1/series
Idempotency-Key: series-create-001

{
  "title": "Agent Briefing",
  "topic": "Weekly AI product updates",
  "language": "zh-TW",
  "hostIds": ["builtin_zh_kai", "builtin_zh_luna"],
  "episodeFormat": "brief",
  "seriesMode": "news",
  "colors": {
    "primary": "#2563eb",
    "accent": "#f97316"
  }
}
```

Create a public series only when explicitly requested:

```json
{
  "title": "Public Agent Briefing",
  "topic": "AI news",
  "hostIds": ["builtin_zh_kai", "builtin_zh_luna"],
  "visibility": "public",
  "publicSlug": "public-agent-briefing",
  "seoTitle": "Public Agent Briefing",
  "seoDescription": "AI generated public podcast series"
}
```

Publish or unpublish an existing series:

```http
PATCH /api/v1/series/{seriesId}/visibility

{
  "visibility": "public",
  "publicSlug": "my-series",
  "seoTitle": "My Series",
  "seoDescription": "Public podcast feed",
  "colors": {
    "primary": "#2563eb",
    "accent": "#f97316"
  }
}
```

Enable RSS after the series is public:

```http
PATCH /api/v1/series/{seriesId}/rss

{
  "enabled": true,
  "language": "zh-TW",
  "author": "NewsTune",
  "ownerEmail": "owner@example.com",
  "category": "Technology"
}
```

## Episodes

List episodes of an owned series (`episodes:read` or `episodes:write`; 404 means the endpoint is not deployed yet — fall back to `ledger.json`):

```http
GET /api/v1/series/{seriesId}/episodes?limit=20&order=desc
```

`limit` defaults to 20, maximum 50. `order` defaults to `desc` by `episodeNumber`; pass `order=asc` for oldest-first.

```json
{
  "ok": true,
  "episodes": [
    {
      "episodeNumber": 3,
      "title": "Episode 3",
      "summary": "本集摘要……",
      "closingCliffhanger": "下集預告……",
      "status": "ready",
      "createdAt": "2026-07-06T00:00:00.000Z",
      "hasAudio": true
    }
  ]
}
```

`summary` and `closingCliffhanger` are `null` when the episode does not have them. `hasAudio` is `true` when merged audio exists.

Read one episode including its script (`episodes:read` or `episodes:write`):

```http
GET /api/v1/series/{seriesId}/episodes/{episodeNumber}
```

`episodeNumber` must be an integer; anything else (`1.5`, `abc`) returns `400 EPISODE_NUMBER_INVALID`. A missing episode returns `404 EPISODE_NOT_FOUND`.

The response adds two fields to the list-item shape:

- `script`: the final episode script, resolved as `finalScriptV2 || supplementedScript || finalScript || null`.
- `topics`: string array of the episode's topics (from its search plan), `[]` when absent.

Use `material_to_podcast` when NewsTune should write and produce the episode from supplied material:

```http
POST /api/v1/series/{seriesId}/episodes
Idempotency-Key: episode-material-001

{
  "mode": "material_to_podcast",
  "title": "Episode 1",
  "brief": "Explain the product launch clearly.",
  "sourceMaterial": "Agent gathered notes and citations..."
}
```

Use `material_to_podcast` for shareable source material and higher-quality cloud drafting. If the user has local folders, private documents, CLI output, or development logs, prefer local/agent processing and call `script_to_audio` with the finished script unless the user explicitly approves sending summarized source material to NewsTune cloud.

Use `script_to_audio` when the caller already generated the script:

```http
POST /api/v1/series/{seriesId}/episodes
Idempotency-Key: episode-script-001

{
  "mode": "script_to_audio",
  "title": "Episode 1",
  "hostIds": ["host_..."],
  "script": "Host A: Welcome...\nHost B: Here is the update...",
  "summary": "本集摘要，回填伺服器端記憶供未來集數延續。",
  "topics": ["launchd scheduling", "journal pipeline"],
  "hostGuidance": "Kai 主導開場，Luna 負責技術補充。",
  "visibility": "private"
}
```

Optional continuity fields on `script_to_audio` (validated before any credits are deducted):

| Field | Constraint | Error on violation |
| --- | --- | --- |
| `summary` | string, trimmed, up to 4000 chars | `400 SUMMARY_TOO_LONG` |
| `topics` | string array, up to 20 items | `400 TOPICS_TOO_MANY` (non-array: `400 TOPICS_INVALID`) |
| `topics[]` item | up to 200 chars each | `400 TOPIC_TOO_LONG` |
| `hostGuidance` | string, up to 4000 chars | `400 HOST_GUIDANCE_TOO_LONG` |

`summary` and `topics` are stored on the episode so future generations (and the read endpoints above) can see what a script-to-audio episode covered — without them, script-to-audio episodes are invisible to NewsTune's native episode-continuity memory. `hostGuidance` is accepted on every mode: `script_to_audio` persists it on the episode; `material_to_podcast` also passes it into the generation pipeline. If the deployed backend predates these fields, it ignores the unknown fields harmlessly; the journal `submit` flow compensates by recording `summary`/`topics` in the local `ledger.json`.

The response queues a job:

```json
{
  "jobId": "...",
  "episodeId": "srs_...:0003",
  "episodeNumber": 3,
  "status": "queued",
  "mode": "script_to_audio"
}
```

### Episode visibility on create

`POST /api/v1/series/{seriesId}/episodes` accepts an optional `visibility` field (`"public"` | `"private"`, both modes):

- Omitted → `script_to_audio` persists `private` explicitly. `material_to_podcast` leaves the field **unset**, which the backend treats as public-eligible: the episode stays hidden for now, but the next series-visibility toggle (or an owner saving the series in the app) backfills a `publicSlug` and publishes it. If an episode must stay hidden, send `"private"` explicitly.
- `"public"` → requires `publish:write` on the API key. **Auto-slug applies to `script_to_audio` only**: in a public series that mode allocates the episode's `publicSlug` when the render finishes (the create response may not carry it yet). `material_to_podcast` never auto-allocates — after the job completes, call the visibility PATCH below once (idempotent) to allocate the slug and make the episode actually visible.
- A public episode inside a private series stays unreachable until the series itself is published.

`scripts/episode_from_journal.mjs submit` resolves the value it sends as: `--visibility` flag → `podcast.json` `episodeVisibility` → series default (`public` when the bound series is public, else `private`).

### Change episode visibility

Retroactively publish or unpublish a single episode (`publish:write`):

```http
PATCH /api/v1/series/{seriesId}/episodes/{episodeNumber}/visibility

{
  "visibility": "public"
}
```

```json
{
  "ok": true,
  "episode": {
    "episodeNumber": 3,
    "visibility": "public",
    "publicSlug": "my-episode-slug",
    "status": "ready"
  }
}
```

`publicSlug` is `null` when the episode is not yet `audio_ready` (the PATCH persists visibility, but slugs are only allocated for ready episodes). In that case re-run the same PATCH once the episode is ready — it is idempotent and will allocate the slug then. This endpoint is newer than the create endpoint: until the backend deploy lands it returns `404` — treat that as "not yet deployed" (same degradation convention as the read endpoints above), print a stderr note, and retry after deploy. `scripts/episode_from_journal.mjs publish` implements exactly this.

The public episode page URL is `https://podcast.newstune.app` + (`/zh-tw` when the series language is `zh`, `zh-TW`, or `zh-Hant*`; empty otherwise, including `zh-Hans`/`zh-CN`) + `/episode/{publicSlug}/`.

## Standalone TTS

```http
POST /api/v1/tts
Idempotency-Key: tts-001

{
  "text": "Render this short narration.",
  "voice": {
    "referenceId": "allowed-voice-reference",
    "backend": "fish"
  }
}
```

The response queues a job:

```json
{
  "jobId": "...",
  "status": "queued",
  "mode": "tts_render"
}
```

Then poll the job:

```http
GET /api/v1/jobs/{jobId}
```

Use the job result's `mergedUrl`, `ttsAudio.merged`, or `mergedAssetId` as the rendered audio output.

For voice preview, first prefer `GET /api/v1/voices` entries with `previewUrl`. If no preview URL is available and the user approves spending TTS credits, call `POST /api/v1/tts` with a short sample text, then poll `/api/v1/jobs/{jobId}`.
