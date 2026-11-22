/**
 * Context Monitor sidecar backend.
 *
 * Read-only monitor for Antigravity conversation transcripts in:
 *   ~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRAIN_DIR = join(homedir(), '.gemini', 'antigravity', 'brain');
const ID_RE = /^[0-9a-f-]{8,}$/i;

const transcriptCache = new Map();
const stepLogCache = new Map();

function systemDefaultLanguage() {
  try {
    const loc = Intl.DateTimeFormat().resolvedOptions().locale || 'en';
    return loc.toLowerCase().startsWith('ru') ? 'ru' : 'en';
  } catch {
    return 'en';
  }
}

function resolveTranscriptPath(convId) {
  const logsDir = join(BRAIN_DIR, convId, '.system_generated', 'logs');
  const full = join(logsDir, 'transcript_full.jsonl');
  if (existsSync(full)) return full;
  const compact = join(logsDir, 'transcript.jsonl');
  if (existsSync(compact)) return compact;
  return null;
}

function cleanTitle(raw) {
  if (typeof raw !== 'string') return '';
  const stripped = raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<\/?USER_REQUEST>/g, '');
  const singleLine = stripped.replace(/\s+/g, ' ').trim();
  if (!singleLine) return '';
  return singleLine.length > 60 ? `${singleLine.slice(0, 57)}...` : singleLine;
}

function buildBreakdown({
  lastTotal,
  firstModelTotal,
  firstUserChars,
  systemMsgChars,
  toolsChars,
  assistantChars,
  userChars,
  totalOutputTokens,
  userTurns,
  toolCallsCount,
  toolNameCounts,
}) {
  const topTools = Object.entries(toolNameCounts)
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .slice(0, 3)
    .map(([name, count]) => ({ name, count }));

  if (lastTotal <= 0) {
    return {
      systemTokens: 0,
      toolsTokens: 0,
      assistantTokens: 0,
      userTokens: 0,
      totalOutputTokens,
      userTurns,
      toolCallsCount,
      topTools,
    };
  }

  const baseSystemEst =
    firstModelTotal !== null
      ? Math.min(Math.max(firstModelTotal - Math.floor(firstUserChars / 4), 0), Math.min(lastTotal, 35000))
      : 0;

  const rawSys = baseSystemEst + Math.floor(systemMsgChars / 4);
  const rawTools = Math.floor(toolsChars / 4);
  const rawAssistant = Math.floor(assistantChars / 4);
  const rawUser = Math.floor(userChars / 4);
  const rawSum = rawSys + rawTools + rawAssistant + rawUser;

  let systemTokens;
  let toolsTokens;
  let assistantTokens;
  let userTokens;

  if (rawSum > 0) {
    const scale = lastTotal / rawSum;
    systemTokens = Math.round(rawSys * scale);
    toolsTokens = Math.round(rawTools * scale);
    assistantTokens = Math.round(rawAssistant * scale);
    userTokens = Math.max(0, lastTotal - systemTokens - toolsTokens - assistantTokens);
  } else {
    systemTokens = lastTotal;
    toolsTokens = 0;
    assistantTokens = 0;
    userTokens = 0;
  }

  return {
    systemTokens,
    toolsTokens,
    assistantTokens,
    userTokens,
    totalOutputTokens,
    userTurns,
    toolCallsCount,
    topTools,
  };
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
    recentMessages: [],
    breakdown: {
      systemTokens: 0,
      toolsTokens: 0,
      assistantTokens: 0,
      userTokens: 0,
      totalOutputTokens: 0,
      userTurns: 0,
      toolCallsCount: 0,
      topTools: [],
    },
    sessionStats: {
      primaryModel: '',
      otherModelsCount: 0,
      modelUsage: [],
      totalInputTokens: 0,
      totalCacheReadTokens: 0,
      totalOutputTokens: 0,
      avgCacheHitPercent: 0,
      durationSeconds: 0,
      mediaCount: 0,
      errorCount: 0,
      userMessageCount: 0,
    },
    updatedAt: null,
  };

  if (!convId || !ID_RE.test(convId)) return empty;
  const filePath = resolveTranscriptPath(convId);
  if (!filePath) return empty;

  let st;
  try {
    st = statSync(filePath);
  } catch {
    return empty;
  }

  const cached = transcriptCache.get(convId);
  if (cached && cached.path === filePath && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.stats;
  }

  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return empty;
  }

  const mtimeIso = st.mtime.toISOString();
  let title = '';
  let totalSteps = 0;
  const modelSteps = [];
  const messageTurns = [];
  let allTimePeak = 0;
  let segmentPeak = 0;
  let pendingCompaction = false;
  let compactionEvents = 0;
  const compactedSteps = [];
  let prevContext = 0;

  let firstModelTotal = null;
  let firstUserChars = 0;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let userTurns = 0;
  let toolCallsCount = 0;
  const toolNameCounts = {};
  const modelStepCounts = {};
  const modelOutputCounts = {};
  const modelLastSeenIndex = {};
  let firstTsMs = null;
  let lastTsMs = null;
  let mediaCount = 0;
  let errorCount = 0;

  let userChars = 0;
  let assistantChars = 0;
  let toolsChars = 0;
  let systemMsgChars = 0;

  let currentTurnIndex = 0;
  let currentTurnSteps = 0;
  let currentTurnEndTokens = 0;
  let currentTurnSumInput = 0;
  let currentTurnSumCache = 0;
  let currentTurnLastCache = 0;
  let currentTurnHadCompaction = false;
  let previousTurnEndTokens = 0;

  const finalizeCurrentTurn = () => {
    if (currentTurnSteps <= 0) return;
    const denom = currentTurnSumInput + currentTurnSumCache;
    const cacheHitPercent = denom > 0 ? Math.round((currentTurnSumCache / denom) * 100) : 0;
    messageTurns.push({
      turnIndex: Math.max(1, currentTurnIndex),
      contextTokens: currentTurnEndTokens,
      delta: currentTurnEndTokens - previousTurnEndTokens,
      modelStepsInTurn: currentTurnSteps,
      cacheReadTokens: currentTurnLastCache,
      cacheHitPercent,
      hadCompaction: currentTurnHadCompaction,
    });
    previousTurnEndTokens = currentTurnEndTokens;
    currentTurnSteps = 0;
    currentTurnSumInput = 0;
    currentTurnSumCache = 0;
    currentTurnLastCache = 0;
    currentTurnHadCompaction = false;
  };

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    totalSteps += 1;
    const contentStr = typeof entry.content === 'string' ? entry.content : '';

    if (typeof entry.created_at === 'string') {
      const ts = Date.parse(entry.created_at);
      if (Number.isFinite(ts)) {
        if (firstTsMs === null) firstTsMs = ts;
        lastTsMs = ts;
      }
    }
    if (Array.isArray(entry.media)) {
      mediaCount += entry.media.length;
    }
    if (typeof entry.error === 'string' && entry.error.trim().length > 0) {
      errorCount += 1;
    }

    if (entry.type === 'CHECKPOINT') {
      compactionEvents += 1;
      pendingCompaction = true;
      segmentPeak = 0;
      userChars = 0;
      assistantChars = 0;
      toolsChars = 0;
      systemMsgChars = 0;
      if (currentTurnSteps > 0) currentTurnHadCompaction = true;
      continue;
    }

    if (entry.type === 'USER_INPUT') {
      finalizeCurrentTurn();
      userTurns += 1;
      currentTurnIndex = userTurns;
      currentTurnSteps = 0;
      currentTurnEndTokens = 0;
      currentTurnSumInput = 0;
      currentTurnSumCache = 0;
      currentTurnLastCache = 0;
      currentTurnHadCompaction = false;
      userChars += contentStr.length;
      if (firstModelTotal === null) {
        firstUserChars += contentStr.length;
      }
      if (!title && contentStr) {
        title = cleanTitle(contentStr);
      }
    } else if (entry.type === 'PLANNER_RESPONSE') {
      assistantChars += contentStr.length;
      if (typeof entry.thinking === 'string') {
        assistantChars += entry.thinking.length;
      }
      if (Array.isArray(entry.tool_calls)) {
        toolCallsCount += entry.tool_calls.length;
        for (const call of entry.tool_calls) {
          if (call && typeof call.name === 'string' && call.name) {
            toolNameCounts[call.name] = (toolNameCounts[call.name] || 0) + 1;
          }
        }
        try {
          toolsChars += JSON.stringify(entry.tool_calls).length;
        } catch {
          // ignore serialization error
        }
      }
    } else if (entry.type === 'SYSTEM_MESSAGE') {
      systemMsgChars += contentStr.length;
    } else if (entry.type === 'GENERIC') {
      toolsChars += contentStr.length;
    }

    if (typeof entry.input_tokens === 'number') {
      const inputTokens = Number(entry.input_tokens) || 0;
      const cacheReadTokens = Number(entry.cache_read_tokens) || 0;
      const outputTokens = Number(entry.output_tokens) || 0;
      const contextTokens = inputTokens + cacheReadTokens;
      const stepIndex = Number.isFinite(entry.step_index) ? entry.step_index : totalSteps;
      const modelName = typeof entry.model === 'string' ? entry.model : '';

      if (firstModelTotal === null) firstModelTotal = contextTokens;
      totalInputTokens += inputTokens;
      totalCacheReadTokens += cacheReadTokens;
      totalOutputTokens += outputTokens;

      if (modelName) {
        modelStepCounts[modelName] = (modelStepCounts[modelName] || 0) + 1;
        modelOutputCounts[modelName] = (modelOutputCounts[modelName] || 0) + outputTokens;
        modelLastSeenIndex[modelName] = modelSteps.length;
      }

      let isCompaction = false;
      if (pendingCompaction) {
        isCompaction = true;
        pendingCompaction = false;
        segmentPeak = contextTokens;
        compactedSteps.push(stepIndex);
      } else if (segmentPeak > 0) {
        const drop = segmentPeak - contextTokens;
        if (drop > 25000 && drop / segmentPeak > 0.3) {
          compactionEvents += 1;
          isCompaction = true;
          segmentPeak = contextTokens;
          compactedSteps.push(stepIndex);
          userChars = 0;
          assistantChars = 0;
          toolsChars = 0;
          systemMsgChars = 0;
        } else if (contextTokens > segmentPeak) {
          segmentPeak = contextTokens;
        }
      } else {
        segmentPeak = contextTokens;
      }

      if (contextTokens > allTimePeak) {
        allTimePeak = contextTokens;
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
        isCompaction,
        model: modelName,
        createdAt: entry.created_at || null,
      });

      if (currentTurnIndex === 0) currentTurnIndex = 1;
      currentTurnSteps += 1;
      currentTurnEndTokens = contextTokens;
      currentTurnSumInput += inputTokens;
      currentTurnSumCache += cacheReadTokens;
      currentTurnLastCache = cacheReadTokens;
      if (isCompaction) currentTurnHadCompaction = true;
    }
  }

  finalizeCurrentTurn();

  const modelUsage = Object.entries(modelStepCounts)
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return (modelLastSeenIndex[b[0]] ?? -1) - (modelLastSeenIndex[a[0]] ?? -1);
    })
    .map(([name, steps]) => ({
      name,
      steps,
      outputTokens: modelOutputCounts[name] || 0,
    }));

  const last = modelSteps.length > 0 ? modelSteps[modelSteps.length - 1] : null;
  const contextTokens = last ? last.contextTokens : 0;
  const cacheHitPercent =
    last && contextTokens > 0 ? Math.round((last.cacheReadTokens / contextTokens) * 100) : 0;

  const sessionDenom = totalInputTokens + totalCacheReadTokens;
  const avgCacheHitPercent = sessionDenom > 0 ? Math.round((totalCacheReadTokens / sessionDenom) * 100) : 0;
  const durationSeconds =
    firstTsMs !== null && lastTsMs !== null && lastTsMs >= firstTsMs
      ? Math.round((lastTsMs - firstTsMs) / 1000)
      : 0;

  const stats = {
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
    peakTokens: allTimePeak,
    compactionEvents,
    compactedSteps,
    recentSteps: modelSteps.slice(-12).reverse(),
    recentMessages: messageTurns.slice(-12).reverse(),
    breakdown: buildBreakdown({
      lastTotal: contextTokens,
      firstModelTotal,
      firstUserChars,
      systemMsgChars,
      toolsChars,
      assistantChars,
      userChars,
      totalOutputTokens,
      userTurns,
      toolCallsCount,
      toolNameCounts,
    }),
    sessionStats: {
      primaryModel: modelUsage[0]?.name || (last ? last.model : ''),
      otherModelsCount: Math.max(0, modelUsage.length - 1),
      modelUsage,
      totalInputTokens,
      totalCacheReadTokens,
      totalOutputTokens,
      avgCacheHitPercent,
      durationSeconds,
      mediaCount,
      errorCount,
      userMessageCount: Math.max(userTurns, messageTurns.length),
    },
    updatedAt: (last && last.createdAt) || mtimeIso,
  };

  transcriptCache.set(convId, { path: filePath, mtimeMs: st.mtimeMs, size: st.size, stats });
  return stats;
}

function readStepRecords(convId, filePath, st) {
  const cached = stepLogCache.get(convId);
  if (cached && cached.path === filePath && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.records;
  }

  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const fallbackMs = st.mtimeMs;
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.input_tokens !== 'number') continue;
    const parsedMs = typeof entry.created_at === 'string' ? Date.parse(entry.created_at) : NaN;
    records.push({
      tsMs: Number.isFinite(parsedMs) ? parsedMs : fallbackMs,
      model: typeof entry.model === 'string' ? entry.model : '',
      inputTokens: Number(entry.input_tokens) || 0,
      cacheReadTokens: Number(entry.cache_read_tokens) || 0,
      outputTokens: Number(entry.output_tokens) || 0,
    });
  }

  stepLogCache.set(convId, { path: filePath, mtimeMs: st.mtimeMs, size: st.size, records });
  return records;
}

function readPeriodStats(hours = 24) {
  const cutoffMs = Date.now() - hours * 3600 * 1000;
  const empty = {
    windowHours: hours,
    activeChats: 0,
    modelSteps: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalOutputTokens: 0,
    avgCacheHitPercent: 0,
    modelUsage: [],
  };
  if (!existsSync(BRAIN_DIR)) return empty;

  let entries;
  try {
    entries = readdirSync(BRAIN_DIR, { withFileTypes: true });
  } catch {
    return empty;
  }

  let activeChats = 0;
  let modelSteps = 0;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  const modelCounts = {};
  const modelOutputs = {};

  for (const dirent of entries) {
    if (!dirent.isDirectory() || !ID_RE.test(dirent.name)) continue;
    const filePath = resolveTranscriptPath(dirent.name);
    if (!filePath) continue;
    let st;
    try {
      st = statSync(filePath);
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoffMs) continue;

    const records = readStepRecords(dirent.name, filePath, st);
    let matchedChat = false;
    for (const rec of records) {
      if (rec.tsMs < cutoffMs) continue;
      matchedChat = true;
      modelSteps += 1;
      totalInputTokens += rec.inputTokens;
      totalCacheReadTokens += rec.cacheReadTokens;
      totalOutputTokens += rec.outputTokens;
      if (rec.model) {
        modelCounts[rec.model] = (modelCounts[rec.model] || 0) + 1;
        modelOutputs[rec.model] = (modelOutputs[rec.model] || 0) + rec.outputTokens;
      }
    }
    if (matchedChat) activeChats += 1;
  }

  const denom = totalInputTokens + totalCacheReadTokens;
  const avgCacheHitPercent = denom > 0 ? Math.round((totalCacheReadTokens / denom) * 100) : 0;
  const modelUsage = Object.entries(modelCounts)
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .map(([name, steps]) => ({
      name,
      steps,
      outputTokens: modelOutputs[name] || 0,
    }));

  return {
    windowHours: hours,
    activeChats,
    modelSteps,
    totalInputTokens,
    totalCacheReadTokens,
    totalOutputTokens,
    avgCacheHitPercent,
    modelUsage,
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

  const includeStats = data.includeStats === '1' || data.includeStats === 'true';
  const hours = Number(data.hours) === 168 ? 168 : 24;

  return {
    activeConversationId: convId || null,
    language: systemDefaultLanguage(),
    current: convId ? readTranscriptStats(convId) : null,
    recent,
    periodStats: includeStats ? readPeriodStats(hours) : null,
  };
}, 'GET');

await app.run();
