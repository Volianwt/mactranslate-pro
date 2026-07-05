// ---------------------------------------------------------------------------
// ASR engine abstraction layer
//
// Goal: let server.ts stay provider-agnostic. The downstream translation
// pipeline (handleRecognized, pending merge/commit, GPT translation) is
// unchanged; each engine just pushes transcripts through onPartial/onFinal.
//
// Currently supported providers:
//   - "azure" — wraps the existing Azure Speech SDK path (default)
//   - "qwen"  — Alibaba DashScope realtime WebSocket ASR (qwen3-asr-flash-realtime-2026-02-10)
//   - "soniox" — Soniox realtime WebSocket ASR (stt-rt-v4)
//
// Adding a new provider: implement ASREngine, register it in createASREngine.
// ---------------------------------------------------------------------------

import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import {
  RealtimeUtteranceBuffer,
  SonioxNodeClient,
  type RealtimeResult,
  type RealtimeSttSession,
  type RealtimeToken,
} from "@soniox/node";
import { WebSocket as WSClient } from "ws";

export type ASRLanguage = "en" | "zh";
export type ASRProvider = "azure" | "qwen" | "soniox";

export type ASRLowConfidenceToken = {
  text: string;
  confidence: number;
};

export type ASRFinalMetadata = {
  provider: ASRProvider;
  averageConfidence?: number;
  minConfidence?: number;
  lowConfidenceTokens?: ASRLowConfidenceToken[];
};

export interface ASREngineCallbacks {
  onPartial: (text: string, language: ASRLanguage) => void;
  onFinal: (
    text: string,
    language: ASRLanguage,
    metadata?: ASRFinalMetadata
  ) => void;
  /** fatal=true means the engine cannot recover on its own and the client should be told to stop. */
  onError: (message: string, fatal: boolean) => void;
  diag: (event: string, detail?: Record<string, unknown>) => void;
}

export interface ASREngine {
  readonly provider: ASRProvider;
  /** Start the engine. Returns true on success, false if it could not start. */
  start(sampleRate: number, channels: number): Promise<boolean>;
  /** Feed one PCM16 mono audio chunk. */
  pushAudio(buffer: Buffer): void;
  /** Stop the engine and release all resources. Safe to call multiple times. */
  stop(reason: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function detectLanguageFromText(text: string): ASRLanguage {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const totalChars = text.replace(/\s/g, "").length;
  return totalChars > 0 && chineseChars / totalChars > 0.3 ? "zh" : "en";
}

const SONIOX_NEUTRAL_LATIN_RE =
  /\b(?:ok(?:ay)?|yeah|yep|uh|um|hmm|mm-?hmm|uh-huh|hello|hi|bye(?:-bye)?|thanks?|thank you|please)\b/gi;
const CHINESE_DATE_SIGNAL_RE = /(?:\d{1,4}\s*年|\d{1,2}\s*月|\d{1,2}\s*号)/u;

function stripNeutralSonioxLatin(text: string): string {
  return text.replace(SONIOX_NEUTRAL_LATIN_RE, " ").replace(/\s+/g, " ").trim();
}

function containsJapaneseKana(text: string): boolean {
  return /[\u3040-\u30ff]/.test(text);
}

function detectLanguageFromAzure(langCode: string): ASRLanguage {
  return langCode.startsWith("zh") ? "zh" : "en";
}

function normalizeUnexpectedQwenJapanese(text: string): string {
  const trimmed = text.trim();
  const token = trimmed.replace(/[。！!？?]+$/u, "");

  // This app is intentionally bilingual (CN/EN). In real calls we have seen
  // Qwen leak a couple of short Japanese acknowledgements for Chinese "对/是".
  // Normalize only the exact leakage tokens we have observed, and leave every
  // other transcript untouched.
  if (/^(はい|ええ|うん)$/u.test(token)) return "对。";
  if (/^そうですね$/u.test(token)) return "对。";
  return text;
}

function detectLanguageFromQwen(langCode: string | undefined, fallbackText: string): ASRLanguage {
  if (langCode === "zh" || langCode === "yue") return "zh";
  if (langCode === "en") return "en";
  // Product scope is CN/EN only. If Qwen leaks Japanese output in this
  // bilingual setting, keep it on the CJK side instead of misrouting it to EN.
  if (langCode === "ja" || containsJapaneseKana(fallbackText)) return "zh";
  return detectLanguageFromText(fallbackText);
}

function detectLanguageFromSoniox(langCode: string | undefined, fallbackText: string): ASRLanguage {
  const stripped = stripNeutralSonioxLatin(fallbackText);
  const candidate = stripped || fallbackText;
  const chineseChars = (candidate.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinChars = (candidate.match(/[A-Za-z]/g) || []).length;

  if (!langCode) {
    if (CHINESE_DATE_SIGNAL_RE.test(candidate) && chineseChars >= 2) return "zh";
    if (chineseChars >= 4 && (latinChars === 0 || chineseChars / (chineseChars + latinChars) >= 0.15)) {
      return "zh";
    }
    return detectLanguageFromText(candidate);
  }
  if (langCode === "en") {
    // Soniox can tag Chinese or mixed Chinese-English utterances as English.
    // Override the provider label when the transcript has significant Chinese.
    if (CHINESE_DATE_SIGNAL_RE.test(candidate) && chineseChars >= 2) return "zh";
    if (chineseChars >= 4 && (latinChars === 0 || chineseChars / (chineseChars + latinChars) >= 0.15)) {
      return "zh";
    }
    return "en";
  }
  if (langCode === "zh" || langCode === "yue" || langCode === "cmn" || langCode.startsWith("zh")) {
    return "zh";
  }
  if (CHINESE_DATE_SIGNAL_RE.test(candidate) && chineseChars >= 2) return "zh";
  if (chineseChars >= 4 && (latinChars === 0 || chineseChars / (chineseChars + latinChars) >= 0.15)) {
    return "zh";
  }
  return detectLanguageFromText(candidate);
}

function getLastTokenLanguage(tokens: RealtimeToken[]): string | undefined {
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const lang = tokens[i]?.language;
    if (typeof lang === "string" && lang.trim()) return lang.trim();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Azure engine — ported from the original server.ts implementation.
// Behaviour (watchdog, generation guard, recovery backoff) is preserved.
// ---------------------------------------------------------------------------
const CONTINUOUS_LID_ENDPOINT_PATH = "speech/universal/v2";
const RECOGNIZER_STOP_TIMEOUT_MS = 3000;
const WATCHDOG_INTERVAL_MS = 2000;
const AUDIO_PACKET_STALE_MS = 10000;
const AZURE_IDLE_RECOVERY_MS = 150000;
const MIN_AUTO_RECOVERY_GAP_MS = 60000;
const MAX_AUTO_RECOVERY_ATTEMPTS = 3;
const AUTO_RECOVERY_BACKOFF_MS = [2000, 4000, 8000] as const;

export class AzureASREngine implements ASREngine {
  readonly provider: ASRProvider = "azure";

  private cb: ASREngineCallbacks;
  private pushStream: sdk.PushAudioInputStream | null = null;
  private recognizer: sdk.SpeechRecognizer | null = null;
  private recognizerGeneration = 0;
  private recoveryInFlight = false;
  private consecutiveRecoveryAttempts = 0;
  private lastAudioPacketAt = 0;
  private lastAzureEventAt = 0;
  private lastRecoveryAt = 0;
  private recognizerRecoveryTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private audioSampleRate: number | null = null;
  private audioChannels = 1;
  private closed = false;

  constructor(cb: ASREngineCallbacks) {
    this.cb = cb;
  }

  async start(sampleRate: number, channels: number): Promise<boolean> {
    this.audioSampleRate = sampleRate;
    this.audioChannels = channels;
    this.closed = false;
    this.startWatchdog();
    const ok = await this.startRecognizer();
    if (!ok) this.scheduleRecovery("initial start failure");
    return ok;
  }

  pushAudio(buffer: Buffer): void {
    this.lastAudioPacketAt = Date.now();
    if (this.pushStream) {
      this.pushStream.write(
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      );
    }
  }

  async stop(reason: string): Promise<void> {
    this.closed = true;
    this.clearRecoveryTimer();
    this.clearWatchdog();
    await this.stopRecognizer(reason);
  }

  // -- internals ------------------------------------------------------------
  private clearRecoveryTimer() {
    if (this.recognizerRecoveryTimer) {
      clearTimeout(this.recognizerRecoveryTimer);
      this.recognizerRecoveryTimer = null;
    }
  }

  private clearWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private noteAzureActivity() {
    this.lastAzureEventAt = Date.now();
  }

  private noteHealthyAzureActivity() {
    this.lastAzureEventAt = Date.now();
    this.consecutiveRecoveryAttempts = 0;
  }

  private stopRecognizerResources(
    recognizerToStop: sdk.SpeechRecognizer | null,
    pushStreamToStop: sdk.PushAudioInputStream | null,
    reason: string
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      let timeout: NodeJS.Timeout | null = null;
      const finalize = () => {
        if (settled) return;
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        if (pushStreamToStop) {
          try {
            pushStreamToStop.close();
          } catch (err) {
            console.error(`Error closing Azure push stream (${reason}):`, err);
          }
        }
        if (recognizerToStop) {
          try {
            recognizerToStop.close();
          } catch (err) {
            console.error(`Error closing Azure recognizer (${reason}):`, err);
          }
        }
        resolve();
      };

      if (!recognizerToStop) {
        finalize();
        return;
      }

      timeout = setTimeout(() => {
        this.cb.diag("azure_stop_timeout", { reason });
        finalize();
      }, RECOGNIZER_STOP_TIMEOUT_MS);

      try {
        recognizerToStop.stopContinuousRecognitionAsync(
          () => {
            this.cb.diag("azure_recognition_stopped", { reason });
            finalize();
          },
          (err) => {
            console.error(`Error stopping Azure Speech (${reason}):`, err);
            finalize();
          }
        );
      } catch (err) {
        console.error(`Azure stop threw synchronously (${reason}):`, err);
        finalize();
      }
    });
  }

  private async stopRecognizer(reason: string): Promise<void> {
    const recognizerToStop = this.recognizer;
    const pushStreamToStop = this.pushStream;
    this.recognizer = null;
    this.pushStream = null;
    if (!recognizerToStop && !pushStreamToStop) return;
    await this.stopRecognizerResources(recognizerToStop, pushStreamToStop, reason);
  }

  private scheduleRecovery(reason: string, immediate = false) {
    if (this.closed || !this.audioSampleRate) return;
    if (this.recoveryInFlight || this.recognizerRecoveryTimer) return;

    const nextAttempt = this.consecutiveRecoveryAttempts + 1;
    if (nextAttempt > MAX_AUTO_RECOVERY_ATTEMPTS) {
      console.error(
        `Azure recognizer recovery exhausted after ${this.consecutiveRecoveryAttempts} attempts (${reason})`
      );
      this.cb.onError(
        "Speech recognition stopped responding after a long hold. Please stop and start again.",
        true
      );
      return;
    }

    const delayMs = immediate
      ? 0
      : AUTO_RECOVERY_BACKOFF_MS[
          Math.min(this.consecutiveRecoveryAttempts, AUTO_RECOVERY_BACKOFF_MS.length - 1)
        ];

    this.cb.diag("recovery_schedule", { attempt: nextAttempt, delayMs, reason });
    this.recognizerRecoveryTimer = setTimeout(() => {
      this.recognizerRecoveryTimer = null;
      void this.performRecovery(reason);
    }, delayMs);
  }

  private async performRecovery(reason: string) {
    if (this.closed || !this.audioSampleRate || this.recoveryInFlight) return;
    this.recoveryInFlight = true;
    const attempt = this.consecutiveRecoveryAttempts + 1;
    this.consecutiveRecoveryAttempts = attempt;
    this.lastRecoveryAt = Date.now();

    this.cb.diag("recovery_attempt", { attempt, reason });

    let shouldRetry = false;
    try {
      await this.stopRecognizer(`recovery:${reason}`);
      const started = await this.startRecognizer();
      if (!started) shouldRetry = true;
    } finally {
      this.recoveryInFlight = false;
    }
    if (shouldRetry) this.scheduleRecovery(`retry after ${reason}`);
  }

  private startWatchdog() {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      if (this.closed || this.recoveryInFlight || !this.recognizer || !this.audioSampleRate) return;
      if (!this.lastAudioPacketAt || !this.lastAzureEventAt) return;

      const now = Date.now();
      const hasRecentAudio = now - this.lastAudioPacketAt <= AUDIO_PACKET_STALE_MS;
      const azureLooksIdle = now - this.lastAzureEventAt >= AZURE_IDLE_RECOVERY_MS;
      const recoveryCooldownPassed = now - this.lastRecoveryAt >= MIN_AUTO_RECOVERY_GAP_MS;

      if (hasRecentAudio && azureLooksIdle && recoveryCooldownPassed) {
        this.cb.diag("watchdog_trigger", {
          audioAgeSec: Math.round((now - this.lastAudioPacketAt) / 1000),
          azureIdleSec: Math.round((now - this.lastAzureEventAt) / 1000),
        });
        this.scheduleRecovery("watchdog inactivity after long hold", true);
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  private async startRecognizer(): Promise<boolean> {
    const speechKey = process.env.AZURE_SPEECH_KEY;
    const speechRegion = process.env.AZURE_SPEECH_REGION;
    const sampleRate = this.audioSampleRate;
    const channels = this.audioChannels;

    if (!speechKey || !speechRegion) {
      this.cb.onError(
        "Server is missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION. Update your .env file.",
        true
      );
      return false;
    }
    if (!sampleRate) return false;

    const audioFormat = sdk.AudioStreamFormat.getWaveFormatPCM(sampleRate, 16, channels);
    const nextPushStream = sdk.AudioInputStream.createPushStream(audioFormat);
    const audioConfig = sdk.AudioConfig.fromStreamInput(nextPushStream);

    const speechEndpoint = new URL(
      `wss://${speechRegion}.stt.speech.microsoft.com/${CONTINUOUS_LID_ENDPOINT_PATH}`
    );
    const speechConfig = sdk.SpeechConfig.fromEndpoint(speechEndpoint, speechKey);
    speechConfig.setProperty(
      sdk.PropertyId.SpeechServiceConnection_LanguageIdMode,
      "Continuous"
    );
    speechConfig.setProperty(
      sdk.PropertyId.Speech_SegmentationStrategy,
      "Semantic"
    );
    speechConfig.setProperty("Speech.SegmentationSilenceTimeoutMs", "1800");
    speechConfig.setProperty(
      sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs,
      "3500"
    );
    speechConfig.setProfanity(sdk.ProfanityOption.Raw);

    const autoDetectConfig = sdk.AutoDetectSourceLanguageConfig.fromLanguages([
      "zh-CN",
      "en-US",
    ]);

    const nextRecognizer = sdk.SpeechRecognizer.FromConfig(
      speechConfig,
      autoDetectConfig,
      audioConfig
    );
    const generation = ++this.recognizerGeneration;
    this.recognizer = nextRecognizer;
    this.pushStream = nextPushStream;
    this.lastAzureEventAt = Date.now();

    let lastDetectedLanguage: ASRLanguage = "zh";
    const isCurrentRecognizer = () =>
      !this.closed &&
      this.recognizer === nextRecognizer &&
      this.pushStream === nextPushStream &&
      generation === this.recognizerGeneration;

    nextRecognizer.sessionStarted = () => {
      if (!isCurrentRecognizer()) return;
      this.noteHealthyAzureActivity();
      this.cb.diag("azure_session_started");
    };

    nextRecognizer.recognizing = (_sender, event) => {
      if (!isCurrentRecognizer()) return;
      const result = event.result;
      if (!result.text?.trim()) return;
      this.noteHealthyAzureActivity();

      let language: ASRLanguage = lastDetectedLanguage;
      try {
        const langResult = sdk.AutoDetectSourceLanguageResult.fromResult(result);
        if (langResult.language && langResult.language !== "Unknown") {
          language = detectLanguageFromAzure(langResult.language);
          lastDetectedLanguage = language;
        } else {
          language = detectLanguageFromText(result.text);
        }
      } catch {
        language = detectLanguageFromText(result.text);
      }

      this.cb.onPartial(result.text, language);
    };

    nextRecognizer.recognized = (_sender, event) => {
      if (!isCurrentRecognizer()) return;
      const result = event.result;
      this.noteHealthyAzureActivity();

      if (result.reason === sdk.ResultReason.RecognizedSpeech && result.text?.trim()) {
        let language: ASRLanguage = lastDetectedLanguage;
        try {
          const langResult = sdk.AutoDetectSourceLanguageResult.fromResult(result);
          if (langResult.language && langResult.language !== "Unknown") {
            language = detectLanguageFromAzure(langResult.language);
            lastDetectedLanguage = language;
          } else {
            language = detectLanguageFromText(result.text);
          }
        } catch {
          language = detectLanguageFromText(result.text);
        }
        let azureLang = "unknown";
        try {
          const lr = sdk.AutoDetectSourceLanguageResult.fromResult(result);
          azureLang = lr.language || "unknown";
        } catch {
          /* ignore */
        }
        this.cb.diag("recognized", {
          lang: language,
          azureLang,
          len: result.text.length,
          text: result.text.substring(0, 80),
        });
        this.cb.onFinal(result.text, language);
      }
    };

    nextRecognizer.canceled = (_sender, event) => {
      if (!isCurrentRecognizer()) return;
      this.noteAzureActivity();
      if (event.reason === sdk.CancellationReason.Error) {
        this.cb.diag("azure_error", {
          code: event.errorCode,
          details: event.errorDetails?.substring(0, 200),
        });
        console.error("Azure Speech error:", event.errorCode, event.errorDetails);
        this.scheduleRecovery(`Azure error ${event.errorCode}`);
      }
    };

    nextRecognizer.sessionStopped = () => {
      if (!isCurrentRecognizer()) return;
      this.noteAzureActivity();
      this.cb.diag("azure_session_stopped");
      if (!this.recoveryInFlight) {
        this.scheduleRecovery("Azure session stopped");
      }
    };

    return await new Promise<boolean>((resolve) => {
      nextRecognizer.startContinuousRecognitionAsync(
        () => {
          if (!isCurrentRecognizer()) {
            resolve(false);
            return;
          }
          this.noteHealthyAzureActivity();
          this.cb.diag("azure_recognition_started");
          resolve(true);
        },
        async (err) => {
          console.error("Failed to start Azure Speech:", err);
          if (this.recognizer === nextRecognizer) {
            await this.stopRecognizer("start failure");
          } else {
            await this.stopRecognizerResources(nextRecognizer, nextPushStream, "stale start failure");
          }
          resolve(false);
        }
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Qwen3-ASR engine — Alibaba DashScope realtime WebSocket
//
// Protocol: OpenAI-Realtime-compatible events
//   docs: https://www.alibabacloud.com/help/en/model-studio/qwen-real-time-speech-recognition
//
//   URL (international, default for non-CN users):
//     wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime-2026-02-10
//   URL (mainland China):
//     wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime-2026-02-10
//
//   Headers:
//     Authorization: Bearer <DASHSCOPE_API_KEY>
//     OpenAI-Beta: realtime=v1
//
//   Message flow:
//     server → session.created
//     client → session.update (configure audio format, VAD)
//     client → input_audio_buffer.append (base64 PCM chunk) × N
//     server → conversation.item.input_audio_transcription.text       (partial)
//     server → conversation.item.input_audio_transcription.completed  (final)
//     client → session.finish
//
// Region override: set DASHSCOPE_WS_URL to override the default entirely,
// or DASHSCOPE_REGION=cn to force mainland endpoint.
// ---------------------------------------------------------------------------
const DASHSCOPE_WS_URL_INTL = "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime";
const DASHSCOPE_WS_URL_CN = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
const QWEN_ASR_MODEL = "qwen3-asr-flash-realtime-2026-02-10";
const QWEN_TURN_DETECTION_THRESHOLD = 0.3;
const QWEN_TURN_DETECTION_SILENCE_MS = 600;
const QWEN_STOP_WAIT_MS = 1500;
const QWEN_MAX_AUTO_RECOVERY_ATTEMPTS = 3;
const QWEN_AUTO_RECOVERY_BACKOFF_MS = [1000, 3000, 5000] as const;

function resolveDashscopeUrl(): string {
  const override = process.env.DASHSCOPE_WS_URL;
  if (override) {
    // User-provided URL; append model query param if absent.
    return override.includes("model=")
      ? override
      : `${override}${override.includes("?") ? "&" : "?"}model=${QWEN_ASR_MODEL}`;
  }
  const region = (process.env.DASHSCOPE_REGION || "").toLowerCase();
  const base = region === "cn" || region === "china" ? DASHSCOPE_WS_URL_CN : DASHSCOPE_WS_URL_INTL;
  return `${base}?model=${QWEN_ASR_MODEL}`;
}

export class QwenASREngine implements ASREngine {
  readonly provider: ASRProvider = "qwen";

  private cb: ASREngineCallbacks;
  private ws: WSClient | null = null;
  private audioSampleRate: number | null = null;
  private audioChannels = 1;
  private sessionReady = false;
  private closed = false;
  private stopReason: string | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopResolve: (() => void) | null = null;
  private stopTimer: NodeJS.Timeout | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private recoveryInFlight = false;
  private consecutiveRecoveryAttempts = 0;
  private socketGeneration = 0;
  /** PCM chunks that arrive before session.created — replay once ready. */
  private audioBuffer: Buffer[] = [];
  private eventCounter = 0;

  constructor(cb: ASREngineCallbacks) {
    this.cb = cb;
  }

  private nextEventId(): string {
    this.eventCounter++;
    return `evt_${Date.now().toString(36)}_${this.eventCounter}`;
  }

  private sendEvent(payload: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WSClient.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      this.cb.diag("qwen_send_error", { type: payload.type, error: String(err) });
    }
  }

  private clearStopWait(): void {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  private finalizeStop(): void {
    this.clearStopWait();
    this.clearRecoveryTimer();
    const ws = this.ws;
    this.ws = null;
    this.sessionReady = false;
    if (ws && ws.readyState < WSClient.CLOSING) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    if (this.stopReason) {
      this.cb.diag("qwen_stopped", { reason: this.stopReason });
    }
    this.stopReason = null;
    this.recoveryInFlight = false;
    this.consecutiveRecoveryAttempts = 0;
    const resolve = this.stopResolve;
    this.stopResolve = null;
    this.stopPromise = null;
    resolve?.();
  }

  private scheduleRecovery(reason: string): void {
    if (this.closed || !this.audioSampleRate) return;
    if (this.recoveryInFlight || this.recoveryTimer) return;

    const nextAttempt = this.consecutiveRecoveryAttempts + 1;
    if (nextAttempt > QWEN_MAX_AUTO_RECOVERY_ATTEMPTS) {
      this.cb.diag("qwen_recovery_exhausted", { reason });
      this.cb.onError(
        "Qwen ASR connection became unstable during this session. Please stop and start again, or switch back to Azure.",
        true
      );
      return;
    }

    const delayMs =
      QWEN_AUTO_RECOVERY_BACKOFF_MS[
        Math.min(this.consecutiveRecoveryAttempts, QWEN_AUTO_RECOVERY_BACKOFF_MS.length - 1)
      ];
    this.cb.diag("qwen_recovery_schedule", { attempt: nextAttempt, delayMs, reason });
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      void this.performRecovery(reason);
    }, delayMs);
  }

  private async performRecovery(reason: string): Promise<void> {
    if (this.closed || !this.audioSampleRate || this.recoveryInFlight) return;
    this.recoveryInFlight = true;
    this.consecutiveRecoveryAttempts += 1;
    const attempt = this.consecutiveRecoveryAttempts;
    this.cb.diag("qwen_recovery_attempt", { attempt, reason });
    try {
      const ok = await this.connect(this.audioSampleRate);
      if (!ok) {
        this.scheduleRecovery(`retry after ${reason}`);
      }
    } finally {
      this.recoveryInFlight = false;
    }
  }

  private async connect(sampleRate: number): Promise<boolean> {
    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      this.cb.onError(
        "Server is missing DASHSCOPE_API_KEY. Add it to your .env file or switch back to Azure in Settings.",
        true
      );
      return false;
    }

    this.closed = false;
    this.sessionReady = false;

    const url = resolveDashscopeUrl();
    this.cb.diag("qwen_connecting", { url });

    return await new Promise<boolean>((resolve) => {
      let resolved = false;
      const finish = (ok: boolean) => {
        if (!resolved) {
          resolved = true;
          resolve(ok);
        }
      };

      try {
        this.ws = new WSClient(url, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "OpenAI-Beta": "realtime=v1",
          },
        });
      } catch (err) {
        this.cb.diag("qwen_ws_construct_error", { error: String(err) });
        this.cb.onError(`Failed to open DashScope connection: ${String(err)}`, true);
        finish(false);
        return;
      }

      const ws = this.ws!;
      const generation = ++this.socketGeneration;
      const isCurrentSocket = () => this.ws === ws && generation === this.socketGeneration;

      ws.on("open", () => {
        if (!isCurrentSocket()) return;
        this.cb.diag("qwen_ws_open");
        // Configure the session. We omit `input_audio_transcription.language`
        // to let the model auto-detect CN/EN. Server VAD segments utterances
        // so we get completed events at natural boundaries.
        this.sendEvent({
          event_id: this.nextEventId(),
          type: "session.update",
          session: {
            input_audio_format: "pcm",
            sample_rate: sampleRate,
            turn_detection: {
              type: "server_vad",
              threshold: QWEN_TURN_DETECTION_THRESHOLD,
              silence_duration_ms: QWEN_TURN_DETECTION_SILENCE_MS,
            },
          },
        });
      });

      ws.on("message", (data, isBinary) => {
        if (!isCurrentSocket()) return;
        if (isBinary) return;
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        const type: string | undefined = msg?.type;
        if (!type) return;

        // session.created — connection is live; start flushing audio.
        if (type === "session.created" || type === "session.updated") {
          if (!this.sessionReady) {
            this.sessionReady = true;
            this.consecutiveRecoveryAttempts = 0;
            this.cb.diag("qwen_session_ready", { type });
            for (const chunk of this.audioBuffer) {
              this.sendEvent({
                event_id: this.nextEventId(),
                type: "input_audio_buffer.append",
                audio: chunk.toString("base64"),
              });
            }
            this.audioBuffer = [];
            finish(true);
          }
          return;
        }

        // Partial / interim transcript.
        if (type === "conversation.item.input_audio_transcription.text") {
          const confirmed: string = typeof msg?.text === "string" ? msg.text : "";
          const stash: string = typeof msg?.stash === "string" ? msg.stash : "";
          const preview = `${confirmed}${stash}`.trim();
          if (preview) {
            const language = detectLanguageFromQwen(msg?.language, preview);
            this.cb.onPartial(preview, language);
          }
          return;
        }

        // Final / completed transcript.
        if (type === "conversation.item.input_audio_transcription.completed") {
          const rawTranscript: string | undefined = msg?.transcript ?? msg?.text;
          if (rawTranscript && rawTranscript.trim()) {
            const providerLang =
              typeof msg?.language === "string" && msg.language.trim()
                ? msg.language.trim()
                : undefined;
            const transcript = normalizeUnexpectedQwenJapanese(rawTranscript);
            const language = detectLanguageFromQwen(providerLang, transcript);
            const leakedJapanese =
              providerLang === "ja" || containsJapaneseKana(rawTranscript);

            if (transcript !== rawTranscript) {
              this.cb.diag("qwen_leak_normalized", {
                providerLang: providerLang || "unknown",
                original: rawTranscript.substring(0, 80),
                normalized: transcript.substring(0, 80),
              });
            }
            if (leakedJapanese || (providerLang && !["zh", "yue", "en"].includes(providerLang))) {
              this.cb.diag("qwen_unexpected_language", {
                providerLang: providerLang || "unknown",
                mappedLang: language,
                text: rawTranscript.substring(0, 80),
              });
            }
            this.cb.diag("qwen_final", {
              len: transcript.length,
              text: transcript.substring(0, 80),
              lang: language,
              providerLang: providerLang || "unknown",
            });
            this.cb.onFinal(transcript, language);
          }
          return;
        }

        if (type === "conversation.item.input_audio_transcription.failed") {
          const error = msg?.error || {};
          const code = error.code || error.type || "unknown";
          const message = error.message || "Input audio transcription failed";
          this.cb.diag("qwen_transcription_failed", { code, message, itemId: msg?.item_id });
          this.cb.onError(
            `Qwen ASR transcription failed (${code}): ${message}. You can switch back to Azure in Settings.`,
            true
          );
          return;
        }

        if (type === "input_audio_buffer.speech_started") {
          this.cb.diag("qwen_speech_started");
          return;
        }
        if (type === "input_audio_buffer.speech_stopped") {
          this.cb.diag("qwen_speech_stopped");
          return;
        }

        if (type === "input_audio_buffer.committed") {
          this.cb.diag("qwen_audio_committed");
          return;
        }

        if (type === "conversation.item.created") {
          this.cb.diag("qwen_item_created", {
            itemId: msg?.item?.id ?? msg?.item_id,
            itemType: msg?.item?.type,
          });
          return;
        }

        if (type === "session.finished") {
          this.cb.diag("qwen_session_finished");
          if (this.closed) {
            this.finalizeStop();
          }
          return;
        }

        if (type === "error") {
          const err = msg?.error || {};
          const code = err.code || err.type || "unknown";
          const message = err.message || "DashScope realtime error";
          this.cb.diag("qwen_error_event", { code, message });
          this.cb.onError(
            `Qwen ASR error (${code}): ${message}. You can switch back to Azure in Settings.`,
            true
          );
          if (!this.sessionReady) finish(false);
          return;
        }

        // Unknown event — just log, don't fail.
        this.cb.diag("qwen_unknown_event", { type });
      });

      ws.on("error", (err) => {
        if (!isCurrentSocket()) return;
        this.cb.diag("qwen_ws_error", { error: String(err) });
        if (!this.sessionReady) {
          this.cb.onError(
            `DashScope connection error: ${String(err)}. Check DASHSCOPE_API_KEY / network, or switch back to Azure.`,
            true
          );
          finish(false);
        }
      });

      ws.on("close", (code, reason) => {
        if (!isCurrentSocket()) return;
        this.cb.diag("qwen_ws_close", { code, reason: reason?.toString().substring(0, 120) });
        if (!this.sessionReady && !this.closed) {
          this.cb.onError(
            `DashScope connection closed before session was ready (code ${code}). Check DASHSCOPE_API_KEY and region.`,
            true
          );
          finish(false);
        }
        if (this.closed) {
          this.finalizeStop();
        } else {
          this.ws = null;
          this.sessionReady = false;
          this.scheduleRecovery(`websocket closed (code ${code})`);
        }
      });
    });
  }

  async start(sampleRate: number, channels: number): Promise<boolean> {
    this.audioSampleRate = sampleRate;
    this.audioChannels = channels;
    this.audioBuffer = [];
    this.eventCounter = 0;
    this.stopReason = null;
    this.stopPromise = null;
    this.stopResolve = null;
    this.clearStopWait();
    this.clearRecoveryTimer();
    this.recoveryInFlight = false;
    this.consecutiveRecoveryAttempts = 0;
    return await this.connect(sampleRate);
  }

  pushAudio(buffer: Buffer): void {
    if (this.closed) return;
    if (!this.sessionReady) {
      // Buffer until session.created arrives.
      this.audioBuffer.push(buffer);
      return;
    }
    this.sendEvent({
      event_id: this.nextEventId(),
      type: "input_audio_buffer.append",
      audio: buffer.toString("base64"),
    });
  }

  async stop(reason: string): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    if (this.closed) return;
    this.closed = true;
    this.clearRecoveryTimer();
    this.stopReason = reason;
    const ws = this.ws;
    if (!ws) return;

    this.stopPromise = new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });

    if (ws.readyState === WSClient.OPEN && this.sessionReady) {
      // Ask the server to flush any trailing transcript before we close locally.
      try {
        ws.send(JSON.stringify({
          event_id: this.nextEventId(),
          type: "session.finish",
        }));
      } catch {
        this.finalizeStop();
        return this.stopPromise;
      }

      this.stopTimer = setTimeout(() => {
        this.cb.diag("qwen_stop_timeout", { waitMs: QWEN_STOP_WAIT_MS });
        this.finalizeStop();
      }, QWEN_STOP_WAIT_MS);

      return this.stopPromise;
    }

    this.finalizeStop();
    return this.stopPromise;
  }
}

// ---------------------------------------------------------------------------
// Soniox realtime STT engine — official Soniox Node SDK
//
// Docs:
//   - https://soniox.com/docs/stt/SDKs/node-SDK/realtime-transcription
//   - https://soniox.com/docs/stt/rt/real-time-transcription
//   - https://soniox.com/docs/stt/models
// ---------------------------------------------------------------------------
const SONIOX_ASR_MODEL = "stt-rt-v4";
// Give Soniox a bit more silence before endpointing so long English phrases
// like "schedule your medication delivery" do not get cut at word boundaries.
const SONIOX_ENDPOINT_DELAY_MS = 1600;
// Keep idle fallback slightly behind endpoint detection so endpoint remains the
// primary flush path, while still preventing buffered finals from hanging.
const SONIOX_IDLE_FINAL_FLUSH_MS = 1900;
const SONIOX_STOP_WAIT_MS = 2000;
const SONIOX_CONNECTING_AUDIO_BUFFER_LIMIT_BYTES = 512 * 1024;
const SONIOX_CONNECT_RETRY_WAIT_MS = 250;
const SONIOX_CONNECT_MAX_ATTEMPTS = 2;
const SONIOX_LOW_CONFIDENCE_THRESHOLD = 0.75;
const SONIOX_MAX_LOW_CONFIDENCE_TOKENS = 16;

function buildSonioxFinalMetadata(tokens: RealtimeToken[]): ASRFinalMetadata {
  const lexicalTokens = tokens.filter(
    (token) =>
      Number.isFinite(token.confidence) &&
      /[A-Za-z0-9\u4e00-\u9fff]/u.test(token.text)
  );

  if (lexicalTokens.length === 0) {
    return { provider: "soniox" };
  }

  const confidences = lexicalTokens.map((token) => token.confidence);
  const averageConfidence =
    confidences.reduce((sum, confidence) => sum + confidence, 0) / confidences.length;
  const lowConfidenceTokens = lexicalTokens
    .filter((token) => token.confidence < SONIOX_LOW_CONFIDENCE_THRESHOLD)
    .sort((a, b) => a.confidence - b.confidence)
    .slice(0, SONIOX_MAX_LOW_CONFIDENCE_TOKENS)
    .map((token) => ({
      text: token.text,
      confidence: Math.round(token.confidence * 1000) / 1000,
    }));

  return {
    provider: "soniox",
    averageConfidence: Math.round(averageConfidence * 1000) / 1000,
    minConfidence: Math.round(Math.min(...confidences) * 1000) / 1000,
    lowConfidenceTokens,
  };
}

function isRetryableSonioxConnectError(error: unknown): boolean {
  const text = String(error).toLowerCase();
  return (
    text.includes("connectionerror") ||
    text.includes("websocket") ||
    text.includes("network") ||
    text.includes("timeout") ||
    text.includes("socket")
  );
}

export class SonioxASREngine implements ASREngine {
  readonly provider: ASRProvider = "soniox";

  private cb: ASREngineCallbacks;
  private client: SonioxNodeClient | null = null;
  private session: RealtimeSttSession | null = null;
  private audioSampleRate: number | null = null;
  private audioChannels = 1;
  private closed = false;
  private stopReason: string | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopResolve: (() => void) | null = null;
  private stopTimer: NodeJS.Timeout | null = null;
  private sessionGeneration = 0;
  private connected = false;
  private partialFinalText = "";
  private partialPreviewText = "";
  private idleFinalizeTimer: NodeJS.Timeout | null = null;
  private hasBufferedFinalTokens = false;
  private pendingAudio: Buffer[] = [];
  private pendingAudioBytes = 0;
  private utteranceBuffer = new RealtimeUtteranceBuffer({
    final_only: true,
    group_by: [],
  });

  constructor(cb: ASREngineCallbacks) {
    this.cb = cb;
  }

  private clearStopWait(): void {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
  }

  private clearIdleFinalize(): void {
    if (this.idleFinalizeTimer) {
      clearTimeout(this.idleFinalizeTimer);
      this.idleFinalizeTimer = null;
    }
  }

  private resetRollingPreview(): void {
    this.partialFinalText = "";
    this.partialPreviewText = "";
  }

  private resetPendingAudio(): void {
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
  }

  private enqueuePendingAudio(buffer: Buffer): void {
    if (buffer.length <= 0) return;
    this.pendingAudio.push(buffer);
    this.pendingAudioBytes += buffer.length;
    while (
      this.pendingAudioBytes > SONIOX_CONNECTING_AUDIO_BUFFER_LIMIT_BYTES &&
      this.pendingAudio.length > 0
    ) {
      const dropped = this.pendingAudio.shift();
      if (!dropped) break;
      this.pendingAudioBytes -= dropped.length;
    }
  }

  private flushPendingAudio(session: RealtimeSttSession): void {
    if (!this.connected || this.closed || this.pendingAudio.length === 0) return;
    const queued = this.pendingAudio;
    this.resetPendingAudio();
    for (const chunk of queued) {
      session.sendAudio(chunk);
    }
    this.cb.diag("soniox_buffer_flushed", {
      chunks: queued.length,
      bytes: queued.reduce((sum, chunk) => sum + chunk.length, 0),
    });
  }

  private finalizeStop(): void {
    this.clearStopWait();
    this.clearIdleFinalize();
    this.connected = false;
    this.session = null;
    this.client = null;
    this.resetRollingPreview();
    this.hasBufferedFinalTokens = false;
    this.resetPendingAudio();
    this.utteranceBuffer.reset();
    if (this.stopReason) {
      this.cb.diag("soniox_stopped", { reason: this.stopReason });
    }
    this.stopReason = null;
    const resolve = this.stopResolve;
    this.stopResolve = null;
    this.stopPromise = null;
    resolve?.();
  }

  private flushBufferedUtterance(trigger: "endpoint" | "finalized" | "finished" | "idle"): void {
    this.clearIdleFinalize();
    const utterance = this.utteranceBuffer.markEndpoint();
    this.resetRollingPreview();
    this.hasBufferedFinalTokens = false;
    if (!utterance?.text.trim()) return;

    const providerLang = utterance.language || "unknown";
    const transcript = utterance.text;
    const language = detectLanguageFromSoniox(utterance.language, transcript);
    const metadata = buildSonioxFinalMetadata(utterance.tokens);
    this.cb.diag("soniox_final", {
      len: transcript.length,
      text: transcript.substring(0, 80),
      lang: language,
      providerLang,
      trigger,
      averageConfidence: metadata.averageConfidence,
      minConfidence: metadata.minConfidence,
      lowConfidenceTokenCount: metadata.lowConfidenceTokens?.length || 0,
    });
    this.cb.onFinal(transcript, language, metadata);
  }

  private scheduleIdleFinalize(session: RealtimeSttSession, generation: number): void {
    this.clearIdleFinalize();
    this.idleFinalizeTimer = setTimeout(() => {
      this.idleFinalizeTimer = null;
      const isCurrentSession =
        this.session === session && generation === this.sessionGeneration;
      if (!isCurrentSession || this.closed || !this.hasBufferedFinalTokens) return;
      this.cb.diag("soniox_idle_finalize", { waitMs: SONIOX_IDLE_FINAL_FLUSH_MS });
      this.flushBufferedUtterance("idle");
    }, SONIOX_IDLE_FINAL_FLUSH_MS);
  }

  private bindSessionEvents(session: RealtimeSttSession, generation: number): void {
    const isCurrentSession = () =>
      this.session === session && generation === this.sessionGeneration;

    session.on("connected", () => {
      if (!isCurrentSession()) return;
      this.connected = true;
      this.cb.diag("soniox_connected", { model: SONIOX_ASR_MODEL });
      try {
        this.flushPendingAudio(session);
      } catch (error) {
        this.cb.diag("soniox_buffer_flush_error", { error: String(error) });
        if (!this.closed) {
          this.cb.onError(
            `Soniox ASR audio streaming failed: ${
              error instanceof Error ? error.message : String(error)
            }.`,
            true
          );
        }
      }
    });

    session.on("result", (result: RealtimeResult) => {
      if (!isCurrentSession()) return;
      this.utteranceBuffer.addResult(result);

      const finalDelta = result.tokens
        .filter((token) => token.is_final)
        .map((token) => token.text)
        .join("");
      if (finalDelta) {
        this.partialFinalText += finalDelta;
        this.hasBufferedFinalTokens = true;
      }

      this.partialPreviewText = result.tokens
        .filter((token) => !token.is_final)
        .map((token) => token.text)
        .join("");

      const preview = `${this.partialFinalText}${this.partialPreviewText}`.trim();
      if (!preview) return;

      const providerLang = getLastTokenLanguage(result.tokens);
      const language = detectLanguageFromSoniox(providerLang, preview);
      this.cb.onPartial(preview, language);

      if (this.hasBufferedFinalTokens) {
        this.scheduleIdleFinalize(session, generation);
      }
    });

    session.on("endpoint", () => {
      if (!isCurrentSession()) return;
      this.cb.diag("soniox_endpoint");
      this.flushBufferedUtterance("endpoint");
    });

    session.on("finalized", () => {
      if (!isCurrentSession()) return;
      this.cb.diag("soniox_finalized");
      this.flushBufferedUtterance("finalized");
    });

    session.on("finished", () => {
      if (!isCurrentSession()) return;
      this.cb.diag("soniox_session_finished");
      this.flushBufferedUtterance("finished");
      if (this.closed) {
        this.finalizeStop();
      }
    });

    session.on("disconnected", (reason) => {
      if (this.session !== session || generation !== this.sessionGeneration) return;
      this.clearIdleFinalize();
      this.connected = false;
      this.cb.diag("soniox_disconnected", {
        reason: reason?.substring(0, 120) || "unknown",
      });
      this.session = null;
      if (this.closed) {
        this.finalizeStop();
        return;
      }
      this.cb.onError(
        `Soniox ASR connection closed unexpectedly${reason ? `: ${reason}` : ""}. You can switch back to Azure or retry.`,
        true
      );
    });

    session.on("error", (error) => {
      if (this.session !== session || generation !== this.sessionGeneration) return;
      this.clearIdleFinalize();
      this.cb.diag("soniox_error", { error: String(error) });
      if (this.closed) return;
      this.cb.onError(
        `Soniox ASR error: ${error instanceof Error ? error.message : String(error)}.`,
        true
      );
    });
  }

  async start(sampleRate: number, channels: number): Promise<boolean> {
    const apiKey = process.env.SONIOX_API_KEY;
    if (!apiKey) {
      this.cb.onError(
        "Server is missing SONIOX_API_KEY. Add it to your .env file or switch back to Azure/Qwen in Settings.",
        true
      );
      return false;
    }

    this.audioSampleRate = sampleRate;
    this.audioChannels = channels;
    this.closed = false;
    this.connected = false;
    this.stopReason = null;
    this.stopPromise = null;
    this.stopResolve = null;
    this.clearStopWait();
    this.clearIdleFinalize();
    this.resetRollingPreview();
    this.hasBufferedFinalTokens = false;
    this.resetPendingAudio();
    this.utteranceBuffer.reset();

    for (let attempt = 1; attempt <= SONIOX_CONNECT_MAX_ATTEMPTS; attempt += 1) {
      try {
        this.client = new SonioxNodeClient({ api_key: apiKey });
        const session = this.client.realtime.stt({
          model: SONIOX_ASR_MODEL,
          audio_format: "pcm_s16le",
          sample_rate: sampleRate,
          num_channels: channels,
          language_hints: ["en", "zh"],
          enable_language_identification: true,
          enable_endpoint_detection: true,
          max_endpoint_delay_ms: SONIOX_ENDPOINT_DELAY_MS,
          context: {
            general: [
              { key: "domain", value: "Healthcare and medical interpretation" },
              {
                key: "setting",
                value: "Real-time conversation between clinicians, patients, and caregivers",
              },
              {
                key: "languages",
                value: "English and Mandarin Chinese; speakers may alternate or code-switch without warning",
              },
              {
                key: "content",
                value: "Symptoms, medications, diagnoses, tests, procedures, anatomy, care instructions, scheduling, and insurance",
              },
              {
                key: "transcription_style",
                value: "Verbatim transcription; preserve names, numbers, medication names, diseases, procedures, and body parts",
              },
              { key: "chinese_script", value: "Use Simplified Chinese" },
            ],
          },
        });

        const generation = ++this.sessionGeneration;
        this.session = session;
        this.bindSessionEvents(session, generation);
        this.cb.diag("soniox_connecting", {
          model: SONIOX_ASR_MODEL,
          sampleRate: sampleRate,
          channels,
          attempt,
        });
        await session.connect();
        if (this.session === session && generation === this.sessionGeneration && !this.closed) {
          this.connected = true;
          this.flushPendingAudio(session);
        }
        return true;
      } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
        this.connected = false;
        try {
          this.session?.close();
        } catch {
          // ignore
        }
        this.session = null;
        this.client = null;

        if (this.closed) {
          this.resetPendingAudio();
          this.clearIdleFinalize();
          this.cb.diag("soniox_start_aborted", {
            attempt,
            reason: "closed during connect",
          });
          return false;
        }

        if (
          attempt < SONIOX_CONNECT_MAX_ATTEMPTS &&
          !this.closed &&
          isRetryableSonioxConnectError(err)
        ) {
          this.cb.diag("soniox_start_retry", {
            attempt,
            waitMs: SONIOX_CONNECT_RETRY_WAIT_MS,
            error: errorText.substring(0, 120),
          });
          await new Promise((resolve) => setTimeout(resolve, SONIOX_CONNECT_RETRY_WAIT_MS));
          continue;
        }

        this.resetPendingAudio();
        this.cb.diag("soniox_start_error", { attempt, error: String(err) });
        this.cb.onError(`Failed to start Soniox ASR: ${errorText}.`, true);
        return false;
      }
    }

    return false;
  }

  pushAudio(buffer: Buffer): void {
    if (this.closed) return;
    if (!this.session || !this.connected) {
      this.enqueuePendingAudio(buffer);
      return;
    }
    try {
      this.session.sendAudio(buffer);
    } catch (err) {
      this.cb.diag("soniox_send_error", { error: String(err) });
      if (!this.closed) {
        this.cb.onError(
          `Soniox ASR audio streaming failed: ${err instanceof Error ? err.message : String(err)}.`,
          true
        );
      }
    }
  }

  async stop(reason: string): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.closed) return;

    this.closed = true;
    this.stopReason = reason;
    const session = this.session;
    if (!session) {
      this.finalizeStop();
      return;
    }

    this.stopPromise = new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });
    const stopPromise = this.stopPromise;

    this.stopTimer = setTimeout(() => {
      this.cb.diag("soniox_stop_timeout", { waitMs: SONIOX_STOP_WAIT_MS });
      try {
        session.close();
      } catch {
        // ignore
      }
      this.finalizeStop();
    }, SONIOX_STOP_WAIT_MS);

    try {
      await session.finish();
      if (this.stopPromise) {
        this.finalizeStop();
      }
    } catch {
      try {
        session.close();
      } catch {
        // ignore
      }
      if (this.stopPromise) {
        this.finalizeStop();
      }
    }

    return stopPromise;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createASREngine(
  provider: string | undefined,
  callbacks: ASREngineCallbacks
): ASREngine {
  const p = (provider || "azure").toLowerCase();
  if (p === "qwen") return new QwenASREngine(callbacks);
  if (p === "soniox") return new SonioxASREngine(callbacks);
  return new AzureASREngine(callbacks);
}
