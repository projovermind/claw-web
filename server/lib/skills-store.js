import fs from 'node:fs/promises';
import fssync from 'node:fs';
import EventEmitter from 'node:events';
import lockfile from 'proper-lockfile';
import { nanoid } from 'nanoid';

const EMPTY = () => ({ version: 1, skills: {} });

/**
 * 스킬 풀주입 시 소비 토큰 추정 (한국어 평균 chars/3.5)
 * @param {object} skill
 * @returns {number}
 */
export function estimateSkillTokens(skill) {
  const content = (skill?.content ?? '') + '\n' + (skill?.description ?? '');
  return Math.ceil(content.length / 3.5);
}

/**
 * 스킬의 주입 모드 반환
 * @param {object} skill
 * @returns {'always'|'triggered'|'manual'}
 */
export function skillMode(skill) {
  if (skill?.alwaysOn === true) return 'always';
  if (Array.isArray(skill?.triggers) && skill.triggers.length > 0) return 'triggered';
  return 'manual';
}
const newId = () => `skill_${nanoid(12)}`;

export async function createSkillsStore(filePath) {
  const emitter = new EventEmitter();
  let cache = EMPTY();

  if (!fssync.existsSync(filePath)) {
    await fs.writeFile(filePath, JSON.stringify(EMPTY(), null, 2));
  }

  async function read() {
    const raw = await fs.readFile(filePath, 'utf8');
    return { ...EMPTY(), ...JSON.parse(raw) };
  }

  cache = await read();

  async function writeWithLock(mutator) {
    const release = await lockfile.lock(filePath, { retries: { retries: 10, minTimeout: 100 } });
    try {
      const current = await read();
      const next = mutator(current);
      const tmp = filePath + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(next, null, 2));
      await fs.rename(tmp, filePath);
      cache = next;
      emitter.emit('change', cache);
      return next;
    } finally {
      await release();
    }
  }

  return {
    getAll: () => Object.values(cache.skills ?? {}),
    get: (id) => cache.skills?.[id] ?? null,
    getMany: (ids) => {
      if (!ids || ids.length === 0) return [];
      const out = [];
      for (const id of ids) {
        const s = cache.skills?.[id];
        if (s) out.push(s);
      }
      return out;
    },
    onChange: (cb) => emitter.on('change', cb),

    async create({ name, description, content, triggers, alwaysOn, priority }) {
      const id = newId();
      const now = new Date().toISOString();
      const skill = {
        id,
        name: name ?? 'Untitled skill',
        description: description ?? '',
        content: content ?? '',
        triggers: triggers ?? [],
        alwaysOn: alwaysOn ?? true,
        priority: priority ?? 0,
        createdAt: now,
        updatedAt: now
      };
      await writeWithLock((current) => {
        current.skills = { ...(current.skills ?? {}), [id]: skill };
        return current;
      });
      return skill;
    },

    async update(id, patch) {
      await writeWithLock((current) => {
        const s = current.skills?.[id];
        if (!s) return current;
        current.skills[id] = {
          ...s,
          ...patch,
          updatedAt: new Date().toISOString()
        };
        return current;
      });
      return cache.skills[id];
    },

    async remove(id) {
      await writeWithLock((current) => {
        if (current.skills) delete current.skills[id];
        return current;
      });
    },

    async close() {
      emitter.removeAllListeners();
    }
  };
}
