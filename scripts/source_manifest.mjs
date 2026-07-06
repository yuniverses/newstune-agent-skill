#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log', '.xml',
  '.html', '.htm', '.yaml', '.yml', '.toml', '.ini', '.env', '.js', '.jsx', '.ts',
  '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cc', '.cpp',
  '.h', '.hpp', '.cs', '.php', '.sql',
]);

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`NewsTune SourceManifest helper

Usage:
  node scripts/source_manifest.mjs --source <url-or-path> [--source <url-or-path> ...]
  node scripts/source_manifest.mjs --source ./notes --priority required --freshness live --update-mode watch

Options:
  --source <value>             URL, RSS/YouTube URL, file path, or folder path. Repeatable.
  --priority <value>           required | preferred | optional | background. Default: preferred.
  --trust <value>              high | medium | low | unknown. Default: unknown.
  --freshness <value>          static | recent | live | user_defined. Default: user_defined.
  --update-mode <value>        one_time | watch | scheduled. Default: one_time.
  --must-cite <true|false>     Whether the generated episode should cite/use this source explicitly.
  --topic <value>              Optional topic binding for the source.
  --max-files <number>         Folder scan cap. Default: 80.
  --max-snippet-chars <number> Text snippet cap per file. Default: 1200.

The helper prints JSON only. It does not upload local files to NewsTune.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = { sources: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') usage(0);
    if (!arg.startsWith('--')) {
      out.sources.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (key === 'source') {
      if (!next || next.startsWith('--')) throw new Error('--source requires a value');
      out.sources.push(next);
      index += 1;
      continue;
    }
    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    index += 1;
  }
  return out;
}

function stableId(input) {
  return `src_${crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 12)}`;
}

function isUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function classifyUrl(value) {
  const lower = value.toLowerCase();
  if (lower.includes('youtube.com/') || lower.includes('youtu.be/')) return 'youtube';
  if (lower.endsWith('.xml') || lower.includes('/rss') || lower.includes('feed')) return 'rss';
  return 'url';
}

function classifyPath(filePath, stats) {
  if (stats.isDirectory()) return 'folder';
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'file';
}

function readSnippet(filePath, maxChars) {
  const ext = path.extname(filePath).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext)) return undefined;
  try {
    return fs.readFileSync(filePath, 'utf8').slice(0, maxChars);
  } catch {
    return undefined;
  }
}

function scanFolder(folderPath, options) {
  const maxFiles = Number(options['max-files'] || 80);
  const maxSnippetChars = Number(options['max-snippet-chars'] || 1200);
  const rows = [];
  const stack = [folderPath];
  while (stack.length && rows.length < maxFiles) {
    const current = stack.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      let stats;
      try {
        stats = fs.statSync(fullPath);
      } catch {
        continue;
      }
      rows.push({
        path: fullPath,
        name: entry.name,
        source_type: classifyPath(fullPath, stats),
        size_bytes: stats.size,
        updated_at: stats.mtime.toISOString(),
        snippet: readSnippet(fullPath, maxSnippetChars),
      });
      if (rows.length >= maxFiles) break;
    }
  }
  return rows;
}

function baseManifestFields(raw, options) {
  return {
    source_id: stableId(raw),
    priority: String(options.priority || 'preferred'),
    trust_level: String(options.trust || 'unknown'),
    freshness_expectation: String(options.freshness || 'user_defined'),
    update_mode: String(options['update-mode'] || 'one_time'),
    must_cite: String(options['must-cite'] || 'false') === 'true',
    allowed_transformations: ['summarize', 'quote_short_excerpts', 'rewrite_as_podcast_script'],
    topic_binding: options.topic ? String(options.topic) : undefined,
  };
}

function manifestForSource(raw, options) {
  const common = baseManifestFields(raw, options);
  if (isUrl(raw)) {
    return {
      ...common,
      source_type: classifyUrl(raw),
      url: raw,
    };
  }

  const resolved = path.resolve(raw);
  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    return {
      ...common,
      source_type: 'missing_path',
      path: resolved,
      error: 'PATH_NOT_FOUND',
    };
  }

  const sourceType = classifyPath(resolved, stats);
  const row = {
    ...common,
    source_type: sourceType,
    path: resolved,
    name: path.basename(resolved),
    size_bytes: stats.size,
    updated_at: stats.mtime.toISOString(),
  };
  if (stats.isDirectory()) {
    return {
      ...row,
      files: scanFolder(resolved, options),
    };
  }
  return {
    ...row,
    snippet: readSnippet(resolved, Number(options['max-snippet-chars'] || 1200)),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.sources.length) usage(1);
  const sources = options.sources.map((source) => manifestForSource(source, options));
  process.stdout.write(`${JSON.stringify({
    version: 'newstune-source-manifest-v1',
    created_at: new Date().toISOString(),
    sources,
  }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
