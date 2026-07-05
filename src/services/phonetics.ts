export type PronunciationResult = {
  ipa: string | null;
  respelling: string | null;
  stressIndex?: number | null;
  audioUrl?: string | null;
  source?: string;
  ipaSource?: string | null;
  audioSource?: string | null;
  confidence?: 'dictionary' | 'generated' | 'tts' | 'none';
  dictionaryPronunciation?: string | null;
};

const LOCAL_MEDICAL_RESPELLINGS: Record<string, PronunciationResult> = {
  acetaminophen: { ipa: null, respelling: 'uh-see-tuh-mi-nuh-fin' },
  albuterol: { ipa: null, respelling: 'al-byoo-tuh-rawl' },
  amoxicillin: { ipa: null, respelling: 'uh-mok-suh-sil-in' },
  appendectomy: { ipa: null, respelling: 'ap-en-dek-tuh-mee' },
  appendicitis: { ipa: null, respelling: 'uh-pen-duh-sai-tuhs' },
  arrhythmia: { ipa: null, respelling: 'uh-rith-mee-uh' },
  atorvastatin: { ipa: null, respelling: 'uh-tor-vuh-sta-tin' },
  azithromycin: { ipa: null, respelling: 'uh-zith-roh-mai-sin' },
  besylate: { ipa: '/ˈbɛsəˌleɪt/', respelling: 'bes-uh-late' },
  biopsy: { ipa: null, respelling: 'bai-op-see' },
  bradycardia: { ipa: null, respelling: 'bray-dee-kar-dee-uh' },
  bronchitis: { ipa: null, respelling: 'braang-kai-tuhs' },
  cholecystectomy: { ipa: null, respelling: 'koh-luh-sis-tek-tuh-mee' },
  cholecystitis: { ipa: null, respelling: 'koh-luh-sis-tai-tuhs' },
  clopidogrel: { ipa: null, respelling: 'kloh-pid-uh-grel' },
  colonoscopy: { ipa: null, respelling: 'koh-luh-nos-kuh-pee' },
  diverticulitis: { ipa: null, respelling: 'dai-ver-tik-yoo-lai-tuhs' },
  dyspnea: { ipa: null, respelling: 'disp-nee-uh' },
  echocardiogram: { ipa: null, respelling: 'ek-oh-kar-dee-oh-gram' },
  electrocardiogram: { ipa: null, respelling: 'ee-lek-troh-kar-dee-oh-gram' },
  endoscopy: { ipa: null, respelling: 'en-dos-kuh-pee' },
  esophagus: { ipa: null, respelling: 'ee-sof-uh-gus' },
  gabapentin: { ipa: null, respelling: 'gab-uh-pen-tin' },
  hemorrhoids: { ipa: null, respelling: 'hem-uh-roids' },
  hematuria: { ipa: null, respelling: 'hee-muh-toor-ee-uh' },
  hydrochlorothiazide: { ipa: null, respelling: 'hy-droh-klor-oh-thai-uh-zide' },
  hypertension: { ipa: null, respelling: 'hy-per-ten-shun' },
  hypothyroidism: { ipa: null, respelling: 'hy-poh-thai-royd-iz-um' },
  ibuprofen: { ipa: null, respelling: 'ai-byoo-proh-fen' },
  levothyroxine: { ipa: null, respelling: 'lee-voh-thai-rok-seen' },
  lisinopril: { ipa: null, respelling: 'lai-sin-oh-pril' },
  metformin: { ipa: null, respelling: 'met-for-min' },
  metoprolol: { ipa: null, respelling: 'meh-toh-proh-lol' },
  myocarditis: { ipa: null, respelling: 'mai-oh-kar-dai-tuhs' },
  omeprazole: { ipa: null, respelling: 'oh-mep-ruh-zole' },
  pancreatitis: { ipa: null, respelling: 'pan-kree-uh-tai-tuhs' },
  pneumonia: { ipa: null, respelling: 'noo-moh-nyuh' },
  prednisone: { ipa: null, respelling: 'pred-ni-zone' },
  rhinitis: { ipa: null, respelling: 'rai-nai-tuhs' },
  sinusitis: { ipa: null, respelling: 'sai-nuh-sai-tuhs' },
  tachycardia: { ipa: null, respelling: 'tak-ee-kar-dee-uh' },
  ultrasound: { ipa: null, respelling: 'ul-truh-sound' },
};

const MEDICAL_SUFFIXES = [
  'algia',
  'cele',
  'cardia',
  'cyte',
  'ectomy',
  'emia',
  'gram',
  'graphy',
  'itis',
  'lysis',
  'megaly',
  'oma',
  'opathy',
  'oscopy',
  'ostomy',
  'otomy',
  'penia',
  'phagia',
  'phasia',
  'plasty',
  'plegia',
  'pnea',
  'rrhea',
  'scopy',
  'sclerosis',
  'stenosis',
  'therapy',
  'uria',
];

const DRUG_SUFFIXES = [
  'afil',
  'azepam',
  'cillin',
  'cycline',
  'dipine',
  'floxacin',
  'mab',
  'mycin',
  'nib',
  'nidine',
  'olol',
  'oxetine',
  'pam',
  'prazole',
  'pril',
  'sartan',
  'semide',
  'statin',
  'sylate',
  'terol',
  'vir',
  'zepam',
];

const MEDICAL_PREFIXES = [
  'adeno',
  'arthro',
  'bronch',
  'cardio',
  'chole',
  'colo',
  'derm',
  'encephalo',
  'enter',
  'gastro',
  'gynec',
  'hemat',
  'hemo',
  'hepato',
  'hyster',
  'myo',
  'nephro',
  'neuro',
  'ophthalm',
  'oto',
  'osteo',
  'pneumo',
  'pulmo',
  'rhin',
  'splen',
  'uro',
];

const AUTO_MEDICAL_TERMS = new Set([
  // Diseases / conditions
  'asthma',
  'bronchitis',
  'diabetes',
  'emphysema',
  'epilepsy',
  'fibromyalgia',
  'hepatitis',
  'hypertension',
  'hypotension',
  'influenza',
  'leukemia',
  'lymphoma',
  'migraine',
  'pneumonia',
  'psoriasis',
  'sepsis',
  'sinusitis',
  'tuberculosis',

  // Anatomy / organs
  'abdomen',
  'adrenal',
  'appendix',
  'bladder',
  'bronchus',
  'cervix',
  'colon',
  'diaphragm',
  'duodenum',
  'esophagus',
  'gallbladder',
  'kidney',
  'larynx',
  'ligament',
  'pancreas',
  'pharynx',
  'prostate',
  'spleen',
  'thyroid',
  'trachea',
  'ureter',
  'urethra',

  // Tests / procedures
  'angiogram',
  'angioplasty',
  'biopsy',
  'colonoscopy',
  'endoscopy',
  'hysterectomy',
  'mammogram',
  'ultrasound',

  // Common drugs / medication terms that are easy to misread
  'albuterol',
  'amoxicillin',
  'atorvastatin',
  'azithromycin',
  'clopidogrel',
  'gabapentin',
  'hydrochlorothiazide',
  'ibuprofen',
  'levothyroxine',
  'lisinopril',
  'metformin',
  'metoprolol',
  'omeprazole',
  'prednisone',

  // Drug salt forms
  'acetate',
  'besylate',
  'citrate',
  'fumarate',
  'hydrochloride',
  'lactate',
  'maleate',
  'mesylate',
  'phosphate',
  'succinate',
  'sulfate',
  'tartrate',
  'tosylate',
]);

const AUTO_MEDICAL_EXCLUSIONS = new Set([
  'doctor',
  'doctors',
  'hospital',
  'medicine',
  'medicines',
  'medical',
  'medication',
  'medications',
  'nurse',
  'patient',
  'patients',
  'provider',
  'providers',
  'comfortable',
  'uncomfortable',
  'misconception',
  'traditional',
  'treatment',
  'treatments',
]);

const ENGLISH_WORD_RE = /[a-zA-Z]+(?:['\u2019-][a-zA-Z]+)*/g;

const GOOGLE_STYLE_CHUNK_OVERRIDES: Record<string, string> = {
  bye: 'bai',
  by: 'bai',
  dye: 'dai',
  eye: 'ai',
  kye: 'kai',
  lye: 'lai',
  my: 'mai',
  nye: 'nai',
  rye: 'rai',
  sy: 'sai',
  thye: 'thai',
  tye: 'tai',
};

const LOCAL_MEDICAL_STRESS_INDEX: Record<string, number> = {
  acetaminophen: 3,
  albuterol: 1,
  amoxicillin: 3,
  appendectomy: 2,
  appendicitis: 3,
  arrhythmia: 1,
  atorvastatin: 1,
  azithromycin: 3,
  besylate: 0,
  biopsy: 0,
  bradycardia: 2,
  bronchitis: 1,
  cholecystectomy: 3,
  cholecystitis: 3,
  clopidogrel: 1,
  colonoscopy: 2,
  diverticulitis: 4,
  dyspnea: 1,
  echocardiogram: 2,
  electrocardiogram: 3,
  endoscopy: 1,
  esophagus: 1,
  gabapentin: 2,
  hemorrhoids: 0,
  hematuria: 2,
  hydrochlorothiazide: 4,
  hypertension: 2,
  hypothyroidism: 2,
  ibuprofen: 2,
  levothyroxine: 3,
  lisinopril: 1,
  metformin: 1,
  metoprolol: 1,
  myocarditis: 3,
  omeprazole: 1,
  pancreatitis: 3,
  pneumonia: 1,
  prednisone: 0,
  rhinitis: 1,
  sinusitis: 2,
  tachycardia: 2,
  ultrasound: 0,
};

const pronunciationCache = new Map<string, PronunciationResult>();
const pendingRequests = new Map<string, Promise<PronunciationResult>>();
const pendingHintRequests = new Map<string, Promise<PronunciationResult>>();
const AUDIO_OUTPUT_STORAGE_KEY = 'mtp_pronunciation_output_device';
const MIN_PRONUNCIATION_AUDIO_VOLUME = 0.01;
const MAX_PRONUNCIATION_AUDIO_VOLUME = 0.05;

let pronunciationAudioOutputDeviceId = (() => {
  try {
    return localStorage.getItem(AUDIO_OUTPUT_STORAGE_KEY) || '';
  } catch {
    return '';
  }
})();
let pronunciationAudioVolume = MIN_PRONUNCIATION_AUDIO_VOLUME;
let activePronunciationAudio: HTMLAudioElement | null = null;

type SinkAudioElement = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

export function setPronunciationAudioOutputDeviceId(deviceId: string) {
  pronunciationAudioOutputDeviceId = deviceId;
  try {
    localStorage.setItem(AUDIO_OUTPUT_STORAGE_KEY, deviceId);
  } catch {}
}

export function setPronunciationAudioVolume(volume: number) {
  pronunciationAudioVolume = Math.min(
    MAX_PRONUNCIATION_AUDIO_VOLUME,
    Math.max(MIN_PRONUNCIATION_AUDIO_VOLUME, volume),
  );
}

export async function playPronunciationAudio(audioUrl: string | null | undefined) {
  if (!audioUrl) return;

  activePronunciationAudio?.pause();
  activePronunciationAudio = null;

  const audio = new Audio(audioUrl) as SinkAudioElement;
  audio.preload = 'auto';
  audio.volume = pronunciationAudioVolume;

  if (pronunciationAudioOutputDeviceId && typeof audio.setSinkId === 'function') {
    try {
      await audio.setSinkId(pronunciationAudioOutputDeviceId);
    } catch (error) {
      console.warn('Failed to route pronunciation audio to selected output:', error);
    }
  }

  activePronunciationAudio = audio;
  await audio.play();
}

function normalizeRespellingOutput(value: string | null): string | null {
  if (!value) return null;
  const normalized = value
    .replace(/[()]/g, ' ')
    .replace(/[^A-Za-z -]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*/g, '-')
    .trim();
  if (!normalized) return null;

  const chunks = normalized
    .split(/[-\s]+/)
    .map((chunk) => chunk.toLowerCase())
    .filter(Boolean)
    .map((chunk, index, all) => {
      const override = GOOGLE_STYLE_CHUNK_OVERRIDES[chunk];
      if (override) return override;
      if (chunk === 'tis' && index === all.length - 1) return 'tuhs';
      return chunk;
    });

  return chunks.join('·') || null;
}

function countIpaSyllableNuclei(value: string): number {
  const vowels = new Set([
    'a', 'e', 'i', 'o', 'u',
    'æ', 'ɑ', 'ɒ', 'ɔ', 'ə', 'ɛ', 'ɜ', 'ɞ', 'ɐ',
    'ɪ', 'ʊ', 'ʌ', 'ø', 'œ', 'ɶ', 'y', 'ʏ', 'ʉ',
    'ɨ', 'ɯ', 'ɤ', 'ɘ', 'ɵ', 'ɚ', 'ɝ',
  ]);
  let count = 0;
  let inVowelGroup = false;

  for (const char of value.toLowerCase().normalize('NFD')) {
    if (/[\u0300-\u036f]/.test(char) || char === 'ː' || char === 'ˑ') {
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
}

function deriveStressIndexFromIpa(ipa: string | null, respelling: string | null): number | null {
  if (!ipa) return null;

  const primaryStressIndex = ipa.indexOf('ˈ');
  if (primaryStressIndex < 0) return null;

  const candidate = countIpaSyllableNuclei(ipa.slice(0, primaryStressIndex));
  const syllableCount = respelling ? respelling.split('·').filter(Boolean).length : 0;
  if (syllableCount > 0 && candidate >= syllableCount) return null;
  return candidate;
}

export function normalizePronunciationLookupKey(word: string): string {
  return word
    .toLowerCase()
    .replace(/\u2019/g, "'")
    .replace(/'s$/i, '')
    .replace(/[^a-z -]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getLocalPronunciation(word: string): PronunciationResult | null {
  const key = normalizePronunciationLookupKey(word);
  const local = LOCAL_MEDICAL_RESPELLINGS[key];
  if (!local) return null;
  return {
    ipa: local.ipa,
    respelling: normalizeRespellingOutput(local.respelling),
    stressIndex: LOCAL_MEDICAL_STRESS_INDEX[key] ?? null,
  };
}

function stripAudio(pronunciation: PronunciationResult): PronunciationResult {
  return {
    ...pronunciation,
    audioUrl: null,
    audioSource: null,
  };
}

export function shouldAutoLookupPronunciation(word: string): boolean {
  const key = normalizePronunciationLookupKey(word);
  if (!key || key.length < 6) return false;
  if (AUTO_MEDICAL_EXCLUSIONS.has(key)) return false;
  if (LOCAL_MEDICAL_RESPELLINGS[key]) return true;
  if (AUTO_MEDICAL_TERMS.has(key)) return true;
  if (MEDICAL_SUFFIXES.some((suffix) => key.endsWith(suffix))) return true;
  if (DRUG_SUFFIXES.some((suffix) => key.endsWith(suffix))) return true;
  if (key.length >= 9 && MEDICAL_PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
  if (key.length >= 12 && /[aeiouy].*[aeiouy].*[aeiouy].*[aeiouy]/.test(key)) return true;
  return false;
}

export function extractPronunciationCandidates(text: string, limit = 6): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  const matches = text.match(ENGLISH_WORD_RE) || [];

  for (const match of matches) {
    const key = normalizePronunciationLookupKey(match);
    if (!key || seen.has(key) || !shouldAutoLookupPronunciation(key)) continue;
    seen.add(key);
    candidates.push(key);
    if (candidates.length >= limit) break;
  }

  return candidates;
}

export async function lookupPronunciation(word: string): Promise<PronunciationResult> {
  const key = normalizePronunciationLookupKey(word);
  if (!key || key.length < 2) {
    return { ipa: null, respelling: null };
  }

  const local = getLocalPronunciation(key);
  const cached = pronunciationCache.get(key);
  if (cached?.audioUrl) {
    return cached;
  }

  if (pendingRequests.has(key)) {
    return pendingRequests.get(key)!;
  }

  const request = (async () => {
    try {
      const resp = await fetch('/api/pronunciation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: key }),
      });
      if (!resp.ok) {
        return local || { ipa: null, respelling: null };
      }
      const data = await resp.json();
      const ipa = typeof data?.ipa === 'string' ? data.ipa : null;
      const respelling =
        normalizeRespellingOutput(typeof data?.respelling === 'string' ? data.respelling : null) ||
        local?.respelling ||
        null;
      const stressIndex =
        typeof data?.stressIndex === 'number'
          ? data.stressIndex
          : deriveStressIndexFromIpa(ipa, respelling) ?? local?.stressIndex ?? null;
      const result: PronunciationResult = {
        ipa,
        respelling,
        stressIndex,
        audioUrl: typeof data?.audioUrl === 'string' ? data.audioUrl : null,
        source: typeof data?.source === 'string' ? data.source : undefined,
        ipaSource: typeof data?.ipaSource === 'string' ? data.ipaSource : null,
        audioSource: typeof data?.audioSource === 'string' ? data.audioSource : null,
        confidence: data?.confidence || undefined,
        dictionaryPronunciation:
          typeof data?.dictionaryPronunciation === 'string' ? data.dictionaryPronunciation : null,
      };
      if (result.ipa || result.respelling || result.audioUrl) {
        pronunciationCache.set(key, result);
      }
      return result;
    } catch {
      return local || { ipa: null, respelling: null };
    } finally {
      pendingRequests.delete(key);
    }
  })();

  pendingRequests.set(key, request);
  return request;
}

export async function lookupPronunciationHint(word: string): Promise<PronunciationResult> {
  const key = normalizePronunciationLookupKey(word);
  if (!key || key.length < 2) {
    return { ipa: null, respelling: null };
  }

  const local = getLocalPronunciation(key);
  if (local?.respelling || local?.ipa) {
    pronunciationCache.set(key, stripAudio(local));
    return stripAudio(local);
  }

  const cached = pronunciationCache.get(key);
  if (cached?.ipa || cached?.respelling) {
    return stripAudio(cached);
  }

  if (pendingHintRequests.has(key)) {
    return pendingHintRequests.get(key)!;
  }

  const request = (async () => {
    try {
      const resp = await fetch('/api/pronunciation-hint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: key }),
      });
      if (!resp.ok) {
        return { ipa: null, respelling: null };
      }
      const data = await resp.json();
      const ipa = typeof data?.ipa === 'string' ? data.ipa : null;
      const respelling = normalizeRespellingOutput(typeof data?.respelling === 'string' ? data.respelling : null);
      const result: PronunciationResult = stripAudio({
        ipa,
        respelling,
        stressIndex:
          typeof data?.stressIndex === 'number'
            ? data.stressIndex
            : deriveStressIndexFromIpa(ipa, respelling),
        source: typeof data?.source === 'string' ? data.source : undefined,
        ipaSource: typeof data?.ipaSource === 'string' ? data.ipaSource : null,
        confidence: data?.confidence || undefined,
        dictionaryPronunciation:
          typeof data?.dictionaryPronunciation === 'string' ? data.dictionaryPronunciation : null,
      });
      if (result.ipa || result.respelling) {
        pronunciationCache.set(key, result);
      }
      return result;
    } catch {
      return { ipa: null, respelling: null };
    } finally {
      pendingHintRequests.delete(key);
    }
  })();

  pendingHintRequests.set(key, request);
  return request;
}

export async function lookupIPA(word: string): Promise<string | null> {
  const result = await lookupPronunciation(word);
  return result.ipa;
}
