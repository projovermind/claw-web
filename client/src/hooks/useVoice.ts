/**
 * Web Speech API 기반 음성 입출력 훅 (완전 무료, 서버 수정 불필요).
 *
 * - STT: SpeechRecognition (Chrome/Edge/Safari 지원)
 * - TTS: SpeechSynthesis (모든 주요 브라우저 지원)
 *
 * 사용 예:
 *   const voice = useVoice('ko-KR');
 *   voice.toggleListening((text) => setInput(text));   // 🎤 토글
 *   voice.speak('안녕하세요');                           // 🔊 읽기
 *   voice.stopSpeaking();                              // 중단
 */
import { useCallback, useEffect, useRef, useState } from 'react';

// Web Speech API 타입 (브라우저 벤더 prefix 대응)
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }>;
}

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useVoice(lang = 'ko-KR') {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [supported] = useState(() => getRecognitionCtor() !== null);
  const recogRef = useRef<SpeechRecognitionLike | null>(null);
  const onFinalRef = useRef<((text: string) => void) | null>(null);
  // 연속 재생을 위한 취소 요청 플래그
  const speakCancelledRef = useRef(false);

  // 사용 가능한 TTS 목소리 목록 (브라우저에 따라 비동기 로드됨 — voiceschanged 이벤트 구독)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const update = () => {
      const list = synth.getVoices();
      voicesRef.current = list;
      setVoices(list);
    };
    update();
    synth.addEventListener?.('voiceschanged', update);
    return () => synth.removeEventListener?.('voiceschanged', update);
  }, []);

  // unmount 시 정리
  useEffect(() => {
    return () => {
      recogRef.current?.abort();
      window.speechSynthesis?.cancel();
    };
  }, []);

  const startListening = useCallback((onFinal: (text: string) => void) => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return false;
    const r = new Ctor();
    r.lang = lang;
    r.continuous = false;
    r.interimResults = false;
    onFinalRef.current = onFinal;
    r.onresult = (e) => {
      const last = e.results[e.results.length - 1];
      if (last && last.isFinal) {
        const text = last[0]?.transcript ?? '';
        onFinalRef.current?.(text.trim());
      }
    };
    r.onerror = () => setListening(false);
    r.onend = () => setListening(false);
    recogRef.current = r;
    try {
      r.start();
      setListening(true);
      return true;
    } catch {
      setListening(false);
      return false;
    }
  }, [lang]);

  const stopListening = useCallback(() => {
    recogRef.current?.stop();
    setListening(false);
  }, []);

  const toggleListening = useCallback((onFinal: (text: string) => void) => {
    if (listening) stopListening();
    else startListening(onFinal);
  }, [listening, startListening, stopListening]);

  // 짧은 텍스트는 한 번에 — 문장 교체 시 발생하는 gap 을 피한다.
  // 긴 텍스트만 문장 단위로 묶어 ~220자 chunk 로 분할 (Chrome 긴 발화 버그 우회).
  const splitSentences = (text: string): string[] => {
    if (text.length <= 220) return [text];
    const parts = text.match(/[^.!?。！？\n]+[.!?。！？]?/g) ?? [text];
    const chunks: string[] = [];
    let buf = '';
    for (const p of parts) {
      const t = p.trim();
      if (!t) continue;
      if (!buf) { buf = t; continue; }
      if ((buf + ' ' + t).length <= 220) buf = buf + ' ' + t;
      else { chunks.push(buf); buf = t; }
    }
    if (buf) chunks.push(buf);
    return chunks;
  };

  const speak = useCallback((text: string, onEnd?: () => void) => {
    if (!text || !window.speechSynthesis) { onEnd?.(); return; }
    const synth = window.speechSynthesis;
    // 기존 큐가 있을 때만 cancel — 빈 상태에서 cancel() 호출 시 Chrome 엔진이
    // 일시적으로 choppy 상태에 빠지는 버그 회피.
    if (synth.speaking || synth.pending) synth.cancel();
    speakCancelledRef.current = false;

    const chunks = splitSentences(text);
    if (chunks.length === 0) { onEnd?.(); return; }

    // 설정(localStorage) 읽어서 적용 — 매 speak 마다 최신값 반영
    const savedVoiceURI = (() => {
      try { return localStorage.getItem('voice:voiceURI') || ''; } catch { return ''; }
    })();
    const savedRate = (() => {
      try { return parseFloat(localStorage.getItem('voice:rate') || '1') || 1; } catch { return 1; }
    })();
    const savedPitch = (() => {
      try { return parseFloat(localStorage.getItem('voice:pitch') || '1') || 1; } catch { return 1; }
    })();
    const selectedVoice = savedVoiceURI
      ? voicesRef.current.find((v) => v.voiceURI === savedVoiceURI) ?? null
      : null;

    setSpeaking(true);
    let i = 0;
    const cleanup = () => setSpeaking(false);
    const speakNext = () => {
      if (speakCancelledRef.current) { cleanup(); onEnd?.(); return; }
      if (i >= chunks.length) { cleanup(); onEnd?.(); return; }
      const u = new SpeechSynthesisUtterance(chunks[i++]);
      u.lang = selectedVoice?.lang ?? lang;
      if (selectedVoice) u.voice = selectedVoice;
      u.rate = Math.max(0.5, Math.min(2, savedRate));
      u.pitch = Math.max(0, Math.min(2, savedPitch));
      u.onend = () => speakNext();
      u.onerror = () => speakNext();
      synth.speak(u);
    };
    speakNext();
  }, [lang]);

  const stopSpeaking = useCallback(() => {
    speakCancelledRef.current = true;
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }, []);

  return {
    supported,
    listening,
    speaking,
    voices,
    startListening,
    stopListening,
    toggleListening,
    speak,
    stopSpeaking,
  };
}
