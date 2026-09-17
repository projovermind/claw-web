import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler.js';
import { createBackendUsageReader } from '../lib/backend-usage.js';
import { normalizeTiers } from '../lib/model-tiers.js';
import { logger } from '../lib/logger.js';

const createSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i),
  // anthropic-compatible: Claude CLI talks to it via ANTHROPIC_BASE_URL +
  // ANTHROPIC_AUTH_TOKEN (e.g. Z.AI Coding Plan). openai-compatible: a
  // separate OpenAI-shaped endpoint (kept for future direct-call use).
  type: z.enum(['openai-compatible', 'anthropic-compatible']),
  label: z.string().min(1).max(80),
  baseURL: z.string().url(),
  envKey: z.string().min(1).max(80),
  models: z.record(z.string()),
  // 티어(상/중/하) → 모델 ID. models 와 별개 — 이쪽이 modelTier 해석에 쓰인다.
  tierModels: z.record(z.string()).optional(),
  // Optional: if provided, we also store the actual key value in the
  // secrets store (and inject into process.env) — user can paste the key
  // directly in the UI instead of fiddling with shell env vars.
  secret: z.string().min(1).max(500).optional()
}).strict();

const updateSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  baseURL: z.string().url().optional(),
  envKey: z.string().min(1).max(80).optional(),
  models: z.record(z.string()).optional(),
  // 티어 이름 → 모델 ID. 키는 backends.json 의 tiers.order 에 있는 값.
  tierModels: z.record(z.string()).optional(),
  // 모델 id → 컨텍스트 창(토큰). 휴리스틱(context-window.js)보다 우선한다.
  // 새 모델이 나왔는데 휴리스틱이 아직 모를 때 코드 수정 없이 교정하는 통로.
  contextWindows: z.record(z.number().int().positive()).optional(),
  // 이 백엔드가 실패했을 때 대신 쓸 백엔드 id. 전역 fallbackBackend 보다 우선.
  fallback: z.string().max(64).nullable().optional()
}).strict();

const fallbackSchema = z.object({
  backendId: z.string().max(64).nullable()
}).strict();

const tiersSchema = z.object({
  // 표시 순서 = 성능 내림차순. 강등은 이 순서를 따라 아래로 내려간다.
  order: z.array(z.string().min(1).max(32).regex(/^[a-z0-9_-]+$/i)).min(1).max(12),
  labels: z.record(z.string().min(1).max(40)).optional(),
  // 티어 → 백엔드 id. null/빈 값 = 그 티어는 전역 백엔드를 따른다.
  backends: z.record(z.string().max(64).nullable()).optional()
}).strict();

const applyToAgentsSchema = z.object({
  // null = 상속 (에이전트에서 backendId 를 지워 전역 active 백엔드를 따르게 함).
  // 생략하면 backendId 는 손대지 않는다 — modelTier 만 일괄 적용할 때 쓴다.
  backendId: z.string().max(64).nullable().optional(),
  // null = 티어 지정 해제(기존 model 설정을 따름)
  modelTier: z.string().max(32).nullable().optional(),
  // 지정 시 해당 프로젝트 소속 에이전트만 대상
  projectId: z.string().max(128).optional(),
  // { agentId: backendId|null } — 이전 상태를 그대로 되돌린다. 주면 backendId 는 무시.
  restore: z.record(z.string().max(64).nullable()).optional(),
  // { agentId: modelTier|null } — previousTiers 를 그대로 되쏘면 티어가 복구된다.
  restoreTiers: z.record(z.string().max(32).nullable()).optional()
}).strict().refine(
  (b) => b.backendId !== undefined || b.modelTier !== undefined || b.restore || b.restoreTiers,
  { message: 'backendId 또는 modelTier 중 하나는 있어야 합니다' }
);

const secretSchema = z.object({
  // Pass empty string or null to clear; otherwise this becomes the new value.
  value: z.string().max(500).nullable()
}).strict();

const revealSchema = z.object({
  // Re-auth — must match webConfig.auth.token. Required even when auth is
  // disabled globally, so revealing a stored secret always demands at least
  // the configured token (matches the auth model — if no token is set, the
  // server has no way to verify identity and will refuse).
  password: z.string().min(1).max(500)
}).strict();

/**
 * 원클릭 등록용 백엔드 프리셋.
 *
 * 모두 `anthropic-compatible` — Claude CLI 가 ANTHROPIC_BASE_URL +
 * ANTHROPIC_AUTH_TOKEN 으로 말을 거는 게이트웨이다. 실제 모델은 게이트웨이가
 * 뒤에서 고르며, 우리 쪽은 opus/sonnet/haiku 티어 이름만 매핑해 준다.
 *
 * 주의: 게이트웨이 경유 시 thinkingEffort 는 주입되지 않는다
 * (claude-cli-runner.js — ANTHROPIC_BASE_URL 이 있으면 스킵).
 */
export const BACKEND_PRESETS = [
  {
    id: 'omniroute',
    label: 'OmniRoute (로컬 게이트웨이)',
    desc: '로컬 :20128 게이트웨이로 무료 티어 모델을 쓴다. 클로드 구독 없이 claw-web 을 시험해 보는 용도. 실제 Claude 모델이 아니다.',
    warn: 'scripts/omniroute-setup.sh 로 설치·상주·키 발급까지 한 번에 된다. 외부 제공자로 프롬프트가 나가므로 운영 데이터 에이전트에는 붙이지 말 것.',
    backend: {
      type: 'anthropic-compatible',
      label: 'OmniRoute',
      baseURL: 'http://localhost:20128',
      envKey: 'OMNIROUTE_TOKEN',
      // 무료로 키 없이 붙고 실제로 tool_use 블록을 내보내는 것만 남겼다.
      // 제공자 접두사가 곧 OmniRoute 의 provider 이름이라 'claude/...' 류는 401 이 난다.
      // 검증 방법: scripts/omniroute-probe.mjs
      models: {
        auto: 'auto',                                          // 게이트웨이 자동 선택 (= big-pickle)
        'big-pickle': 'oc/big-pickle',                          // 주력 — 가장 빠르고 정확
        'mimo-2.5': 'oc/mimo-v2.5-free',
        'muse-spark-1.2': 'oc/muse-spark-1.2-contributor-free',
        // GLM-5.2 는 답변 품질은 좋지만 이 경로에서 tool_use 를 못 내보낸다(대화 전용).
        'glm-5.2-chat': 'cfp/zai-org/glm-5.2'
      },
      // 티어는 셋 다 big-pickle — 이 게이트웨이에서 tool_use 를 확실히 내보내는
      // 유일한 주력 모델이다. 급을 나눌 만큼 성능대가 갈리는 모델이 없다.
      tierModels: { high: 'oc/big-pickle', middle: 'oc/big-pickle', low: 'oc/big-pickle' }
    }
  },
  {
    id: 'zai',
    label: 'Z.AI Coding Plan',
    desc: 'GLM 코딩 플랜. 저부가 에이전트(요약·분류·로그 파싱)용 절약 백엔드.',
    warn: 'ZAI_API_KEY 를 등록 후 설정해야 실제로 붙는다.',
    backend: {
      type: 'anthropic-compatible',
      label: 'Z.AI (GLM)',
      baseURL: 'https://api.z.ai/api/anthropic',
      envKey: 'ZAI_API_KEY',
      // z.ai 공식 문서(docs.z.ai/devpack/latest-model) 기준 현행 코딩 플랜 모델.
      // glm-5.3 = 텍스트 전용 주력, glm-5.3-flash = 멀티모달/경량.
      models: { opus: 'glm-5.3', sonnet: 'glm-5.3', haiku: 'glm-5.3-flash' },
      tierModels: { high: 'glm-5.3', middle: 'glm-5.3', low: 'glm-5.3-flash' }
    }
  }
];

export function createBackendsRouter({ backendsStore, eventBus, webConfig, configStore, metadataStore, usageReader }) {
  const router = Router();
  const usage = usageReader ?? createBackendUsageReader({ backendsStore });

  router.get('/', (req, res) => {
    res.json(backendsStore.getPublic());
  });

  // 백엔드별 사용량(5시간/7일 창 + 추가 크레딧). 백엔드의 configDir 에 붙은
  // Claude CLI OAuth 토큰으로 조회하며, 결과는 60초 캐시된다. `?force=1` 로 무효화.
  // 토큰 자체는 응답에 담기지 않는다.
  router.get('/usage', async (req, res, next) => {
    try {
      const force = req.query.force === '1' || req.query.force === 'true';
      res.json({ backends: await usage.getAll({ force }), fetchedAt: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const data = createSchema.parse(req.body);
      const { id, secret, ...fields } = data;
      await backendsStore.createBackend(id, fields);
      if (secret && fields.envKey) {
        await backendsStore.setSecret(id, secret);
      }
      if (eventBus) eventBus.publish('backends.updated', {});
      res.status(201).json(backendsStore.getPublic().backends[id]);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      if (err.code === 'DUPLICATE') return next(new HttpError(409, err.message, 'DUPLICATE'));
      next(err);
    }
  });

  // Dedicated endpoint for setting/clearing a backend's secret. Separate from
  // PATCH / (which handles non-sensitive config fields) so the UI can
  // confidently show a password input without worrying about accidentally
  // including the secret in normal patches.
  router.put('/:id/secret', async (req, res, next) => {
    try {
      const { value } = secretSchema.parse(req.body);
      if (!backendsStore.getBackend(req.params.id)) {
        throw new HttpError(404, 'Backend not found', 'BACKEND_NOT_FOUND');
      }
      await backendsStore.setSecret(req.params.id, value || null);
      if (eventBus) eventBus.publish('backends.updated', {});
      res.json(backendsStore.getPublic().backends[req.params.id]);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      if (err.message?.includes('no envKey')) {
        return next(new HttpError(400, err.message, 'NO_ENVKEY'));
      }
      next(err);
    }
  });

  // Reveal stored secret/OAuth for a backend after re-authenticating with the
  // server's auth token. Returns the raw values (e.g. `sk-ant-api03-...`) so
  // the user can copy them. We deliberately require `webConfig.auth.token` to
  // be set — without it, there is no way to verify the requester's identity.
  router.post('/:id/reveal', async (req, res, next) => {
    try {
      const { password } = revealSchema.parse(req.body);
      const expected = webConfig?.auth?.token;
      if (!expected) {
        throw new HttpError(
          503,
          '서버에 인증 토큰이 설정되지 않아 토큰을 노출할 수 없습니다. 설정 > 보안에서 토큰을 먼저 설정하세요.',
          'AUTH_NOT_CONFIGURED'
        );
      }
      if (password !== expected) {
        throw new HttpError(403, '비밀번호가 일치하지 않습니다', 'BAD_PASSWORD');
      }
      if (!backendsStore.getBackend(req.params.id)) {
        throw new HttpError(404, 'Backend not found', 'BACKEND_NOT_FOUND');
      }
      const backend = backendsStore.getBackend(req.params.id);
      const secret = backendsStore.getSecretValue(req.params.id);
      const oauthToken = backendsStore.getOAuthToken(req.params.id);
      const claudeCreds = backendsStore.getClaudeCliCreds(req.params.id);
      // For convenience, also expose well-known process.env API keys so the
      // user can copy the value the runner will actually inject. Only
      // includes keys that are SET — never reports `null` / `undefined`.
      const envCandidates = backend?.envKey
        ? [backend.envKey]
        : ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
      const env = {};
      for (const k of envCandidates) {
        if (process.env[k]) env[k] = process.env[k];
      }
      res.json({
        secret,
        oauthToken,
        claudeCreds,
        env: Object.keys(env).length ? env : null
      });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  // PATCH 와 PUT 은 같은 핸들러 — 둘 다 부분 갱신이다(주지 않은 필드는 보존).
  const updateHandler = async (req, res, next) => {
    try {
      const data = updateSchema.parse(req.body);
      if (!backendsStore.getBackend(req.params.id)) {
        throw new HttpError(404, 'Backend not found', 'BACKEND_NOT_FOUND');
      }
      await backendsStore.updateBackend(req.params.id, data);
      if (eventBus) eventBus.publish('backends.updated', {});
      res.json(backendsStore.getPublic().backends[req.params.id]);
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  };
  router.patch('/:id', updateHandler);
  router.put('/:id', updateHandler);

  router.delete('/:id', async (req, res, next) => {
    try {
      if (!backendsStore.getBackend(req.params.id)) {
        throw new HttpError(404, 'Backend not found', 'BACKEND_NOT_FOUND');
      }
      await backendsStore.deleteBackend(req.params.id);
      if (eventBus) eventBus.publish('backends.updated', {});
      res.status(204).end();
    } catch (err) {
      if (err.code === 'PROTECTED') return next(new HttpError(400, err.message, 'PROTECTED'));
      next(err);
    }
  });

  router.post('/active', async (req, res, next) => {
    try {
      const { backendId } = z.object({ backendId: z.string() }).parse(req.body);
      await backendsStore.setActive(backendId);
      if (eventBus) eventBus.publish('backends.updated', {});
      res.json({ activeBackend: backendId });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  // 전역 폴백 백엔드 지정/해제.
  router.post('/fallback', async (req, res, next) => {
    try {
      const { backendId } = fallbackSchema.parse(req.body);
      const fallbackBackend = await backendsStore.setFallbackBackend(backendId);
      if (eventBus) eventBus.publish('backends.updated', {});
      res.json({ fallbackBackend });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      if (/^Unknown backend /.test(err.message ?? '')) {
        return next(new HttpError(404, err.message, 'BACKEND_NOT_FOUND'));
      }
      next(err);
    }
  });

  // 티어 체계 통째 저장 (추가/이름변경/삭제 모두 이 한 경로). 백엔드의 tierModels
  // 는 건드리지 않으므로, 지운 티어를 되살리면 매핑도 그대로 살아난다.
  router.post('/tiers', async (req, res, next) => {
    try {
      const body = tiersSchema.parse(req.body);
      // 등록되지 않은 백엔드를 가리키는 티어는 저장을 거부하는 대신 버린다 —
      // 백엔드 하나가 사라졌다고 티어 이름 변경까지 통째로 막히면 안 된다.
      const backends = {};
      for (const [tier, id] of Object.entries(body.backends ?? {})) {
        if (typeof id !== 'string' || !id.trim()) continue;
        if (!backendsStore.getBackend(id.trim())) {
          logger.warn({ tier, backendId: id }, 'tiers: 등록되지 않은 백엔드 id — 무시');
          continue;
        }
        backends[tier] = id.trim();
      }
      const tiers = await backendsStore.setTiers({ ...body, backends });
      if (eventBus) eventBus.publish('backends.updated', {});
      res.json({ tiers });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  // 모든 에이전트의 backendId 를 한 번에 바꾼다. 응답의 previous 맵을 그대로
  // restore 로 다시 POST 하면 원상복구된다 (실수했을 때의 탈출구).
  router.post('/apply-to-agents', async (req, res, next) => {
    try {
      if (!configStore) throw new HttpError(503, 'config store not available', 'NO_CONFIG_STORE');
      const { backendId, modelTier, projectId, restore, restoreTiers } = applyToAgentsSchema.parse(req.body);
      if (backendId != null && !backendsStore.getBackend(backendId)) {
        throw new HttpError(404, `Backend ${backendId} not found`, 'BACKEND_NOT_FOUND');
      }
      // 등록되지 않은 티어를 박아 두면 런타임에 조용히 models.default 로 새어
      // "적용했는데 아무것도 안 바뀐" 상태가 된다 → 여기서 막는다.
      // getPublic() 은 백엔드마다 cred 파일을 뒤지므로 여기선 raw + 정규화로 충분하다.
      const knownTiers = normalizeTiers(backendsStore.getRaw()?.tiers).order;
      const badTier = [modelTier, ...Object.values(restoreTiers ?? {})]
        .find((t) => t != null && !knownTiers.includes(t));
      if (badTier) {
        throw new HttpError(404, `Tier ${badTier} not found`, 'TIER_NOT_FOUND');
      }

      const touchBackend = backendId !== undefined || !!restore;
      const touchTier = modelTier !== undefined || !!restoreTiers;

      const agents = configStore.getAgents() ?? {};
      const restoreMap = restore ?? restoreTiers ?? null;
      const targets = restoreMap
        ? Object.keys(restoreMap).filter((id) => agents[id])
        : Object.keys(agents).filter((id) => {
            if (!projectId) return true;
            return metadataStore?.getAgent(id)?.projectId === projectId;
          });

      const previous = {};
      const previousTiers = {};
      const changed = [];
      for (const id of targets) {
        const patch = {};
        if (touchBackend) {
          // accountId 는 backendId 의 구버전 별칭인데 계정 스케줄러에서는 오히려
          // 우선순위가 높다. 남겨두면 backendId 만 바꿔도 실제 spawn 은 옛 계정으로
          // 가므로, 실효값을 previous 에 담고 적용 시엔 제거한다.
          const before = agents[id]?.backendId ?? agents[id]?.accountId ?? null;
          const after = restore ? (restore[id] ?? null) : backendId;
          previous[id] = before;
          if (before !== after || agents[id]?.accountId != null) {
            patch.backendId = after;
            patch.accountId = null;
          }
        }
        if (touchTier) {
          const beforeTier = agents[id]?.modelTier ?? null;
          const afterTier = restoreTiers ? (restoreTiers[id] ?? null) : modelTier;
          previousTiers[id] = beforeTier;
          if (beforeTier !== afterTier) patch.modelTier = afterTier;
        }
        if (Object.keys(patch).length === 0) continue;
        // config.json 은 파일 락 하나를 공유하므로 순차 갱신. 병렬로 돌리면
        // 락 재시도 폭주로 오히려 느려지고 일부가 조용히 유실된다.
        await configStore.updateAgent(id, patch);
        changed.push(id);
      }

      if (eventBus && changed.length) eventBus.publish('agents.updated', {});
      res.json({
        applied: restore ? 'restore' : (backendId ?? null),
        appliedTier: restoreTiers ? 'restore' : (modelTier ?? null),
        scope: projectId ?? 'all',
        total: targets.length,
        // updated 는 클라이언트 토스트가 읽는 실제 변경 건수. changed 는 대상 id 목록.
        updated: changed.length,
        changed,
        previous,
        previousTiers
      });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      next(err);
    }
  });

  // ── 원클릭 프리셋 ──
  router.get('/presets', (_req, res) => {
    const existing = backendsStore.getRaw()?.backends ?? {};
    res.json({
      presets: BACKEND_PRESETS.map((p) => ({ ...p, installed: !!existing[p.id] }))
    });
  });

  router.post('/presets/:id/apply', async (req, res, next) => {
    try {
      const preset = BACKEND_PRESETS.find((p) => p.id === req.params.id);
      if (!preset) throw new HttpError(404, 'Preset not found', 'PRESET_NOT_FOUND');
      // 이미 있는 백엔드를 덮어쓰면 사용자가 맞춰 둔 모델 매핑/키가 소리 없이 날아간다.
      await backendsStore.createBackend(preset.id, { ...preset.backend });
      if (eventBus) eventBus.publish('backends.updated', {});
      res.status(201).json(backendsStore.getPublic().backends[preset.id]);
    } catch (err) {
      if (err.code === 'DUPLICATE') {
        return next(new HttpError(409, `백엔드 "${req.params.id}" 가 이미 있습니다`, 'DUPLICATE'));
      }
      next(err);
    }
  });

  router.post('/austerity', async (req, res, next) => {
    try {
      const { enabled, backendId } = z
        .object({ enabled: z.boolean(), backendId: z.string().optional() })
        .parse(req.body);
      await backendsStore.setAusterity(enabled, backendId);
      if (eventBus) eventBus.publish('backends.updated', {});
      res.json({ austerityMode: enabled });
    } catch (err) {
      if (err.name === 'ZodError') return next(new HttpError(400, 'Invalid body', 'INVALID_BODY'));
      // 기본 austerityBackend 는 'zai' 인데 그 백엔드를 등록한 적이 없으면
      // 여기서 터진다. 원인을 알 수 없는 500 대신 할 일을 알려 준다.
      if (/^Unknown backend /.test(err.message ?? '')) {
        return next(new HttpError(
          400,
          `절약 모드 대상 백엔드가 등록되어 있지 않습니다. 설정 > 백엔드에서 프리셋으로 먼저 추가하세요. (${err.message})`,
          'AUSTERITY_BACKEND_MISSING'
        ));
      }
      next(err);
    }
  });

  return router;
}
