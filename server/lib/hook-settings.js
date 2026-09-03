import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

/** Hook events the Claude CLI settings format accepts. */
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'Notification',
  'SessionStart',
  'UserPromptSubmit'
];

/**
 * Does this hook apply to the given agent?
 * An empty/absent `agentIds` means "all agents".
 */
export function hookAppliesTo(hook, agentId) {
  if (!Array.isArray(hook.agentIds) || hook.agentIds.length === 0) return true;
  return hook.agentIds.includes(agentId);
}

/**
 * Assemble stored hooks into the Claude CLI `--settings` shape:
 *   { hooks: { [event]: [{ matcher, hooks: [{ type:'command', command, ... }] }] } }
 *
 * Hooks are filtered by `enabled` and by `agentIds`, and grouped by
 * (event, matcher) so several commands can share one matcher entry.
 *
 * @returns {object|null} null when no hook applies (caller omits --settings).
 */
export function buildHookSettings(hooks, agentId) {
  const byEvent = {};
  for (const hook of hooks ?? []) {
    if (!hook || hook.enabled === false) continue;
    if (!HOOK_EVENTS.includes(hook.event)) continue;
    if (!hook.command || typeof hook.command !== 'string' || !hook.command.trim()) continue;
    if (!hookAppliesTo(hook, agentId)) continue;

    const matcher = hook.matcher || '*';
    const entry = { type: 'command', command: hook.command };
    if (hook.async === true) entry.async = true;
    if (typeof hook.timeout === 'number' && hook.timeout > 0) entry.timeout = hook.timeout;

    const groups = (byEvent[hook.event] ??= []);
    const group = groups.find((g) => g.matcher === matcher);
    if (group) group.hooks.push(entry);
    else groups.push({ matcher, hooks: [entry] });
  }
  return Object.keys(byEvent).length > 0 ? { hooks: byEvent } : null;
}

/**
 * Write the assembled settings to `<logsDir>/hook-settings-<sessionId>.json`.
 * @returns {string|null} the file path, or null when there was nothing to write.
 */
export function writeHookSettingsFile({ hooks, agentId, sessionId, logsDir }) {
  const settings = buildHookSettings(hooks, agentId);
  if (!settings) return null;
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    const safeId = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_');
    const filePath = path.join(logsDir, `hook-settings-${safeId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2));
    return filePath;
  } catch (err) {
    logger.warn({ err: err?.message, sessionId, agentId }, 'hook-settings: write failed — hooks not injected');
    return null;
  }
}

/** Best-effort removal of a settings file written by writeHookSettingsFile. */
export function removeHookSettingsFile(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch { /* already gone */ }
}
