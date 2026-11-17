import { useCallback, useEffect, useRef, useState } from 'react';
import { triggerCausalHaptic } from '../utils/applePhysics';

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
  length: number;
}

interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
}

interface SpeechRecognitionInstance extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

/**
 * Subtle, non-intrusive causal earcon synchronized with mic start/stop (SKILL.md §13).
 */
function playMicroChime(kind: 'start' | 'end'): void {
  if (typeof window === 'undefined') return;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    const now = ctx.currentTime;
    if (kind === 'start') {
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.exponentialRampToValueAtTime(740, now + 0.065);
    } else {
      osc.frequency.setValueAtTime(660, now);
      osc.frequency.exponentialRampToValueAtTime(480, now + 0.065);
    }
    gain.gain.setValueAtTime(0.035, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.085);
    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 150);
  } catch {
    // Ignore audio context restrictions
  }
}

export interface UseVoiceAgentOptions {
  voiceLang: 'en-US' | 'es-US';
  onInterimTranscript?: (text: string) => void;
  onFinalTranscript: (text: string) => void;
}

export function useVoiceAgent({
  voiceLang,
  onInterimTranscript,
  onFinalTranscript,
}: UseVoiceAgentOptions) {
  const [isSupported] = useState<boolean>(() => Boolean(getSpeechRecognitionCtor()));
  const [ttsSupported] = useState<boolean>(
    () => typeof window !== 'undefined' && 'speechSynthesis' in window
  );

  const [isListening, setIsListening] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const finalBufferRef = useRef<string>('');
  const submittedRef = useRef<boolean>(false);

  const cleanupAudioMeter = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    setMicLevel(0);
  }, []);

  const startAudioMeter = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.78;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteFrequencyData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i];
        const avg = sum / buf.length / 140;
        setMicLevel(Math.min(1, avg));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      // SpeechRecognition may still work even if separate meter stream fails
    }
  }, []);

  const stopSpeaking = useCallback(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setIsSpeaking(false);
    setSpeakingId(null);
  }, []);

  const speak = useCallback(
    (text: string, lang: 'en-US' | 'es-US' = 'en-US', messageId?: string) => {
      if (!ttsSupported || !text.trim()) return;
      window.speechSynthesis.cancel();

      const clean = text
        .replace(/[`*_#]/g, '')
        .replace(/\[Synthetic\]/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

      const utter = new SpeechSynthesisUtterance(clean);
      utter.lang = lang;
      utter.rate = 1.02;
      utter.pitch = 1.0;

      const voices = window.speechSynthesis.getVoices();
      const langPrefix = lang.slice(0, 2).toLowerCase();
      const preferred =
        voices.find(
          (v) =>
            v.lang.toLowerCase().startsWith(langPrefix) &&
            /(natural|samantha|ava|allison|paulina|mónica|monica|google)/i.test(
              v.name
            )
        ) || voices.find((v) => v.lang.toLowerCase().startsWith(langPrefix));
      if (preferred) utter.voice = preferred;

      utter.onstart = () => {
        setIsSpeaking(true);
        setSpeakingId(messageId ?? 'active');
      };
      utter.onend = () => {
        setIsSpeaking(false);
        setSpeakingId(null);
      };
      utter.onerror = () => {
        setIsSpeaking(false);
        setSpeakingId(null);
      };

      window.speechSynthesis.speak(utter);
    },
    [ttsSupported]
  );

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Ignore already stopped
      }
    }
    cleanupAudioMeter();
    setIsListening(false);
  }, [cleanupAudioMeter]);

  const startListening = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setVoiceError(
        'Browser speech recognition is unavailable here (use Chrome, Edge, or Safari).'
      );
      return;
    }

    // Barge-in interruption: cancel any active TTS immediately on the same frame (SKILL.md §3)
    stopSpeaking();
    setVoiceError(null);
    finalBufferRef.current = '';
    submittedRef.current = false;

    try {
      const rec = new Ctor();
      rec.lang = voiceLang;
      rec.continuous = false;
      rec.interimResults = true;

      rec.onresult = (event: SpeechRecognitionEventLike) => {
        let interim = '';
        let finalChunk = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i];
          if (res.isFinal) {
            finalChunk += res[0].transcript;
          } else {
            interim += res[0].transcript;
          }
        }
        if (finalChunk) {
          finalBufferRef.current = `${finalBufferRef.current} ${finalChunk}`.trim();
        }
        const combined = `${finalBufferRef.current} ${interim}`.trim();
        onInterimTranscript?.(combined);
      };

      rec.onerror = (event: SpeechRecognitionErrorEventLike) => {
        if (event.error === 'not-allowed') {
          setVoiceError('Microphone access was blocked. Allow mic permission in browser.');
        } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
          setVoiceError(`Voice error: ${event.error}`);
        }
        cleanupAudioMeter();
        setIsListening(false);
      };

      rec.onend = () => {
        cleanupAudioMeter();
        setIsListening(false);
        const committed = finalBufferRef.current.trim();
        if (committed && !submittedRef.current) {
          submittedRef.current = true;
          playMicroChime('end');
          triggerCausalHaptic(7);
          onFinalTranscript(committed);
        }
      };

      recognitionRef.current = rec;
      rec.start();
      setIsListening(true);
      playMicroChime('start');
      triggerCausalHaptic(8);
      startAudioMeter();
    } catch {
      setVoiceError('Could not start voice listener.');
      cleanupAudioMeter();
      setIsListening(false);
    }
  }, [
    cleanupAudioMeter,
    onFinalTranscript,
    onInterimTranscript,
    startAudioMeter,
    stopSpeaking,
    voiceLang,
  ]);

  const toggleListening = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      cleanupAudioMeter();
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, [cleanupAudioMeter]);

  return {
    isSupported,
    ttsSupported,
    isListening,
    micLevel,
    voiceError,
    isSpeaking,
    speakingId,
    startListening,
    stopListening,
    toggleListening,
    speak,
    stopSpeaking,
  };
}
