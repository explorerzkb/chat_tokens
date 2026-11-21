/**
 * Context Monitor sidecar backend.
 *
 * Read-only monitor for Antigravity conversation transcripts in:
 *   ~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/transcript.jsonl
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRAIN_DIR = join(homedir(), '.gemini', 'antigravity', 'brain');
const ID_RE = /^[0-9a-f-]{8,}$/i;

function resolveTranscriptPath(convId) {
  const logsDir = join(BRAIN_DIR, convId, '.system_generated', 'logs');
  const compact = join(logsDir, 'transcript.jsonl');
  if (existsSync(compact)) return compact;
  const full = join(logsDir, 'transcript_full.jsonl');
  if (existsSync(full)) return full;
  return null;
}

function cleanTitle(raw) {
  if (typeof raw !== 'string') return '';
  const singleLine = raw.replace(/\s+/g, ' ').trim();
  if (!singleLine) return '';
  return singleLine.length > 60 ? `${singleLine.slice(0, 57)}...` : singleLine;
}

function readTranscriptStats(convId) {
  const empty = {
    conversationId: convId,
    title: '',
    exists: false,
    contextTokens: 0,
    lastInputTokens: 0,
    lastCacheReadTokens: 0,
    lastOutputTokens: 0,
    lastDelta: 0,
    cacheHitPercent: 0,
    model: '',
    stepCount: 0,
    totalModelSteps: 0,
    peakTokens: 0,
    compactionEvents: 0,
    compactedSteps: [],
    recentSteps: [],
    updatedAt: null,
  };

  if (!convId || !ID_RE.test(convId)) return empty;
  const filePath = resolveTranscriptPath(convId);
  if (!filePath) return empty;

  let raw;
  let mtimeIso = null;
  try {
    mtimeIso = statSync(filePath).mtime.toISOString();
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return empty;
  }

  let title = '';
  let totalSteps = 0;
  const modelSteps = [];
  let peakTokens = 0;
  let compactionEvents = 0;
  const compactedSteps = [];
  let prevContext = 0;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    totalSteps += 1;
    if (!title && entry.type === 'USER_INPUT' && typeof entry.content === 'string') {
      title = cleanTitle(entry.content);
    }

    if (typeof entry.input_tokens === 'number') {
      const inputTokens = Number(entry.input_tokens) || 0;
      const cacheReadTokens = Number(entry.cache_read_tokens) || 0;
      const outputTokens = Number(entry.output_tokens) || 0;
      const contextTokens = inputTokens + cacheReadTokens;
      const stepIndex = Number.isFinite(entry.step_index) ? entry.step_index : totalSteps;

      if (peakTokens > 0) {
        const drop = peakTokens - contextTokens;
        if (drop > 25000 && drop / peakTokens > 0.3) {
          compactionEvents += 1;
          compactedSteps.push(stepIndex);
        }
      }
      if (contextTokens > peakTokens) {
        peakTokens = contextTokens;
      }

      const delta = modelSteps.length > 0 ? contextTokens - prevContext : contextTokens;
      prevContext = contextTokens;

      modelSteps.push({
        stepIndex,
        contextTokens,
        inputTokens,
        cacheReadTokens,
        outputTokens,
        delta,
        model: entry.model || '',
        createdAt: entry.created_at || null,
      });
    }
  }

  const last = modelSteps.length > 0 ? modelSteps[modelSteps.length - 1] : null;
  const contextTokens = last ? last.contextTokens : 0;
  const cacheHitPercent =
    last && contextTokens > 0 ? Math.round((last.cacheReadTokens / contextTokens) * 100) : 0;

  return {
    conversationId: convId,
    title: title || convId.slice(0, 8),
    exists: true,
    contextTokens,
    lastInputTokens: last ? last.inputTokens : 0,
    lastCacheReadTokens: last ? last.cacheReadTokens : 0,
    lastOutputTokens: last ? last.outputTokens : 0,
    lastDelta: last ? last.delta : 0,
    cacheHitPercent,
    model: last ? last.model : '',
    stepCount: totalSteps,
    totalModelSteps: modelSteps.length,
    peakTokens,
    compactionEvents,
    compactedSteps,
    recentSteps: modelSteps.slice(-12).reverse(),
    updatedAt: (last && last.createdAt) || mtimeIso,
  };
}

function listRecentConversations(limit = 10) {
  if (!existsSync(BRAIN_DIR)) return [];
  let entries;
  try {
    entries = readdirSync(BRAIN_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = [];
  for (const dirent of entries) {
    if (!dirent.isDirectory() || !ID_RE.test(dirent.name)) continue;
    const tp = resolveTranscriptPath(dirent.name);
    if (!tp) continue;
    try {
      const st = statSync(tp);
      candidates.push({ id: dirent.name, mtimeMs: st.mtimeMs });
    } catch {
      // skip unreadable transcript
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.slice(0, limit).map((item) => {
    const stats = readTranscriptStats(item.id);
    return {
      conversationId: stats.conversationId,
      title: stats.title,
      contextTokens: stats.contextTokens,
      model: stats.model,
      updatedAt: stats.updatedAt,
    };
  });
}

const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

app.api('/api/context', (data) => {
  const requestedId =
    typeof data.conversationId === 'string' && ID_RE.test(data.conversationId)
      ? data.conversationId
      : '';
  const recent = listRecentConversations(10);
  let convId = requestedId || (app.config.conversationId && ID_RE.test(app.config.conversationId) ? app.config.conversationId : '');
  if (!convId && recent.length > 0) {
    convId = recent[0].conversationId;
  }

  return {
    activeConversationId: convId || null,
    current: convId ? readTranscriptStats(convId) : null,
    recent,
  };
}, 'GET');

await app.run();
