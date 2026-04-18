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
    'mailto:admin@localhost',
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
  async function sendPushToAll(title, body) {
    if (webConfig.push?.enabled === false) return; // 명시적 false 일 때만 비활성
    if (isDesktopActive()) {
      logger.debug('push-store: desktop active — skipping push');
      return;
    }
    if (subscriptions.length === 0) return;

    const payload = JSON.stringify({ title, body });
    const expired = [];

    await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, payload);
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            expired.push(sub.endpoint);
          } else {
            logger.warn({ err, endpoint: sub.endpoint }, 'push-store: send failed');
          }
        }
      })
    );

    if (expired.length > 0) {
      subscriptions = subscriptions.filter((s) => !expired.includes(s.endpoint));
      await saveSubs();
      logger.info({ removed: expired.length }, 'push-store: removed expired subscriptions');
    }
  }

  return {
    getVapidPublicKey: () => webConfig.vapidPublicKey,
    addSubscription,
    removeSubscription,
    touchActivity,
    sendPushToAll
  };
}
