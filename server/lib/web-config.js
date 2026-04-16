import fs from 'node:fs';

const DEFAULTS = {
  port: 3838,
  features: {
    dashboard: true,
    agentsPage: true,
    dragAndDrop: true,
    chat: true,
    activityFeed: true,
    mdEditor: false,
    logsViewer: false,
    tokenManager: false
  },
  auth: { enabled: false, token: null }
};

export function loadWebConfig(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    ...DEFAULTS,
    ...parsed,
    features: { ...DEFAULTS.features, ...(parsed.features ?? {}) },
    auth: { ...DEFAULTS.auth, ...(parsed.auth ?? {}) }
  };
}
