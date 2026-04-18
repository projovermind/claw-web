import webpush from 'web-push';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

/**
 * Push store — VAPID key management, subscription storage, idle-aware push.
 *
 * VAPID keys are saved in web-config.json (vapidPublicKey / vapidPrivateKey).
 * Subscription list is persisted in push-subscriptions.json next to web-config.json.
 * lastDesktopActivity is in-memory only.
 */
export function createPushStore({ webConfig, webConfigPath }) {
  const dir = path.dirname(webConfigPath);
  const subsPath = path.join(dir, 'push-subscriptions.json');

  // ── VAPID key bootstrap ──────────────────────────────────────
  if (!webConfig.vapidPublicKey || !webConfig.vapidPrivateKey) {
    const keys = webpush.generateVAPIDKeys();
    webConfig.vapidPublicKey = keys.publicKey;
    webConfig.vapidPrivateKey = keys.privateKey;
    try {
      fssync.writeFileSync(webConfigPath, JSON.stringify(webConfig, null, 2));
      logger.info('push-store: generated and saved VAPID keys');
    } catch (err) {
      logger.warn({ err }, 'push-store: failed to persist VAPID keys');
    }
  }

  webpush.setVapidDetails(
    'mailto:admin@claw-web.app',
    webConfig.vapidPublicKey,
    webConfig.vapidPrivateKey
  );

  // ── Subscription store ───────────────────────────────────────
  let subscriptions = [];

  function loadSubs() {
    try {
      if (fssync.existsSync(subsPath)) {
        subscriptions = JSON.parse(fssync.readFileSync(subsPath, 'utf8'));
      }
    } catch (err) {
      logger.warn({ err }, 'push-store: failed to load subscriptions');
      subscriptions = [];
    }
  }

  async function saveSubs() {
    try {
      await fs.writeFile(subsPath, JSON.stringify(subscriptions, null, 2));
    } catch (err) {
      logger.warn({ err }, 'push-store: failed to save subscriptions');
    }
  }

  loadSubs();

  // ── Runner ref — 활성 세션 있으면 알림 억제 ─────────────────
  let runnerRef = null;
  function setRunnerRef(r) { runnerRef = r; }
  function isRunnerActive() {
    try { return runnerRef && runnerRef.activeIds().length > 0; } catch { return false; }
  }

  // ── lastDesktopActivity ──────────────────────────────────────
  let lastDesktopActivity = null;

  function touchActivity() {
    lastDesktopActivity = Date.now();
  }

  function isDesktopActive() {
    if (!lastDesktopActivity) return false;
    const thresholdMs = (webConfig.push?.idleThreshold ?? 5) * 60 * 1000;
    return Date.now() - lastDesktopActivity < thresholdMs;
  }

  // ── Subscription management ──────────────────────────────────
  async function addSubscription(sub) {
    const exists = subscriptions.some((s) => s.endpoint === sub.endpoint);
    if (!exists) {
      subscriptions.push(sub);
      await saveSubs();
    }
  }

  async function removeSubscription(endpoint) {
    const before = subscriptions.length;
    subscriptions = subscriptions.filter((s) => s.endpoint !== endpoint);
    if (subscriptions.length !== before) await saveSubs();
  }

  // ── Send push ────────────────────────────────────────────────
  async function sendPushToAll(title, body, { skipIdleCheck = false, skipRunnerCheck = false, url } = {}) {
    if (webConfig.push?.enabled === false) return { skipped: 'disabled' };
    if (!skipRunnerCheck && isRunnerActive()) {
      logger.debug('push-store: runner active — skipping push');
      return { skipped: 'runner_active' };
    }
    if (!skipIdleCheck && isDesktopActive()) {
      logger.debug('push-store: desktop active — skipping push');
      return { skipped: 'desktop_active' };
    }
    if (subscriptions.length === 0) return { skipped: 'no_subscriptions' };

    const payload = JSON.stringify({ title, body, url: url ?? '/' });
    const expired = [];
    const results = [];

    await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, payload);
          results.push({ endpoint: sub.endpoint.slice(0, 40), ok: true });
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            expired.push(sub.endpoint);
            results.push({ endpoint: sub.endpoint.slice(0, 40), ok: false, reason: 'expired' });
          } else {
            logger.warn({ err, endpoint: sub.endpoint }, 'push-store: send failed');
            results.push({ endpoint: sub.endpoint.slice(0, 40), ok: false, status: err.statusCode, reason: err.body || err.message });
          }
        }
      })
    );

    if (expired.length > 0) {
      subscriptions = subscriptions.filter((s) => !expired.includes(s.endpoint));
      await saveSubs();
      logger.info({ removed: expired.length }, 'push-store: removed expired subscriptions');
    }
    return { results };
  }

  return {
    getVapidPublicKey: () => webConfig.vapidPublicKey,
    addSubscription,
    removeSubscription,
    touchActivity,
    setRunnerRef,
    sendPushToAll
  };
}
