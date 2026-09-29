import type { Settings } from '@techie-mind/config';
import type { Language, TaskResult } from '@techie-mind/contracts';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

/**
 * Voice input and spoken replies (spec §44): STT → the same agent pipeline as typed text → TTS.
 *
 * - Local Whisper (default): the side panel records with MediaRecorder and posts the audio to a
 *   whisper.cpp server on a loopback address. Audio never leaves this machine.
 * - Chrome Web Speech: only after the user agreed in Settings that Google receives the audio.
 * - Replies are spoken with the browser's speech synthesis (on-device voices where available).
 */

/** Languages the composer's language button cycles through. */
export const VOICE_LANGUAGES: ReadonlyArray<{ id: Language; label: string; bcp47: string }> = [
  { id: 'en', label: 'EN', bcp47: 'en-IN' },
  { id: 'hi', label: 'HI', bcp47: 'hi-IN' },
  { id: 'kn', label: 'KN', bcp47: 'kn-IN' },
  { id: 'ta', label: 'TA', bcp47: 'ta-IN' },
  { id: 'te', label: 'TE', bcp47: 'te-IN' },
];

export function bcp47(language: Language): string {
  switch (language) {
    case 'hi':
    case 'hinglish':
      return 'hi-IN';
    case 'kn':
    case 'mixed':
      return 'kn-IN';
    case 'ta':
      return 'ta-IN';
    case 'te':
      return 'te-IN';
    default:
      return 'en-IN';
  }
}

/** Whisper takes ISO-639-1 codes. */
function whisperLanguage(language: Language): string {
  return bcp47(language).slice(0, 2);
}

/** Longest recording before it is sent automatically. */
const MAX_RECORDING_MS = 12_000;

export type VoicePhase = 'idle' | 'listening' | 'transcribing';

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

function speechRecognition(): (new () => SpeechRecognitionLike) | null {
  const w = globalThis as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const MIC_BLOCKED =
  'Microphone access is not allowed yet. Open Settings → AI Models → Voice & Audio and press "Allow microphone" once.';

/**
 * Hook for the composer's mic button. `onText` receives the recognized words, which then run
 * exactly like a typed request (same plan preview, firewall and verification).
 */
export function useVoiceInput(settings: Settings, onText: (text: string) => void) {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const language = settings.language.preferredInputLanguage;

  useEffect(() => () => stopRef.current?.(), []);

  const startWebSpeech = useCallback(() => {
    const Recognition = speechRecognition();
    if (!Recognition) {
      setError('This browser has no Web Speech recognition. Use local Whisper in Settings.');
      return;
    }
    const rec = new Recognition();
    rec.lang = bcp47(language);
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    let heard = '';
    rec.onresult = (event) => {
      heard = Array.from(event.results)
        .map((r) => r[0]?.transcript ?? '')
        .join(' ')
        .trim();
    };
    rec.onerror = (event) => {
      setError(
        event.error === 'not-allowed' || event.error === 'service-not-allowed'
          ? MIC_BLOCKED
          : event.error === 'no-speech'
            ? 'I did not hear anything. Press the mic and speak.'
            : `Speech recognition failed (${event.error}).`,
      );
    };
    rec.onend = () => {
      stopRef.current = null;
      setPhase('idle');
      if (heard) onText(heard);
    };
    stopRef.current = () => rec.stop();
    setPhase('listening');
    rec.start();
  }, [language, onText]);

  const startWhisper = useCallback(async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError(MIC_BLOCKED);
      return;
    }
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const timer = setTimeout(() => recorder.state === 'recording' && recorder.stop(), MAX_RECORDING_MS);
    recorder.onstop = () => {
      clearTimeout(timer);
      stream.getTracks().forEach((t) => t.stop());
      stopRef.current = null;
      setPhase('transcribing');
      const audio = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      void transcribeLocally(settings.voice.localSttUrl, audio, whisperLanguage(language)).then(
        (text) => {
          setPhase('idle');
          if (text) onText(text);
          else setError('I did not catch that. Press the mic and speak again.');
        },
        (e: unknown) => {
          setPhase('idle');
          setError(
            `Local speech recognition is not reachable at ${settings.voice.localSttUrl} (${e instanceof Error ? e.message : 'error'}). Start whisper.cpp's server (see docs/VOICE.md) or choose another engine in Settings.`,
          );
        },
      );
    };
    stopRef.current = () => recorder.state === 'recording' && recorder.stop();
    setPhase('listening');
    recorder.start();
  }, [language, onText, settings.voice.localSttUrl]);

  /** Mic button: start listening, or finish the current recording. */
  const toggle = useCallback(() => {
    setError(null);
    if (phase === 'listening') {
      stopRef.current?.();
      return;
    }
    if (phase === 'transcribing') return;
    if (settings.voice.sttEngine === 'web-speech') {
      if (!settings.voice.webSpeechConsent) {
        setError(
          'Chrome speech recognition sends your audio to Google. Agree to that in Settings → Voice & Audio, or use local Whisper.',
        );
        return;
      }
      startWebSpeech();
    } else {
      void startWhisper();
    }
  }, [phase, settings.voice, startWebSpeech, startWhisper]);

  return { phase, error, toggle, clearError: () => setError(null) };
}

/** POST the recording to whisper.cpp's server (`/inference`) on this machine. */
async function transcribeLocally(url: string, audio: Blob, language: string): Promise<string> {
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    throw new Error('not a loopback address');
  }
  const form = new FormData();
  form.append('file', audio, 'speech.webm');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  form.append('language', language);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { method: 'POST', body: form, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { text?: unknown };
    return typeof body.text === 'string'
      ? body.text
          .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      : '';
  } finally {
    clearTimeout(timer);
  }
}

// ── spoken replies ─────────────────────────────────────────────────────────────────────────────

const PHRASES: Record<string, { done: string; needs: string; failed: string; paused: string }> = {
  'en-IN': { done: 'Done.', needs: 'I need you.', failed: 'I could not finish.', paused: 'Paused.' },
  'hi-IN': {
    done: 'हो गया।',
    needs: 'मुझे आपकी ज़रूरत है।',
    failed: 'मैं पूरा नहीं कर पाया।',
    paused: 'रोका गया।',
  },
  'kn-IN': {
    done: 'ಆಯ್ತು.',
    needs: 'ನಿಮ್ಮ ಸಹಾಯ ಬೇಕು.',
    failed: 'ಪೂರ್ಣಗೊಳಿಸಲು ಆಗಲಿಲ್ಲ.',
    paused: 'ನಿಲ್ಲಿಸಲಾಗಿದೆ.',
  },
  'ta-IN': {
    done: 'முடிந்தது.',
    needs: 'உங்கள் உதவி தேவை.',
    failed: 'முடிக்க முடியவில்லை.',
    paused: 'இடைநிறுத்தப்பட்டது.',
  },
  'te-IN': {
    done: 'పూర్తయింది.',
    needs: 'మీ సహాయం కావాలి.',
    failed: 'పూర్తి చేయలేకపోయాను.',
    paused: 'ఆపబడింది.',
  },
};

/** A short spoken line: status in the user's language, then the essential detail. */
export function spokenSummary(result: TaskResult): { text: string; lang: string } {
  const lang = bcp47(result.intent?.language ?? 'en');
  const p = PHRASES[lang] ?? PHRASES['en-IN']!;
  const detail = (() => {
    if (result.status === 'COMPLETED') {
      const out = result.output;
      if (!out) return '';
      if (out.kind === 'text') return out.text.slice(0, 280);
      if (out.kind === 'items') return `${out.items.length} results.`;
      return out.entries.slice(0, 3).join('. ');
    }
    if (result.handover) return result.handover.userAction;
    return result.error?.message.slice(0, 200) ?? '';
  })();
  const head =
    result.status === 'COMPLETED'
      ? p.done
      : result.status === 'PAUSED'
        ? p.paused
        : result.status === 'HUMAN_REQUIRED'
          ? p.needs
          : p.failed;
  return { text: `${head} ${detail}`.trim(), lang };
}

const FEMALE_VOICE = /female|woman|lekha|veena|heera|kalpana|swara|neerja|sangeeta/i;
const MALE_VOICE = /\bmale\b|\bman\b|rishi|hemant|prabhat|madhur/i;

function pickVoice(lang: string, persona: Settings['voice']['voicePersona']) {
  const voices = globalThis.speechSynthesis?.getVoices() ?? [];
  const matching = voices.filter((v) => v.lang.replace('_', '-').startsWith(lang.slice(0, 2)));
  if (matching.length === 0) return null;
  const byPersona =
    persona === 'female-natural'
      ? matching.find((v) => FEMALE_VOICE.test(v.name))
      : persona === 'male-natural'
        ? matching.find((v) => MALE_VOICE.test(v.name) && !FEMALE_VOICE.test(v.name))
        : undefined;
  return (
    byPersona ?? matching.find((v) => v.lang.replace('_', '-') === lang) ?? matching[0] ?? null
  );
}

/** Speak the task's outcome (Settings → Voice: "Speak concise summaries"). */
export function speakResult(result: TaskResult, persona: Settings['voice']['voicePersona']): void {
  const synth = globalThis.speechSynthesis;
  if (!synth) return;
  const { text, lang } = spokenSummary(result);
  if (!text) return;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = pickVoice(lang, persona);
  utterance.lang = voice?.lang ?? lang;
  if (voice) utterance.voice = voice;
  synth.speak(utterance);
}
