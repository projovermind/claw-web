import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectsStore } from '../server/lib/projects-store.js';
import { createProjectsRouter, claudeMemoryDir } from '../server/routes/projects.js';
import { errorHandler } from '../server/middleware/error-handler.js';

describe('claude-memory route', () => {
  let app, store, file, home, memDir;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);

    file = path.join(os.tmpdir(), `mem-proj-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      projects: [
        { id: 'withdir', name: 'With', path: '/Volumes/Core/demo' },
        { id: 'nodir', name: 'No', path: '' }
      ]
    }));
    store = await createProjectsStore(file);

    memDir = claudeMemoryDir('/Volumes/Core/demo');
    fs.mkdirSync(memDir, { recursive: true });

    app = express();
    app.use(express.json());
    app.use('/api/projects', createProjectsRouter({ projectsStore: store }));
    app.use(errorHandler);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await store.close();
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('maps workingDir to ~/.claude/projects/<slug>/memory', () => {
    expect(claudeMemoryDir('/Volumes/Core/demo')).toBe(
      path.join(home, '.claude', 'projects', '-Volumes-Core-demo', 'memory')
    );
  });

  it('GET lists memory files and MEMORY.md content', async () => {
    fs.writeFileSync(path.join(memDir, 'MEMORY.md'), '- [A](a.md)');
    fs.writeFileSync(path.join(memDir, 'a.md'), 'body');
    fs.writeFileSync(path.join(memDir, 'ignored.txt'), 'nope');

    const res = await request(app).get('/api/projects/withdir/claude-memory');
    expect(res.status).toBe(200);
    expect(res.body.files.map((f) => f.name)).toEqual(['a.md', 'MEMORY.md']);
    expect(res.body.index).toBe('- [A](a.md)');
  });

  it('GET returns an empty listing when the memory dir does not exist', async () => {
    fs.rmSync(memDir, { recursive: true, force: true });
    const res = await request(app).get('/api/projects/withdir/claude-memory');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ files: [], index: null });
  });

  it('404s a project without a working dir', async () => {
    const res = await request(app).get('/api/projects/nodir/claude-memory');
    expect(res.status).toBe(404);
    expect(res.body.error?.code ?? res.body.code).toBe('NO_WORKING_DIR');
  });

  it('PUT writes and GET reads a single file', async () => {
    const put = await request(app)
      .put('/api/projects/withdir/claude-memory/note.md')
      .send({ content: 'hello' });
    expect(put.status).toBe(200);
    expect(fs.readFileSync(path.join(memDir, 'note.md'), 'utf8')).toBe('hello');

    const get = await request(app).get('/api/projects/withdir/claude-memory/note.md');
    expect(get.body.content).toBe('hello');
  });

  it('rejects path traversal with 400 and writes nothing outside the dir', async () => {
    const escapee = path.join(home, 'pwned.md');
    for (const name of ['../pwned.md', '..%2Fpwned.md', 'sub/a.md', 'a.txt', '....md']) {
      const res = await request(app)
        .put(`/api/projects/withdir/claude-memory/${name}`)
        .send({ content: 'x' });
      expect([400, 404], `name=${name}`).toContain(res.status);
    }
    expect(fs.existsSync(escapee)).toBe(false);
  });

  it('PUT without a string content is 400', async () => {
    const res = await request(app)
      .put('/api/projects/withdir/claude-memory/note.md')
      .send({ content: 42 });
    expect(res.status).toBe(400);
  });
});
