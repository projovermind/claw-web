import fs from 'node:fs/promises';
import fssync from 'node:fs';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';

/**
 * Simple interval-based scheduler. Checks every 60 seconds if any cron
 * expression matches the current minute. Uses no external cron library.
 *
 * Cron format: minute hour dom month dow (standard 5-field).
 * Supports: numbers, '*', ranges (1-5), lists (1,3,5), step syntax.
 */
export function createScheduler({ filePath, eventBus }) {
  let schedules = [];
  let timer = null;

  // Load schedules from disk
  if (fssync.existsSync(filePath)) {
    try {
      const raw = fssync.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      schedules = Array.isArray(parsed) ? parsed : parsed.schedules || [];
    } catch {
      schedules = [];
    }
  }

  async function save() {
    try {
      const tmp = filePath + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(schedules, null, 2));
      await fs.rename(tmp, filePath);
    } catch (err) {
      logger.error({ err }, 'scheduler: failed to save schedules');
    }
  }

  /** Parse a single cron field against a numeric value */
  function matchField(field, value, max) {
    if (field === '*') return true;

    // Step: */N
    if (field.startsWith('*/')) {
      const step = parseInt(field.slice(2), 10);
      return !isNaN(step) && step > 0 && value % step === 0;
    }

    // List: 1,3,5
    const parts = field.split(',');
    for (const part of parts) {
      // Range: 1-5
      if (part.includes('-')) {
        const [lo, hi] = part.split('-').map(Number);
        if (!isNaN(lo) && !isNaN(hi) && value >= lo && value <= hi) return true;
      } else {
        if (parseInt(part, 10) === value) return true;
      }
    }
    return false;
  }

  /** Check if a cron expression matches the given Date */
  function matchesCron(cronExpr, date) {
    const fields = cronExpr.trim().split(/\s+/);
    if (fields.length < 5) return false;

    const [minute, hour, dom, month, dow] = fields;
    return (
      matchField(minute, date.getMinutes(), 59) &&
      matchField(hour, date.getHours(), 23) &&
      matchField(dom, date.getDate(), 31) &&
      matchField(month, date.getMonth() + 1, 12) &&
      matchField(dow, date.getDay(), 7)
    );
  }

  function tick() {
    const now = new Date();
    for (const sched of schedules) {
      if (!sched.enabled) continue;
      if (matchesCron(sched.cron, now)) {
        // Fire the schedule
        sched.lastRunAt = now.toISOString();
        sched.lastStatus = 'triggered';
        if (eventBus) {
          eventBus.publish('schedule.triggered', {
            id: sched.id,
            name: sched.name,
            agentId: sched.agentId,
            prompt: sched.prompt
          });
        }
        logger.info({ scheduleId: sched.id, name: sched.name }, 'schedule triggered');
        save().catch(() => {});
      }
    }
  }

  // Start polling every 60 seconds
  timer = setInterval(tick, 60 * 1000);

  return {
    list() {
      return schedules;
    },

    get(id) {
      return schedules.find((s) => s.id === id) || null;
    },

    async create({ name, cron, agentId, prompt, enabled = true }) {
      const schedule = {
        id: `sched_${randomUUID().slice(0, 8)}`,
        name: name || 'Untitled',
        cron: cron || '0 * * * *',
        agentId: agentId || '',
        prompt: prompt || '',
        enabled: enabled !== false,
        lastRunAt: null,
        lastStatus: null
      };
      schedules.push(schedule);
      await save();
      return schedule;
    },

    async update(id, patch) {
      const idx = schedules.findIndex((s) => s.id === id);
      if (idx < 0) return null;
      const allowed = ['name', 'cron', 'agentId', 'prompt', 'enabled'];
      for (const key of allowed) {
        if (patch[key] !== undefined) schedules[idx][key] = patch[key];
      }
      await save();
      return schedules[idx];
    },

    async remove(id) {
      const idx = schedules.findIndex((s) => s.id === id);
      if (idx < 0) return false;
      schedules.splice(idx, 1);
      await save();
      return true;
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  };
}
