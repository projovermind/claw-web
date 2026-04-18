/**
 * 알림음 — Web Audio API 로 짧은 사인파 beep 생성 (외부 파일 불필요).
 *
 * 사용: playDing()  — 응답 완료 시 등
 */
let sharedCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    if (!sharedCtx) {
      const C = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
      if (!C) return null;
      sharedCtx = new C();
    }
    // 일부 브라우저에선 사용자 상호작용 후 suspended → resume
    if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => {});
    return sharedCtx;
  } catch {
    return null;
  }
}

/** iPhone Tri-tone 스타일 메시지 알림 — C6 → E6 → G6 상행 arpeggio.
 *  각 음이 짧게 분리되고 마지막만 여운. 마림바 비슷한 tone 을 위해 sine +
 *  약한 triangle harmonic 을 섞음.
 */
export function playDing(volume = 0.2) {
  const ctx = getCtx();
  if (!ctx) return;
  const vol = Math.max(0.01, Math.min(1, volume));
  try {
    // C6 (1046.5) → E6 (1318.5) → G6 (1568.0) 빠른 상행
    const notes = [
      { freq: 1046.5, start: 0,    dur: 0.14, isLast: false },
      { freq: 1318.5, start: 0.09, dur: 0.14, isLast: false },
      { freq: 1568.0, start: 0.18, dur: 0.55, isLast: true  }
    ];
    notes.forEach((note) => {
      const t0 = ctx.currentTime + note.start;
      // 기본 sine + 살짝 triangle (마림바 느낌)
      const oscSine = ctx.createOscillator();
      const oscTri  = ctx.createOscillator();
      oscSine.type = 'sine';
      oscTri.type  = 'triangle';
      oscSine.frequency.setValueAtTime(note.freq, t0);
      oscTri.frequency.setValueAtTime(note.freq * 2, t0); // 옥타브 위 harmonic

      const gain = ctx.createGain();
      // 타악기 percussive 엔벨로프: 즉시 attack + exponential decay
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + note.dur);

      // triangle 은 더 약하게 섞음
      const triGain = ctx.createGain();
      triGain.gain.value = 0.15;

      oscSine.connect(gain);
      oscTri.connect(triGain).connect(gain);
      gain.connect(ctx.destination);

      oscSine.start(t0);
      oscTri.start(t0);
      oscSine.stop(t0 + note.dur + 0.05);
      oscTri.stop(t0 + note.dur + 0.05);
      // 마지막 음은 여운이 좀 더 길게 — 이미 dur 에 반영됨
      void note.isLast;
    });
  } catch { /* ignore */ }
}

/** 에러/경고 — 더 낮은 톤 두 번 */
export function playWarn(volume = 0.2) {
  const ctx = getCtx();
  if (!ctx) return;
  try {
    [0, 0.15].forEach((offset) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, ctx.currentTime + offset);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.01, Math.min(1, volume)), ctx.currentTime + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.12);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.15);
    });
  } catch { /* ignore */ }
}
