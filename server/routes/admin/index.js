/**
 * Admin Router — 서버 관리 작업 (재시작, 업데이트, Claude CLI, Named Tunnel)
 *
 * 엔드포인트:
 *   GET  /update/check
 *   POST /update/install
 *   POST /update/patch
 *   GET  /claude/status
 *   POST /claude/install
 *   POST /claude/login
 *   POST /restart
 *   GET  /tunnel/cf/status
 *   POST /tunnel/cf/login
 *   POST /tunnel/cf/setup
 *   POST /tunnel/cf/teardown
 */
import { Router } from 'express';
import { registerUpdateRoutes } from './update.js';
import { registerClaudeRoutes } from './claude.js';
import { registerRestartRoute } from './restart.js';
import { registerTunnelCfRoutes } from './tunnel-cf.js';

export function createAdminRouter({ runner, eventBus }) {
  const router = Router();

  registerUpdateRoutes(router, { eventBus });
  registerClaudeRoutes(router, { eventBus });
  registerRestartRoute(router, { runner });
  registerTunnelCfRoutes(router);

  return router;
}
