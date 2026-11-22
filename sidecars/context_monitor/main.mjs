/**
 * Context Monitor sidecar backend.
 *
 * Read-only monitor for Antigravity conversation transcripts in:
 *   ~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/
 */
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarApp } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const AGY_DIR = join(HOME, '.gemini', 'antigravity');
const BRAIN_DIR = join(AGY_DIR, 'brain');
const DB_PATH = join(AGY_DIR, 'conversation_summaries.db');
const DB_WAL_PATH = `${DB_PATH}-wal`;
const PREFS_PATH = join(HOME, '.gemini', 'config', 'chat_tokens_prefs.json');
const ID_RE = /^[0-9a-f-]{8,}$/i;

function resolveAntigravitySupportDir() {
  const plat = platform();
  if (plat === 'darwin') {
    return join(HOME, 'Library', 'Application Support', 'Antigravity');
  }
  if (plat === 'win32') {
    const appData = process.env.APPDATA || join(HOME, 'AppData', 'Roaming');
    return join(appData, 'Antigravity');
  }
  const configHome = process.env.XDG_CONFIG_HOME || join(HOME, '.config');
  return join(configHome, 'Antigravity');
}

const SUPPORT_DIR = resolveAntigravitySupportDir();
const APP_STORAGE_PATH = join(SUPPORT_DIR, 'app_storage.json');
const USER_SETTINGS_PATH = join(SUPPORT_DIR, 'User', 'settings.json');

const MODEL_SELECTION_RE = /changed setting `Model Selection` from ([^\n]+?) to ([^\n.]+(?:\.[^\n.]*)*?)\./g;
const FILE_TOOLS = new Set([
  'read_file',
  'view_file',
  'edit_file',
  'write_file',
  'write_to_file',
  'replace_file_content',
]);
const DROP_MODEL_TOKENS = new Set([
  'gemini',
  'claude',
  'anthropic',
  'google',
  'agy',
  'orchestrator',
  'worker',
]);
const KNOWN_SHORT_MODELS = [
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku'],
  ['argon', 'Argon'],
  ['hydrogen', 'Hydrogen'],
  ['neon', 'Neon'],
  ['flash', 'Flash'],
  ['pro', 'Pro'],
];

const transcriptStates = new Map();
const periodCache = new Map();
let summariesCache = null;
let recentCache = null;
let appThemeCache = null;
let prefsCache = null;

function systemDefaultLanguage() {
  try {
    const loc = Intl.DateTimeFormat().resolvedOptions().locale || 'en';
    return loc.toLowerCase().startsWith('ru') ? 'ru' : 'en';
  } catch {
    return 'en';
  }
}

function fileStamp(filePath) {
  try {
    const st = statSync(filePath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

function stampsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function currentDBStamp() {
  return {
    db: fileStamp(DB_PATH),
    wal: fileStamp(DB_WAL_PATH),
  };
}

function dbStampsEqual(a, b) {
  if (!a || !b) return false;
  return stampsEqual(a.db, b.db) && stampsEqual(a.wal, b.wal);
}

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
  const stripped = raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .replace(/<\/?USER_REQUEST>/g, '');
  const singleLine = stripped.replace(/\s+/g, ' ').trim();
  if (!singleLine) return '';
  return singleLine.length > 60 ? `${singleLine.slice(0, 57)}...` : singleLine;
}

function stripEffortSuffix(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\s*\((x?high|medium|low)\)/gi, '')
    .replace(/-(x?high|medium|low)$/i, '')
    .trim();
}

function normalizedModelKey(raw) {
  const noEffort = stripEffortSuffix(raw).toLowerCase();
  const cleaned = noEffort
    .replace(/[()]/g, ' ')
    .replace(/\./g, '-')
    .split(/\s+/)
    .filter(Boolean)
    .join('-');
  return cleaned;
}

function formatModelDisplay(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return { name: '', effort: null };

  let work = trimmed;
  let effort = null;

  const effortPatterns = [
    /\s*\((x?high|medium|low)\)\s*$/i,
    /-(x?high|medium|low)$/i,
    /\s+(x?high|medium|low)$/i,
  ];
  for (const re of effortPatterns) {
    const m = work.match(re);
    if (m) {
      const rawEffort = m[1].toLowerCase();
      if (rawEffort === 'xhigh') effort = 'XHigh';
      else if (rawEffort === 'high') effort = 'High';
      else if (rawEffort === 'medium') effort = 'Medium';
      else if (rawEffort === 'low') effort = 'Low';
      work = work.slice(0, m.index).trim();
      break;
    }
  }

  const orchMatch = work.match(/^orchestrator\s*\(([^)]+)\)$/i);
  if (orchMatch) {
    work = orchMatch[1].trim();
  }

  work = work.replace(/[()]/g, ' ').replace(/(?<=\d)-(?=\d)/g, '.');
  const rawTokens = work.split(/[-_\s]+/).filter(Boolean);
  const filtered = rawTokens.filter((tok) => !DROP_MODEL_TOKENS.has(tok.toLowerCase()));
  const chosen = filtered.length > 0 ? filtered : rawTokens;

  const formattedTokens = chosen.map((tok) => {
    if (tok === tok.toLowerCase() && /[a-z\p{L}]/iu.test(tok)) {
      return tok.charAt(0).toUpperCase() + tok.slice(1);
    }
    return tok;
  });

  const cleanName = formattedTokens.join(' ');
  return {
    name: cleanName || trimmed,
    effort,
  };
}

function shortModelName(raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  for (const [token, label] of KNOWN_SHORT_MODELS) {
    if (lower.includes(token)) return label;
  }
  return formatModelDisplay(trimmed).name;
}

function hexLuminance(rawHex) {
  if (typeof rawHex !== 'string') return null;
  const hex = rawHex.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  const val = parseInt(hex, 16);
  const r = ((val >> 16) & 0xff) / 255;
  const g = ((val >> 8) & 0xff) / 255;
  const b = (val & 0xff) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function readAppThemeState() {
  const appStamp = fileStamp(APP_STORAGE_PATH);
  const settingsStamp = fileStamp(USER_SETTINGS_PATH);
  if (
    appThemeCache &&
    stampsEqual(appThemeCache.appStamp, appStamp) &&
    stampsEqual(appThemeCache.settingsStamp, settingsStamp)
  ) {
    return appThemeCache.isDarkTheme;
  }

  let hubIsDark = null;
  if (appStamp) {
    try {
      const dict = JSON.parse(readFileSync(APP_STORAGE_PATH, 'utf-8'));
      if (dict && typeof dict.hubSurfaceBackgroundColor === 'string') {
        const lum = hexLuminance(dict.hubSurfaceBackgroundColor);
        if (lum !== null) hubIsDark = lum < 0.5;
      }
    } catch {
      // ignore malformed app_storage.json
    }
  }

  let themeSettingIsDark = null;
  if (settingsStamp) {
    try {
      const raw = readFileSync(USER_SETTINGS_PATH, 'utf-8');
      const m = raw.match(/"workbench\.colorTheme"\s*:\s*"([^"]+)"/);
      const colorTheme = m ? m[1] : '';
      const lower = colorTheme.toLowerCase();
      if (lower.includes('light')) {
        themeSettingIsDark = false;
      } else if (
        lower.includes('dark') ||
        lower.includes('black') ||
        lower.includes('night') ||
        lower.includes('abyss') ||
        lower.includes('monokai') ||
        lower.includes('dracula')
      ) {
        themeSettingIsDark = true;
      }
    } catch {
      // ignore unreadable settings.json
    }
  }

  const isDarkTheme = themeSettingIsDark ?? hubIsDark ?? null;
  appThemeCache = { appStamp, settingsStamp, isDarkTheme };
  return isDarkTheme;
}

function querySQLiteJson(sql) {
  if (!existsSync(DB_PATH)) return null;
  try {
    const out = execFileSync('sqlite3', ['-readonly', '-json', DB_PATH, sql], {
      timeout: 400,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return null;
  }
}

const DEFAULT_PREFS = {
  threshold: 200000,
  language: null,
  historyMode: 'messages',
  themeMode: 'auto',
};

function sanitizePrefs(raw) {
  const out = { ...DEFAULT_PREFS };
  if (!raw || typeof raw !== 'object') return out;
  const th = Number(raw.threshold);
  if (Number.isFinite(th) && th >= 10000 && th <= 10000000) {
    out.threshold = Math.round(th);
  }
  if (raw.language === 'ru' || raw.language === 'en') {
    out.language = raw.language;
  } else if (raw.language === 'auto' || raw.language === null || raw.language === '') {
    out.language = null;
  }
  if (raw.historyMode === 'messages' || raw.historyMode === 'steps') {
    out.historyMode = raw.historyMode;
  }
  if (raw.themeMode === 'auto' || raw.themeMode === 'light' || raw.themeMode === 'dark') {
    out.themeMode = raw.themeMode;
  }
  return out;
}

function readPrefs() {
  const stamp = fileStamp(PREFS_PATH);
  if (prefsCache && stampsEqual(prefsCache.stamp, stamp)) {
    return prefsCache.prefs;
  }
  let prefs = { ...DEFAULT_PREFS };
  if (stamp) {
    try {
      prefs = sanitizePrefs(JSON.parse(readFileSync(PREFS_PATH, 'utf-8')));
    } catch {
      // keep defaults on malformed prefs file
    }
  }
  prefsCache = { stamp, prefs };
  return prefs;
}

function writePrefs(patch) {
  const current = readPrefs();
  const mergedInput = { ...current };
  if (patch && typeof patch === 'object') {
    if (patch.threshold !== undefined) mergedInput.threshold = patch.threshold;
    if (patch.language !== undefined) mergedInput.language = patch.language;
    if (patch.historyMode !== undefined) mergedInput.historyMode = patch.historyMode;
    if (patch.themeMode !== undefined) mergedInput.themeMode = patch.themeMode;
  }
  const next = sanitizePrefs(mergedInput);
  if (
    next.threshold === current.threshold &&
    next.language === current.language &&
    next.historyMode === current.historyMode &&
    next.themeMode === current.themeMode &&
    existsSync(PREFS_PATH)
  ) {
    return next;
  }
  try {
    mkdirSync(dirname(PREFS_PATH), { recursive: true });
    const tmpPath = `${PREFS_PATH}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(next, null, 2) + '\n', 'utf-8');
    renameSync(tmpPath, PREFS_PATH);
    prefsCache = { stamp: fileStamp(PREFS_PATH), prefs: next };
  } catch {
    // ignore write failures in restricted environments
  }
  return next;
}

function querySummariesFromDB() {
  const dbStamp = currentDBStamp();
  if (summariesCache && dbStampsEqual(summariesCache.dbStamp, dbStamp)) {
    return summariesCache;
  }
  const rows = querySQLiteJson(
    'SELECT conversation_id, title FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 200;'
  );
  const list = [];
  const map = new Map();
  if (rows) {
    for (const r of rows) {
      if (typeof r.conversation_id !== 'string' || !ID_RE.test(r.conversation_id)) continue;
      const title = typeof r.title === 'string' ? r.title.trim() : '';
      list.push({ id: r.conversation_id, title });
      if (title) map.set(r.conversation_id, title);
    }
  }
  summariesCache = { dbStamp, rows: list, map };
  return summariesCache;
}

function isCompactionMarker(stepType, source, content) {
  if (stepType === 'CHECKPOINT') return true;
  if (stepType === 'SYSTEM_MESSAGE' || source === 'SYSTEM') {
    if (
      content.includes('<plan>') ||
      content.includes('Plan mode is off') ||
      content.includes('[plan review') ||
      content.includes('[Message] timestamp=')
    ) {
      return false;
    }
    return (
      content.includes('Resuming from a compaction') ||
      content.includes('lost access to the full conversation history') ||
      content.includes('This conversation grew too large') ||
      content.includes('history before this point may be missing or incomplete') ||
      content.includes('{{ CHECKPOINT') ||
      content.includes('earlier parts of this conversation have been truncated')
    );
  }
  return false;
}

function parseModelSelectionChanges(content) {
  const results = [];
  MODEL_SELECTION_RE.lastIndex = 0;
  let match;
  while ((match = MODEL_SELECTION_RE.exec(content)) !== null) {
    const fromStr = (match[1] || '').trim();
    const toStr = (match[2] || '').trim();
    if (fromStr && toStr) {
      results.push({ from: fromStr, to: toStr });
    }
  }
  return results;
}

function estimateJSONCharCount(value) {
  if (typeof value === 'string') return value.length + 2;
  if (Array.isArray(value)) {
    let sum = 2;
    for (const item of value) sum += estimateJSONCharCount(item) + 1;
    return sum;
  }
  if (value && typeof value === 'object') {
    let sum = 2;
    for (const [k, v] of Object.entries(value)) {
      sum += k.length + 4 + estimateJSONCharCount(v);
    }
    return sum;
  }
  return 6;
}

function isFileToolName(name) {
  return FILE_TOOLS.has(name);
}

function extractTouchedFileName(call) {
  if (!call || typeof call !== 'object') return null;
  const args = call.args && typeof call.args === 'object'
    ? call.args
    : call.arguments && typeof call.arguments === 'object'
      ? call.arguments
      : null;
  if (!args) return null;
  for (const key of ['Path', 'AbsolutePath', 'TargetFile', 'File', 'path']) {
    const raw = args[key];
    if (typeof raw === 'string' && raw) {
      const cleaned = raw.trim().replace(/^["']+|["']+$/g, '');
      const name = basename(cleaned);
      if (name) return name;
    }
  }
  return null;
}

function looksLikeFileToolOutput(content) {
  return (
    content.startsWith('Showing lines ') ||
    content.startsWith('File Path: ') ||
    content.startsWith('Made ') ||
    content.startsWith('Created file') ||
    (content.includes('Showing lines ') && content.includes('Completed At:'))
  );
}

function looksLikeCommandOutput(content) {
  return (
    content.startsWith('Command exited') ||
    content.startsWith('Tool is running as a background task') ||
    content.includes('Command exited with code')
  );
}

function buildBreakdown({
  lastTotal,
  firstModelTotal,
  firstUserChars,
  systemMsgChars,
  historyChars,
  checkpointChars,
  filesChars,
  toolsChars,
  assistantChars,
  thinkingChars,
  userChars,
  totalOutputTokens,
  userTurns,
  mediaCount,
  toolCallsCount,
  fileTouchesCount,
  toolNameCounts,
  fileNameCounts,
}) {
  const topTools = Object.entries(toolNameCounts)
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .map(([name, count]) => ({ name, count }));

  const topFiles = Object.entries(fileNameCounts)
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .map(([name, count]) => ({ name, count }));

  if (lastTotal <= 0) {
    return {
      systemTokens: 0,
      basePromptTokens: 0,
      systemMessageTokens: 0,
      historyTokens: 0,
      checkpointSummaryTokens: 0,
      filesTokens: 0,
      toolsTokens: 0,
      assistantTokens: 0,
      thinkingTokens: 0,
      userTokens: 0,
      totalOutputTokens,
      userTurns,
      mediaCount,
      toolCallsCount,
      fileTouchesCount,
      topTools,
      topFiles,
    };
  }

  const baseSystemEst =
    firstModelTotal !== null
      ? Math.min(Math.max(firstModelTotal - Math.floor(firstUserChars / 4), 0), Math.min(lastTotal, 35000))
      : 0;

  const rawBasePrompt = baseSystemEst;
  const rawSysMsg = Math.floor(systemMsgChars / 4);
  const rawHistory = Math.floor(historyChars / 4);
  const rawCheckpoint = Math.floor(checkpointChars / 4);
  const rawFiles = Math.floor(filesChars / 4);
  const rawTools = Math.floor(toolsChars / 4);
  const rawAssistant = Math.floor(assistantChars / 4);
  const rawThinking = Math.floor(thinkingChars / 4);
  const rawUser = Math.floor(userChars / 4);

  const rawSum =
    rawBasePrompt +
    rawSysMsg +
    rawHistory +
    rawCheckpoint +
    rawFiles +
    rawTools +
    rawAssistant +
    rawThinking +
    rawUser;

  if (rawSum <= 0) {
    return {
      systemTokens: lastTotal,
      basePromptTokens: lastTotal,
      systemMessageTokens: 0,
      historyTokens: 0,
      checkpointSummaryTokens: 0,
      filesTokens: 0,
      toolsTokens: 0,
      assistantTokens: 0,
      thinkingTokens: 0,
      userTokens: 0,
      totalOutputTokens,
      userTurns,
      mediaCount,
      toolCallsCount,
      fileTouchesCount,
      topTools,
      topFiles,
    };
  }

  const scale = lastTotal / rawSum;
  let basePromptTokens = rawBasePrompt > 0 ? Math.round(rawBasePrompt * scale) : 0;
  const systemMessageTokens = rawSysMsg > 0 ? Math.round(rawSysMsg * scale) : 0;
  const historyTokens = rawHistory > 0 ? Math.round(rawHistory * scale) : 0;
  const checkpointSummaryTokens = rawCheckpoint > 0 ? Math.round(rawCheckpoint * scale) : 0;
  let filesTokens = rawFiles > 0 ? Math.round(rawFiles * scale) : 0;
  let toolsTokens = rawTools > 0 ? Math.round(rawTools * scale) : 0;
  let assistantTokens = rawAssistant > 0 ? Math.round(rawAssistant * scale) : 0;
  const thinkingTokens = rawThinking > 0 ? Math.round(rawThinking * scale) : 0;
  let userTokens = rawUser > 0 ? Math.round(rawUser * scale) : 0;

  const currentSum =
    basePromptTokens +
    systemMessageTokens +
    historyTokens +
    checkpointSummaryTokens +
    filesTokens +
    toolsTokens +
    assistantTokens +
    thinkingTokens +
    userTokens;
  const diff = lastTotal - currentSum;
  if (diff !== 0) {
    if (userTokens > 0 && userTokens + diff >= 0) userTokens += diff;
    else if (filesTokens > 0 && filesTokens + diff >= 0) filesTokens += diff;
    else if (toolsTokens > 0 && toolsTokens + diff >= 0) toolsTokens += diff;
    else if (assistantTokens > 0 && assistantTokens + diff >= 0) assistantTokens += diff;
    else basePromptTokens = Math.max(0, basePromptTokens + diff);
  }

  const systemTokens = basePromptTokens + systemMessageTokens + historyTokens + checkpointSummaryTokens;

  return {
    systemTokens,
    basePromptTokens,
    systemMessageTokens,
    historyTokens,
    checkpointSummaryTokens,
    filesTokens,
    toolsTokens,
    assistantTokens,
    thinkingTokens,
    userTokens,
    totalOutputTokens,
    userTurns,
    mediaCount,
    toolCallsCount,
    fileTouchesCount,
    topTools,
    topFiles,
  };
}

class IncrementalTranscriptState {
  constructor(path) {
    this.path = path;
    this.lastProcessedOffset = 0;
    this.lastMtimeMs = 0;

    this.extractedTitle = '';
    this.totalSteps = 0;
    this.userTurns = 0;
    this.currentTurnIndex = 0;

    this.currentUIModel = '';
    this.lastRecordedEffectiveModel = '';
    this.lastRawStepModelInSegment = '';
    this.currentSegmentIndex = 0;
    this.segmentIsOrchestrator = new Map([[0, false]]);
    this.currentPhase = 'planner';

    this.pendingCompaction = false;
    this.pendingModelSwitch = false;
    this.pendingEffortSwitch = false;
    this.pendingPhaseChange = false;
    this.compactionEvents = 0;

    this.allTimePeak = 0;
    this.segmentPeak = 0;
    this.checkpointExtraInputTokens = 0;
    this.checkpointExtraCacheTokens = 0;
    this.checkpointExtraOutputTokens = 0;

    this.pendingUserChars = 0;
    this.pendingAssistantChars = 0;
    this.pendingThinkingChars = 0;
    this.pendingFilesChars = 0;
    this.pendingToolsChars = 0;
    this.pendingSystemChars = 0;
    this.pendingHistoryChars = 0;
    this.pendingCheckpointChars = 0;
    this.pendingToolCalls = 0;
    this.pendingToolNames = [];
    this.pendingFileNames = [];
    this.pendingMediaCount = 0;
    this.pendingErrorCount = 0;
    this.lastStepFileToolRatio = 0;

    this.parsedSteps = [];
    this.stepRecords = [];
    this.cachedStats = null;
  }

  handleSettingsChangeIfPresent(content) {
    if (!content.includes('Model Selection')) return;
    const changes = parseModelSelectionChanges(content);
    for (const change of changes) {
      if (change.from.toLowerCase() === 'none') {
        if (!this.currentUIModel) {
          this.currentUIModel = change.to;
          if (change.to.toLowerCase().includes('orchestrator')) {
            this.segmentIsOrchestrator.set(this.currentSegmentIndex, true);
          }
        }
        continue;
      }
      if (change.from === change.to) continue;

      const fromBase = normalizedModelKey(change.from);
      const toBase = normalizedModelKey(change.to);
      if (fromBase === toBase && fromBase) {
        this.pendingEffortSwitch = true;
        this.currentUIModel = change.to;
      } else {
        this.pendingModelSwitch = true;
        this.currentSegmentIndex += 1;
        this.currentPhase = 'planner';
        this.lastRawStepModelInSegment = '';
        this.segmentIsOrchestrator.set(
          this.currentSegmentIndex,
          change.to.toLowerCase().includes('orchestrator')
        );
        this.currentUIModel = change.to;
      }
    }
  }

  processLine(lineStr, fallbackMs) {
    let obj;
    try {
      obj = JSON.parse(lineStr);
    } catch {
      return;
    }
    if (!obj || typeof obj !== 'object') return;

    this.totalSteps += 1;
    const stepType = typeof obj.type === 'string' ? obj.type : '';
    const source = typeof obj.source === 'string' ? obj.source : '';
    const contentStr = typeof obj.content === 'string' ? obj.content : '';
    const parsedDateMs = typeof obj.created_at === 'string' ? Date.parse(obj.created_at) : NaN;
    const validTsMs = Number.isFinite(parsedDateMs) ? parsedDateMs : null;

    if (Array.isArray(obj.media)) {
      this.pendingMediaCount += obj.media.length;
    }
    if (typeof obj.error === 'string' && obj.error.trim().length > 0) {
      this.pendingErrorCount += 1;
    }

    if (isCompactionMarker(stepType, source, contentStr)) {
      if (!this.pendingCompaction) {
        this.compactionEvents += 1;
        this.pendingCompaction = true;
      }
      this.segmentPeak = 0;
      this.pendingUserChars = 0;
      this.pendingAssistantChars = 0;
      this.pendingThinkingChars = 0;
      this.pendingFilesChars = 0;
      this.pendingToolsChars = 0;
      this.pendingSystemChars = 0;
      this.pendingHistoryChars = 0;
      this.pendingCheckpointChars = contentStr.length;

      if (typeof obj.input_tokens === 'number' && Number.isFinite(obj.input_tokens)) {
        const inVal = Math.trunc(obj.input_tokens) || 0;
        const cacheVal = Math.trunc(Number(obj.cache_read_tokens) || 0);
        const outVal = Math.trunc(Number(obj.output_tokens) || 0);
        const total = inVal + cacheVal;
        this.allTimePeak = Math.max(this.allTimePeak, total);
        this.checkpointExtraInputTokens += inVal;
        this.checkpointExtraCacheTokens += cacheVal;
        this.checkpointExtraOutputTokens += outVal;
        const modelName = typeof obj.model === 'string' && obj.model ? obj.model : this.currentUIModel;
        this.stepRecords.push({
          tsMs: validTsMs ?? fallbackMs,
          model: modelName,
          inputTokens: inVal,
          cacheReadTokens: cacheVal,
          outputTokens: outVal,
          contextTokens: total,
          turnIndex: 0,
          isCompaction: false,
          toolNames: [],
          fileNames: [],
        });
      }
      return;
    }

    let hasExitPlanTool = false;
    let hasEnterPlanTool = false;

    switch (stepType) {
      case 'USER_INPUT': {
        this.userTurns += 1;
        this.currentTurnIndex = this.userTurns;
        this.currentPhase = 'planner';
        this.handleSettingsChangeIfPresent(contentStr);
        this.pendingUserChars += contentStr.length;
        if (!this.extractedTitle && contentStr) {
          this.extractedTitle = cleanTitle(contentStr);
        }
        break;
      }
      case 'PLANNER_RESPONSE': {
        this.pendingAssistantChars += contentStr.length;
        if (typeof obj.thinking === 'string') {
          this.pendingThinkingChars += obj.thinking.length;
        }
        if (Array.isArray(obj.tool_calls)) {
          this.pendingToolCalls += obj.tool_calls.length;
          let fileCallsCount = 0;
          for (const call of obj.tool_calls) {
            if (!call || typeof call !== 'object') continue;
            const callChars = estimateJSONCharCount(call);
            const name = typeof call.name === 'string' ? call.name : '';
            if (name) {
              this.pendingToolNames.push(name);
              if (name === 'exit_plan_mode') hasExitPlanTool = true;
              else if (name === 'enter_plan_mode') hasEnterPlanTool = true;
            }
            const fileName = extractTouchedFileName(call);
            if (fileName) {
              this.pendingFileNames.push(fileName);
            }
            if (isFileToolName(name)) {
              this.pendingFilesChars += callChars;
              fileCallsCount += 1;
            } else {
              this.pendingToolsChars += callChars;
            }
          }
          this.lastStepFileToolRatio =
            obj.tool_calls.length === 0 ? 0 : fileCallsCount / obj.tool_calls.length;
        } else {
          this.lastStepFileToolRatio = 0;
        }
        break;
      }
      case 'SYSTEM_MESSAGE': {
        this.pendingSystemChars += contentStr.length;
        if (contentStr.includes('Plan mode is off')) {
          this.segmentIsOrchestrator.set(this.currentSegmentIndex, true);
          this.currentPhase = 'executor';
          this.pendingPhaseChange = true;
        } else if (contentStr.includes('[plan review')) {
          this.segmentIsOrchestrator.set(this.currentSegmentIndex, true);
          this.currentPhase = 'planner';
          this.pendingPhaseChange = true;
        }
        break;
      }
      case 'EPHEMERAL_MESSAGE':
        this.pendingSystemChars += contentStr.length;
        break;
      case 'CONVERSATION_HISTORY':
        this.pendingHistoryChars += contentStr.length;
        break;
      case 'VIEW_FILE':
      case 'CODE_ACTION':
        this.pendingFilesChars += contentStr.length;
        break;
      case 'RUN_COMMAND':
      case 'SEARCH_WEB':
      case 'LIST_DIRECTORY':
      case 'GREP_SEARCH':
      case 'READ_URL_CONTENT':
      case 'ERROR_MESSAGE':
        this.pendingToolsChars += contentStr.length;
        break;
      case 'GENERIC': {
        if (looksLikeFileToolOutput(contentStr)) {
          this.pendingFilesChars += contentStr.length;
        } else if (looksLikeCommandOutput(contentStr)) {
          this.pendingToolsChars += contentStr.length;
        } else if (this.lastStepFileToolRatio >= 0.99) {
          this.pendingFilesChars += contentStr.length;
        } else if (this.lastStepFileToolRatio <= 0.01) {
          this.pendingToolsChars += contentStr.length;
        } else {
          const fPart = Math.round(contentStr.length * this.lastStepFileToolRatio);
          this.pendingFilesChars += fPart;
          this.pendingToolsChars += contentStr.length - fPart;
        }
        break;
      }
      default:
        break;
    }

    if (hasExitPlanTool || hasEnterPlanTool) {
      this.segmentIsOrchestrator.set(this.currentSegmentIndex, true);
    }

    if (typeof obj.input_tokens === 'number' && Number.isFinite(obj.input_tokens)) {
      const inVal = Math.trunc(obj.input_tokens) || 0;
      const cacheVal = Math.trunc(Number(obj.cache_read_tokens) || 0);
      const outVal = Math.trunc(Number(obj.output_tokens) || 0);
      const total = inVal + cacheVal;
      const stepIdx =
        typeof obj.step_index === 'number' && Number.isFinite(obj.step_index)
          ? obj.step_index
          : this.totalSteps;
      const rawStepModel = typeof obj.model === 'string' ? obj.model : '';
      const effectiveModel = rawStepModel || this.currentUIModel;
      const modelKey = normalizedModelKey(effectiveModel);

      if (rawStepModel) {
        if (
          this.lastRawStepModelInSegment &&
          this.lastRawStepModelInSegment !== rawStepModel &&
          !this.pendingModelSwitch &&
          !this.pendingEffortSwitch
        ) {
          this.segmentIsOrchestrator.set(this.currentSegmentIndex, true);
          this.pendingPhaseChange = true;
        }
        this.lastRawStepModelInSegment = rawStepModel;
      }

      let stepCompacted = false;
      if (this.pendingCompaction) {
        stepCompacted = true;
        this.pendingCompaction = false;
        this.segmentPeak = total;
      } else if (this.segmentPeak >= 100000) {
        const drop = this.segmentPeak - total;
        const sameModel =
          !this.lastRecordedEffectiveModel || effectiveModel === this.lastRecordedEffectiveModel;
        if (
          !this.pendingModelSwitch &&
          !this.pendingEffortSwitch &&
          !this.pendingPhaseChange &&
          sameModel &&
          drop / this.segmentPeak >= 0.75
        ) {
          this.compactionEvents += 1;
          stepCompacted = true;
          this.segmentPeak = total;
        } else {
          this.segmentPeak = Math.max(this.segmentPeak, total);
        }
      } else {
        this.segmentPeak = Math.max(this.segmentPeak, total);
      }

      this.allTimePeak = Math.max(this.allTimePeak, total);

      if (this.currentTurnIndex === 0) {
        this.currentTurnIndex = 1;
      }

      const toolNamesCopy = this.pendingToolNames.slice();
      const fileNamesCopy = this.pendingFileNames.slice();

      this.parsedSteps.push({
        stepIndex: stepIdx,
        turnIndex: this.currentTurnIndex,
        segmentIndex: this.currentSegmentIndex,
        phase: this.currentPhase,
        effectiveModel,
        modelKey,
        inputTokens: inVal,
        cacheReadTokens: cacheVal,
        outputTokens: outVal,
        contextTokens: total,
        isCompaction: stepCompacted,
        isModelSwitch: this.pendingModelSwitch,
        isEffortSwitch: this.pendingEffortSwitch,
        userCharsDelta: this.pendingUserChars,
        assistantCharsDelta: this.pendingAssistantChars,
        thinkingCharsDelta: this.pendingThinkingChars,
        filesCharsDelta: this.pendingFilesChars,
        toolsCharsDelta: this.pendingToolsChars,
        systemCharsDelta: this.pendingSystemChars,
        historyCharsDelta: this.pendingHistoryChars,
        checkpointCharsDelta: this.pendingCheckpointChars,
        toolCallsDelta: this.pendingToolCalls,
        toolNames: toolNamesCopy,
        fileNames: fileNamesCopy,
        timestampMs: validTsMs,
        createdAt: typeof obj.created_at === 'string' ? obj.created_at : null,
        mediaCountDelta: this.pendingMediaCount,
        errorCountDelta: this.pendingErrorCount,
      });

      this.stepRecords.push({
        tsMs: validTsMs ?? fallbackMs,
        model: effectiveModel,
        inputTokens: inVal,
        cacheReadTokens: cacheVal,
        outputTokens: outVal,
        contextTokens: total,
        turnIndex: this.currentTurnIndex,
        isCompaction: stepCompacted,
        toolNames: toolNamesCopy,
        fileNames: fileNamesCopy,
      });

      this.pendingModelSwitch = false;
      this.pendingEffortSwitch = false;
      this.pendingPhaseChange = false;
      this.pendingUserChars = 0;
      this.pendingAssistantChars = 0;
      this.pendingThinkingChars = 0;
      this.pendingFilesChars = 0;
      this.pendingToolsChars = 0;
      this.pendingSystemChars = 0;
      this.pendingHistoryChars = 0;
      this.pendingCheckpointChars = 0;
      this.pendingToolCalls = 0;
      this.pendingToolNames = [];
      this.pendingFileNames = [];
      this.pendingMediaCount = 0;
      this.pendingErrorCount = 0;
      this.lastRecordedEffectiveModel = effectiveModel;
    }

    if (hasExitPlanTool) {
      this.currentPhase = 'executor';
      this.pendingPhaseChange = true;
    } else if (hasEnterPlanTool) {
      this.currentPhase = 'planner';
      this.pendingPhaseChange = true;
    }
  }

  buildSnapshot(
    steps,
    {
      extraInputTokens = 0,
      extraCacheTokens = 0,
      extraOutputTokens = 0,
      overridePeak = null,
      overrideCompactions = null,
      overrideUserTurns = null,
    } = {}
  ) {
    if (!steps || steps.length === 0) {
      return {
        contextTokens: 0,
        lastInputTokens: 0,
        lastCacheReadTokens: 0,
        lastOutputTokens: 0,
        lastDelta: 0,
        cacheHitPercent: 0,
        model: '',
        totalModelSteps: 0,
        peakTokens: overridePeak ?? 0,
        compactionEvents: overrideCompactions ?? 0,
        recentSteps: [],
        recentMessages: [],
        breakdown: buildBreakdown({
          lastTotal: 0,
          firstModelTotal: null,
          firstUserChars: 0,
          systemMsgChars: 0,
          historyChars: 0,
          checkpointChars: 0,
          filesChars: 0,
          toolsChars: 0,
          assistantChars: 0,
          thinkingChars: 0,
          userChars: 0,
          totalOutputTokens: 0,
          userTurns: 0,
          mediaCount: 0,
          toolCallsCount: 0,
          fileTouchesCount: 0,
          toolNameCounts: {},
          fileNameCounts: {},
        }),
        sessionStats: {
          primaryModel: '',
          primaryModelDisplay: { name: '', effort: null },
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
      };
    }

    const lastStep = steps[steps.length - 1];
    let totalIn = extraInputTokens;
    let totalCache = extraCacheTokens;
    let totalOut = extraOutputTokens;
    let stepPeak = 0;
    let stepCompactions = 0;

    const modelStepCounts = {};
    const modelOutputCounts = {};
    const modelLastSeenIndex = {};

    let toolCallsCount = 0;
    const toolNameCounts = {};
    let fileTouchesCount = 0;
    const fileNameCounts = {};
    let mediaCount = 0;
    let errorCount = 0;

    let firstTsMs = null;
    let lastTsMs = null;

    let firstModelTotal = null;
    let firstUserChars = 0;
    let userChars = 0;
    let assistantChars = 0;
    let thinkingChars = 0;
    let filesChars = 0;
    let toolsChars = 0;
    let systemChars = 0;
    let historyChars = 0;
    let checkpointChars = 0;

    const stepSamples = [];
    let prevStepContext = 0;

    const turnOrder = [];
    const turnAccum = new Map();

    for (let idx = 0; idx < steps.length; idx += 1) {
      const step = steps[idx];
      totalIn += step.inputTokens;
      totalCache += step.cacheReadTokens;
      totalOut += step.outputTokens;
      stepPeak = Math.max(stepPeak, step.contextTokens);

      if (step.isCompaction) {
        stepCompactions += 1;
        userChars = 0;
        assistantChars = 0;
        thinkingChars = 0;
        filesChars = 0;
        toolsChars = 0;
        systemChars = 0;
        historyChars = 0;
        checkpointChars = 0;
      }

      if (firstModelTotal === null) {
        firstModelTotal = step.contextTokens;
        firstUserChars = step.userCharsDelta;
      }

      userChars += step.userCharsDelta;
      assistantChars += step.assistantCharsDelta;
      thinkingChars += step.thinkingCharsDelta;
      filesChars += step.filesCharsDelta;
      toolsChars += step.toolsCharsDelta;
      systemChars += step.systemCharsDelta;
      historyChars += step.historyCharsDelta;
      checkpointChars += step.checkpointCharsDelta;

      toolCallsCount += step.toolCallsDelta;
      for (const tName of step.toolNames) {
        toolNameCounts[tName] = (toolNameCounts[tName] || 0) + 1;
      }
      fileTouchesCount += step.fileNames.length;
      for (const fName of step.fileNames) {
        fileNameCounts[fName] = (fileNameCounts[fName] || 0) + 1;
      }
      mediaCount += step.mediaCountDelta;
      errorCount += step.errorCountDelta;

      if (step.timestampMs !== null) {
        if (firstTsMs === null) firstTsMs = step.timestampMs;
        lastTsMs = step.timestampMs;
      }

      if (step.effectiveModel) {
        modelStepCounts[step.effectiveModel] = (modelStepCounts[step.effectiveModel] || 0) + 1;
        modelOutputCounts[step.effectiveModel] =
          (modelOutputCounts[step.effectiveModel] || 0) + step.outputTokens;
        modelLastSeenIndex[step.effectiveModel] = idx;
      }

      const stepDelta = idx > 0 ? step.contextTokens - prevStepContext : step.contextTokens;
      prevStepContext = step.contextTokens;

      stepSamples.push({
        stepIndex: step.stepIndex,
        contextTokens: step.contextTokens,
        delta: stepDelta,
        isCompaction: step.isCompaction,
        isModelSwitch: step.isModelSwitch,
        isEffortSwitch: step.isEffortSwitch,
      });

      const existing = turnAccum.get(step.turnIndex);
      if (existing) {
        existing.steps += 1;
        existing.endTokens = step.contextTokens;
        existing.sumIn += step.inputTokens;
        existing.sumCache += step.cacheReadTokens;
        existing.lastCache = step.cacheReadTokens;
        existing.hadCompaction = existing.hadCompaction || step.isCompaction;
        existing.hadModelSwitch = existing.hadModelSwitch || step.isModelSwitch;
        existing.hadEffortSwitch = existing.hadEffortSwitch || step.isEffortSwitch;
      } else {
        turnOrder.push(step.turnIndex);
        turnAccum.set(step.turnIndex, {
          steps: 1,
          endTokens: step.contextTokens,
          sumIn: step.inputTokens,
          sumCache: step.cacheReadTokens,
          lastCache: step.cacheReadTokens,
          hadCompaction: step.isCompaction,
          hadModelSwitch: step.isModelSwitch,
          hadEffortSwitch: step.isEffortSwitch,
        });
      }
    }

    const messageSamples = [];
    let prevTurnEndTokens = 0;
    for (const tIdx of turnOrder) {
      const t = turnAccum.get(tIdx);
      const turnDelta = t.endTokens - prevTurnEndTokens;
      prevTurnEndTokens = t.endTokens;
      const turnDenom = t.sumIn + t.sumCache;
      const turnCachePct = turnDenom > 0 ? Math.round((t.sumCache / turnDenom) * 100) : 0;
      messageSamples.push({
        turnIndex: tIdx,
        contextTokens: t.endTokens,
        delta: turnDelta,
        modelStepsInTurn: t.steps,
        cacheReadTokens: t.lastCache,
        cacheHitPercent: turnCachePct,
        hadCompaction: t.hadCompaction,
        hadModelSwitch: t.hadModelSwitch,
        hadEffortSwitch: t.hadEffortSwitch,
      });
    }

    const modelUsage = Object.entries(modelStepCounts)
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return (modelLastSeenIndex[b[0]] ?? -1) - (modelLastSeenIndex[a[0]] ?? -1);
      })
      .map(([name, count]) => ({
        name,
        formattedModel: formatModelDisplay(name),
        steps: count,
        outputTokens: modelOutputCounts[name] || 0,
      }));

    const primaryModel = modelUsage[0]?.name || lastStep.effectiveModel || '';
    const otherModelsCount = Math.max(0, modelUsage.length - 1);
    const sessionDenom = totalIn + totalCache;
    const avgCacheHitPercent = sessionDenom > 0 ? Math.round((totalCache / sessionDenom) * 100) : 0;
    const durationSeconds =
      firstTsMs !== null && lastTsMs !== null && lastTsMs >= firstTsMs
        ? Math.round((lastTsMs - firstTsMs) / 1000)
        : 0;
    const effectiveTurns =
      overrideUserTurns !== null
        ? Math.max(overrideUserTurns, messageSamples.length)
        : messageSamples.length;

    const breakdown = buildBreakdown({
      lastTotal: lastStep.contextTokens,
      firstModelTotal,
      firstUserChars,
      systemMsgChars: systemChars,
      historyChars,
      checkpointChars,
      filesChars,
      toolsChars,
      assistantChars,
      thinkingChars,
      userChars,
      totalOutputTokens: totalOut,
      userTurns: effectiveTurns,
      mediaCount,
      toolCallsCount,
      fileTouchesCount,
      toolNameCounts,
      fileNameCounts,
    });

    const lastDelta =
      steps.length > 1
        ? lastStep.contextTokens - steps[steps.length - 2].contextTokens
        : lastStep.contextTokens;
    const cacheHitPercent =
      lastStep.contextTokens > 0
        ? Math.round((lastStep.cacheReadTokens / lastStep.contextTokens) * 100)
        : 0;

    return {
      contextTokens: lastStep.contextTokens,
      lastInputTokens: lastStep.inputTokens,
      lastCacheReadTokens: lastStep.cacheReadTokens,
      lastOutputTokens: lastStep.outputTokens,
      lastDelta,
      cacheHitPercent,
      model: lastStep.effectiveModel,
      modelDisplay: formatModelDisplay(lastStep.effectiveModel),
      totalModelSteps: steps.length,
      peakTokens: overridePeak ?? stepPeak,
      compactionEvents: overrideCompactions ?? stepCompactions,
      recentSteps: stepSamples.slice(-6).reverse(),
      recentMessages: messageSamples.slice(-6).reverse(),
      breakdown,
      sessionStats: {
        primaryModel,
        primaryModelDisplay: formatModelDisplay(primaryModel),
        otherModelsCount,
        modelUsage,
        totalInputTokens: totalIn,
        totalCacheReadTokens: totalCache,
        totalOutputTokens: totalOut,
        avgCacheHitPercent,
        durationSeconds,
        mediaCount,
        errorCount,
        userMessageCount: effectiveTurns,
      },
    };
  }

  buildTranscriptStats(conversationId, fallbackTitle, st) {
    if (
      this.cachedStats &&
      this.cachedStats.fallbackTitle === fallbackTitle &&
      this.cachedStats.mtimeMs === st.mtimeMs &&
      this.cachedStats.size === st.size
    ) {
      return this.cachedStats.stats;
    }

    const allSnapshot = this.buildSnapshot(this.parsedSteps, {
      extraInputTokens: this.checkpointExtraInputTokens,
      extraCacheTokens: this.checkpointExtraCacheTokens,
      extraOutputTokens: this.checkpointExtraOutputTokens,
      overridePeak: this.allTimePeak,
      overrideCompactions: this.compactionEvents,
      overrideUserTurns: this.userTurns,
    });

    const manualSteps = this.parsedSteps.filter(
      (s) => this.segmentIsOrchestrator.get(s.segmentIndex) !== true
    );
    const orchSteps = this.parsedSteps.filter(
      (s) => this.segmentIsOrchestrator.get(s.segmentIndex) === true
    );

    const hasManualMode = manualSteps.length > 0;
    const hasOrchestratorMode = orchSteps.length > 0;
    const scopedSnapshots = { allChat: allSnapshot };
    const manualModels = [];

    if (hasManualMode) {
      scopedSnapshots.manualAll = this.buildSnapshot(manualSteps);

      const groupedManual = new Map();
      const manualOrder = [];
      for (const step of manualSteps) {
        const key = step.modelKey || 'default';
        if (!groupedManual.has(key)) {
          groupedManual.set(key, []);
          manualOrder.push(key);
        }
        groupedManual.get(key).push(step);
      }

      const rawShortNames = {};
      const shortCounts = {};
      for (const key of manualOrder) {
        const list = groupedManual.get(key);
        const full = list[list.length - 1]?.effectiveModel || key;
        const short = shortModelName(full);
        rawShortNames[key] = short;
        shortCounts[short] = (shortCounts[short] || 0) + 1;
      }

      for (const key of manualOrder) {
        const list = groupedManual.get(key);
        if (!list || list.length === 0) continue;
        const full = list[list.length - 1]?.effectiveModel || key;
        const baseShort = rawShortNames[key] || full;
        const label = (shortCounts[baseShort] || 0) > 1 ? stripEffortSuffix(full) : baseShort;
        manualModels.push({
          id: key,
          shortName: label,
          fullName: full,
          steps: list.length,
        });
        scopedSnapshots[`manualModel:${key}`] = this.buildSnapshot(list);
      }
    }

    if (hasOrchestratorMode) {
      scopedSnapshots.orchestratorAll = this.buildSnapshot(orchSteps);
      const plannerSteps = orchSteps.filter((s) => s.phase === 'planner');
      if (plannerSteps.length > 0) {
        scopedSnapshots.orchestratorPlanner = this.buildSnapshot(plannerSteps);
      }
      const executorSteps = orchSteps.filter((s) => s.phase === 'executor');
      if (executorSteps.length > 0) {
        scopedSnapshots.orchestratorExecutor = this.buildSnapshot(executorSteps);
      }
    }

    const displayTitle =
      fallbackTitle || this.extractedTitle || conversationId.slice(0, 8);
    const lastStep = this.parsedSteps[this.parsedSteps.length - 1];
    const updatedAt =
      (lastStep && lastStep.createdAt) || st.mtime.toISOString();

    const stats = {
      conversationId,
      title: displayTitle,
      exists: true,
      contextTokens: allSnapshot.contextTokens,
      lastInputTokens: allSnapshot.lastInputTokens,
      lastCacheReadTokens: allSnapshot.lastCacheReadTokens,
      lastOutputTokens: allSnapshot.lastOutputTokens,
      lastDelta: allSnapshot.lastDelta,
      cacheHitPercent: allSnapshot.cacheHitPercent,
      model: allSnapshot.model,
      modelDisplay: allSnapshot.modelDisplay,
      stepCount: this.totalSteps,
      totalModelSteps: allSnapshot.totalModelSteps,
      peakTokens: allSnapshot.peakTokens,
      compactionEvents: allSnapshot.compactionEvents,
      recentSteps: allSnapshot.recentSteps,
      recentMessages: allSnapshot.recentMessages,
      breakdown: allSnapshot.breakdown,
      sessionStats: allSnapshot.sessionStats,
      hasManualMode,
      hasOrchestratorMode,
      manualModels,
      scopedSnapshots,
      updatedAt,
    };

    this.cachedStats = {
      fallbackTitle,
      mtimeMs: st.mtimeMs,
      size: st.size,
      stats,
    };
    return stats;
  }
}

function appendTailLines(state, fromOffset, st) {
  const bytesToRead = st.size - fromOffset;
  if (bytesToRead <= 0) {
    state.lastMtimeMs = st.mtimeMs;
    return true;
  }

  let fd;
  let chunk;
  try {
    fd = openSync(state.path, 'r');
    chunk = Buffer.allocUnsafe(bytesToRead);
    let totalRead = 0;
    while (totalRead < bytesToRead) {
      const n = readSync(fd, chunk, totalRead, bytesToRead - totalRead, fromOffset + totalRead);
      if (n <= 0) break;
      totalRead += n;
    }
    if (totalRead < bytesToRead) {
      chunk = chunk.subarray(0, totalRead);
    }
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close error
      }
    }
  }

  if (chunk.length === 0) {
    state.lastMtimeMs = st.mtimeMs;
    return true;
  }

  const fallbackMs = st.mtimeMs;
  let lineStart = 0;
  let consumedBytes = 0;

  while (lineStart < chunk.length) {
    const newlineIdx = chunk.indexOf(0x0a, lineStart);
    if (newlineIdx !== -1) {
      const lineStr = chunk.subarray(lineStart, newlineIdx).toString('utf8').trim();
      if (lineStr) {
        state.processLine(lineStr, fallbackMs);
      }
      consumedBytes = newlineIdx + 1;
      lineStart = newlineIdx + 1;
    } else {
      const trailingStr = chunk.subarray(lineStart).toString('utf8').trim();
      if (!trailingStr) {
        consumedBytes = chunk.length;
      } else {
        try {
          const parsed = JSON.parse(trailingStr);
          if (parsed && typeof parsed === 'object') {
            state.processLine(trailingStr, fallbackMs);
            consumedBytes = chunk.length;
          }
        } catch {
          // incomplete line still being flushed; retry on next poll
        }
      }
      break;
    }
  }

  if (consumedBytes > 0) {
    state.lastProcessedOffset = fromOffset + consumedBytes;
    state.cachedStats = null;
  }
  state.lastMtimeMs = st.mtimeMs;
  return true;
}

function ensureIncrementalState(convId, filePath, st) {
  const existing = transcriptStates.get(convId);
  if (existing && existing.path === filePath) {
    if (st.size === existing.lastProcessedOffset && st.mtimeMs === existing.lastMtimeMs) {
      return existing;
    }
    if (st.size === existing.lastProcessedOffset) {
      existing.lastMtimeMs = st.mtimeMs;
      return existing;
    }
    if (st.size > existing.lastProcessedOffset) {
      if (appendTailLines(existing, existing.lastProcessedOffset, st)) {
        return existing;
      }
      return null;
    }
  }

  const fresh = new IncrementalTranscriptState(filePath);
  if (!appendTailLines(fresh, 0, st)) {
    return null;
  }
  transcriptStates.set(convId, fresh);
  return fresh;
}

function readTranscriptStats(convId, fallbackTitle = '') {
  const empty = {
    conversationId: convId,
    title: fallbackTitle || (convId ? convId.slice(0, 8) : ''),
    exists: false,
    contextTokens: 0,
    lastInputTokens: 0,
    lastCacheReadTokens: 0,
    lastOutputTokens: 0,
    lastDelta: 0,
    cacheHitPercent: 0,
    model: '',
    modelDisplay: { name: '', effort: null },
    stepCount: 0,
    totalModelSteps: 0,
    peakTokens: 0,
    compactionEvents: 0,
    recentSteps: [],
    recentMessages: [],
    breakdown: buildBreakdown({
      lastTotal: 0,
      firstModelTotal: null,
      firstUserChars: 0,
      systemMsgChars: 0,
      historyChars: 0,
      checkpointChars: 0,
      filesChars: 0,
      toolsChars: 0,
      assistantChars: 0,
      thinkingChars: 0,
      userChars: 0,
      totalOutputTokens: 0,
      userTurns: 0,
      mediaCount: 0,
      toolCallsCount: 0,
      fileTouchesCount: 0,
      toolNameCounts: {},
      fileNameCounts: {},
    }),
    sessionStats: {
      primaryModel: '',
      primaryModelDisplay: { name: '', effort: null },
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
    hasManualMode: false,
    hasOrchestratorMode: false,
    manualModels: [],
    scopedSnapshots: {},
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

  const state = ensureIncrementalState(convId, filePath, st);
  if (!state) return empty;

  return state.buildTranscriptStats(convId, fallbackTitle, st);
}

function pruneTranscriptStates(validIds) {
  if (transcriptStates.size <= validIds.size) return;
  for (const key of transcriptStates.keys()) {
    if (!validIds.has(key)) transcriptStates.delete(key);
  }
}

function stampKey(st) {
  return st ? `${st.mtimeMs}:${st.size}` : '0';
}

function scanEligiblePeriodTranscripts(hours = 24) {
  const cutoffMs = Date.now() - hours * 3600 * 1000;
  if (!existsSync(BRAIN_DIR)) {
    return { cutoffMs, validIds: new Set(), eligible: [], sigKey: '' };
  }
  let entries;
  try {
    entries = readdirSync(BRAIN_DIR, { withFileTypes: true });
  } catch {
    return { cutoffMs, validIds: new Set(), eligible: [], sigKey: '' };
  }

  const validIds = new Set();
  const eligible = [];
  const signatures = [];

  for (const dirent of entries) {
    if (!dirent.isDirectory() || !ID_RE.test(dirent.name)) continue;
    validIds.add(dirent.name);
    const filePath = resolveTranscriptPath(dirent.name);
    if (!filePath) continue;
    let st;
    try {
      st = statSync(filePath);
    } catch {
      continue;
    }
    if (st.mtimeMs < cutoffMs) continue;
    eligible.push({ convId: dirent.name, filePath, st });
    signatures.push(`${dirent.name}:${st.mtimeMs}:${st.size}`);
  }

  pruneTranscriptStates(validIds);
  signatures.sort();
  return { cutoffMs, validIds, eligible, sigKey: signatures.join('|') };
}

function readPeriodStats(hours = 24, preScanned = null) {
  const empty = {
    windowHours: hours,
    activeChats: 0,
    userMessages: 0,
    modelSteps: 0,
    compactionEvents: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalOutputTokens: 0,
    avgCacheHitPercent: 0,
    totalDurationSeconds: 0,
    totalToolCalls: 0,
    totalFileTouches: 0,
    peakTokens: 0,
    modelUsage: [],
    topTools: [],
    topFiles: [],
    activeChatItems: [],
  };
  const scan = preScanned || scanEligiblePeriodTranscripts(hours);
  const { cutoffMs, eligible, sigKey } = scan;
  if (eligible.length === 0 && !existsSync(BRAIN_DIR)) return empty;

  const cached = periodCache.get(hours);
  if (
    cached &&
    cached.sigKey === sigKey &&
    (cached.oldestIncludedMs === null || cached.oldestIncludedMs >= cutoffMs)
  ) {
    return cached.stats;
  }

  const dbTitles = querySummariesFromDB().map;

  let activeChats = 0;
  let userMessages = 0;
  let modelSteps = 0;
  let compactionEvents = 0;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let totalDurationSeconds = 0;
  let totalToolCalls = 0;
  let totalFileTouches = 0;
  let overallPeak = 0;

  const modelCounts = {};
  const modelOutputs = {};
  const toolCounts = {};
  const fileCounts = {};
  const chatItemsWithDate = [];
  let oldestIncludedMs = null;

  for (const item of eligible) {
    const state = ensureIncrementalState(item.convId, item.filePath, item.st);
    if (!state) continue;

    let matchedThisChat = false;
    const chatTurns = new Set();
    let chatSteps = 0;
    let chatPeak = 0;
    let chatFirstMs = null;
    let chatLastMs = null;

    for (const rec of state.stepRecords) {
      if (rec.tsMs < cutoffMs) continue;
      matchedThisChat = true;
      if (oldestIncludedMs === null || rec.tsMs < oldestIncludedMs) {
        oldestIncludedMs = rec.tsMs;
      }
      if (chatFirstMs === null || rec.tsMs < chatFirstMs) chatFirstMs = rec.tsMs;
      if (chatLastMs === null || rec.tsMs > chatLastMs) chatLastMs = rec.tsMs;

      modelSteps += 1;
      chatSteps += 1;
      if (rec.turnIndex > 0) chatTurns.add(rec.turnIndex);
      if (rec.isCompaction) compactionEvents += 1;
      chatPeak = Math.max(chatPeak, rec.contextTokens);
      overallPeak = Math.max(overallPeak, rec.contextTokens);

      totalInputTokens += rec.inputTokens;
      totalCacheReadTokens += rec.cacheReadTokens;
      totalOutputTokens += rec.outputTokens;

      if (rec.model) {
        modelCounts[rec.model] = (modelCounts[rec.model] || 0) + 1;
        modelOutputs[rec.model] = (modelOutputs[rec.model] || 0) + rec.outputTokens;
      }
      totalToolCalls += rec.toolNames.length;
      for (const tName of rec.toolNames) {
        toolCounts[tName] = (toolCounts[tName] || 0) + 1;
      }
      totalFileTouches += rec.fileNames.length;
      for (const fName of rec.fileNames) {
        fileCounts[fName] = (fileCounts[fName] || 0) + 1;
      }
    }

    if (matchedThisChat) {
      activeChats += 1;
      userMessages += chatTurns.size;
      if (chatFirstMs !== null && chatLastMs !== null && chatLastMs >= chatFirstMs) {
        totalDurationSeconds += Math.round((chatLastMs - chatFirstMs) / 1000);
      }
      const dbTitle = dbTitles.get(item.convId) || '';
      const title = dbTitle || state.extractedTitle || item.convId.slice(0, 8);
      const latestMs = chatLastMs ?? item.st.mtimeMs ?? cutoffMs;
      chatItemsWithDate.push({
        item: {
          id: item.convId,
          title,
          peakTokens: chatPeak,
          steps: chatSteps,
        },
        latestMs,
      });
    }
  }

  const denom = totalInputTokens + totalCacheReadTokens;
  const avgCacheHitPercent = denom > 0 ? Math.round((totalCacheReadTokens / denom) * 100) : 0;

  const modelUsage = Object.entries(modelCounts)
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .map(([name, steps]) => {
      const display = formatModelDisplay(name);
      return {
        name,
        displayName: display.name || name,
        effort: display.effort,
        steps,
        outputTokens: modelOutputs[name] || 0,
      };
    });

  const topTools = Object.entries(toolCounts)
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .map(([name, count]) => ({ name, count }));

  const topFiles = Object.entries(fileCounts)
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .map(([name, count]) => ({ name, count }));

  const activeChatItems = chatItemsWithDate
    .sort((a, b) => b.latestMs - a.latestMs)
    .map((entry) => entry.item);

  const stats = {
    windowHours: hours,
    activeChats,
    userMessages,
    modelSteps,
    compactionEvents,
    totalInputTokens,
    totalCacheReadTokens,
    totalOutputTokens,
    avgCacheHitPercent,
    totalDurationSeconds,
    totalToolCalls,
    totalFileTouches,
    peakTokens: overallPeak,
    modelUsage,
    topTools,
    topFiles,
    activeChatItems,
  };

  periodCache.set(hours, { sigKey, oldestIncludedMs, stats });
  return stats;
}

function scanRecentInBrain(limit = 10) {
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
      candidates.push({ id: dirent.name, title: '', mtimeMs: st.mtimeMs });
    } catch {
      // skip unreadable transcript
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.slice(0, limit).map(({ id, title }) => ({ id, title }));
}

function listRecentConversations(limit = 10) {
  const dbSummary = querySummariesFromDB();
  let rows = dbSummary.rows.slice(0, limit);
  const usingFallbackScan = rows.length === 0;
  const brainStamp = usingFallbackScan ? fileStamp(BRAIN_DIR) : null;

  if (usingFallbackScan) {
    rows = scanRecentInBrain(limit);
  }

  const itemSigKey = rows
    .map((item) => {
      const tp = resolveTranscriptPath(item.id);
      return `${item.id}:${stampKey(tp ? fileStamp(tp) : null)}`;
    })
    .join('|');

  if (
    recentCache &&
    recentCache.limit === limit &&
    dbStampsEqual(recentCache.dbStamp, dbSummary.dbStamp) &&
    stampsEqual(recentCache.brainStamp, brainStamp) &&
    recentCache.itemSigKey === itemSigKey
  ) {
    return recentCache.list;
  }

  const list = rows.map((item) => {
    const stats = readTranscriptStats(item.id, item.title);
    return {
      conversationId: item.id,
      title: item.title || stats.title || item.id.slice(0, 8),
      contextTokens: stats.contextTokens,
      model: stats.model,
      updatedAt: stats.updatedAt,
    };
  });

  recentCache = {
    limit,
    dbStamp: dbSummary.dbStamp,
    brainStamp,
    itemSigKey,
    list,
  };
  return list;
}

const app = new SidecarApp();

app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));

app.api('/api/prefs', (data) => writePrefs(data), 'GET');

app.api('/api/context', (data) => {
  const requestedId =
    typeof data.conversationId === 'string' && ID_RE.test(data.conversationId)
      ? data.conversationId
      : '';
  const recent = listRecentConversations(10);
  const summaries = querySummariesFromDB();
  let convId =
    requestedId ||
    (app.config.conversationId && ID_RE.test(app.config.conversationId)
      ? app.config.conversationId
      : '');
  if (!convId && recent.length > 0) {
    convId = recent[0].conversationId;
  }

  const includeStats = data.includeStats === '1' || data.includeStats === 'true';
  const hours = Number(data.hours) === 168 ? 168 : 24;

  const convTp = convId ? resolveTranscriptPath(convId) : null;
  const convStamp = convTp ? fileStamp(convTp) : null;
  const prefsStamp = fileStamp(PREFS_PATH);
  const appStamp = fileStamp(APP_STORAGE_PATH);
  const settingsStamp = fileStamp(USER_SETTINGS_PATH);
  const periodScan = includeStats ? scanEligiblePeriodTranscripts(hours) : null;

  const rev = [
    convId || '',
    stampKey(convStamp),
    stampKey(summaries.dbStamp.db),
    stampKey(summaries.dbStamp.wal),
    stampKey(prefsStamp),
    stampKey(appStamp),
    stampKey(settingsStamp),
    includeStats ? '1' : '0',
    String(hours),
    periodScan ? periodScan.sigKey : '',
  ].join(';');

  if (typeof data.rev === 'string' && data.rev && data.rev === rev) {
    return { unchanged: true, rev };
  }

  const fallbackTitle = convId ? summaries.map.get(convId) || '' : '';

  return {
    unchanged: false,
    rev,
    activeConversationId: convId || null,
    language: systemDefaultLanguage(),
    isDarkTheme: readAppThemeState(),
    prefs: readPrefs(),
    current: convId ? readTranscriptStats(convId, fallbackTitle) : null,
    recent,
    periodStats: includeStats ? readPeriodStats(hours, periodScan) : null,
  };
}, 'GET');

await app.run();
