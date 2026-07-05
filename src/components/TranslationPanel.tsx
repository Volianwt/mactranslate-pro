import React, { useLayoutEffect, useRef, memo, useCallback, useEffect, useState, useMemo } from 'react';
import { Loader2, Volume2 } from 'lucide-react';
import { Message } from '../types';
import {
  extractPronunciationCandidates,
  lookupPronunciation,
  lookupPronunciationHint,
  normalizePronunciationLookupKey,
  playPronunciationAudio,
  type PronunciationResult,
} from '../services/phonetics';

interface Props {
  title: string;
  messages: Message[];
  liveText: string;
  isListening: boolean;
  compact?: boolean;
  autoPronounce?: boolean;
  showIpa?: boolean;
}

// Regex to split text into English words and non-English segments
const WORD_SPLIT_RE = /([a-zA-Z]+(?:['\u2019-][a-zA-Z]+)*)/g;
const ENGLISH_WORD_RE = /^[a-zA-Z]+(?:['\u2019-][a-zA-Z]+)*$/;
const DIFF_TOKEN_RE = /([a-zA-Z]+(?:['\u2019-][a-zA-Z]+)?|\d+(?:\.\d+)?|[\u4e00-\u9fff]|\s+|.)/g;
type DiffSegment = {
  text: string;
  variant: 'plain' | 'original' | 'corrected';
};

function isContentDiffToken(token: string): boolean {
  return /[a-zA-Z0-9\u4e00-\u9fff]/.test(token);
}

function tokenizeDiffText(text: string): string[] {
  return text.match(DIFF_TOKEN_RE) || [];
}

function buildCorrectedDiffSegments(original: string, corrected: string): DiffSegment[] {
  const source = tokenizeDiffText(original);
  const target = tokenizeDiffText(corrected);
  const n = source.length;
  const m = target.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));

  for (let i = 0; i <= n; i++) {
    dp[i][0] = i;
  }

  for (let j = 0; j <= m; j++) {
    dp[0][j] = j;
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (source[i - 1] === target[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + 1,
        );
      }
    }
  }

  const reversedSegments: DiffSegment[] = [];

  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && source[i - 1] === target[j - 1] && dp[i][j] === dp[i - 1][j - 1]) {
      reversedSegments.push({ text: target[j - 1], variant: 'plain' });
      i--;
      j--;
      continue;
    }

    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      const sourceToken = source[i - 1];
      const targetToken = target[j - 1];

      if (isContentDiffToken(targetToken)) {
        reversedSegments.push({ text: targetToken, variant: 'corrected' });
      } else {
        reversedSegments.push({ text: targetToken, variant: 'plain' });
      }

      if (isContentDiffToken(sourceToken)) {
        reversedSegments.push({ text: sourceToken, variant: 'original' });
      }

      i--;
      j--;
      continue;
    }

    if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      const sourceToken = source[i - 1];
      if (isContentDiffToken(sourceToken)) {
        reversedSegments.push({ text: sourceToken, variant: 'original' });
      }
      i--;
      continue;
    }

    if (j > 0 && dp[i][j] === dp[i][j - 1] + 1) {
      const targetToken = target[j - 1];
      if (isContentDiffToken(targetToken)) {
        reversedSegments.push({ text: targetToken, variant: 'corrected' });
      } else {
        reversedSegments.push({ text: targetToken, variant: 'plain' });
      }
      j--;
      continue;
    }
  }

  const segments: DiffSegment[] = [];
  for (const segment of reversedSegments.reverse()) {
    const prev = segments[segments.length - 1];
    if (prev && prev.variant === segment.variant) {
      prev.text += segment.text;
    } else {
      segments.push({ ...segment });
    }
  }

  return segments;
}

function getCorrectedSegmentClassName(variant: DiffSegment['variant']) {
  if (variant === 'original') {
    return 'text-zinc-500/80 line-through decoration-zinc-500/90';
  }

  if (variant === 'corrected') {
    return 'text-sky-300/95 font-medium';
  }

  return undefined;
}

function RespellingText({
  pronunciation,
  parenthesized,
}: {
  pronunciation: PronunciationResult;
  parenthesized: boolean;
}) {
  if (!pronunciation.respelling) return null;

  const chunks = pronunciation.respelling.split('·');
  const stressIndex = Number.isInteger(pronunciation.stressIndex)
    ? pronunciation.stressIndex!
    : null;

  return (
    <span className={parenthesized ? 'inline-respelling' : 'inline-respelling inline-respelling-simple'}>
      {parenthesized ? '(' : null}
      {chunks.map((chunk, index) => (
        <React.Fragment key={`${chunk}-${index}`}>
          {index > 0 ? <span className="respelling-divider">·</span> : null}
          <span className={stressIndex === index ? 'respelling-stress' : undefined}>{chunk}</span>
        </React.Fragment>
      ))}
      {parenthesized ? ')' : null}
    </span>
  );
}

function ClickableText({
  text,
  className,
  autoPronounce = false,
  showIpa = true,
  maxAutoPronunciations = 4,
  autoPronunciationSeen,
}: {
  text: string;
  className?: string;
  autoPronounce?: boolean;
  showIpa?: boolean;
  maxAutoPronunciations?: number;
  autoPronunciationSeen?: Set<string>;
}) {
  const [expanded, setExpanded] = useState<Record<string, PronunciationResult & { loading?: boolean }>>({});
  const autoRequestedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setExpanded({});
    autoRequestedRef.current.clear();
  }, [text]);

  const parts = useMemo(() => text.split(WORD_SPLIT_RE), [text]);

  useEffect(() => {
    if (!autoPronounce) return;

    const candidateKeys = new Set(extractPronunciationCandidates(text, maxAutoPronunciations));
    if (candidateKeys.size === 0) return;

    let cancelled = false;
    const seenLookupKeys = autoPronunciationSeen || new Set<string>();
    const scheduledLookupKeys = new Set<string>();

    parts.forEach((part, i) => {
      if (!ENGLISH_WORD_RE.test(part) || part.length < 2) return;
      const lookupKey = normalizePronunciationLookupKey(part);
      if (!candidateKeys.has(lookupKey) || seenLookupKeys.has(lookupKey)) return;

      seenLookupKeys.add(lookupKey);
      scheduledLookupKeys.add(lookupKey);
      const displayKey = `${lookupKey}__${i}`;
      if (autoRequestedRef.current.has(displayKey)) return;

      autoRequestedRef.current.add(displayKey);
      void lookupPronunciationHint(part).then((pronunciation) => {
        if (cancelled || (!pronunciation.ipa && !pronunciation.respelling)) return;
        setExpanded((prev) => {
          if (prev[displayKey]) return prev;
          return {
            ...prev,
            [displayKey]: {
              ...pronunciation,
              loading: false,
            },
          };
        });
      });
    });

    return () => {
      cancelled = true;
      scheduledLookupKeys.forEach((key) => seenLookupKeys.delete(key));
    };
  }, [autoPronounce, autoPronunciationSeen, maxAutoPronunciations, parts, text]);

  const handleWordClick = useCallback(async (word: string, key: string, event: React.MouseEvent) => {
    if (word.length < 2) return;
    event.stopPropagation();

    const existing = expanded[key];
    if (existing?.audioUrl && !existing.loading) {
      void playPronunciationAudio(existing.audioUrl);
      return;
    }

    setExpanded((prev) => ({
      ...prev,
      [key]: {
        ipa: existing?.ipa ?? null,
        respelling: existing?.respelling ?? null,
        stressIndex: existing?.stressIndex ?? null,
        loading: true,
      },
    }));
    const pronunciation = await lookupPronunciation(word);
    void playPronunciationAudio(pronunciation.audioUrl);
    setExpanded((prev) => ({
      ...prev,
      [key]: {
        ...pronunciation,
        loading: false,
      },
    }));
  }, [expanded]);

  return (
    <span>
      {parts.map((part, i) => {
        if (ENGLISH_WORD_RE.test(part) && part.length >= 2) {
          const key = `${normalizePronunciationLookupKey(part)}__${i}`;
          const inline = expanded[key] || null;
          return (
            <span key={i} className="inline-pronunciation-cluster">
              <span
                className={className ? `ipa-word ${className}` : 'ipa-word'}
                onClick={(e) => {
                  void handleWordClick(part, key, e);
                }}
              >
                {part}
              </span>
              {inline?.loading ? (
                <Loader2 className="inline w-3 h-3 animate-spin text-blue-400/70 align-middle" />
              ) : inline?.ipa || inline?.respelling || inline?.audioUrl ? (
                <span className="inline-pronunciation-tail">
                  {inline?.audioUrl ? <Volume2 className="inline w-3 h-3 text-emerald-300/80 align-middle" /> : null}
                  {inline?.respelling ? (
                    <RespellingText pronunciation={inline} parenthesized={showIpa} />
                  ) : null}
                  {showIpa && inline?.ipa ? <span className="inline-ipa">{inline.ipa}</span> : null}
                </span>
              ) : null}
            </span>
          );
        }
        return <span key={i} className={className}>{part}</span>;
      })}
    </span>
  );
}

const MessageItem = memo(({
  msg,
  compact = false,
  autoPronounce = false,
  showIpa = true,
}: {
  msg: Message;
  compact?: boolean;
  autoPronounce?: boolean;
  showIpa?: boolean;
}) => {
  const isFinal = !msg.isTranslating;
  const showCorrected = isFinal && Boolean(msg.corrected && msg.corrected.trim() && msg.corrected !== msg.original);
  const correctedSegments = useMemo(
    () => showCorrected ? buildCorrectedDiffSegments(msg.original, msg.corrected!) : [],
    [msg.corrected, msg.original, showCorrected],
  );
  const originalClassName = compact
    ? 'whitespace-pre-line text-zinc-500 text-[14px] leading-[1.5]'
    : 'whitespace-pre-line text-zinc-300/92 text-[14px] leading-[1.8]';
  const translationClassName = compact
    ? 'whitespace-pre-line text-zinc-100 text-[16px] leading-[1.5] mt-1'
    : 'whitespace-pre-line text-zinc-50 text-[16px] leading-[1.8] mt-1';
  const autoPronunciationSeen = useMemo(
    () => new Set<string>(),
    [msg.corrected, msg.original, msg.translated],
  );

  return (
    <div className={compact ? 'py-2' : 'py-3'}>
      <div className={originalClassName}>
        {showCorrected
          ? correctedSegments.map((segment, idx) => (
              <React.Fragment key={idx}>
                <ClickableText
                  text={segment.text}
                  className={getCorrectedSegmentClassName(segment.variant)}
                  autoPronounce={autoPronounce}
                  showIpa={showIpa}
                  autoPronunciationSeen={autoPronunciationSeen}
                />
              </React.Fragment>
            ))
          : isFinal ? (
              <ClickableText
                text={msg.original}
                autoPronounce={autoPronounce}
                showIpa={showIpa}
                autoPronunciationSeen={autoPronunciationSeen}
              />
            ) : msg.original}
      </div>
      {(msg.translated || msg.isTranslating) && (
        <div className={translationClassName}>
          {msg.translated ? isFinal ? (
            <ClickableText
              text={msg.translated}
              autoPronounce={autoPronounce}
              showIpa={showIpa}
              autoPronunciationSeen={autoPronunciationSeen}
            />
          ) : msg.translated : null}
          {msg.isTranslating && !msg.translated && <span className="text-zinc-600 text-[14px]">翻译中...</span>}
          {msg.isTranslating && <Loader2 className="inline w-3.5 h-3.5 ml-1.5 animate-spin text-blue-400/60 align-middle" />}
        </div>
      )}
    </div>
  );
});

export const TranslationPanel = memo(function TranslationPanel({
  title,
  messages,
  liveText,
  isListening,
  compact = false,
  autoPronounce = false,
  showIpa = true,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUp = useRef(false);
  const messageScrollKey = useMemo(() => {
    const last = messages[messages.length - 1];
    return last ? `${messages.length}:${last.id}:${last.isTranslating ? 'draft' : 'final'}` : '0';
  }, [messages]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    isUserScrolledUp.current = !atBottom;
  }, []);

  useLayoutEffect(() => {
    if (isUserScrolledUp.current) return;
    bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [messageScrollKey]);

  useLayoutEffect(() => {
    if (isUserScrolledUp.current || !liveText) return;
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [liveText]);

  useEffect(() => {
    const content = contentRef.current;
    const scrollContainer = scrollRef.current;
    if (!content || !scrollContainer || typeof ResizeObserver === 'undefined') return;

    const resizeObserver = new ResizeObserver(() => {
      if (isUserScrolledUp.current) return;
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    });

    resizeObserver.observe(content);
    return () => resizeObserver.disconnect();
  }, []);

  return (
    <div className={compact
      ? 'flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-white/[0.035] bg-[#09090c]'
      : 'flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-white/[0.06] bg-[#121218]'
    }>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={compact
          ? 'min-h-0 flex-1 overflow-y-auto px-3 py-2 custom-scrollbar'
          : 'min-h-0 flex-1 overflow-y-auto px-5 py-4 custom-scrollbar'
        }
        style={{ overflowAnchor: 'none' }}
      >
        <div ref={contentRef} className="flex min-h-full flex-col">
          <div className="divide-y divide-white/[0.04]">
            {messages.map((msg) => (
              <MessageItem
                key={msg.id}
                msg={msg}
                compact={compact}
                autoPronounce={autoPronounce}
                showIpa={showIpa}
              />
            ))}
          </div>

          {liveText && (
            <div className={compact ? 'py-2 border-t border-white/[0.04]' : 'py-3 border-t border-white/[0.04]'}>
              <div className={compact
                ? 'whitespace-pre-line text-zinc-500 text-[14px] leading-[1.5]'
                : 'whitespace-pre-line text-zinc-500 text-[14px] leading-[1.8]'
              }>
                <ClickableText text={liveText} autoPronounce={autoPronounce} showIpa={showIpa} />
                <span className="inline-block w-[2px] h-4 bg-blue-400/50 ml-0.5 align-middle animate-pulse"></span>
              </div>
            </div>
          )}

          {messages.length === 0 && !liveText && (
            <div className={compact
              ? 'flex flex-1 items-center justify-center text-zinc-700 text-[12px]'
              : 'flex flex-1 items-center justify-center text-zinc-600 text-[14px]'
            }>
              {isListening ? '正在聆听...' : '点击开始以启动实时转录和翻译'}
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
});
