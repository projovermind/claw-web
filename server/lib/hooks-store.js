import fs from 'node:fs/promises';
import fssync from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * Simple JSON-file store for hooks.
 * Each hook: { id, event, matcher, action, command, enabled }
 */
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

    async create({ event, matcher, action, command, enabled = true }) {
      const hook = {
        id: `hook_${randomUUID().slice(0, 8)}`,
        event: event || 'PreToolUse',
        matcher: matcher || '*',
        action: action || 'shell',
        command: command || '',
        enabled: enabled !== false
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
        if (patch[key] !== undefined) hooks[idx][key] = patch[key];
      }
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
