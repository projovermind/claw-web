import { Router } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { HttpError } from '../middleware/error-handler.js';

const execAsync = promisify(execFile);

/**
 * Git worktree management.
 *
 * POST   /api/worktree/create  { projectId, branch }
 * GET    /api/worktree/list    ?projectId=xxx
 * DELETE /api/worktree/:path
 */
export function createWorktreeRouter({ projectsStore }) {
  const router = Router();

  function getProjectPath(projectId) {
    const projects = projectsStore.getAll();
    const project = projects.find((p) => p.id === projectId);
    if (!project) throw new HttpError(404, 'Project not found', 'PROJECT_NOT_FOUND');
    return project.path;
  }

  router.post('/create', async (req, res, next) => {
    try {
      const { projectId, branch } = req.body;
      if (!projectId || !branch) {
        throw new HttpError(400, 'projectId and branch are required', 'MISSING_PARAMS');
      }
      const projectPath = getProjectPath(projectId);
      const safeBranch = branch.replace(/[^a-zA-Z0-9_\-./]/g, '_');
      const worktreePath = path.join(projectPath, '.worktrees', safeBranch.replace(/\//g, '_'));

      try {
        await execAsync('git', ['worktree', 'add', '-b', safeBranch, worktreePath], { cwd: projectPath });
      } catch (_gitErr) {
        try {
          await execAsync('git', ['worktree', 'add', worktreePath, safeBranch], { cwd: projectPath });
        } catch (gitErr2) {
          const msg = gitErr2.stderr || gitErr2.message;
          throw new HttpError(400, 'git worktree add failed: ' + msg, 'GIT_ERROR');
        }
      }

      res.status(201).json({ path: worktreePath, branch: safeBranch });
    } catch (err) {
      next(err);
    }
  });

  router.get('/list', async (req, res, next) => {
    try {
      const projectId = req.query.projectId;
      if (!projectId) throw new HttpError(400, 'projectId query param required', 'MISSING_PARAMS');
      const projectPath = getProjectPath(projectId);

      const { stdout } = await execAsync('git', ['worktree', 'list', '--porcelain'], { cwd: projectPath });
      const worktrees = parseWorktreeList(stdout);
      res.json({ worktrees });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:path', async (req, res, next) => {
    try {
      const worktreePath = decodeURIComponent(req.params.path);
      if (!worktreePath || worktreePath === '/') {
        throw new HttpError(400, 'Invalid worktree path', 'INVALID_PATH');
      }

      try {
        const { stdout } = await execAsync('git', ['rev-parse', '--git-common-dir'], { cwd: worktreePath });
        const commonDir = path.resolve(worktreePath, stdout.trim());
        const mainRepoPath = path.dirname(commonDir);
        await execAsync('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: mainRepoPath });
      } catch (gitErr) {
        const msg = gitErr.stderr || gitErr.message;
        throw new HttpError(400, 'git worktree remove failed: ' + msg, 'GIT_ERROR');
      }

      res.json({ removed: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function parseWorktreeList(output) {
  const worktrees = [];
  let current = null;

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { path: line.slice(9), branch: '', head: '', bare: false };
    } else if (line.startsWith('HEAD ') && current) {
      current.head = line.slice(5);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice(7).replace('refs/heads/', '');
    } else if (line === 'bare' && current) {
      current.bare = true;
    } else if (line === '' && current) {
      worktrees.push(current);
      current = null;
    }
  }
  if (current) worktrees.push(current);

  return worktrees;
}
