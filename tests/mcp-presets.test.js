import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpRouter, MCP_PRESETS } from '../server/routes/mcp.js';
import { errorHandler } from '../server/middleware/error-handler.js';

// findSettingsPath() prefers <cwd>/.claude/settings.json — stub cwd to a temp
// dir so the test never touches the real user config.
describe('mcp presets', () => {
  let app, tmpCwd, settingsPath;

  beforeEach(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-'));
    fs.mkdirSync(path.join(tmpCwd, '.claude'));
    settingsPath = path.join(tmpCwd, '.claude', 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ mcpServers: {} }));
    vi.spyOn(process, 'cwd').mockReturnValue(tmpCwd);

    app = express();
    app.use(express.json());
    app.use('/api/mcp', createMcpRouter({}));
    app.use(errorHandler);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('GET /presets lists the three presets', async () => {
    const res = await request(app).get('/api/mcp/presets');
    expect(res.status).toBe(200);
    expect(res.body.presets.map((p) => p.id)).toEqual(['playwright', 'context7', 'github']);
  });

  it('apply merges the preset into existing servers', async () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ mcpServers: { existing: { command: 'x' } } }));
    const res = await request(app).post('/api/mcp/presets/playwright/apply');
    expect(res.status).toBe(200);
    expect(res.body.mcpServers.existing).toEqual({ command: 'x' });
    expect(res.body.mcpServers.playwright).toEqual(MCP_PRESETS[0].config);
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).mcpServers.playwright).toBeTruthy();
  });

  it('apply returns 409 when the key already exists and leaves it untouched', async () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ mcpServers: { github: { url: 'mine' } } }));
    const res = await request(app).post('/api/mcp/presets/github/apply');
    expect(res.status).toBe(409);
    expect(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).mcpServers.github).toEqual({ url: 'mine' });
  });

  it('apply returns 404 for an unknown preset', async () => {
    const res = await request(app).post('/api/mcp/presets/nope/apply');
    expect(res.status).toBe(404);
  });
});
