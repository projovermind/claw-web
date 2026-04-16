/**
 * CARL Injector — carl.json 기반 컨텍스트 규칙 자동 주입
 *
 * Python hook (carl_v2_hook.py)의 핵심 로직을 Node.js로 포팅.
 * 매 채팅 메시지마다 키워드 매칭 → 시스템 프롬프트에 규칙 주입.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

const CARL_FOLDER = '.carl';
const CARL_JSON = 'carl.json';

/**
 * workingDir에서 .carl/carl.json 찾기 (상위 디렉토리 탐색)
 */
function findCarlJson(workingDir) {
  if (!workingDir) return null;
  let dir = workingDir;
  for (let i = 0; i < 10; i++) {
    const p = path.join(dir, CARL_FOLDER, CARL_JSON);
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 글로벌 ~/.carl/carl.json 폴백
  const globalPath = path.join(process.env.HOME || '', CARL_FOLDER, CARL_JSON);
  if (fs.existsSync(globalPath)) return globalPath;
  return null;
}

/**
 * 유저 메시지에서 도메인 키워드 매칭
 */
function matchDomains(domains, userMessage) {
  const msg = userMessage.toLowerCase();
  const matched = [];

  for (const [name, domain] of Object.entries(domains)) {
    if (domain.state !== 'active') continue;
    if (domain.always_on) continue; // always_on은 별도 수집

    // exclude 체크
    const excluded = (domain.exclude || []).some(ex => msg.includes(ex.toLowerCase()));
    if (excluded) continue;

    // recall 키워드 매칭
    const recalls = domain.recall || [];
    const hit = recalls.some(keyword => msg.includes(keyword.toLowerCase()));
    if (hit) matched.push(name);
  }

  return matched;
}

/**
 * CARL 컨텍스트 빌드
 *
 * @param {string} workingDir - 에이전트 작업 디렉토리
 * @param {string} userMessage - 유저 메시지
 * @returns {string|null} - 주입할 컨텍스트 블록 또는 null
 */
export function buildCarlContext(workingDir, userMessage) {
  try {
    const carlPath = findCarlJson(workingDir);
    if (!carlPath) return null;

    const carl = JSON.parse(fs.readFileSync(carlPath, 'utf8'));
    const domains = carl.domains || {};

    // 1. always_on 도메인 수집
    const alwaysOnRules = [];
    for (const [name, domain] of Object.entries(domains)) {
      if (domain.state !== 'active' || !domain.always_on) continue;
      for (const rule of (domain.rules || [])) {
        alwaysOnRules.push(rule.text || rule);
      }
    }

    // 2. 키워드 매칭된 도메인 수집
    const matchedNames = matchDomains(domains, userMessage);
    const matchedRules = [];
    const matchedDecisions = [];

    for (const name of matchedNames) {
      const domain = domains[name];
      for (const rule of (domain.rules || [])) {
        matchedRules.push({ domain: name, text: rule.text || rule });
      }
      for (const decision of (domain.decisions || [])) {
        matchedDecisions.push({ domain: name, text: decision.text || decision });
      }
    }

    // 아무것도 없으면 null
    if (alwaysOnRules.length === 0 && matchedRules.length === 0) return null;

    // 3. 컨텍스트 블록 포맷
    const parts = ['<carl-context>'];

    if (alwaysOnRules.length > 0) {
      parts.push('## Global Rules');
      for (const r of alwaysOnRules) {
        parts.push(`- ${r}`);
      }
    }

    if (matchedRules.length > 0) {
      parts.push('');
      parts.push(`## Active Rules (${matchedNames.join(', ')})`);
      for (const r of matchedRules) {
        parts.push(`- [${r.domain}] ${r.text}`);
      }
    }

    if (matchedDecisions.length > 0) {
      parts.push('');
      parts.push('## Decisions');
      for (const d of matchedDecisions) {
        parts.push(`- [${d.domain}] ${d.text}`);
      }
    }

    parts.push('</carl-context>');

    const result = parts.join('\n');
    logger.debug({ matched: matchedNames, rules: alwaysOnRules.length + matchedRules.length }, 'carl: injected');
    return result;
  } catch (err) {
    logger.debug({ err: err.message }, 'carl: injection failed (non-fatal)');
    return null;
  }
}
