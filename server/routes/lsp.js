import { Router } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { HttpError } from '../middleware/error-handler.js';

const execAsync = promisify(execFile);

// Directories to skip when grepping
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'coverage', '.cache'];

/**
 * LSP-like endpoints using grep-based approximation.
 *
 * POST /api/lsp/definition  - jump to definition
 * POST /api/lsp/references  - find references
 * POST /api/lsp/hover       - hover info (line content)
 */
export function createLspRouter({ projectsStore }) {
  const router = Router();

  function getProjectPath(projectId) {
    const projects = projectsStore.list();
    const project = projects.find((p) => p.id === projectId);
    if (!project) throw new HttpError(404, 'Project not found', 'PROJECT_NOT_FOUND');
    return project.path;
  }

  // Extract the symbol (word) at the given position from a line of text
  function getSymbolAt(lineText, character) {
    if (!lineText || character < 0) return null;
    const wordRegex = /[a-zA-Z_$][a-zA-Z0-9_$]*/g;
    let match;
    while ((match = wordRegex.exec(lineText)) !== null) {
      if (match.index <= character && match.index + match[0].length > character) {
        return match[0];
      }
    }
    return null;
  }

  // Run grep with standard skip patterns
  async function grepProject(pattern, projectPath, maxResults) {
    const limit = maxResults || 50;
    const excludeArgs = SKIP_DIRS.flatMap((d) => ['--exclude-dir', d]);
    try {
      const { stdout } = await execAsync(
        'grep',
        ['-rn',
         '--include=*.js', '--include=*.ts', '--include=*.tsx', '--include=*.jsx',
         '--include=*.py', '--include=*.go', '--include=*.rs',
         ...excludeArgs, '-E', pattern, projectPath],
        { maxBuffer: 1024 * 1024, timeout: 10000 }
      );
      return stdout
        .split('\n')
        .filter(Boolean)
        .slice(0, limit)
        .map((line) => {
          const colonIdx = line.indexOf(':');
          const secondColon = line.indexOf(':', colonIdx + 1);
          if (colonIdx < 0 || secondColon < 0) return null;
          return {
            file: line.slice(0, colonIdx),
            line: parseInt(line.slice(colonIdx + 1, secondColon), 10),
            text: line.slice(secondColon + 1).trim()
          };
        })
        .filter(Boolean);
    } catch (_err) {
      // grep returns exit code 1 when no matches
      return [];
    }
  }

  router.post('/definition', async (req, res, next) => {
    try {
      const { file, line, character, projectId } = req.body;
      if (!projectId) throw new HttpError(400, 'projectId is required', 'MISSING_PARAMS');

      const projectPath = getProjectPath(projectId);
      let symbol = null;

      if (file && line != null && character != null) {
        try {
          const content = await fs.readFile(file, 'utf8');
          const lines = content.split('\n');
          const lineText = lines[line - 1] || lines[line] || '';
          symbol = getSymbolAt(lineText, character);
        } catch (_e) {
          // file not readable
        }
      }

      if (!symbol) {
        return res.json({ locations: [] });
      }

      // Search for definition patterns
      const patterns = [
        '(function|const|let|var|class|interface|type|enum)\\s+' + symbol + '\\b',
        'export\\s+(default\\s+)?(function|const|let|var|class|interface|type)\\s+' + symbol + '\\b',
        symbol + '\\s*[:=]\\s*(function|\\(|async|=>)'
      ];

      const allResults = [];
      for (const pat of patterns) {
        const results = await grepProject(pat, projectPath, 20);
        allResults.push(...results);
      }

      // Deduplicate by file:line
      const seen = new Set();
      const unique = allResults.filter((r) => {
        const key = r.file + ':' + r.line;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      res.json({ locations: unique.slice(0, 20) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/references', async (req, res, next) => {
    try {
      const { file, line, character, projectId } = req.body;
      if (!projectId) throw new HttpError(400, 'projectId is required', 'MISSING_PARAMS');

      const projectPath = getProjectPath(projectId);
      let symbol = null;

      if (file && line != null && character != null) {
        try {
          const content = await fs.readFile(file, 'utf8');
          const lines = content.split('\n');
          const lineText = lines[line - 1] || lines[line] || '';
          symbol = getSymbolAt(lineText, character);
        } catch (_e) {
          // ignore
        }
      }

      if (!symbol) {
        return res.json({ locations: [] });
      }

      const locations = await grepProject('\\b' + symbol + '\\b', projectPath, 100);
      res.json({ locations });
    } catch (err) {
      next(err);
    }
  });

  router.post('/hover', async (req, res, next) => {
    try {
      const { file, line } = req.body;
      if (!file || line == null) {
        throw new HttpError(400, 'file and line are required', 'MISSING_PARAMS');
      }
      try {
        const content = await fs.readFile(file, 'utf8');
        const lines = content.split('\n');
        const lineIdx = (typeof line === 'number' ? line : parseInt(line, 10)) - 1;
        const lineText = lines[lineIdx] || '';
        res.json({ content: lineText, line: lineIdx + 1 });
      } catch (_e) {
        res.json({ content: '', line });
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
