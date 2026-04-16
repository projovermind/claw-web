import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProjectMdRouter } from '../server/routes/project-md.js';
import { errorHandler } from '../server/middleware/error-handler.js';

// Minimal in-memory projectsStore stub matching the shape project-md.js expects
function makeProjectsStore(projects) {
  return {
    getById: (id) => projects.find((p) => p.id === id) ?? null
  };
}

describe('project-md route', () => {
  let app, tmpDir, webConfig, projectsStore;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `hivemind-md-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(tmpDir, { recursive: true });
    webConfig = { allowedRoots: [tmpDir] };
    projectsStore = makeProjectsStore([
      { id: 'overmind', name: 'Overmind', path: tmpDir }
    ]);

    app = express();
    app.use(express.json({ limit: '32mb' })); // match production limit so Zod gets a crack at oversized bodies
    app.use(
      '/api/projects',
      createProjectMdRouter({ projectsStore, webConfig })
    );
    app.use(errorHandler);
  });

  afterEach(async () => {
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('GET returns exists:false and empty content when file does not exist', async () => {
    const res = await request(app).get('/api/projects/overmind/md');
    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(false);
    expect(res.body.content).toBe('');
    expect(res.body.mtimeMs).toBe(0);
    expect(res.body.filePath).toBe(path.join(tmpDir, 'CLAUDE.md'));
  });

  it('PUT creates the file and GET returns its content + mtime', async () => {
    const put = await request(app)
      .put('/api/projects/overmind/md')
      .send({ content: '# Overmind\n\nHello world' });
    expect(put.status).toBe(200);
    expect(put.body.exists).toBe(true);
    expect(put.body.mtimeMs).toBeGreaterThan(0);

    const get = await request(app).get('/api/projects/overmind/md');
    expect(get.body.exists).toBe(true);
    expect(get.body.content).toBe('# Overmind\n\nHello world');
    expect(get.body.mtimeMs).toBe(put.body.mtimeMs);
  });

  it('PUT with matching ifMatchMtime succeeds', async () => {
    const put1 = await request(app)
      .put('/api/projects/overmind/md')
      .send({ content: 'v1' });
    const mtime1 = put1.body.mtimeMs;

    const put2 = await request(app)
      .put('/api/projects/overmind/md')
      .send({ content: 'v2', ifMatchMtime: mtime1 });
    expect(put2.status).toBe(200);
    expect(put2.body.mtimeMs).toBeGreaterThanOrEqual(mtime1);
  });

  it('PUT with stale ifMatchMtime returns 409 MTIME_CONFLICT', async () => {
    await request(app).put('/api/projects/overmind/md').send({ content: 'v1' });
    // Fake a stale mtime (e.g. from a very old read)
    const res = await request(app)
      .put('/api/projects/overmind/md')
      .send({ content: 'v2', ifMatchMtime: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('MTIME_CONFLICT');
  });

  it('PUT with ifMatchMtime:0 against existing file returns 409', async () => {
    // Client thinks the file is new (mtime=0) but it already exists
    await request(app).put('/api/projects/overmind/md').send({ content: 'existing' });
    const res = await request(app)
      .put('/api/projects/overmind/md')
      .send({ content: 'clobber', ifMatchMtime: 0 });
    expect(res.status).toBe(409);
  });

  it('rejects non-allowlisted filenames', async () => {
    const res = await request(app)
      .put('/api/projects/overmind/md/evil.sh')
      .send({ content: '#!/bin/sh\nrm -rf /' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_FILENAME');
  });

  it('rejects project path outside allowedRoots', async () => {
    const outside = {
      getById: () => ({ id: 'outside', name: 'Outside', path: '/tmp/not-allowed-path-xyz' })
    };
    const app2 = express();
    app2.use(express.json());
    app2.use(
      '/api/projects',
      createProjectMdRouter({ projectsStore: outside, webConfig })
    );
    app2.use(errorHandler);
    const res = await request(app2).get('/api/projects/outside/md');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_ALLOWED_ROOTS');
  });

  it('returns 404 when project does not exist', async () => {
    const res = await request(app).get('/api/projects/ghost/md');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PROJECT_NOT_FOUND');
  });

  it('accepts AGENTS.md via /md/AGENTS.md route', async () => {
    const put = await request(app)
      .put('/api/projects/overmind/md/AGENTS.md')
      .send({ content: '# Agents' });
    expect(put.status).toBe(200);
    expect(put.body.filename).toBe('AGENTS.md');
    const get = await request(app).get('/api/projects/overmind/md/AGENTS.md');
    expect(get.body.content).toBe('# Agents');
  });

  it('rejects content over 200000 chars', async () => {
    const res = await request(app)
      .put('/api/projects/overmind/md')
      .send({ content: 'x'.repeat(200001) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });
});
