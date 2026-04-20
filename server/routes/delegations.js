import { Router } from 'express';

export function createDelegationsRouter({ delegationTracker }) {
  const router = Router();
  router.get('/', (req, res) => res.json({ delegations: delegationTracker.list() }));
  return router;
}
