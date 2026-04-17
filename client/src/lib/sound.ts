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

/** 띠링 — 880Hz → 1320Hz 사선 상승, 0.5초 fade out */
export function playDing(volume = 0.2) {
  const ctx = getCtx();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.01, Math.min(1, volume)), ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.55);
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
