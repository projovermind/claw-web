import fs from 'node:fs/promises';
import fssync from 'node:fs';
import EventEmitter from 'node:events';
import { timingSafeEqual } from 'node:crypto';
import lockfile from 'proper-lockfile';

/**
 * 인스턴스 연합 레지스트리 — 크로스호스트 위임의 주소록.
 *
 * `backends-store.js` 와 같은 패턴(원자적 쓰기 + 인메모리 캐시)을 따른다.
 * 토큰은 UI 인증 토큰과 **분리**된다:
 *  - `instances[id].token` — 내가 그 인스턴스에 보낼 때 쓰는 아웃바운드 토큰
 *  - `inboundTokens[originId]` — 그 인스턴스가 나에게 들어올 때 검증할 토큰
 * 둘은 서로 다른 값일 수 있다(방향별 발급).
 */

const EMPTY = () => ({
  version: 1,
  // 이 인스턴스 자신의 식별자. 에이전트의 `host` 가 이 값이면 로컬 실행.
  selfId: 'self',
  // 콜백 URL 의 베이스. 비어 있으면 원격 위임을 거부한다 — 회신 받을 주소가
  // 없는 채로 보내면 결과가 영영 안 돌아온다.
  selfPublicUrl: null,
  instances: {},
  inboundTokens: {}
});

/** 길이가 달라도 타이밍 차이가 새지 않는 토큰 비교 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export async function createInstancesStore(filePath) {
  const emitter = new EventEmitter();

  if (!fssync.existsSync(filePath)) {
    await fs.writeFile(filePath, JSON.stringify(EMPTY(), null, 2));
  }

  async function read() {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return { ...EMPTY(), ...JSON.parse(raw) };
    } catch {
      return EMPTY();
    }
  }

  let cache = await read();

  async function writeWithLock(mutator) {
    const release = await lockfile.lock(filePath, { retries: { retries: 10, minTimeout: 100 } });
    try {
      const current = await read();
      const next = mutator(current);
      const tmp = filePath + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(next, null, 2));
      await fs.rename(tmp, filePath);
      cache = next;
      emitter.emit('change', cache);
      return next;
    } finally {
      await release();
    }
  }

  /** 토큰은 절대 그대로 내보내지 않는다 — 설정돼 있는지만 알린다. */
  function maskInstance(id, inst) {
    return {
      id,
      label: inst.label ?? id,
      baseUrl: inst.baseUrl ?? null,
      tokenSet: !!inst.token,
      inboundTokenSet: !!cache.inboundTokens?.[id],
      enabled: inst.enabled !== false,
      platform: inst.platform ?? null,
      lastHealthAt: inst.lastHealthAt ?? null,
      health: inst.health ?? null
    };
  }

  return {
    getRaw: () => cache,
    getSelfId: () => cache.selfId ?? 'self',
    getSelfPublicUrl: () => cache.selfPublicUrl || null,
    getInstance: (id) => cache.instances?.[id] ?? null,
    onChange: (cb) => emitter.on('change', cb),

    getPublic() {
      return {
        selfId: cache.selfId ?? 'self',
        selfPublicUrl: cache.selfPublicUrl || null,
        instances: Object.entries(cache.instances ?? {}).map(([id, inst]) => maskInstance(id, inst))
      };
    },

    async setSelf({ selfId, selfPublicUrl } = {}) {
      await writeWithLock((current) => {
        if (selfId !== undefined) current.selfId = selfId || 'self';
        if (selfPublicUrl !== undefined) current.selfPublicUrl = selfPublicUrl || null;
        return current;
      });
      return { selfId: cache.selfId, selfPublicUrl: cache.selfPublicUrl };
    },

    async createInstance(id, data) {
      const { inboundToken, ...rest } = data ?? {};
      await writeWithLock((current) => {
        current.instances = current.instances ?? {};
        if (current.instances[id]) {
          const err = new Error(`Instance ${id} exists`);
          err.code = 'DUPLICATE';
          throw err;
        }
        current.instances[id] = { enabled: true, ...rest };
        if (inboundToken) {
          current.inboundTokens = current.inboundTokens ?? {};
          current.inboundTokens[id] = inboundToken;
        }
        return current;
      });
      return maskInstance(id, cache.instances[id]);
    },

    async updateInstance(id, patch) {
      const { inboundToken, ...rest } = patch ?? {};
      await writeWithLock((current) => {
        if (!current.instances?.[id]) {
          const err = new Error(`Instance ${id} not found`);
          err.code = 'NOT_FOUND';
          throw err;
        }
        current.instances[id] = { ...current.instances[id], ...rest };
        if (inboundToken !== undefined) {
          current.inboundTokens = current.inboundTokens ?? {};
          if (inboundToken === null || inboundToken === '') delete current.inboundTokens[id];
          else current.inboundTokens[id] = inboundToken;
        }
        return current;
      });
      return maskInstance(id, cache.instances[id]);
    },

    async deleteInstance(id) {
      await writeWithLock((current) => {
        if (current.instances) delete current.instances[id];
        // 인바운드 토큰도 같이 지운다 — 남겨두면 지운 인스턴스가 계속 들어올 수 있다.
        if (current.inboundTokens) delete current.inboundTokens[id];
        return current;
      });
    },

    /**
     * 임의의 origin id 에 대한 인바운드 토큰 설정/해제. 인스턴스 등록과 별개다 —
     * origin 이 스스로를 부르는 id(selfId)가 내가 그 인스턴스를 등록한 id 와
     * 다를 수 있다(루프백이 그 경우다).
     */
    async setInboundToken(originId, token) {
      await writeWithLock((current) => {
        current.inboundTokens = current.inboundTokens ?? {};
        if (token === null || token === '') delete current.inboundTokens[originId];
        else current.inboundTokens[originId] = token;
        return current;
      });
    },

    /** 헬스체크 결과 기록. 위임 전 게이트가 이 값을 읽는다. */
    async recordHealth(id, health) {
      await writeWithLock((current) => {
        if (!current.instances?.[id]) return current;
        current.instances[id] = {
          ...current.instances[id],
          lastHealthAt: Date.now(),
          health
        };
        return current;
      });
      return cache.instances?.[id]?.health ?? null;
    },

    /**
     * 들어온 연합 요청의 자격 검증. `X-Claw-Origin` 이 가리키는 인스턴스에
     * 대해 발급해 둔 인바운드 토큰과 일치해야 한다. UI 토큰으로는 통과할 수 없다.
     */
    verifyInbound(originId, token) {
      if (!originId || !token) return false;
      const expected = cache.inboundTokens?.[originId];
      if (!expected) return false;
      return safeEqual(token, expected);
    },

    async close() {
      emitter.removeAllListeners();
    }
  };
}
