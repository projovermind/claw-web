import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from './logger.js';

const DEFAULT_PLUGINS_ROOT = path.join(os.homedir(), '.claude/plugins/cache/claude-plugins-official');

// Parse minimal YAML frontmatter from a markdown file.
// Supports:
//  - name: value
//  - description: value  (quoted or unquoted)
// Ignores nested blocks (metadata:, pathPatterns: etc). Body = everything after second `---`.
function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { meta: {}, body: text };
  const fmBlock = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n/, '');
  const meta = {};
  let inSimple = true; // we only read top-level key:value pairs, skip when indented
  for (const rawLine of fmBlock.split('\n')) {
    if (/^\s/.test(rawLine)) {
      inSimple = false;
      continue;
    }
    inSimple = true;
    const m = rawLine.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Only capture primitive scalar values (skip pipe/gt literal, arrays, objects)
    if (value === '' || value === '|' || value === '>') continue;
    meta[key] = value;
  }
  return { meta, body: body.trim() };
}

/**
 * Scan Claude Code plugin cache for SKILL.md files.
 * Each returned skill has:
 *  - id: `sys:{plugin}:{skillName}` (stable)
 *  - name: from frontmatter, fallback dir name
 *  - description: from frontmatter
 *  - content: body after frontmatter
 *  - plugin: plugin folder name
 *  - source: absolute file path
 *  - system: true  (marker)
 */
export async function loadSystemSkills(pluginsRoot = DEFAULT_PLUGINS_ROOT) {
  if (!fssync.existsSync(pluginsRoot)) {
    return [];
  }

  const results = [];

  async function walk(dir, pluginName) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules, .git, etc.
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        await walk(full, pluginName);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        try {
          const text = await fs.readFile(full, 'utf8');
          const { meta, body } = parseFrontmatter(text);
          const skillDir = path.basename(path.dirname(full));
          const name = meta.name ?? skillDir;
          const id = `sys:${pluginName}:${name}`;
          results.push({
            id,
            name,
            description: meta.description ?? '',
            content: body,
            plugin: pluginName,
            source: full,
            system: true
          });
        } catch (err) {
          logger.warn({ err, full }, 'system-skills: failed to parse SKILL.md');
        }
      }
    }
  }

  try {
    const pluginDirs = await fs.readdir(pluginsRoot, { withFileTypes: true });
    for (const pluginEntry of pluginDirs) {
      if (!pluginEntry.isDirectory()) continue;
      if (pluginEntry.name.startsWith('.')) continue;
      const pluginPath = path.join(pluginsRoot, pluginEntry.name);
      // Plugins are versioned: each sub-dir is a version (e.g. 5.0.7, 1.0.0)
      const versionDirs = await fs.readdir(pluginPath, { withFileTypes: true });
      for (const ver of versionDirs) {
        if (!ver.isDirectory()) continue;
        await walk(path.join(pluginPath, ver.name), pluginEntry.name);
      }
    }
  } catch (err) {
    logger.warn({ err, pluginsRoot }, 'system-skills: top-level scan failed');
    return [];
  }

  // Dedup by id (prefer first match — typically latest version is what globs first)
  const seen = new Set();
  const dedup = [];
  for (const s of results) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    dedup.push(s);
  }

  logger.info({ count: dedup.length, pluginsRoot }, 'system-skills: loaded');
  return dedup;
}

export function createSystemSkillsStore(pluginsRoot) {
  let cache = [];
  let byId = new Map();

  async function refresh() {
    cache = await loadSystemSkills(pluginsRoot);
    byId = new Map(cache.map((s) => [s.id, s]));
    return cache;
  }

  return {
    async init() {
      await refresh();
      return cache.length;
    },
    refresh,
    getAll: () => cache,
    getMany: (ids) => {
      const out = [];
      for (const id of ids) {
        const s = byId.get(id);
        if (s) out.push(s);
      }
      return out;
    },
    get: (id) => byId.get(id) ?? null
  };
}
