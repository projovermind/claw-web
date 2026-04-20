import express from 'express';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../lib/logger.js';

const execFileAsync = promisify(execFile);

const DEFAULT_DIR = path.join(os.homedir(), '.hivemind-export');

// Parse minimal YAML frontmatter (replicates system-skills.js logic)
function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { meta: {}, body: text };
  const fmBlock = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n/, '');
  const meta = {};
  for (const rawLine of fmBlock.split('\n')) {
    if (/^\s/.test(rawLine)) continue;
    const m = rawLine.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value === '' || value === '|' || value === '>') continue;
    meta[key] = value;
  }
  return { meta, body: body.trim() };
}

function toKebab(str) {
  const slug = str
    .toLowerCase()
    .replace(/[\s\u2014\u2013_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 60);
  return slug || 'skill';
}

function slugify(skill) {
  const base = toKebab(skill.name || 'skill');
  const hash = (skill.id || '').slice(-6);
  return hash ? `${base}-${hash}` : base;
}

export function createExportImportRouter({ skillsStore, configStore }) {
  const router = express.Router();

  // ── Skills export ──────────────────────────────────────────────────────────
  router.post('/skills/export', async (req, res, next) => {
    try {
      const dir = path.resolve(req.body?.dir ?? DEFAULT_DIR);
      const skillsDir = path.join(dir, 'skills');
      await fs.mkdir(skillsDir, { recursive: true });

      const skills = skillsStore.getAll();
      const saved = [];

      for (const skill of skills) {
        const slug = slugify(skill);
        const fm = [
          '---',
          `name: ${skill.name}`,
          `description: ${skill.description ?? ''}`,
          `id: ${skill.id}`,
          `createdAt: ${skill.createdAt ?? ''}`,
          `updatedAt: ${skill.updatedAt ?? ''}`,
          '---',
          '',
          skill.content ?? ''
        ].join('\n');
        const filePath = path.join(skillsDir, `${slug}.md`);
        await fs.writeFile(filePath, fm, 'utf8');
        saved.push(slug);
      }

      logger.info({ dir, count: saved.length }, 'export-import: skills exported');
      res.json({ ok: true, dir, count: saved.length, files: saved });
    } catch (err) {
      next(err);
    }
  });

  // ── Skills import ──────────────────────────────────────────────────────────
  router.post('/skills/import', async (req, res, next) => {
    try {
      const dir = path.resolve(req.body?.dir ?? DEFAULT_DIR);
      const skillsDir = path.join(dir, 'skills');

      let entries;
      try {
        entries = await fs.readdir(skillsDir);
      } catch {
        return res.status(400).json({ error: `Skills dir not found: ${skillsDir}` });
      }

      const mdFiles = entries.filter((f) => f.endsWith('.md'));
      const result = { created: 0, updated: 0, errors: [] };

      for (const file of mdFiles) {
        try {
          const text = await fs.readFile(path.join(skillsDir, file), 'utf8');
          const { meta, body } = parseFrontmatter(text);

          const name = meta.name || path.basename(file, '.md');
          const description = meta.description ?? '';
          const content = body;
          const importedId = meta.id;

          if (importedId && skillsStore.get(importedId)) {
            await skillsStore.update(importedId, { name, description, content });
            result.updated++;
          } else {
            await skillsStore.create({ name, description, content });
            result.created++;
          }
        } catch (err) {
          result.errors.push({ file, error: err.message });
        }
      }

      logger.info({ dir, result }, 'export-import: skills imported');
      res.json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  // ── Agents export ──────────────────────────────────────────────────────────
  router.post('/agents/export', async (req, res, next) => {
    try {
      const dir = path.resolve(req.body?.dir ?? DEFAULT_DIR);
      const agentsDir = path.join(dir, 'agents');
      await fs.mkdir(agentsDir, { recursive: true });

      const agents = configStore.getAgents();
      const saved = [];

      for (const [agentId, agentData] of Object.entries(agents)) {
        const filePath = path.join(agentsDir, `${agentId}.json`);
        await fs.writeFile(filePath, JSON.stringify(agentData, null, 2), 'utf8');
        saved.push(agentId);
      }

      logger.info({ dir, count: saved.length }, 'export-import: agents exported');
      res.json({ ok: true, dir, count: saved.length, agents: saved });
    } catch (err) {
      next(err);
    }
  });

  // ── Agents import ──────────────────────────────────────────────────────────
  router.post('/agents/import', async (req, res, next) => {
    try {
      const dir = path.resolve(req.body?.dir ?? DEFAULT_DIR);
      const agentsDir = path.join(dir, 'agents');

      let entries;
      try {
        entries = await fs.readdir(agentsDir);
      } catch {
        return res.status(400).json({ error: `Agents dir not found: ${agentsDir}` });
      }

      const jsonFiles = entries.filter((f) => f.endsWith('.json'));
      const result = { created: 0, updated: 0, errors: [] };

      for (const file of jsonFiles) {
        const agentId = path.basename(file, '.json');
        try {
          const text = await fs.readFile(path.join(agentsDir, file), 'utf8');
          const data = JSON.parse(text);

          const existing = configStore.getAgent(agentId);
          if (existing) {
            await configStore.updateAgent(agentId, data);
            result.updated++;
          } else {
            await configStore.createAgent(agentId, data);
            result.created++;
          }
        } catch (err) {
          result.errors.push({ file, error: err.message });
        }
      }

      logger.info({ dir, result }, 'export-import: agents imported');
      res.json({ ok: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  // ── Git commit ─────────────────────────────────────────────────────────────
  router.post('/git/commit', async (req, res, next) => {
    try {
      const dir = path.resolve(req.body?.dir ?? DEFAULT_DIR);
      const message = req.body?.message ?? `export snapshot ${new Date().toISOString()}`;

      // Ensure dir exists
      await fs.mkdir(dir, { recursive: true });

      // git init if no .git
      const gitDir = path.join(dir, '.git');
      if (!fssync.existsSync(gitDir)) {
        await execFileAsync('git', ['init'], { cwd: dir });
        logger.info({ dir }, 'export-import: git init');
      }

      await execFileAsync('git', ['add', '.'], { cwd: dir });
      await execFileAsync('git', ['commit', '--allow-empty', '-m', message], { cwd: dir });

      logger.info({ dir, message }, 'export-import: git commit done');
      res.json({ ok: true, dir, message });
    } catch (err) {
      // git commit exits non-zero if nothing to commit — treat as ok
      if (err.stderr?.includes('nothing to commit') || err.stdout?.includes('nothing to commit')) {
        return res.json({ ok: true, dir: req.body?.dir ?? DEFAULT_DIR, message: 'nothing to commit' });
      }
      next(err);
    }
  });

  return router;
}
