import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSkillsStore } from '../server/lib/skills-store.js';
import { createSkillsRouter } from '../server/routes/skills.js';
import { errorHandler } from '../server/middleware/error-handler.js';
import { toRawUrl, parseSkillMarkdown } from '../server/lib/skill-import.js';

const SKILL_MD = `---
name: systematic-debugging
description: Debug things systematically
---

# Systematic Debugging

Read superpowers:test-driven-development first.
`;

function mockFetchOnce(body, { ok = true, status = 200, contentLength = null } = {}) {
  return vi.fn(async () => ({
    ok,
    status,
    headers: { get: (k) => (k === 'content-length' ? contentLength : null) },
    text: async () => body
  }));
}

describe('POST /api/skills/import-url', () => {
  let app, skillsStore, file;

  beforeEach(async () => {
    file = path.join(os.tmpdir(), `skills-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    skillsStore = await createSkillsStore(file);
    app = express();
    app.use(express.json());
    app.use('/api/skills', createSkillsRouter({ skillsStore, systemSkillsStore: null, metadataStore: null, eventBus: null }));
    app.use(errorHandler);
  });

  afterEach(async () => {
    await skillsStore.close();
    vi.unstubAllGlobals();
    for (const f of [file, `${file}.tmp`]) { try { fs.unlinkSync(f); } catch {} }
    try { fs.rmSync(`${file}.lock`, { recursive: true, force: true }); } catch {}
  });

  it('converts github blob URLs to raw URLs', () => {
    expect(toRawUrl('https://github.com/obra/superpowers/blob/main/skills/a/SKILL.md'))
      .toBe('https://raw.githubusercontent.com/obra/superpowers/main/skills/a/SKILL.md');
    expect(toRawUrl('https://raw.githubusercontent.com/o/r/main/SKILL.md'))
      .toBe('https://raw.githubusercontent.com/o/r/main/SKILL.md');
  });

  it('parses frontmatter and rewrites plugin references', () => {
    const parsed = parseSkillMarkdown(SKILL_MD);
    expect(parsed.name).toBe('systematic-debugging');
    expect(parsed.description).toBe('Debug things systematically');
    expect(parsed.body).toContain("'test-driven-development' 스킬");
    expect(parsed.body).not.toContain('superpowers:');
  });

  it('imports a skill from a github blob URL', async () => {
    vi.stubGlobal('fetch', mockFetchOnce(SKILL_MD));
    const url = 'https://github.com/obra/superpowers/blob/main/skills/systematic-debugging/SKILL.md';
    const res = await request(app)
      .post('/api/skills/import-url')
      .send({ url, triggers: ['버그', 'debug'] });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('systematic-debugging');
    expect(res.body.description).toBe('Debug things systematically');
    expect(res.body.triggers).toEqual(['버그', 'debug']);
    expect(res.body.alwaysOn).toBe(false);
    expect(res.body.content.startsWith(`<!-- source: ${url} -->`)).toBe(true);
    expect(global.fetch.mock.calls[0][0])
      .toBe('https://raw.githubusercontent.com/obra/superpowers/main/skills/systematic-debugging/SKILL.md');
  });

  it('409s when a skill with the same name exists', async () => {
    await skillsStore.create({ name: 'systematic-debugging', content: 'x' });
    vi.stubGlobal('fetch', mockFetchOnce(SKILL_MD));
    const res = await request(app)
      .post('/api/skills/import-url')
      .send({ url: 'https://github.com/obra/superpowers/blob/main/skills/systematic-debugging/SKILL.md' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SKILL_NAME_TAKEN');
  });

  it('rejects files over 1MB via content-length', async () => {
    vi.stubGlobal('fetch', mockFetchOnce(SKILL_MD, { contentLength: String(2 * 1024 * 1024) }));
    const res = await request(app)
      .post('/api/skills/import-url')
      .send({ url: 'https://raw.githubusercontent.com/o/r/main/a/SKILL.md' });
    expect(res.status).toBe(413);
  });

  it('400s on a non-URL body', async () => {
    const res = await request(app).post('/api/skills/import-url').send({ url: 'not-a-url' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  it('502s when the upstream fetch fails', async () => {
    vi.stubGlobal('fetch', mockFetchOnce('', { ok: false, status: 404 }));
    const res = await request(app)
      .post('/api/skills/import-url')
      .send({ url: 'https://raw.githubusercontent.com/o/r/main/a/SKILL.md' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('FETCH_FAILED');
  });
});
