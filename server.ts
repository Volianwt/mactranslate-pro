import express from "express";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import dotenv from "dotenv";
import OpenAI from "openai";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { dictionary as cmuPronouncingDictionary } from "cmu-pronouncing-dictionary";
import {
  createASREngine,
  QwenASREngine,
  SonioxASREngine,
  type ASREngine,
  type ASRFinalMetadata,
  type ASRProvider,
} from "./asr-engines";

dotenv.config();

// ---------------------------------------------------------------------------
// Diagnostic logger — lightweight, async, non-blocking
// ---------------------------------------------------------------------------
const LOG_DIR = path.join(process.cwd(), "logs");
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB per file — rotate when exceeded
const MAX_PRE_ENGINE_AUDIO_BYTES = 16000 * 2 * 10;

let logStream: fs.WriteStream | null = null;
let logBytesWritten = 0;

function getLogFileName() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `diag_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`;
}

function ensureLogStream() {
  if (logStream) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const filePath = path.join(LOG_DIR, getLogFileName());
    logStream = fs.createWriteStream(filePath, { flags: "a" });
    logStream.on("error", () => { logStream = null; });
    try {
      const stat = fs.statSync(filePath);
      logBytesWritten = stat.size;
    } catch { logBytesWritten = 0; }
  } catch { /* logging is best-effort */ }
}

function rotateIfNeeded() {
  if (logBytesWritten < MAX_LOG_SIZE) return;
  if (logStream) {
    logStream.end();
    logStream = null;
    logBytesWritten = 0;
  }
  ensureLogStream();
}

function ts() {
  return new Date().toISOString();
}

/** Fire-and-forget diagnostic log. Never throws, never blocks. */
function diag(sessionId: string, event: string, detail?: Record<string, unknown>) {
  try {
    ensureLogStream();
    rotateIfNeeded();
    const line = JSON.stringify({ t: ts(), s: sessionId, e: event, ...detail }) + "\n";
    logStream?.write(line);
    logBytesWritten += Buffer.byteLength(line);
  } catch { /* best-effort */ }
}

/** Returns a tiny stopwatch: call returned fn to get elapsed ms. */
function stopwatch(): () => number {
  const start = performance.now();
  return () => Math.round(performance.now() - start);
}

// ---------------------------------------------------------------------------
// Session transcript recorder — one JSONL file per session
// ---------------------------------------------------------------------------
const SESSION_DIR = path.join(process.cwd(), "logs", "sessions");

type SessionEntry = {
  /** ISO timestamp */
  t: string;
  /** Sequence number within session */
  seq: number;
  /** Which side: left (English) or right (Chinese) */
  side: string;
  /** Source language detected */
  lang: string;
  /** Raw ASR transcript */
  source: string;
  /** Corrected transcript */
  corrected: string;
  /** Translation output */
  translation: string;
  /** Translation latency in ms (from translate_start to translate_done) */
  translateMs?: number;
};

const SESSION_RETENTION_DAYS = 30;

/** Count today's existing session files to determine the next conversation number. */
function getNextConversationNumber(): number {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const todayPrefix = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_`;
  try {
    const files = fs.readdirSync(SESSION_DIR).filter(f => f.startsWith(todayPrefix));
    const nums = files.map(f => {
      const m = f.match(/^[\d-]+_对话(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    });
    return (nums.length > 0 ? Math.max(...nums) : 0) + 1;
  } catch { return 1; }
}

/** Delete session files older than SESSION_RETENTION_DAYS. Runs once at startup. */
function cleanOldSessions() {
  try {
    const cutoff = Date.now() - SESSION_RETENTION_DAYS * 86400000;
    for (const f of fs.readdirSync(SESSION_DIR)) {
      const filePath = path.join(SESSION_DIR, f);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(filePath);
      } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }
}

/** Tracks the latest conversation file so reconnections can resume. */
let latestConversation: { filePath: string; seq: number; num: number } | null = null;

class SessionRecorder {
  private stream: fs.WriteStream | null = null;
  private seq = 0;
  private filePath: string;

  constructor() {
    try { fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch { /* best-effort */ }
    const num = getNextConversationNumber();
    this.filePath = this.buildFilePath(num);
    this.openFile(num);
  }

  private buildFilePath(num: number) {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return path.join(SESSION_DIR, `${dateStr}_对话${num}.jsonl`);
  }

  private openFile(num: number) {
    this.closeStream();
    try {
      this.stream = fs.createWriteStream(this.filePath, { flags: "a" });
      this.stream.on("error", () => { this.stream = null; });
    } catch { /* best-effort */ }
    latestConversation = { filePath: this.filePath, seq: this.seq, num };
  }

  private closeStream() {
    try { this.stream?.end(); } catch { /* best-effort */ }
    this.stream = null;
  }

  /** Called when restore_context arrives — continue writing to the previous conversation file. */
  continueConversation(contextEntryCount: number) {
    if (contextEntryCount > 0 && latestConversation && latestConversation.seq > 0) {
      this.filePath = latestConversation.filePath;
      this.seq = latestConversation.seq;
      this.openFile(latestConversation.num);
      this.record({ side: "-", lang: "-", source: "", corrected: "", translation: "[resumed]" });
      return;
    }
    // No prior conversation — keep current new file
  }

  /** Called on reset — start a brand new conversation file. */
  resetConversation() {
    this.record({ side: "-", lang: "-", source: "", corrected: "", translation: "[reset]" });
    const num = getNextConversationNumber();
    this.filePath = this.buildFilePath(num);
    this.seq = 0;
    this.openFile(num);
  }

  record(entry: Omit<SessionEntry, "t" | "seq">) {
    try {
      const line = JSON.stringify({ t: ts(), seq: ++this.seq, ...entry }) + "\n";
      this.stream?.write(line);
      if (latestConversation) latestConversation.seq = this.seq;
    } catch { /* best-effort */ }
  }

  close() {
    this.closeStream();
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const REQUIRED_ENV_VARS = ["AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION", "OPENAI_API_KEY"] as const;

// Merge / commit timing
const TRANSLATION_TIMEOUT_MS = 20000;
const MAX_TRANSLATION_TIMEOUT_RETRIES = 1;
const MAX_TRANSLATION_CONTEXT_ENTRIES = 20;
const MAX_TRANSLATION_CONTEXT_CHARS = 4000;
const MAX_PROMPT_CURRENT_SIDE_CONTEXT_ENTRIES = 12;
const MAX_PROMPT_CURRENT_SIDE_CONTEXT_CHARS = 2400;
const MAX_PROMPT_OTHER_SIDE_CONTEXT_ENTRIES = 8;
const MAX_PROMPT_OTHER_SIDE_CONTEXT_CHARS = 1600;
const OPENING_ANCHOR_WINDOW_MS = 90_000;
const OPENING_ANCHOR_INITIAL_ENTRY_TARGET = 4;
const OPENING_ANCHOR_REFRESH_ENTRY_TARGET = 6;
const OPENING_ANCHOR_MAX_SOURCE_ENTRIES = 6;
const OPENING_ANCHOR_TIMEOUT_MS = 6000;
const OPENING_ANCHOR_MODEL = "gpt-5.4-mini";
const OPENING_ANCHOR_MAX_CHARS = 320;

type ASRPostProcessingConfig = {
  mergeWindowMs: number;
  incompleteMergeWindowMs: number;
  commitDelayMs: number;
  incompleteCommitDelayMs: number;
  translationDebounceMs: number;
  incompleteTranslationDebounceMs: number;
  maxMergeZhChars: number;
  maxMergeEnWords: number;
};

const ASR_POST_PROCESSING: Record<ASRProvider, ASRPostProcessingConfig> = {
  azure: {
    // Azure was over-merging multiple recognizer finals into one pending
    // translation, which made GPT corrections feel too aggressive. Keep a
    // moderate window so we still smooth obvious fragments without turning
    // whole turns into a single late commit.
    mergeWindowMs: 2200,
    incompleteMergeWindowMs: 3800,
    commitDelayMs: 1800,
    incompleteCommitDelayMs: 3200,
    translationDebounceMs: 200,
    incompleteTranslationDebounceMs: 700,
    maxMergeZhChars: 120,
    maxMergeEnWords: 48,
  },
  qwen: {
    // Qwen already emits cleaner finals, so keep post-processing light.
    mergeWindowMs: 900,
    incompleteMergeWindowMs: 2600,
    commitDelayMs: 900,
    incompleteCommitDelayMs: 2200,
    translationDebounceMs: 150,
    incompleteTranslationDebounceMs: 600,
    maxMergeZhChars: 90,
    maxMergeEnWords: 36,
  },
  soniox: {
    // Soniox endpointing is now intentionally a bit slower to avoid chopping
    // longer phrases mid-word, so keep the server merge/commit window wide
    // enough for endpoint and idle-final pairs to collapse back together.
    mergeWindowMs: 2200,
    incompleteMergeWindowMs: 4000,
    commitDelayMs: 1800,
    incompleteCommitDelayMs: 3400,
    translationDebounceMs: 150,
    incompleteTranslationDebounceMs: 700,
    maxMergeZhChars: 100,
    maxMergeEnWords: 40,
  },
};

const openaiClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type TranslationSide = "left" | "right";
type SourceLanguage = "en" | "zh";
type TranslationContextEntry = {
  source: string;
  corrected: string;
  translation: string;
};

type PersistedConversationContext = Record<TranslationSide, TranslationContextEntry[]> & {
  openingAnchor?: string;
};

type OpeningAnchorSourceEntry = {
  side: TranslationSide;
  language: SourceLanguage;
  corrected: string;
  translation: string;
};

const EN_LOW_SIGNAL_CONTEXT_WORDS = new Set([
  "uh",
  "um",
  "umm",
  "uhm",
  "hmm",
  "hm",
  "mm",
  "mhm",
  "ok",
  "okay",
  "alright",
  "right",
  "yeah",
  "yep",
  "yup",
  "hello",
  "hi",
  "thanks",
  "thank",
  "you",
  "bye",
  "goodbye",
]);

const EN_LOW_SIGNAL_CONTEXT_PHRASES = new Set([
  "ok",
  "okay",
  "alright",
  "right",
  "yeah",
  "yep",
  "yup",
  "thankyou",
  "thanks",
  "hithere",
  "hello",
  "hi",
  "bye",
  "byebye",
  "goodbye",
  "seeyou",
]);

const ZH_LOW_SIGNAL_CONTEXT_PHRASES = new Set([
  "嗯",
  "嗯嗯",
  "啊",
  "啊啊",
  "呃",
  "哦",
  "喔",
  "哎",
  "诶",
  "欸",
  "唉",
  "好",
  "好的",
  "好吧",
  "你好",
  "您好",
  "谢谢",
  "多谢",
  "再见",
  "拜拜",
]);

const LEADING_LOW_SIGNAL_NORMALIZED_PREFIXES = Array.from(
  new Set([
    ...Array.from(EN_LOW_SIGNAL_CONTEXT_PHRASES),
    ...Array.from(ZH_LOW_SIGNAL_CONTEXT_PHRASES),
    "uh",
    "um",
    "umm",
    "uhm",
    "hmm",
    "hm",
    "mm",
    "mhm",
  ])
).sort((a, b) => b.length - a.length);

type PendingTranslation = {
  id: string;
  text: string;
  language: SourceLanguage;
  asrMetadata: ASRFinalMetadata[];
  revision: number;
  latestResolvedRevision: number;
  latestCorrectedText: string;
  latestTranslation: string;
  latestPartialTranslation: string;
  translationTimeoutRetryCount: number;
  translationAttemptToken: number;
  lastUpdatedAt: number;
  commitRequested: boolean;
  commitTimer: NodeJS.Timeout | null;
  translationTimer: NodeJS.Timeout | null;
  isTranslationInFlight: boolean;
  lastTranslateMs: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getMissingEnvVars() {
  return REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
}

function getSideFromLanguage(lang: SourceLanguage): TranslationSide {
  return lang === "zh" ? "right" : "left";
}

function getOppositeSide(side: TranslationSide): TranslationSide {
  return side === "left" ? "right" : "left";
}

function detectLanguageFromAzure(langCode: string): SourceLanguage {
  return langCode.startsWith("zh") ? "zh" : "en";
}

function detectLanguageFromText(text: string): SourceLanguage {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const totalChars = text.replace(/\s/g, "").length;
  // If more than 30% of characters are Chinese, consider it Chinese
  return totalChars > 0 && chineseChars / totalChars > 0.3 ? "zh" : "en";
}

function appendTranscript(base: string, chunk: string, language: SourceLanguage) {
  if (!base) return chunk;
  if (!chunk) return base;
  return language === "zh" ? `${base}${chunk}` : `${base} ${chunk}`;
}

function countChineseChars(text: string) {
  return (text.match(/[\u4e00-\u9fff]/g) || []).length;
}

function countEnglishWords(text: string) {
  return (text.match(/\b[a-zA-Z]+(?:['\u2019-][a-zA-Z]+)?\b/g) || []).length;
}

function normalizeContextSignalText(text: string) {
  return text
    .toLowerCase()
    .replace(/[\s"'`~.,!?;:()\[\]{}<>|/\\+*=—\-，。！？；：、“”‘’（）【】《》…、]+/gu, "");
}

function stripLeadingLowSignalPrefixes(normalized: string) {
  let remaining = normalized;
  let changed = false;

  while (remaining) {
    const prefix = LEADING_LOW_SIGNAL_NORMALIZED_PREFIXES.find((candidate) =>
      remaining.startsWith(candidate)
    );
    if (!prefix) break;
    remaining = remaining.slice(prefix.length);
    changed = true;
  }

  return changed ? remaining : normalized;
}

function isLowSignalContextEntry(entry: TranslationContextEntry) {
  const text = (entry.corrected || entry.source || "").trim();
  if (!text) return true;
  if (/\d/.test(text)) return false;

  const normalized = normalizeContextSignalText(text);
  if (!normalized) return true;

  const strippedNormalized = stripLeadingLowSignalPrefixes(normalized);
  if (!strippedNormalized) return true;
  if (strippedNormalized !== normalized) return false;

  if (/^[嗯啊呃哦喔哎诶欸唉]+$/u.test(normalized)) return true;
  if (ZH_LOW_SIGNAL_CONTEXT_PHRASES.has(normalized)) return true;
  if (EN_LOW_SIGNAL_CONTEXT_PHRASES.has(normalized)) return true;

  const englishWords = (text.toLowerCase().match(/[a-z]+(?:['\u2019-][a-z]+)?/g) || []).map((word) =>
    word.replace(/['\u2019-]/g, "")
  );
  if (
    englishWords.length > 0 &&
    englishWords.length <= 4 &&
    englishWords.every((word) => EN_LOW_SIGNAL_CONTEXT_WORDS.has(word))
  ) {
    return true;
  }

  return false;
}

function getTextWeight(text: string, language: SourceLanguage) {
  return language === "zh" ? countChineseChars(text) : countEnglishWords(text);
}

const EN_COMPLETE_SHORT_RESPONSES = new Set([
  "yes",
  "no",
  "ok",
  "okay",
  "sure",
  "right",
  "correct",
  "thanks",
  "thank you",
  "hello",
  "hi",
  "bye",
  "goodbye",
  "left",
  "right side",
  "left side",
  "left leg",
  "right leg",
  "left arm",
  "right arm",
]);

const EN_INCOMPLETE_TRAILING_WORD_RE =
  /\b(?:a|an|the|of|and|or|but|because|if|when|while|although|unless|than)$/iu;
const EN_INCOMPLETE_TRAILING_PHRASE_RE =
  /\b(?:one of the|some of the|about the|because of|in order to|as long as|what I mean is|the thing is)$/iu;
const ZH_INCOMPLETE_TRAILING_RE =
  /(?:如果|如果说|因为|但是|可是|不过|然后|关于|至于|比如|例如|包括|我的意思是|我想说|就是说|取决于|以便|为了|以及|或者|并且|而且|跟|和|与|从|向|把|被|给|让)$/u;
const ZH_INCOMPLETE_SINGLE_FRAGMENT_RE = /^(?:我|你|他|她|它|这|那|谁)$/u;

function stripUtteranceEndingPunctuation(text: string) {
  return text.trim().replace(/[\s。！？!?；;：:，,、….\-—]+$/gu, "").trim();
}

function isLikelyIncompleteUtterance(text: string, language: SourceLanguage) {
  const trimmed = text.trim();
  if (!trimmed) return false;

  if (/[!?！？]\s*$/u.test(trimmed)) return false;
  if (/[,，:：;；\-—…]\s*$/u.test(trimmed)) return true;

  const withoutEndingPunctuation = stripUtteranceEndingPunctuation(trimmed);
  if (!withoutEndingPunctuation) return false;

  if (language === "en") {
    const normalized = withoutEndingPunctuation.toLowerCase().replace(/\s+/g, " ");
    if (EN_COMPLETE_SHORT_RESPONSES.has(normalized)) return false;
    if (EN_INCOMPLETE_TRAILING_PHRASE_RE.test(normalized)) return true;
    if (EN_INCOMPLETE_TRAILING_WORD_RE.test(normalized)) return true;

    const words = normalized.match(/[a-z]+(?:['\u2019-][a-z]+)?/g) || [];
    return (
      words.length <= 2 &&
      /^(?:i|you|he|she|it|we|they|this|that|these|those|who)$/u.test(normalized)
    );
  }

  if (ZH_INCOMPLETE_TRAILING_RE.test(withoutEndingPunctuation)) return true;
  return ZH_INCOMPLETE_SINGLE_FRAGMENT_RE.test(withoutEndingPunctuation);
}

function isHighSignalOpeningAnchorEntry(
  entry: TranslationContextEntry,
  language: SourceLanguage
) {
  if (isLowSignalContextEntry(entry)) return false;
  const text = (entry.corrected || entry.source || "").trim();
  if (!text) return false;
  if (/\d/.test(text)) return true;
  return language === "zh" ? countChineseChars(text) >= 12 : countEnglishWords(text) >= 5;
}

function canMerge(
  pending: PendingTranslation,
  newLanguage: SourceLanguage,
  config: ASRPostProcessingConfig
): boolean {
  if (pending.commitRequested) return false;
  if (pending.language !== newLanguage) return false;
  // Keep the merge window independent from translation latency. Otherwise
  // short idle-final + endpoint-final pairs get split purely because GPT
  // already started, which is exactly how fragments like "sched" / "ule..."
  // turn into separate rows.
  const mergeWindowMs = isLikelyIncompleteUtterance(pending.text, pending.language)
    ? config.incompleteMergeWindowMs
    : config.mergeWindowMs;
  if (Date.now() - pending.lastUpdatedAt > mergeWindowMs) return false;

  const weight = getTextWeight(pending.text, pending.language);
  if (pending.language === "zh" && weight >= config.maxMergeZhChars) return false;
  if (pending.language === "en" && weight >= config.maxMergeEnWords) return false;

  return true;
}

function trimTranslationContext(
  entries: TranslationContextEntry[],
  maxEntries: number = MAX_TRANSLATION_CONTEXT_ENTRIES,
  maxChars: number = MAX_TRANSLATION_CONTEXT_CHARS
) {
  const filtered = entries.filter((entry) => !isLowSignalContextEntry(entry));
  const trimmed = filtered.slice(-maxEntries);
  let totalChars = trimmed.reduce(
    (sum, e) => sum + e.source.length + e.corrected.length + e.translation.length,
    0
  );
  while (trimmed.length > 1 && totalChars > maxChars) {
    const removed = trimmed.shift();
    if (!removed) break;
    totalChars -= removed.source.length + removed.corrected.length + removed.translation.length;
  }
  return trimmed;
}

function buildConversationContext(
  entries: TranslationContextEntry[],
  maxEntries: number = MAX_TRANSLATION_CONTEXT_ENTRIES,
  maxChars: number = MAX_TRANSLATION_CONTEXT_CHARS
) {
  return trimTranslationContext(entries, maxEntries, maxChars)
    .map(
      (e, i) =>
        `${i + 1}. source=${e.source}${
          e.corrected && e.corrected !== e.source ? `\ncorrected=${e.corrected}` : ""
        }\ntranslation=${e.translation}`
    )
    .join("\n\n");
}

function sanitizeOpeningAnchor(text: string) {
  if (!text) return "";
  const lines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== "(empty)");
  if (lines.length === 0) return "";
  return lines.join("\n").slice(0, OPENING_ANCHOR_MAX_CHARS).trim();
}

function buildOpeningAnchorMessages(entries: OpeningAnchorSourceEntry[]) {
  const openingSnippets = entries
    .map(
      (entry, index) =>
        `${index + 1}. side=${entry.side} lang=${entry.language}\ncorrected=${entry.corrected}${
          entry.translation ? `\ntranslation=${entry.translation}` : ""
        }`
    )
    .join("\n\n");

  return [
    {
      role: "system" as const,
      content: `You extract stable opening-call facts for later interpretation.
Use only facts explicitly stated in the provided opening snippets. Never infer unstated facts. Never include filler, greetings, acknowledgements, or low-information chatter.
Return concise English key:value lines only. Omit unknown fields. Allowed fields only:
domain
left_role
right_role
organization
call_goal
chief_complaint
important_entities
If the snippets are too weak, return exactly:
(empty)
Keep the full output under 280 characters.`,
    },
    {
      role: "user" as const,
      content: `[Opening Snippets]\n${openingSnippets}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------
const STREAMING_THROTTLE_MS = 100;

// Detect translation hallucination: foreign scripts that are neither Chinese nor English
// Cyrillic, Devanagari, Arabic, Thai, Korean (when unexpected), etc.
const FOREIGN_SCRIPT_RE = /[\u0400-\u04ff\u0900-\u097f\u0600-\u06ff\u0e00-\u0e7f\u1000-\u109f\u0b80-\u0bff\u0c00-\u0c7f\u0c80-\u0cff\u0d00-\u0d7f\u10a0-\u10ff]/u;
const FOREIGN_SCRIPT_RE_GLOBAL = /[\u0400-\u04ff\u0900-\u097f\u0600-\u06ff\u0e00-\u0e7f\u1000-\u109f\u0b80-\u0bff\u0c00-\u0c7f\u0c80-\u0cff\u0d00-\u0d7f\u10a0-\u10ff]/gu;

function hasTranslationHallucination(translation: string): boolean {
  return FOREIGN_SCRIPT_RE.test(translation);
}

function sanitizeHallucinatedTranslation(translation: string): string {
  return translation
    .replace(FOREIGN_SCRIPT_RE_GLOBAL, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/[ ,;:]+$/g, "")
    .trim();
}

type MedicalAbbreviationExpansion = {
  pattern: RegExp;
  expansion: string | ((match: string) => string);
  guard: RegExp;
  shouldExpand?: (sourceText: string) => boolean;
};

function medicalAcronymPattern(acronym: string, flags: string = "g") {
  const body = acronym
    .split("")
    .map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\.?\\s*");
  return new RegExp(`\\b${body}\\.?(?=$|[^A-Za-z])`, flags);
}

function canonicalAcronym(match: string) {
  return match.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function sourceLooksLikeEmergencyRoom(text: string) {
  if (/\bE\.?\s*R\.?\s*(?:positive|negative|pos|neg|\+|-)\b/i.test(text)) return false;
  return /\bE\.?\s*R\.?\b/i.test(text)
    && /\b(?:emergency|urgent|room|department|visit|went|go|come|send|sent|hospital|triage)\b/i.test(text);
}

function sourceLooksLikeIntravenous(text: string) {
  if (/\b(?:stage|grade)\s*(?:I\.?\s*V\.?|4)\b/i.test(text)) return false;
  return /\bI\.?\s*V\.?\b/i.test(text)
    && /\b(?:intravenous|antibiotic|antibiotics|fluid|fluids|contrast|injection|infusion|line|drip|push|medication|medicine|dose|hydration)\b/i.test(text);
}

function sourceLooksLikeIntramuscular(text: string) {
  return /\bI\.?\s*M\.?\b/i.test(text)
    && /\b(?:intramuscular|injection|shot|vaccine|medication|medicine|dose)\b/i.test(text);
}

const MEDICAL_ABBREVIATION_EXPANSIONS_ZH: MedicalAbbreviationExpansion[] = [
  { pattern: medicalAcronymPattern("MRI", "gi"), expansion: "核磁共振（MRI）", guard: /核磁|磁共振/i },
  { pattern: medicalAcronymPattern("CT", "gi"), expansion: "计算机断层扫描（CT）", guard: /断层扫描|计算机断层/i },
  { pattern: /\b(?:E\.?\s*C\.?\s*G|E\.?\s*K\.?\s*G)\.?(?=$|[^A-Za-z])/gi, expansion: (match) => `心电图（${canonicalAcronym(match)}）`, guard: /心电图/i },
  { pattern: medicalAcronymPattern("EEG"), expansion: "脑电图（EEG）", guard: /脑电图/i },
  { pattern: medicalAcronymPattern("EMG"), expansion: "肌电图（EMG）", guard: /肌电图/i },
  { pattern: medicalAcronymPattern("CBC", "gi"), expansion: "血常规（CBC）", guard: /血常规|全血细胞计数/i },
  { pattern: medicalAcronymPattern("CMP"), expansion: "综合代谢检查（CMP）", guard: /全套代谢|综合代谢|代谢检查/i },
  { pattern: medicalAcronymPattern("BMP"), expansion: "基础代谢检查（BMP）", guard: /基础代谢|基本代谢/i },
  { pattern: /(?:\bA\.?\s*1\.?\s*C\.?|\bH\.?\s*B\.?\s*A\.?\s*1\.?\s*C\.?)(?=$|[^A-Za-z])/gi, expansion: "糖化血红蛋白（HbA1c）", guard: /糖化血红蛋白/i },
  { pattern: medicalAcronymPattern("BP"), expansion: "血压", guard: /血压/i },
  { pattern: medicalAcronymPattern("HR"), expansion: "心率", guard: /心率/i },
  { pattern: medicalAcronymPattern("O2"), expansion: "氧气", guard: /氧气|吸氧/i },
  { pattern: medicalAcronymPattern("SpO2", "gi"), expansion: "血氧饱和度（SpO2）", guard: /血氧|氧饱和/i },
  { pattern: medicalAcronymPattern("ICU"), expansion: "重症监护室（ICU）", guard: /重症监护/i },
  { pattern: medicalAcronymPattern("ER"), expansion: "急诊室（ER）", guard: /急诊/i, shouldExpand: sourceLooksLikeEmergencyRoom },
  { pattern: medicalAcronymPattern("ENT"), expansion: "耳鼻喉科（ENT）", guard: /耳鼻喉/i },
  { pattern: /\bOB\/?GYN\b/gi, expansion: "妇产科（OB/GYN）", guard: /妇产科|妇科|产科/i },
  { pattern: medicalAcronymPattern("UTI"), expansion: "尿路感染（UTI）", guard: /尿路感染|泌尿道感染/i },
  { pattern: medicalAcronymPattern("URI"), expansion: "上呼吸道感染（URI）", guard: /上呼吸道感染/i },
  { pattern: medicalAcronymPattern("COPD"), expansion: "慢性阻塞性肺病（COPD）", guard: /慢性阻塞性肺病|慢阻肺/i },
  { pattern: medicalAcronymPattern("CHF"), expansion: "心力衰竭（CHF）", guard: /心力衰竭|心衰/i },
  { pattern: medicalAcronymPattern("CAD"), expansion: "冠状动脉疾病（CAD）", guard: /冠状动脉|冠心病/i },
  { pattern: medicalAcronymPattern("DVT"), expansion: "深静脉血栓（DVT）", guard: /深静脉血栓/i },
  { pattern: medicalAcronymPattern("CKD"), expansion: "慢性肾病（CKD）", guard: /慢性肾病|慢性肾脏病/i },
  { pattern: medicalAcronymPattern("ESRD"), expansion: "终末期肾病（ESRD）", guard: /终末期肾病/i },
  { pattern: medicalAcronymPattern("GERD"), expansion: "胃食管反流病（GERD）", guard: /胃食管反流/i },
  { pattern: medicalAcronymPattern("IBS"), expansion: "肠易激综合征（IBS）", guard: /肠易激/i },
  { pattern: medicalAcronymPattern("IBD"), expansion: "炎症性肠病（IBD）", guard: /炎症性肠病/i },
  { pattern: medicalAcronymPattern("HIV"), expansion: "艾滋病病毒（HIV）", guard: /艾滋病病毒/i },
  { pattern: medicalAcronymPattern("AIDS"), expansion: "艾滋病（AIDS）", guard: /艾滋病/i },
  { pattern: medicalAcronymPattern("STD"), expansion: "性传播疾病（STD）", guard: /性传播疾病|性病/i },
  { pattern: medicalAcronymPattern("STI"), expansion: "性传播感染（STI）", guard: /性传播感染|性传播疾病|性病/i },
  { pattern: medicalAcronymPattern("HPV"), expansion: "人乳头瘤病毒（HPV）", guard: /人乳头瘤病毒/i },
  { pattern: medicalAcronymPattern("BPH"), expansion: "前列腺增生（BPH）", guard: /前列腺增生/i },
  { pattern: medicalAcronymPattern("PSA"), expansion: "前列腺特异性抗原（PSA）", guard: /前列腺特异性抗原/i },
  { pattern: medicalAcronymPattern("TSH"), expansion: "促甲状腺激素（TSH）", guard: /促甲状腺激素/i },
  { pattern: medicalAcronymPattern("INR"), expansion: "国际标准化比值（INR）", guard: /国际标准化比值/i },
  { pattern: medicalAcronymPattern("WBC"), expansion: "白细胞（WBC）", guard: /白细胞/i },
  { pattern: medicalAcronymPattern("RBC"), expansion: "红细胞（RBC）", guard: /红细胞/i },
  { pattern: medicalAcronymPattern("Hgb", "gi"), expansion: "血红蛋白（Hgb）", guard: /血红蛋白/i },
  { pattern: medicalAcronymPattern("Hct", "gi"), expansion: "红细胞压积（Hct）", guard: /红细胞压积/i },
  { pattern: medicalAcronymPattern("CXR"), expansion: "胸部X光片（CXR）", guard: /胸部X光|胸片/i },
  { pattern: medicalAcronymPattern("IV"), expansion: "静脉给药（IV）", guard: /静脉给药|静脉注射|静脉输液/i, shouldExpand: sourceLooksLikeIntravenous },
  { pattern: medicalAcronymPattern("IM"), expansion: "肌肉注射（IM）", guard: /肌肉注射/i, shouldExpand: sourceLooksLikeIntramuscular },
  { pattern: medicalAcronymPattern("NPO", "gi"), expansion: "禁食禁水（NPO）", guard: /禁食|禁水/i },
  { pattern: medicalAcronymPattern("PRN", "gi"), expansion: "按需使用（PRN）", guard: /按需使用|需要时使用/i },
  { pattern: medicalAcronymPattern("BID", "gi"), expansion: "每天两次（BID）", guard: /每天两次|每日两次/i },
  { pattern: medicalAcronymPattern("TID", "gi"), expansion: "每天三次（TID）", guard: /每天三次|每日三次/i },
  { pattern: medicalAcronymPattern("QID", "gi"), expansion: "每天四次（QID）", guard: /每天四次|每日四次/i },
  { pattern: medicalAcronymPattern("QHS", "gi"), expansion: "睡前服用（QHS）", guard: /睡前/i },
];

function expandMedicalAbbreviationsForChinese(sourceText: string, translation: string) {
  let expanded = translation;
  for (const item of MEDICAL_ABBREVIATION_EXPANSIONS_ZH) {
    if (item.shouldExpand && !item.shouldExpand(sourceText)) continue;
    if (item.guard.test(translation)) continue;
    expanded = expanded.replace(item.pattern, (match) => (
      typeof item.expansion === "function" ? item.expansion(match) : item.expansion
    ));
  }
  return expanded;
}

function finalizeTranslationText(sourceText: string, sourceLang: SourceLanguage, translation: string) {
  if (!translation.trim()) return translation;
  if (sourceLang !== "en") return translation;
  if (!/[A-Za-z0-9]/.test(sourceText + translation)) return translation;
  return expandMedicalAbbreviationsForChinese(sourceText, translation);
}

function parseStructuredOutput(content: string, fallbackText: string) {
  let correctedText = fallbackText;
  let translation = "";
  const correctedIdx = content.indexOf("[[CORRECTED]]");
  const translationIdx = content.indexOf("[[TRANSLATION]]");
  if (correctedIdx >= 0 && translationIdx > correctedIdx) {
    correctedText = content.substring(correctedIdx + "[[CORRECTED]]".length, translationIdx).trim() || fallbackText;
  }
  if (translationIdx >= 0) {
    translation = content.substring(translationIdx + "[[TRANSLATION]]".length).trim();
  }
  return { correctedText, translation };
}

function isTranslationTimeoutError(error: unknown) {
  return error instanceof Error && error.message === "Translation timed out";
}

function normalizeCorrectionComparisonText(text: string) {
  return text
    .toLowerCase()
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.?!,;:"]+$/g, "");
}

function shouldPreserveIncompleteLeadingFragment(sourceText: string, correctedText: string) {
  const source = sourceText.trim();
  const corrected = correctedText.trim();
  if (!source || !corrected || source === corrected) return false;

  // Mid-sentence ASR fragments often start with a lowercase tail such as
  // "ule your medication..." after the previous chunk ended with "sched".
  // If the model turns that fragment into a strict suffix by deleting the
  // leading tail, keep the original fragment instead of showing it as removed.
  if (!/^[a-z]/.test(source)) return false;

  const normalizedSource = normalizeCorrectionComparisonText(source);
  const normalizedCorrected = normalizeCorrectionComparisonText(corrected);
  if (!normalizedSource || !normalizedCorrected) return false;
  if (!normalizedSource.endsWith(normalizedCorrected)) return false;

  const removedChars = normalizedSource.length - normalizedCorrected.length;
  return removedChars >= 6;
}

const CHINESE_MEDICAL_SOURCE_TERM_RE =
  /[\u4e00-\u9fff]{0,8}(?:地平|沙坦|普利|洛尔|他汀|拉唑|西林|霉素|环素|沙星|替尼|单抗|利尿|抗凝|降压|降糖|止痛|麻醉|激素|胰岛素|血压|血糖|血脂|心率|心脏|肾脏|肝脏|肺部|胃部|肠道|甲状腺|前列腺|高血压|低血压|糖尿病|冠心病|心衰|房颤|哮喘|肺炎|胃炎|肠炎|肝炎|肾炎|尿路|结石|感染|肿瘤|癌|息肉|囊肿|超声|造影|活检|内镜|镜检|CT|MRI|核磁|心电图|血常规|尿常规)[\u4e00-\u9fff]{0,6}(?:类)?/giu;

const CHINESE_MEDICAL_EXPLANATION_RE =
  /(?:钙|钠|钾|β|β受体|受体|通道|酶|血管紧张素|ACE|ARB|PPI|HMG|COX)[\u4e00-\u9fffA-Za-zβ-]{0,12}(?:阻滞|拮抗|抑制|激动|调节|受体|通道|机制|药|剂|类)/iu;

function extractChineseMedicalSourceTerms(text: string) {
  const terms = new Set<string>();
  for (const match of text.matchAll(CHINESE_MEDICAL_SOURCE_TERM_RE)) {
    const term = match[0].trim();
    if (term.length >= 3) terms.add(term);
  }
  return Array.from(terms).sort((a, b) => b.length - a.length);
}

function preserveChineseMedicalSourceTerms(sourceText: string, correctedText: string) {
  if (!/[\u4e00-\u9fff]/u.test(sourceText) || !/[\u4e00-\u9fff]/u.test(correctedText)) {
    return correctedText;
  }

  const sourceTerms = extractChineseMedicalSourceTerms(sourceText);
  if (sourceTerms.length === 0) return correctedText;

  const missingImportantTerm = sourceTerms.some((term) => {
    if (correctedText.includes(term)) return false;
    const withoutClass = term.replace(/类$/u, "");
    if (withoutClass.length >= 3 && correctedText.includes(withoutClass)) return false;
    return true;
  });

  if (!missingImportantTerm) return correctedText;

  // If a low-frequency medical source term disappeared and the replacement
  // looks like a mechanism/class explanation, keep the ASR wording. The
  // translation can explain; corrected_text must not paraphrase.
  if (CHINESE_MEDICAL_EXPLANATION_RE.test(correctedText)) {
    return sourceText;
  }

  return correctedText;
}

function finalizeCorrectedText(fallbackText: string, correctedText: string) {
  if (!correctedText.trim()) return fallbackText;
  if (shouldPreserveIncompleteLeadingFragment(fallbackText, correctedText)) {
    return fallbackText;
  }
  return preserveChineseMedicalSourceTerms(fallbackText, correctedText);
}

function buildASRConfidenceHints(metadata: ASRFinalMetadata[]) {
  const sonioxEntries = metadata.filter(
    (entry) =>
      entry.provider === "soniox" &&
      (typeof entry.averageConfidence === "number" ||
        (entry.lowConfidenceTokens?.length || 0) > 0)
  );
  if (sonioxEntries.length === 0) return "";

  return sonioxEntries
    .map((entry, index) => {
      const details: string[] = [];
      if (typeof entry.averageConfidence === "number") {
        details.push(`average=${entry.averageConfidence.toFixed(3)}`);
      }
      if (typeof entry.minConfidence === "number") {
        details.push(`minimum=${entry.minConfidence.toFixed(3)}`);
      }
      if (entry.lowConfidenceTokens?.length) {
        const tokenList = entry.lowConfidenceTokens
          .map(
            (token) =>
              `${JSON.stringify(token.text)}(${token.confidence.toFixed(3)})`
          )
          .join(", ");
        details.push(`low-confidence tokens=${tokenList}`);
      } else {
        details.push("low-confidence tokens=none");
      }
      return `segment ${index + 1}: ${details.join("; ")}`;
    })
    .join("\n");
}

function countLowConfidenceTokens(metadata: ASRFinalMetadata[]) {
  return metadata.reduce(
    (sum, entry) => sum + (entry.lowConfidenceTokens?.length || 0),
    0
  );
}

function buildTranslateMessages(
  text: string,
  sourceLang: SourceLanguage,
  side: TranslationSide,
  translationContexts: Record<TranslationSide, TranslationContextEntry[]>,
  openingAnchor?: string,
  asrMetadata: ASRFinalMetadata[] = []
) {
  const targetLang = sourceLang === "zh" ? "English" : "Simplified Chinese";
  const asrConfidenceHints = buildASRConfidenceHints(asrMetadata);
  const conversationContext = buildConversationContext(
    translationContexts[side] || [],
    MAX_PROMPT_CURRENT_SIDE_CONTEXT_ENTRIES,
    MAX_PROMPT_CURRENT_SIDE_CONTEXT_CHARS
  );
  const otherSpeakerContext = buildConversationContext(
    translationContexts[getOppositeSide(side)] || [],
    MAX_PROMPT_OTHER_SIDE_CONTEXT_ENTRIES,
    MAX_PROMPT_OTHER_SIDE_CONTEXT_CHARS
  );
  return [
    {
      role: "system" as const,
      content: `You are a top-tier simultaneous interpreter and transcript corrector.
I will provide an Opening Anchor plus rolling conversation context from the current session for the current speaker and the other speaker. Use them to improve coherence, infer the active domain, and keep terminology consistent.
The Opening Anchor is a short low-frequency memory extracted from the beginning of the call. Treat it as helpful background only. If it conflicts with the current sentence or recent speaker context, trust the current sentence and recent context.
For corrected_text: Fix ASR misrecognitions — wrong characters/words due to similar pronunciation or phonetic confusion. Do NOT replace slang, colloquialisms, idioms, or informal expressions with their formal equivalents. Preserve the speaker's exact wording — if they said "大漂亮" keep it as "大漂亮", do not change it to "美国".
Correction and translation are separate tasks. corrected_text must preserve the speaker's surface wording. Do NOT replace a specific term with its definition, mechanism, hypernym, drug class, or explanatory paraphrase. Semantic relatedness is not enough for correction; the replacement must also be acoustically plausible.
For Chinese medical terms, preserve plausible low-frequency source terms, medication names, disease names, procedure names, body-part terms, and medication-class wording. Do NOT change a source term into a pharmacologic mechanism or broader category in corrected_text. Examples: keep "地平类"/"氨氯地平" rather than "钙拮抗剂"/"钙通道阻滞剂"; keep "沙坦类" rather than "血管紧张素受体阻滞剂"; keep "拉唑类" rather than "质子泵抑制剂"; keep "他汀类" rather than "HMG-CoA还原酶抑制剂". You may explain/interpret those terms only in [[TRANSLATION]].
Use conversation context to disambiguate homophones, names, and domain-specific terms. When a word makes no sense in the established domain but sounds similar to a domain-appropriate word, correct it (e.g. in a dental conversation: "DK" → "decay", "suit" → "tooth", "street" → "this tooth"; in a medical conversation: "satisfaction" → "speculum", "service" → "cervix"). The other speaker context is supporting evidence. Never add facts or words that were not actually spoken in the current sentence.
ASR Confidence Hints are advisory evidence from the speech recognizer. A low-confidence token marks a location where you may correct more actively, but only when the replacement is phonetically close and strongly supported by the current sentence and conversation context. For example, in an established biopsy discussion, low-confidence Chinese "复检" may be corrected to "活检" when that is the clear phonetic and semantic fit. Do not change a token solely because its confidence is low, and do not invent omitted speech. When confidence hints are unavailable, follow the normal conservative correction rules.
Do not add missing words just to complete a fragment. Do not infer unstated content unless the correction is highly certain from the current text and prior context. If uncertainty remains, keep the original wording.
If the current sentence is incomplete or cut off, keep corrected_text close to the original fragment and translate conservatively.
Translate the corrected current sentence into ${targetLang}. The translation SHOULD interpret the meaning (e.g. translate "大漂亮" as "the United States") and should prefer terminology that stays consistent with the current conversation.
Domain-aware translation: Infer the domain (medical, insurance, banking, legal, etc.) from conversation context and translate terminology accordingly. For example, "provider" in a medical context should be translated as "医疗服务提供方" or "医生", not literally as "提供者". Do not hardcode any single domain — always derive it from the ongoing conversation.
Medical abbreviation translation for Chinese target: If the English source/corrected_text contains a medical abbreviation or acronym, the Chinese translation must be understandable to a patient. Do not leave only the English abbreviation when a layperson may not know it. Translate the meaning into Simplified Chinese and keep the abbreviation in parentheses when useful. Examples: MRI → 核磁共振（MRI）, CT → 计算机断层扫描（CT）, ECG/EKG → 心电图（ECG/EKG）, CBC → 血常规（CBC）, HbA1c/A1C → 糖化血红蛋白（HbA1c）, BP → 血压, HR → 心率, ICU → 重症监护室（ICU）, ENT → 耳鼻喉科（ENT）, UTI → 尿路感染（UTI）, COPD → 慢性阻塞性肺病（COPD）. For ambiguous abbreviations such as ED, PE, MS, RA, PT, or OR, use the medical context; if unresolved, avoid unsafe expansion and translate descriptively rather than guessing.
Gender consistency: In Chinese, 他/她/它 are all pronounced "tā". When translating Chinese to English, determine the correct gender pronoun from conversation context (e.g. if the other speaker has established the subject is a "daughter"/"she"/"her", translate 他 as "she"). When translating English to Chinese, use the contextually correct character (她 for female, 他 for male).
The translation output MUST be in ${targetLang} only. Never output words in Russian, Hindi, Arabic, or any other language that is not ${targetLang} or English. If you are unsure how to translate a word, keep the original word rather than substituting a word from another language.
If the target language is Chinese, always output Simplified Chinese characters and never Traditional Chinese.
Output in this exact format (two labeled sections):
[[CORRECTED]]
<corrected text here>
[[TRANSLATION]]
<translation here>`,
    },
    {
      role: "user" as const,
      content: `[Opening Anchor]\n${openingAnchor || "(empty)"}\n\n[Current Speaker Context]\n${conversationContext || "(empty)"}\n\n[Other Speaker Context]\n${otherSpeakerContext || "(empty)"}\n\n[ASR Confidence Hints]\n${asrConfidenceHints || "(not available)"}\n\n[Current Sentence to Correct and Translate]\n${text}`,
    },
  ];
}

function buildHallucinationRetryMessages(
  messages: ReturnType<typeof buildTranslateMessages>,
  sourceLang: SourceLanguage
) {
  const targetLang = sourceLang === "zh" ? "English" : "Simplified Chinese";
  return [
    messages[0],
    {
      role: "system" as const,
      content: `Retry mode. The [[TRANSLATION]] section must stay in ${targetLang} only.
Do not output Devanagari, Arabic, Cyrillic, Thai, Burmese, Tamil, Telugu, Kannada, Malayalam, Georgian, Korean, or Japanese characters.
If any term is uncertain, use a plain ${targetLang} paraphrase or omit the problematic word instead of switching scripts.`,
    },
    messages[1],
  ];
}

async function generateOpeningAnchor(
  entries: OpeningAnchorSourceEntry[],
  sessionId?: string
) {
  if (!openaiClient || entries.length === 0) return "";
  const sid = sessionId || "unknown";
  const messages = buildOpeningAnchorMessages(entries);
  const response = await Promise.race([
    openaiClient.chat.completions.create({
      model: OPENING_ANCHOR_MODEL,
      messages,
      temperature: 0.1,
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Opening anchor timed out")), OPENING_ANCHOR_TIMEOUT_MS)
    ),
  ]);
  const content = response.choices[0]?.message?.content || "";
  const anchor = sanitizeOpeningAnchor(content);
  if (anchor) {
    diag(sid, "opening_anchor_ready", { chars: anchor.length, text: anchor.substring(0, 120) });
  } else {
    diag(sid, "opening_anchor_empty");
  }
  return anchor;
}

async function translateText(
  text: string,
  sourceLang: SourceLanguage,
  side: TranslationSide,
  translationContexts: Record<TranslationSide, TranslationContextEntry[]>,
  openingAnchor: string,
  model: string = "gpt-5.4-mini",
  onPartialTranslation?: (partial: string) => boolean,
  sessionId?: string,
  asrMetadata: ASRFinalMetadata[] = [],
) {
  if (!openaiClient) {
    throw new Error("Server is missing OPENAI_API_KEY.");
  }

  const messages = buildTranslateMessages(
    text,
    sourceLang,
    side,
    translationContexts,
    openingAnchor,
    asrMetadata
  );

  const doStreamingCall = async () => {
    const stream = await openaiClient!.chat.completions.create({
      model,
      messages,
      temperature: 0.3,
      stream: true,
    });

    let accumulated = "";
    let translationStarted = false;
    let lastSentAt = 0;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || "";
      if (!delta) continue;
      accumulated += delta;

      if (!translationStarted) {
        if (accumulated.includes("[[TRANSLATION]]")) translationStarted = true;
        continue;
      }

      const now = Date.now();
      if (now - lastSentAt >= STREAMING_THROTTLE_MS) {
        lastSentAt = now;
        const partial = accumulated.substring(
          accumulated.indexOf("[[TRANSLATION]]") + "[[TRANSLATION]]".length
        ).trim();
        const finalizedPartial = finalizeTranslationText(text, sourceLang, partial);
        if (finalizedPartial && onPartialTranslation) {
          const shouldContinue = onPartialTranslation(finalizedPartial);
          if (!shouldContinue) break;
        }
      }
    }

    return parseStructuredOutput(accumulated, text);
  };

  const doNonStreamingCall = async () => {
    const response = await openaiClient!.chat.completions.create({
      model,
      messages,
      temperature: 0.3,
    });
    return parseStructuredOutput(response.choices[0]?.message?.content || "", text);
  };

  const result = onPartialTranslation ? await doStreamingCall() : await doNonStreamingCall();
  result.correctedText = finalizeCorrectedText(text, result.correctedText);
  result.translation = finalizeTranslationText(text, sourceLang, result.translation);

  // Detect hallucination (foreign script in translation) — retry once with lower temperature
  if (result.translation && hasTranslationHallucination(result.translation)) {
    const sid = sessionId || "unknown";
    diag(sid, "hallucination_detected", {
      text: text.substring(0, 80),
      translation: result.translation.substring(0, 120),
    });
    const sanitizedInitial = sanitizeHallucinatedTranslation(result.translation);
    const retrySw = stopwatch();
    const retryMessages = buildHallucinationRetryMessages(messages, sourceLang);
    let retryResult: ReturnType<typeof parseStructuredOutput>;
    try {
      const retryResponse = await openaiClient.chat.completions.create({
        model,
        messages: retryMessages,
        temperature: 0,
      });
      retryResult = parseStructuredOutput(retryResponse.choices[0]?.message?.content || "", text);
    } catch (error) {
      diag(sid, "hallucination_retry_error", {
        ms: retrySw(),
        error: String(error),
      });
      return {
        correctedText: result.correctedText,
        translation: sanitizedInitial || result.translation,
      };
    }

    if (hasTranslationHallucination(retryResult.translation)) {
      const sanitizedRetry = sanitizeHallucinatedTranslation(retryResult.translation);
      const fallbackTranslation =
        sanitizedRetry.length >= sanitizedInitial.length ? sanitizedRetry : sanitizedInitial;
      diag(sid, "hallucination_retry_failed", {
        ms: retrySw(),
        translation: retryResult.translation.substring(0, 120),
        fallbackChars: fallbackTranslation.length,
      });
      retryResult.translation = fallbackTranslation || retryResult.translation;
    } else {
      diag(sid, "hallucination_retry_ok", { ms: retrySw() });
    }
    retryResult.correctedText = finalizeCorrectedText(text, retryResult.correctedText);
    retryResult.translation = finalizeTranslationText(text, sourceLang, retryResult.translation);
    return retryResult;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
async function startServer() {
  cleanOldSessions();

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  type AliveWebSocket = WebSocket & { isAlive?: boolean };

  const heartbeatTimer = setInterval(() => {
    for (const client of wss.clients) {
      const socket = client as AliveWebSocket;
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 15000);

  server.on("close", () => {
    clearInterval(heartbeatTimer);
  });

  server.on("upgrade", (request, socket, head) => {
    if (request.url === "/api/ws") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
  });

  app.get("/api/health", (_req, res) => {
    const missingEnv = getMissingEnvVars();
    res.json({ status: missingEnv.length === 0 ? "ok" : "degraded", missingEnv });
  });

  // Test Azure Speech API
  app.post("/api/test-azure", async (_req, res) => {
    const speechKey = process.env.AZURE_SPEECH_KEY;
    const speechRegion = process.env.AZURE_SPEECH_REGION;
    if (!speechKey || !speechRegion) {
      return res.json({ success: false, error: "Missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION" });
    }
    try {
      // Verify by fetching a token
      const tokenUrl = `https://${speechRegion}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
      const resp = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Ocp-Apim-Subscription-Key": speechKey, "Content-Length": "0" },
      });
      if (resp.ok) {
        res.json({ success: true, region: speechRegion });
      } else {
        res.json({ success: false, error: `HTTP ${resp.status}: Invalid key or region` });
      }
    } catch (err: any) {
      res.json({ success: false, error: err.message || "Connection failed" });
    }
  });

  app.post("/api/test-qwen", async (_req, res) => {
    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      return res.json({ success: false, error: "Missing DASHSCOPE_API_KEY" });
    }

    let lastError = "";
    const diagTail: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const engine = new QwenASREngine({
      onPartial: () => {},
      onFinal: () => {},
      onError: (message) => {
        lastError = message;
      },
      diag: (event, detail) => {
        diagTail.push({ event, detail });
        if (diagTail.length > 8) diagTail.shift();
      },
    });

    try {
      const ok = await engine.start(16000, 1);
      await engine.stop("test endpoint");
      if (ok) {
        return res.json({
          success: true,
          model: "qwen3-asr-flash-realtime-2026-02-10",
          endpoint:
            process.env.DASHSCOPE_WS_URL ||
            ((process.env.DASHSCOPE_REGION || "").toLowerCase() === "cn" ||
            (process.env.DASHSCOPE_REGION || "").toLowerCase() === "china"
              ? "mainland"
              : "international"),
          diagTail,
        });
      }
      return res.json({
        success: false,
        error: lastError || "Qwen realtime handshake failed",
        diagTail,
      });
    } catch (err: any) {
      try {
        await engine.stop("test endpoint exception");
      } catch {}
      return res.json({
        success: false,
        error: err?.message || "Qwen realtime test failed",
        diagTail,
      });
    }
  });

  app.post("/api/test-soniox", async (_req, res) => {
    const apiKey = process.env.SONIOX_API_KEY;
    if (!apiKey) {
      return res.json({ success: false, error: "Missing SONIOX_API_KEY" });
    }

    let lastError = "";
    const diagTail: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const engine = new SonioxASREngine({
      onPartial: () => {},
      onFinal: () => {},
      onError: (message) => {
        lastError = message;
      },
      diag: (event, detail) => {
        diagTail.push({ event, detail });
        if (diagTail.length > 8) diagTail.shift();
      },
    });

    try {
      const ok = await engine.start(16000, 1);
      await engine.stop("test endpoint");
      if (ok) {
        return res.json({
          success: true,
          model: "stt-rt-v4",
          endpoint: process.env.SONIOX_WS_URL || "default",
          diagTail,
        });
      }
      return res.json({
        success: false,
        error: lastError || "Soniox realtime handshake failed",
        diagTail,
      });
    } catch (err: any) {
      try {
        await engine.stop("test endpoint exception");
      } catch {}
      return res.json({
        success: false,
        error: err?.message || "Soniox realtime test failed",
        diagTail,
      });
    }
  });

  // Test OpenAI API with specified model
  app.post("/api/test-openai", express.json(), async (req, res) => {
    if (!openaiClient) {
      return res.json({ success: false, error: "Missing OPENAI_API_KEY" });
    }
    const model = req.body?.model || "gpt-5.4-mini";
    try {
      const result = await openaiClient.chat.completions.create({
        model,
        messages: [{ role: "user", content: "Say OK" }],
        max_completion_tokens: 5,
      } as any);
      const reply = result.choices[0]?.message?.content || "";
      res.json({ success: true, model, reply: reply.trim() });
    } catch (err: any) {
      res.json({ success: false, error: err.message || "API call failed", model });
    }
  });

  // Pronunciation lookup. The resolver is deliberately click-driven on the
  // client side: cache first, then dictionary sources, then generated fallbacks.
  type PronunciationLookupResult = {
    ipa: string | null;
    respelling: string | null;
    stressIndex?: number | null;
    audioUrl?: string | null;
    source?: string;
    ipaSource?: string | null;
    audioSource?: string | null;
    confidence?: "dictionary" | "generated" | "tts" | "none";
    dictionaryPronunciation?: string | null;
    cacheVersion?: number;
  };

  const PRONUNCIATION_CACHE_VERSION = 4;
  const PRONUNCIATION_CACHE_FILE = path.join(LOG_DIR, "pronunciation-cache.json");
  const PRONUNCIATION_AUDIO_DIR = path.join(LOG_DIR, "pronunciation-audio");

  const loadPronunciationCache = () => {
    const cache = new Map<string, PronunciationLookupResult>();
    try {
      const raw = fs.readFileSync(PRONUNCIATION_CACHE_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [key, value] of Object.entries(parsed)) {
          if (!key || !value || typeof value !== "object") continue;
          const entry = value as PronunciationLookupResult;
          cache.set(key, {
            ipa: typeof entry.ipa === "string" ? entry.ipa : null,
            respelling: typeof entry.respelling === "string" ? entry.respelling : null,
            stressIndex: typeof entry.stressIndex === "number" ? entry.stressIndex : null,
            audioUrl: typeof entry.audioUrl === "string" ? entry.audioUrl : null,
            source: typeof entry.source === "string" ? entry.source : undefined,
            ipaSource: typeof entry.ipaSource === "string" ? entry.ipaSource : null,
            audioSource: typeof entry.audioSource === "string" ? entry.audioSource : null,
            confidence: entry.confidence || undefined,
            dictionaryPronunciation:
              typeof entry.dictionaryPronunciation === "string" ? entry.dictionaryPronunciation : null,
            cacheVersion: typeof entry.cacheVersion === "number" ? entry.cacheVersion : undefined,
          });
        }
      }
    } catch {
      // Cache is optional.
    }
    return cache;
  };

  const pronunciationServerCache = loadPronunciationCache();

  const persistPronunciationCache = () => {
    try {
      fs.mkdirSync(path.dirname(PRONUNCIATION_CACHE_FILE), { recursive: true });
      const serializable = Object.fromEntries(pronunciationServerCache.entries());
      fs.writeFileSync(PRONUNCIATION_CACHE_FILE, JSON.stringify(serializable, null, 2));
    } catch {
      // Cache persistence is best-effort.
    }
  };

  const shouldRefreshPronunciationCache = (value: PronunciationLookupResult | undefined) =>
    Boolean(
      value &&
        (value.cacheVersion !== PRONUNCIATION_CACHE_VERSION ||
          !value.audioUrl ||
          (value.ipa && !value.respelling))
    );

  const normalizePronunciationWord = (word: string) =>
    word
      .toLowerCase()
      .replace(/\u2019/g, "'")
      .replace(/'s$/i, "")
      .replace(/[^a-z '\-]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const escapeXml = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

  const getEnv = (...names: string[]) => {
    for (const name of names) {
      const value = process.env[name]?.trim();
      if (value) return value;
    }
    return "";
  };

  const normalizeAmericanIpa = (value: string | null) => {
    if (!value) return null;
    const body = value.trim();
    if (!body) return null;
    const wrapped = body.startsWith("/") && body.endsWith("/") ? body : `/${body}/`;
    // ɒ is a common British dictionary vowel. Use a General American-style
    // LOT/PALM symbol instead so generated fallbacks do not drift British.
    return wrapped.replace(/ɒ/g, "ɑ");
  };

  const extractLoosePronunciationField = (
    raw: string,
    field: "ipa" | "respelling",
  ): string | null | undefined => {
    const match = raw.match(new RegExp(`"${field}"\\s*:\\s*`, "i"));
    if (!match || match.index == null) {
      return undefined;
    }

    const value = raw.slice(match.index + match[0].length).trimStart();
    if (value.startsWith("null")) {
      return null;
    }

    if (!value.startsWith('"')) {
      return undefined;
    }

    const closingQuoteIndex = value.indexOf('"', 1);
    if (closingQuoteIndex >= 0) {
      const parsed = value.slice(1, closingQuoteIndex).trim();
      return parsed || null;
    }

    const truncated = value.slice(1).match(/^[^,\n}]*/)?.[0]?.trim() || "";
    return truncated || null;
  };

  const parsePronunciationLookupContent = (raw: string): PronunciationLookupResult => {
    const content = raw.trim();
    if (!content) {
      return { ipa: null, respelling: null };
    }

    const jsonMatch = content.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        const ipa = typeof parsed?.ipa === "string" && parsed.ipa.startsWith("/") && parsed.ipa.endsWith("/")
          ? parsed.ipa
          : null;
        const respelling = typeof parsed?.respelling === "string" ? parsed.respelling.trim() : null;
        const stressIndex = typeof parsed?.stressIndex === "number" ? parsed.stressIndex : null;
        return {
          ipa,
          respelling: respelling || null,
          stressIndex,
        };
      } catch {}
    }

    const ipaField = extractLoosePronunciationField(content, "ipa");
    const respellingField = extractLoosePronunciationField(content, "respelling");
    const ipaMatch = content.match(/\/[^/\n]+\/$/);
    return {
      ipa: typeof ipaField === "string" && ipaField.startsWith("/") && ipaField.endsWith("/")
        ? ipaField
        : ipaMatch
          ? ipaMatch[0]
          : null,
      respelling: typeof respellingField === "string" ? respellingField : null,
      stressIndex: null,
    };
  };

  const countIpaSyllableNuclei = (value: string) => {
    const vowels = new Set([
      "a", "e", "i", "o", "u",
      "æ", "ɑ", "ɒ", "ɔ", "ə", "ɛ", "ɜ", "ɞ", "ɐ",
      "ɪ", "ʊ", "ʌ", "ø", "œ", "ɶ", "y", "ʏ", "ʉ",
      "ɨ", "ɯ", "ɤ", "ɘ", "ɵ", "ɚ", "ɝ",
    ]);
    let count = 0;
    let inVowelGroup = false;

    for (const char of value.toLowerCase().normalize("NFD")) {
      if (/[\u0300-\u036f]/.test(char) || char === "ː" || char === "ˑ") {
        continue;
      }

      if (vowels.has(char)) {
        if (!inVowelGroup) count++;
        inVowelGroup = true;
      } else {
        inVowelGroup = false;
      }
    }

    return count;
  };

  const deriveStressIndexFromIpa = (ipa: string | null, respelling: string | null) => {
    if (!ipa) return null;
    const primaryStressIndex = ipa.indexOf("ˈ");
    if (primaryStressIndex < 0) return null;

    const candidate = countIpaSyllableNuclei(ipa.slice(0, primaryStressIndex));
    const syllableCount = respelling ? respelling.split("-").filter(Boolean).length : 0;
    if (syllableCount > 0 && candidate >= syllableCount) return null;
    return candidate;
  };

  const lookupOpenAiPronunciation = async (cacheKey: string): Promise<PronunciationLookupResult> => {
    if (!openaiClient) {
      return { ipa: null, respelling: null, stressIndex: null, source: "none", confidence: "none" };
    }

    try {
      const result = await openaiClient.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `Return ONLY compact JSON with keys "ipa", "respelling", and "stressIndex".
- Use General American English / en-US pronunciation only.
- "ipa": General American IPA pronunciation enclosed in slashes, or null
- "respelling": a Google Search-style American English "sounds like" pronunciation using lowercase letters and hyphens, or null
- "stressIndex": zero-based index of the primarily stressed syllable in "respelling" split by hyphens, or null

Rules:
- The IPA primary stress marker ˈ is authoritative. stressIndex must point to the respelling syllable aligned with ˈ.
- Prefer common Google-like chunks such as "rai", "nai", "tuhs", "mai", "oh", "kar", "dai"
- Do NOT use ALL-CAPS for stress
- Do NOT write chunks like "rye", "dye", or "nye" when "rai", "dai", or "nai" would be clearer
- Do not transliterate IPA symbol-by-symbol into awkward spellings
- Make the respelling look like what a dictionary "sounds like" hint would show
- Keep it short and readable at a glance
- If the input is an English medical term, drug name, disease name, or clinical phrase and you know the pronunciation, "respelling" MUST NOT be null
- Good example: {"ipa":"/ˌmaɪoʊkɑːrˈdaɪtɪs/","respelling":"mai-oh-kar-dai-tuhs","stressIndex":3}
- Good example: {"ipa":"/ˌklɔːrˈhɛksɪdiːn/","respelling":"klor-hek-si-deen","stressIndex":1}
- Good example: {"ipa":"/ˌhɛmərɔɪdz/","respelling":"hem-uh-roids","stressIndex":0}
- Good example: {"ipa":"/raɪˈnaɪtɪs/","respelling":"rai-nai-tuhs","stressIndex":1}
- Good example: {"ipa":"/ˌsaɪnəˈsaɪtɪs/","respelling":"sai-nuh-sai-tuhs","stressIndex":2}
- The input may be a single English word or a short English phrase like "Preparation H"
- If the input is not English or has no standard pronunciation, return {"ipa":null,"respelling":null,"stressIndex":null}
- Do not include markdown or explanations`,
          },
          { role: "user", content: cacheKey },
        ],
        max_completion_tokens: 150,
        temperature: 0,
      });
      const raw = result.choices[0]?.message?.content?.trim() || "";
      const pronunciation = parsePronunciationLookupContent(raw);
      pronunciation.ipa = normalizeAmericanIpa(pronunciation.ipa);
      pronunciation.stressIndex = deriveStressIndexFromIpa(pronunciation.ipa, pronunciation.respelling);
      return {
        ...pronunciation,
        cacheVersion: PRONUNCIATION_CACHE_VERSION,
        source: pronunciation.ipa || pronunciation.respelling ? "openai" : "none",
        ipaSource: pronunciation.ipa ? "openai" : null,
        confidence: pronunciation.ipa || pronunciation.respelling ? "generated" : "none",
      };
    } catch {
      return { ipa: null, respelling: null, stressIndex: null, source: "none", confidence: "none" };
    }
  };

  const ARPABET_TO_IPA: Record<string, string> = {
    AA: "ɑ",
    AE: "æ",
    AH: "ʌ",
    AO: "ɑ",
    AW: "aʊ",
    AY: "aɪ",
    EH: "ɛ",
    ER: "ɝ",
    EY: "eɪ",
    IH: "ɪ",
    IY: "i",
    OW: "oʊ",
    OY: "ɔɪ",
    UH: "ʊ",
    UW: "u",
    B: "b",
    CH: "tʃ",
    D: "d",
    DH: "ð",
    F: "f",
    G: "ɡ",
    HH: "h",
    JH: "dʒ",
    K: "k",
    L: "l",
    M: "m",
    N: "n",
    NG: "ŋ",
    P: "p",
    R: "r",
    S: "s",
    SH: "ʃ",
    T: "t",
    TH: "θ",
    V: "v",
    W: "w",
    Y: "j",
    Z: "z",
    ZH: "ʒ",
  };

  const arpabetToIpa = (arpabet: string) => {
    const tokens = arpabet.split(/\s+/).filter(Boolean);
    let output = "";
    for (const token of tokens) {
      const match = token.match(/^([A-Z]+)([012])?$/);
      if (!match) continue;
      const [, base, stress] = match;
      let ipa = ARPABET_TO_IPA[base];
      if (!ipa) continue;

      if (base === "AH" && stress === "0") ipa = "ə";
      if (base === "ER" && stress === "0") ipa = "ɚ";

      const marker = stress === "1" ? "ˈ" : stress === "2" ? "ˌ" : "";
      output += `${marker}${ipa}`;
    }
    return output ? `/${output}/` : null;
  };

  const lookupCmuPronunciation = (cacheKey: string): PronunciationLookupResult | null => {
    const dictionary = cmuPronouncingDictionary as Record<string, string>;
    const candidates = [
      cacheKey,
      cacheKey.replace(/\s+/g, ""),
      cacheKey.replace(/\s+/g, "-"),
      cacheKey.replace(/-/g, ""),
    ];

    for (const candidate of candidates) {
      const arpabet =
        dictionary[candidate] ||
        dictionary[`${candidate}(1)`] ||
        dictionary[`${candidate}(2)`];
      if (!arpabet) continue;
      const ipa = arpabetToIpa(arpabet);
      if (!ipa) continue;
      return {
        ipa: normalizeAmericanIpa(ipa),
        respelling: null,
        stressIndex: null,
        source: "cmudict",
        ipaSource: "cmudict",
        confidence: "dictionary",
        cacheVersion: PRONUNCIATION_CACHE_VERSION,
      };
    }
    return null;
  };

  type MerriamPronunciation = {
    mw: string | null;
    ipa: string | null;
    audio: string | null;
  };

  const buildMerriamAudioUrl = (audio: string) => {
    const format = "mp3";
    let subdirectory = audio.charAt(0);
    if (audio.startsWith("bix")) {
      subdirectory = "bix";
    } else if (audio.startsWith("gg")) {
      subdirectory = "gg";
    } else if (/^[^a-zA-Z]/.test(audio)) {
      subdirectory = "number";
    }
    return `https://media.merriam-webster.com/audio/prons/en/us/${format}/${subdirectory}/${audio}.${format}`;
  };

  const normalizeMerriamEntryId = (value: unknown) => {
    if (typeof value !== "string") return "";
    return value
      .split(":")[0]
      .toLowerCase()
      .replace(/\*/g, "")
      .replace(/\{[^}]*\}/g, "")
      .replace(/[^a-z0-9 '\-]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  };

  const isExactMerriamEntry = (entry: Record<string, unknown>, cacheKey: string) => {
    const meta = entry.meta && typeof entry.meta === "object"
      ? (entry.meta as Record<string, unknown>)
      : null;
    const hwi = entry.hwi && typeof entry.hwi === "object"
      ? (entry.hwi as Record<string, unknown>)
      : null;
    const ids = [
      normalizeMerriamEntryId(meta?.id),
      normalizeMerriamEntryId(hwi?.hw),
    ].filter(Boolean);
    return ids.some((id) => id === cacheKey);
  };

  const collectMerriamPronunciations = (value: unknown, out: MerriamPronunciation[]) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) collectMerriamPronunciations(item, out);
      return;
    }

    const obj = value as Record<string, unknown>;
    const sound = obj.sound && typeof obj.sound === "object"
      ? (obj.sound as Record<string, unknown>)
      : null;
    const mw = typeof obj.mw === "string" ? obj.mw.trim() : null;
    const ipa = typeof obj.ipa === "string" ? obj.ipa.trim() : null;
    const audio = typeof sound?.audio === "string" ? sound.audio.trim() : null;

    if (mw || ipa || audio) {
      out.push({ mw, ipa, audio });
    }

    for (const child of Object.values(obj)) {
      if (child && typeof child === "object") {
        collectMerriamPronunciations(child, out);
      }
    }
  };

  const lookupMerriamWebster = async (
    cacheKey: string,
    reference: "medical" | "collegiate",
    apiKey: string
  ): Promise<PronunciationLookupResult | null> => {
    if (!apiKey) return null;
    const url = `https://www.dictionaryapi.com/api/v3/references/${reference}/json/${encodeURIComponent(cacheKey)}?key=${encodeURIComponent(apiKey)}`;

    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0 || typeof data[0] === "string") {
        return null;
      }

      const pronunciations: MerriamPronunciation[] = [];
      for (const entry of data) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        if (!isExactMerriamEntry(entry as Record<string, unknown>, cacheKey)) continue;
        collectMerriamPronunciations(entry, pronunciations);
      }

      const best =
        pronunciations.find((item) => item.audio && item.ipa) ||
        pronunciations.find((item) => item.audio) ||
        pronunciations.find((item) => item.ipa || item.mw);
      if (!best) return null;

      return {
        ipa: normalizeAmericanIpa(best.ipa),
        respelling: null,
        stressIndex: null,
        audioUrl: best.audio ? buildMerriamAudioUrl(best.audio) : null,
        source: `mw-${reference}`,
        ipaSource: best.ipa ? `mw-${reference}` : null,
        audioSource: best.audio ? `mw-${reference}` : null,
        confidence: "dictionary",
        dictionaryPronunciation: best.mw,
        cacheVersion: PRONUNCIATION_CACHE_VERSION,
      };
    } catch {
      return null;
    }
  };

  const getPronunciationAudioRoute = (cacheKey: string, variant = "default") => {
    const hash = crypto.createHash("sha256").update(`${cacheKey}|${variant}`).digest("hex");
    return {
      fileName: `${hash}.mp3`,
      filePath: path.join(PRONUNCIATION_AUDIO_DIR, `${hash}.mp3`),
      url: `/api/pronunciation-audio/${hash}.mp3`,
    };
  };

  const synthesizeAzurePronunciation = async (cacheKey: string): Promise<string | null> => {
    const speechKey = process.env.AZURE_SPEECH_KEY;
    const speechRegion = process.env.AZURE_SPEECH_REGION;
    if (!speechKey || !speechRegion) return null;

    const voice = process.env.AZURE_TTS_VOICE?.trim() || "en-US-JennyNeural";
    const audioFile = getPronunciationAudioRoute(cacheKey, `azure:${voice}`);
    try {
      if (fs.existsSync(audioFile.filePath)) {
        return audioFile.url;
      }
    } catch {
      // Continue and try to synthesize.
    }

    const ssml = `<speak version='1.0' xml:lang='en-US'><voice xml:lang='en-US' name='${escapeXml(voice)}'><prosody rate='-8%'>${escapeXml(cacheKey)}</prosody></voice></speak>`;
    const endpoint = `https://${speechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": speechKey,
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
          "User-Agent": "MacTranslate-Pro",
        },
        body: ssml,
      });

      if (!response.ok) return null;
      const audio = Buffer.from(await response.arrayBuffer());
      if (audio.length < 128) return null;

      fs.mkdirSync(PRONUNCIATION_AUDIO_DIR, { recursive: true });
      fs.writeFileSync(audioFile.filePath, audio);
      return audioFile.url;
    } catch {
      return null;
    }
  };

  const synthesizeOpenAiPronunciation = async (cacheKey: string): Promise<string | null> => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;

    const model = process.env.OPENAI_TTS_MODEL?.trim() || "gpt-4o-mini-tts-2025-12-15";
    const voice = process.env.OPENAI_TTS_VOICE?.trim() || "marin";
    const audioFile = getPronunciationAudioRoute(cacheKey, `openai:${model}:${voice}`);
    try {
      if (fs.existsSync(audioFile.filePath)) {
        return audioFile.url;
      }
    } catch {
      // Continue and try to synthesize.
    }

    try {
      const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          voice,
          input: cacheKey,
          response_format: "mp3",
          instructions:
            "General American English / en-US pronunciation for a medical interpreter. Say only the word or phrase once, clearly and naturally, with no extra words.",
        }),
      });

      if (!response.ok) {
        const errorPreview = await response.text().catch(() => "");
        console.warn(
          `OpenAI TTS failed (${response.status}): ${errorPreview.substring(0, 160)}`
        );
        return null;
      }

      const audio = Buffer.from(await response.arrayBuffer());
      if (audio.length < 128) return null;

      fs.mkdirSync(PRONUNCIATION_AUDIO_DIR, { recursive: true });
      fs.writeFileSync(audioFile.filePath, audio);
      return audioFile.url;
    } catch (error) {
      console.warn(`OpenAI TTS failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  app.get("/api/pronunciation-audio/:file", (req, res) => {
    const file = String(req.params.file || "");
    if (!/^[a-f0-9]{64}\.mp3$/.test(file)) {
      res.status(404).end();
      return;
    }
    const filePath = path.join(PRONUNCIATION_AUDIO_DIR, file);
    if (!fs.existsSync(filePath)) {
      res.status(404).end();
      return;
    }
    res.type("audio/mpeg");
    res.sendFile(filePath);
  });

  const resolvePronunciation = async (cacheKey: string): Promise<PronunciationLookupResult> => {
    const cachedPronunciation = pronunciationServerCache.get(cacheKey);
    if (cachedPronunciation && !shouldRefreshPronunciationCache(cachedPronunciation)) {
      return cachedPronunciation;
    }

    const medicalKey = getEnv("MW_MEDICAL_API_KEY", "MERRIAM_WEBSTER_MEDICAL_API_KEY");
    const collegiateKey = getEnv("MW_COLLEGIATE_API_KEY", "MERRIAM_WEBSTER_COLLEGIATE_API_KEY");

    const result: PronunciationLookupResult = {
      ipa: null,
      respelling: null,
      stressIndex: null,
      audioUrl: null,
      source: "none",
      ipaSource: null,
      audioSource: null,
      confidence: "none",
      dictionaryPronunciation: null,
      cacheVersion: PRONUNCIATION_CACHE_VERSION,
    };

    const merge = (candidate: PronunciationLookupResult | null) => {
      if (!candidate) return;
      if (!result.ipa && candidate.ipa) {
        result.ipa = candidate.ipa;
        result.ipaSource = candidate.ipaSource || candidate.source || null;
      }
      if (!result.respelling && candidate.respelling) {
        result.respelling = candidate.respelling;
      }
      if (!result.audioUrl && candidate.audioUrl) {
        result.audioUrl = candidate.audioUrl;
        result.audioSource = candidate.audioSource || candidate.source || null;
      }
      if (!result.dictionaryPronunciation && candidate.dictionaryPronunciation) {
        result.dictionaryPronunciation = candidate.dictionaryPronunciation;
      }
      const confidenceRank = { none: 0, tts: 1, generated: 2, dictionary: 3 };
      const currentConfidence = result.confidence || "none";
      const candidateConfidence = candidate.confidence || "none";
      if (confidenceRank[candidateConfidence] > confidenceRank[currentConfidence]) {
        result.confidence = candidate.confidence;
      }
      if (result.source === "none" && candidate.source) {
        result.source = candidate.source;
      }
    };

    // Medical first: this product exists specifically for clinical terms and drug names.
    merge(await lookupMerriamWebster(cacheKey, "medical", medicalKey));
    if (!result.audioUrl || !result.ipa) {
      merge(await lookupMerriamWebster(cacheKey, "collegiate", collegiateKey));
    }

    if (!result.ipa) {
      merge(lookupCmuPronunciation(cacheKey));
    }

    if (!result.ipa || !result.respelling) {
      const generated = await lookupOpenAiPronunciation(cacheKey);
      merge(generated);
      if (result.stressIndex == null && generated.stressIndex != null) {
        result.stressIndex = generated.stressIndex;
      }
    }

    if (!result.audioUrl) {
      const audioUrl = await synthesizeOpenAiPronunciation(cacheKey);
      if (audioUrl) {
        result.audioUrl = audioUrl;
        result.audioSource = "openai-tts";
        if (result.source === "none") result.source = "openai-tts";
        if (result.confidence === "none") result.confidence = "tts";
      }
    }

    if (!result.audioUrl) {
      const audioUrl = await synthesizeAzurePronunciation(cacheKey);
      if (audioUrl) {
        result.audioUrl = audioUrl;
        result.audioSource = "azure-tts";
        if (result.source === "none") result.source = "azure-tts";
        if (result.confidence === "none") result.confidence = "tts";
      }
    }

    if (result.ipa && result.stressIndex == null) {
      result.stressIndex = deriveStressIndexFromIpa(result.ipa, result.respelling);
    }

    if (result.ipa || result.respelling || result.audioUrl) {
      pronunciationServerCache.set(cacheKey, result);
      persistPronunciationCache();
    }

    return result;
  };

  const stripAudioFromPronunciation = (value: PronunciationLookupResult): PronunciationLookupResult => ({
    ...value,
    audioUrl: null,
    audioSource: null,
  });

  const hasUsablePronunciationHint = (value: PronunciationLookupResult | undefined) =>
    Boolean(
      value &&
        value.cacheVersion === PRONUNCIATION_CACHE_VERSION &&
        (value.ipa || value.respelling)
    );

  const resolvePronunciationHint = async (cacheKey: string): Promise<PronunciationLookupResult> => {
    const cachedPronunciation = pronunciationServerCache.get(cacheKey);
    if (hasUsablePronunciationHint(cachedPronunciation)) {
      return stripAudioFromPronunciation(cachedPronunciation!);
    }

    const result: PronunciationLookupResult = {
      ipa: null,
      respelling: null,
      stressIndex: null,
      audioUrl: null,
      source: "none",
      ipaSource: null,
      audioSource: null,
      confidence: "none",
      dictionaryPronunciation: null,
      cacheVersion: PRONUNCIATION_CACHE_VERSION,
    };

    const merge = (candidate: PronunciationLookupResult | null) => {
      if (!candidate) return;
      if (!result.ipa && candidate.ipa) {
        result.ipa = candidate.ipa;
        result.ipaSource = candidate.ipaSource || candidate.source || null;
      }
      if (!result.respelling && candidate.respelling) {
        result.respelling = candidate.respelling;
      }
      if (!result.dictionaryPronunciation && candidate.dictionaryPronunciation) {
        result.dictionaryPronunciation = candidate.dictionaryPronunciation;
      }
      const confidenceRank = { none: 0, tts: 1, generated: 2, dictionary: 3 };
      const currentConfidence = result.confidence || "none";
      const candidateConfidence = candidate.confidence || "none";
      if (confidenceRank[candidateConfidence] > confidenceRank[currentConfidence]) {
        result.confidence = candidate.confidence;
      }
      if (result.source === "none" && candidate.source) {
        result.source = candidate.source;
      }
    };

    merge(lookupCmuPronunciation(cacheKey));

    if (!result.ipa || !result.respelling) {
      const generated = await lookupOpenAiPronunciation(cacheKey);
      merge(generated);
      if (result.stressIndex == null && generated.stressIndex != null) {
        result.stressIndex = generated.stressIndex;
      }
    }

    if (result.ipa && result.stressIndex == null) {
      result.stressIndex = deriveStressIndexFromIpa(result.ipa, result.respelling);
    }

    if (result.ipa || result.respelling) {
      pronunciationServerCache.set(cacheKey, result);
      persistPronunciationCache();
    }

    return result;
  };

  app.post("/api/pronunciation", express.json(), async (req, res) => {
    const word = String(req.body?.word || "").trim();
    const cacheKey = normalizePronunciationWord(word);
    if (!cacheKey || cacheKey.length < 2) {
      return res.json({ ipa: null, respelling: null, audioUrl: null, confidence: "none" });
    }
    if (cacheKey.length > 80) {
      return res.status(400).json({ ipa: null, respelling: null, audioUrl: null, error: "Word is too long" });
    }

    const pronunciation = await resolvePronunciation(cacheKey);
    res.json(pronunciation);
  });

  app.post("/api/pronunciation-hint", express.json(), async (req, res) => {
    const word = String(req.body?.word || "").trim();
    const cacheKey = normalizePronunciationWord(word);
    if (!cacheKey || cacheKey.length < 2) {
      return res.json({ ipa: null, respelling: null, audioUrl: null, confidence: "none" });
    }
    if (cacheKey.length > 80) {
      return res.status(400).json({ ipa: null, respelling: null, audioUrl: null, error: "Word is too long" });
    }

    const pronunciation = await resolvePronunciationHint(cacheKey);
    res.json(stripAudioFromPronunciation(pronunciation));
  });

  app.post("/api/ipa", express.json(), async (req, res) => {
    const word = String(req.body?.word || "").trim();
    const cacheKey = normalizePronunciationWord(word);
    if (!cacheKey || cacheKey.length < 2) {
      return res.json({ ipa: null, respelling: null });
    }

    const cachedPronunciation = pronunciationServerCache.get(cacheKey);
    if (cachedPronunciation && cachedPronunciation.ipa && !shouldRefreshPronunciationCache(cachedPronunciation)) {
      return res.json({
        ipa: cachedPronunciation.ipa,
        respelling: cachedPronunciation.respelling,
        stressIndex: cachedPronunciation.stressIndex ?? null,
      });
    }

    const pronunciation = await lookupOpenAiPronunciation(cacheKey);
    if (pronunciation.ipa || pronunciation.respelling) {
      pronunciationServerCache.set(cacheKey, pronunciation);
      persistPronunciationCache();
    }
    res.json(pronunciation);
  });

  // -------------------------------------------------------------------------
  // WebSocket per-client session
  // -------------------------------------------------------------------------
  wss.on("connection", (rawWs) => {
    const ws = rawWs as AliveWebSocket;
    const sessionId = Math.random().toString(36).substring(2, 10);
    const sessionRecorder = new SessionRecorder();
    diag(sessionId, "ws_connect");
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    let clientClosed = false;
    let audioSampleRate: number | null = null;
    let audioChannels = 1;
    let translationModel = "gpt-5.4-mini";
    let asrEngine: ASREngine | null = null;
    let asrProvider: string = "azure";
    const preEngineAudioQueue: Buffer[] = [];
    let preEngineAudioBytes = 0;
    const getPostProcessing = (): ASRPostProcessingConfig => {
      const provider =
        asrProvider === "qwen" || asrProvider === "soniox" ? asrProvider : "azure";
      return ASR_POST_PROCESSING[provider];
    };

    const translationContexts: Record<TranslationSide, TranslationContextEntry[]> = {
      left: [],
      right: [],
    };
    const openingAnchorSourceEntries: OpeningAnchorSourceEntry[] = [];
    let openingAnchor = "";
    let openingAnchorBuildInFlight = false;
    let openingAnchorBuiltFromEntries = 0;
    let openingAnchorWindowStartedAt = Date.now();

    const resetOpeningAnchorState = () => {
      openingAnchorSourceEntries.length = 0;
      openingAnchor = "";
      openingAnchorBuildInFlight = false;
      openingAnchorBuiltFromEntries = 0;
      openingAnchorWindowStartedAt = Date.now();
    };

    const pendingTranslations: PendingTranslation[] = [];

    // -- Client communication -----------------------------------------------
    const sendToClient = (payload: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    };

    const sendContextSnapshot = () => {
      sendToClient({
        type: "context_snapshot",
        contexts: {
          left: translationContexts.left,
          right: translationContexts.right,
          openingAnchor,
        },
      });
    };

    const clearPreEngineAudio = () => {
      preEngineAudioQueue.length = 0;
      preEngineAudioBytes = 0;
    };

    const queuePreEngineAudio = (buffer: Buffer) => {
      preEngineAudioQueue.push(buffer);
      preEngineAudioBytes += buffer.byteLength;

      while (preEngineAudioBytes > MAX_PRE_ENGINE_AUDIO_BYTES && preEngineAudioQueue.length > 0) {
        const dropped = preEngineAudioQueue.shift();
        preEngineAudioBytes -= dropped?.byteLength ?? 0;
      }
    };

    const flushPreEngineAudio = () => {
      if (!asrEngine || preEngineAudioQueue.length === 0) return;
      const queued = preEngineAudioQueue.splice(0);
      const bytes = preEngineAudioBytes;
      preEngineAudioBytes = 0;
      for (const buffer of queued) {
        asrEngine.pushAudio(buffer);
      }
      diag(sessionId, "pre_engine_audio_flushed", { chunks: queued.length, bytes });
    };

    const maybeRefreshOpeningAnchor = () => {
      if (clientClosed || openingAnchorBuildInFlight) return;
      if (Date.now() - openingAnchorWindowStartedAt > OPENING_ANCHOR_WINDOW_MS) return;

      const candidateCount = openingAnchorSourceEntries.length;
      const shouldInitial =
        !openingAnchor &&
        candidateCount >= OPENING_ANCHOR_INITIAL_ENTRY_TARGET &&
        openingAnchorBuiltFromEntries < OPENING_ANCHOR_INITIAL_ENTRY_TARGET;
      const shouldRefresh =
        candidateCount >= OPENING_ANCHOR_REFRESH_ENTRY_TARGET &&
        openingAnchorBuiltFromEntries < OPENING_ANCHOR_REFRESH_ENTRY_TARGET;

      if (!shouldInitial && !shouldRefresh) return;

      const buildEntries = openingAnchorSourceEntries.slice(0, OPENING_ANCHOR_MAX_SOURCE_ENTRIES);
      const buildCount = buildEntries.length;
      const reason = shouldRefresh ? "refresh" : "initial";
      openingAnchorBuildInFlight = true;
      diag(sessionId, "opening_anchor_build_start", {
        reason,
        entries: buildCount,
        chars: buildEntries.reduce((sum, entry) => sum + entry.corrected.length + entry.translation.length, 0),
      });

      void generateOpeningAnchor(buildEntries, sessionId)
        .then((anchor) => {
          if (clientClosed) return;
          openingAnchor = anchor;
          openingAnchorBuiltFromEntries = Math.max(openingAnchorBuiltFromEntries, buildCount);
          sendContextSnapshot();
        })
        .catch((err) => {
          diag(sessionId, "opening_anchor_error", {
            reason,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          openingAnchorBuildInFlight = false;
        });
    };

    // -- Pending translation management -------------------------------------
    const getLatestPending = () => pendingTranslations[pendingTranslations.length - 1] || null;

    const clearPendingTimer = (p: PendingTranslation, which: "commit" | "translation") => {
      if (which === "commit" && p.commitTimer) {
        clearTimeout(p.commitTimer);
        p.commitTimer = null;
      }
      if (which === "translation" && p.translationTimer) {
        clearTimeout(p.translationTimer);
        p.translationTimer = null;
      }
    };

    const flushCommitted = () => {
      while (pendingTranslations.length > 0) {
        const p = pendingTranslations[0];
        if (!p.commitRequested || p.latestResolvedRevision !== p.revision) break;

        clearPendingTimer(p, "commit");
        clearPendingTimer(p, "translation");

        const committedSource = p.latestCorrectedText || p.text;
        const side = getSideFromLanguage(p.language);
        const contextEntry = {
          source: p.text,
          corrected: committedSource,
          translation: p.latestTranslation,
        };

        if (committedSource.trim()) {
          if (
            openingAnchorSourceEntries.length < OPENING_ANCHOR_MAX_SOURCE_ENTRIES &&
            Date.now() - openingAnchorWindowStartedAt <= OPENING_ANCHOR_WINDOW_MS &&
            isHighSignalOpeningAnchorEntry(contextEntry, p.language)
          ) {
            openingAnchorSourceEntries.push({
              side,
              language: p.language,
              corrected: committedSource,
              translation: p.latestTranslation,
            });
            maybeRefreshOpeningAnchor();
          }

          if (isLowSignalContextEntry(contextEntry)) {
            diag(sessionId, "context_entry_skipped_low_signal", {
              side,
              lang: p.language,
              text: committedSource.substring(0, 80),
            });
          } else {
            translationContexts[side] = trimTranslationContext([
              ...(translationContexts[side] || []),
              contextEntry,
            ]);
            sendContextSnapshot();
          }
        }

        sessionRecorder.record({
          side,
          lang: p.language,
          source: p.text,
          corrected: committedSource,
          translation: p.latestTranslation,
          translateMs: p.lastTranslateMs || undefined,
        });

        sendToClient({
          type: "translation",
          id: p.id,
          translation: p.latestTranslation,
          correctedText: committedSource,
          isCommitted: true,
          side,
        });

        pendingTranslations.shift();
      }
    };

    const scheduleCommit = (p: PendingTranslation) => {
      clearPendingTimer(p, "commit");
      const incomplete = isLikelyIncompleteUtterance(p.text, p.language);
      const delayMs = incomplete
        ? getPostProcessing().incompleteCommitDelayMs
        : getPostProcessing().commitDelayMs;
      p.commitTimer = setTimeout(() => {
        p.commitRequested = true;
        flushCommitted();
      }, delayMs);
    };

    const requestTranslationUpdate = async (pendingId: string, revision: number) => {
      const p = pendingTranslations.find((x) => x.id === pendingId);
      if (!p || p.revision !== revision) {
        if (p) {
          p.isTranslationInFlight = false;
          scheduleTranslationUpdate(p);
        }
        return;
      }

      const txSw = stopwatch();
      diag(sessionId, "translate_start", {
        id: pendingId,
        rev: revision,
        lang: p.language,
        model: translationModel,
        len: p.text.length,
        text: p.text.substring(0, 80),
        incomplete: isLikelyIncompleteUtterance(p.text, p.language),
        lowConfidenceTokenCount: countLowConfidenceTokens(p.asrMetadata),
      });
      const attemptToken = ++p.translationAttemptToken;
      p.latestPartialTranslation = "";

      // Reset any stale partial on the frontend before starting a new stream
      sendToClient({
        type: "translation_streaming_reset",
        id: pendingId,
        side: getSideFromLanguage(p.language),
      });

      // Revision-guarded partial callback. Returns false to abort stream if stale.
      const onPartial = (partial: string): boolean => {
        const current = pendingTranslations.find((x) => x.id === pendingId);
        if (
          !current ||
          current.revision !== revision ||
          current.translationAttemptToken !== attemptToken
        ) {
          return false;
        }
        current.latestPartialTranslation = partial;
        sendToClient({
          type: "translation_streaming",
          id: pendingId,
          partialTranslation: partial,
          side: getSideFromLanguage(current.language),
        });
        return true;
      };

        try {
          const result = await Promise.race([
          translateText(
            p.text,
            p.language,
            getSideFromLanguage(p.language),
            translationContexts,
            openingAnchor,
            translationModel,
            onPartial,
            sessionId,
            p.asrMetadata
          ),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Translation timed out")), TRANSLATION_TIMEOUT_MS)
          ),
        ]);

        const latest = pendingTranslations.find((x) => x.id === pendingId);
        if (!latest) return;
        latest.isTranslationInFlight = false;

        if (latest.revision !== revision) {
          scheduleTranslationUpdate(latest);
          return;
        }

        latest.latestCorrectedText = result.correctedText || latest.text;
        latest.latestTranslation = result.translation;
        latest.latestResolvedRevision = revision;
        latest.lastTranslateMs = txSw();

        diag(sessionId, "translate_done", { id: latest.id, rev: revision, ms: latest.lastTranslateMs, translationLen: latest.latestTranslation.length });

        sendToClient({
          type: "translation",
          id: latest.id,
          translation: latest.latestTranslation,
          correctedText: latest.latestCorrectedText,
          isCommitted: false,
          side: getSideFromLanguage(latest.language),
        });

        flushCommitted();
      } catch (err) {
        diag(sessionId, "translate_error", { id: pendingId, rev: revision, ms: txSw(), error: String(err) });
        console.error("Translation error:", err);
        const latest = pendingTranslations.find((x) => x.id === pendingId);
        if (!latest) return;
        latest.isTranslationInFlight = false;
        if (
          latest.revision === revision &&
          isTranslationTimeoutError(err) &&
          !latest.latestTranslation &&
          !latest.latestPartialTranslation &&
          latest.translationTimeoutRetryCount < MAX_TRANSLATION_TIMEOUT_RETRIES
        ) {
          latest.translationTimeoutRetryCount += 1;
          diag(sessionId, "translate_timeout_retry", {
            id: pendingId,
            rev: revision,
            retry: latest.translationTimeoutRetryCount,
          });
          scheduleTranslationUpdate(latest);
          return;
        }
        latest.latestCorrectedText = latest.latestCorrectedText || latest.text;
        latest.latestTranslation = latest.latestTranslation || latest.latestPartialTranslation || "";
        latest.latestResolvedRevision = revision;
        if (latest.latestPartialTranslation) {
          diag(sessionId, "translate_error_partial_preserved", {
            id: pendingId,
            rev: revision,
            translationLen: latest.latestPartialTranslation.length,
          });
        }
        flushCommitted();
      }
    };

    const scheduleTranslationUpdate = (p: PendingTranslation) => {
      clearPendingTimer(p, "translation");
      const incomplete = isLikelyIncompleteUtterance(p.text, p.language);
      const delayMs = incomplete
        ? getPostProcessing().incompleteTranslationDebounceMs
        : getPostProcessing().translationDebounceMs;
      p.translationTimer = setTimeout(() => {
        p.translationTimer = null;
        if (p.isTranslationInFlight) return;
        p.isTranslationInFlight = true;
        void requestTranslationUpdate(p.id, p.revision);
      }, delayMs);
    };

    // -- Handle recognized speech -------------------------------------------
    const handleRecognized = (
      text: string,
      language: SourceLanguage,
      metadata?: ASRFinalMetadata
    ) => {
      if (!text.trim()) return;
      const side = getSideFromLanguage(language);
      const now = Date.now();
      const postProcessing = getPostProcessing();

      const latest = getLatestPending();
      if (latest && canMerge(latest, language, postProcessing)) {
        // Merge into existing pending
        latest.text = appendTranscript(latest.text, text, language);
        latest.revision++;
        latest.translationTimeoutRetryCount = 0;
        latest.lastUpdatedAt = now;
        if (metadata) {
          latest.asrMetadata = [...latest.asrMetadata, metadata].slice(-8);
        }
        if (isLikelyIncompleteUtterance(latest.text, latest.language)) {
          diag(sessionId, "asr_fragment_deferred", {
            id: latest.id,
            rev: latest.revision,
            lang: latest.language,
            phase: "merged",
            text: latest.text.substring(0, 80),
            commitDelayMs: postProcessing.incompleteCommitDelayMs,
          });
        }

        sendToClient({ type: "transcript", text: latest.text, isFinal: true, id: latest.id, side });
        scheduleCommit(latest);
        scheduleTranslationUpdate(latest);
        return;
      }

      // Commit previous pending if uncommitted
      if (latest && !latest.commitRequested) {
        latest.commitRequested = true;
        clearPendingTimer(latest, "commit");
        flushCommitted();
      }

      // Create new pending
      const pending: PendingTranslation = {
        id: Math.random().toString(36).substring(2, 15),
        text,
        language,
        asrMetadata: metadata ? [metadata] : [],
        revision: 1,
        latestResolvedRevision: 0,
        latestCorrectedText: text,
        latestTranslation: "",
        latestPartialTranslation: "",
        translationTimeoutRetryCount: 0,
        translationAttemptToken: 0,
        lastUpdatedAt: now,
        commitRequested: false,
        commitTimer: null,
        translationTimer: null,
        isTranslationInFlight: false,
        lastTranslateMs: 0,
      };

      pendingTranslations.push(pending);
      if (isLikelyIncompleteUtterance(pending.text, pending.language)) {
        diag(sessionId, "asr_fragment_deferred", {
          id: pending.id,
          rev: pending.revision,
          lang: pending.language,
          phase: "created",
          text: pending.text.substring(0, 80),
          commitDelayMs: postProcessing.incompleteCommitDelayMs,
        });
      }
      sendToClient({ type: "transcript", text, isFinal: true, id: pending.id, side });
      scheduleCommit(pending);
      scheduleTranslationUpdate(pending);
    };

    // -- ASR engine setup ---------------------------------------------------
    // Engine is instantiated when the client sends its `config` message; the
    // engine type is selected by `asrProvider`. Azure is the default.
    const ensureAsrEngineStarted = async () => {
      if (!audioSampleRate || asrEngine || clientClosed) return;
      const engine = createASREngine(asrProvider, {
        onPartial: (text, language) => {
          const side = getSideFromLanguage(language as SourceLanguage);
          sendToClient({ type: "transcript", text, isFinal: false, side });
        },
        onFinal: (text, language, metadata) => {
          handleRecognized(text, language as SourceLanguage, metadata);
        },
        onError: (message, fatal) => {
          sendToClient({ type: "error", message, fatal });
          if (fatal) {
            diag(sessionId, "asr_engine_fatal", { provider: asrProvider, message });
          }
        },
        diag: (event, detail) => diag(sessionId, event, { provider: asrProvider, ...(detail || {}) }),
      });
      asrEngine = engine;
      diag(sessionId, "asr_engine_starting", { provider: asrProvider });
      const ok = await engine.start(audioSampleRate, audioChannels);
      if (!ok) {
        if (!clientClosed && asrEngine === engine) {
          diag(sessionId, "asr_engine_start_failed", { provider: asrProvider });
        }
        // Engine-reported errors have already been sent via onError; drop the
        // instance so the user can try again (e.g. after switching provider).
        asrEngine = null;
        clearPreEngineAudio();
        return;
      }
      flushPreEngineAudio();
    };

    // -- WebSocket message handling ------------------------------------------
    ws.on("message", (message, isBinary) => {
      if (!isBinary) {
        try {
          const payload = JSON.parse(message.toString());
          if (payload.type === "config") {
            const nextAudioFormat = payload.audioFormat;
            if (
              nextAudioFormat &&
              nextAudioFormat.encoding === "linear16" &&
              typeof nextAudioFormat.sampleRate === "number" &&
              Number.isFinite(nextAudioFormat.sampleRate)
            ) {
              audioSampleRate = Math.round(nextAudioFormat.sampleRate);
              audioChannels =
                typeof nextAudioFormat.channels === "number" && nextAudioFormat.channels > 0
                  ? Math.round(nextAudioFormat.channels)
                  : 1;
            }

            // Accept asrProvider from the config payload. Unknown values fall back to Azure.
            if (typeof payload.asrProvider === "string" && payload.asrProvider.length > 0) {
              asrProvider = payload.asrProvider;
            }
            if (typeof payload.translationModel === "string" && payload.translationModel.length > 0) {
              translationModel = payload.translationModel;
            }
            const postProcessing = getPostProcessing();

            diag(sessionId, "config_received", {
              sampleRate: audioSampleRate,
              channels: audioChannels,
              asrProvider,
              translationModel,
              postProcessing,
            });
            // Start the configured ASR engine if not already running
            void ensureAsrEngineStarted();
            return;
          }

          if (payload.type === "keepalive") {
            sendToClient({ type: "keepalive_ack", at: payload.at || Date.now() });
            return;
          }

          // Handle session reset ("新对话" button)
          if (payload.type === "reset") {
            translationContexts.left = [];
            translationContexts.right = [];
            resetOpeningAnchorState();
            for (const p of pendingTranslations) {
              clearPendingTimer(p, "commit");
              clearPendingTimer(p, "translation");
            }
            pendingTranslations.length = 0;
            sessionRecorder.resetConversation();
            diag(sessionId, "session_reset");
            sendContextSnapshot();
            return;
          }

          // Handle context restore (from previous session)
          if (payload.type === "restore_context" && payload.contexts) {
            const ctx = payload.contexts as PersistedConversationContext;
            if (Array.isArray(ctx.left)) translationContexts.left = trimTranslationContext(ctx.left);
            if (Array.isArray(ctx.right)) translationContexts.right = trimTranslationContext(ctx.right);
            openingAnchor = typeof ctx.openingAnchor === "string" ? ctx.openingAnchor.trim() : "";
            openingAnchorBuildInFlight = false;
            openingAnchorBuiltFromEntries = openingAnchor ? OPENING_ANCHOR_REFRESH_ENTRY_TARGET : 0;
            openingAnchorSourceEntries.length = 0;
            openingAnchorWindowStartedAt = Date.now();
            sessionRecorder.continueConversation(translationContexts.left.length + translationContexts.right.length);
            diag(sessionId, "context_restored", {
              left: translationContexts.left.length,
              right: translationContexts.right.length,
              openingAnchor: !!openingAnchor,
            });
            sendContextSnapshot();
            return;
          }

          // Handle settings update
          if (payload.type === "update_settings") {
            if (payload.translationModel && typeof payload.translationModel === "string") {
              translationModel = payload.translationModel;
              diag(sessionId, "model_updated", { model: translationModel });
            }
            // asrProvider changes only take effect on the next connection.
            // We log it here so users know the change was received, but we do
            // NOT hot-swap the engine mid-session (see docs/asr-migration-plan.md).
            if (typeof payload.asrProvider === "string" && payload.asrProvider !== asrProvider) {
              diag(sessionId, "asr_provider_pending_switch", {
                from: asrProvider,
                to: payload.asrProvider,
              });
            }
            return;
          }
        } catch {
          diag(sessionId, "unknown_message", { preview: message.toString().substring(0, 100) });
        }
        return;
      }

      // Binary audio data — forward to the active ASR engine
      const buffer = Array.isArray(message)
        ? Buffer.concat(message)
        : Buffer.from(message as ArrayBuffer);
      if (asrEngine) {
        asrEngine.pushAudio(buffer);
      } else {
        queuePreEngineAudio(buffer);
      }
    });

    ws.on("close", (code, reason) => {
      diag(sessionId, "ws_close", {
        code,
        reason: reason.toString().substring(0, 120),
      });
      sessionRecorder.close();

      clientClosed = true;

      // Clean up pending translations
      for (const p of pendingTranslations) {
        clearPendingTimer(p, "commit");
        clearPendingTimer(p, "translation");
      }
      pendingTranslations.length = 0;
      clearPreEngineAudio();

      const engineToStop = asrEngine;
      asrEngine = null;
      if (engineToStop) void engineToStop.stop("client disconnected");
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err);
    });
  });

  // -------------------------------------------------------------------------
  // Vite / Static serving
  // -------------------------------------------------------------------------
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const PORT = 3000;
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
