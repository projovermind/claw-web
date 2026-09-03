import fs from 'node:fs/promises';
import fssync from 'node:fs';
import { randomUUID } from 'node:crypto';
import { HOOK_EVENTS } from './hook-settings.js';

/**
 * Simple JSON-file store for hooks.
 * Each hook: { id, event, matcher, action, command, enabled, async, agentIds, timeout }
 *
 * `agentIds` empty/absent = applies to every agent. `async`/`timeout` map onto
 * the Claude CLI settings hook entry the runner injects via --settings.
 */
function normalizeAgentIds(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string' && x.trim()).slice(0, 200);
}

function normalizeTimeout(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.round(n), 600);
}
export async function createHooksStore(filePath) {
  let hooks = [];

  // Load existing hooks or create empty file
  if (fssync.existsSync(filePath)) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      hooks = Array.isArray(parsed) ? parsed : parsed.hooks || [];
    } catch {
      hooks = [];
    }
  }

  async function save() {
    const tmp = filePath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(hooks, null, 2));
    await fs.rename(tmp, filePath);
  }

  return {
    list() {
      return hooks;
    },

    get(id) {
      return hooks.find((h) => h.id === id) || null;
    },

    async create({ event, matcher, action, command, enabled = true, async: isAsync, agentIds, timeout }) {
      const hook = {
        id: `hook_${randomUUID().slice(0, 8)}`,
        event: HOOK_EVENTS.includes(event) ? event : 'PreToolUse',
        matcher: matcher || '*',
        action: action || 'shell',
        command: command || '',
        enabled: enabled !== false,
        async: isAsync === true,
        agentIds: normalizeAgentIds(agentIds),
        timeout: normalizeTimeout(timeout)
      };
      hooks.push(hook);
      await save();
      return hook;
    },

    async update(id, patch) {
      const idx = hooks.findIndex((h) => h.id === id);
      if (idx < 0) return null;
      const allowed = ['event', 'matcher', 'action', 'command', 'enabled'];
      for (const key of allowed) {
        if (patch[key] === undefined) continue;
        if (key === 'event' && !HOOK_EVENTS.includes(patch.event)) continue;
        hooks[idx][key] = patch[key];
      }
      if (patch.async !== undefined) hooks[idx].async = patch.async === true;
      if (patch.agentIds !== undefined) hooks[idx].agentIds = normalizeAgentIds(patch.agentIds);
      if (patch.timeout !== undefined) hooks[idx].timeout = normalizeTimeout(patch.timeout);
      await save();
      return hooks[idx];
    },

    async remove(id) {
      const idx = hooks.findIndex((h) => h.id === id);
      if (idx < 0) return false;
      hooks.splice(idx, 1);
      await save();
      return true;
    },

    /** Get hooks matching a specific event and tool name */
    getMatching(event, toolName) {
      return hooks.filter(
        (h) => h.enabled && h.event === event && (h.matcher === '*' || h.matcher === toolName)
      );
    }
  };
}
