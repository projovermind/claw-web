import { useEffect, useRef } from 'react';
import { api } from '../lib/api';

const THROTTLE_MS = 60_000;

export function useActivityPing() {
  const lastPingRef = useRef(0);

  useEffect(() => {
    const ping = () => {
      const now = Date.now();
      if (now - lastPingRef.current < THROTTLE_MS) return;
      lastPingRef.current = now;
      api.pushActivity().catch(() => {});
    };

    window.addEventListener('mousemove', ping, { passive: true });
    window.addEventListener('keydown', ping, { passive: true });
    window.addEventListener('focus', ping);

    return () => {
      window.removeEventListener('mousemove', ping);
      window.removeEventListener('keydown', ping);
      window.removeEventListener('focus', ping);
    };
  }, []);
}
