/**
 * CARL Auto Learner — 분석된 룰을 .carl/carl.json의 auto-learned 도메인에 추가
 *
 * 조건:
 *   - confidence >= 0.8 인 룰만 적용
 *   - 도메인당 최대 20개 룰 (오래된 것 제거)
 *   - 중복 룰 텍스트 방지
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

const CARL_FOLDER = '.carl';
const CARL_JSON = 'carl.json';
const MAX_RULES_PER_DOMAIN = 20;
const MIN_CONFIDENCE = 0.8;

/**
 * workingDir에서 .carl/carl.json 탐색 (carl-injector.js와 동일한 로직)
 */
function findCarlJson(workingDir) {
  if (!workingDir) return null;
  let dir = workingDir;
  for (let i = 0; i < 10; i++) {
    const p = path.join(dir, CARL_FOLDER, CARL_JSON);
    if (fssync.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const globalPath = path.join(process.env.HOME || '', CARL_FOLDER, CARL_JSON);
  if (fssync.existsSync(globalPath)) return globalPath;
  return null;
}

/**
 * carl.json 파일에서 auto-learned 도메인에 룰 추가
 *
 * @param {string} workingDir
 * @param {Array<{domain: string, rule: string, confidence: number, recall: string[]}>} carlRules
 */
export async function learnCarlRules(workingDir, carlRules) {
  if (!carlRules || carlRules.length === 0) return;

  // confidence 필터링
  const eligible = carlRules.filter((r) => (r.confidence ?? 0) >= MIN_CONFIDENCE);
  if (eligible.length === 0) return;

  try {
    const carlPath = findCarlJson(workingDir);
    if (!carlPath) {
      logger.debug({ workingDir }, 'carl-auto-learner: carl.json not found, skipping');
      return;
    }

    const raw = await fs.readFile(carlPath, 'utf8');
    const carl = JSON.parse(raw);

    if (!carl.domains) carl.domains = {};

    // auto-learned 도메인이 없으면 생성
    const AUTO_DOMAIN = 'auto-learned';
    if (!carl.domains[AUTO_DOMAIN]) {
      carl.domains[AUTO_DOMAIN] = {
        state: 'active',
        always_on: false,
        recall: [],
        rules: [],
        decisions: []
      };
    }

    const autoDomain = carl.domains[AUTO_DOMAIN];
    if (!Array.isArray(autoDomain.rules)) autoDomain.rules = [];
    if (!Array.isArray(autoDomain.recall)) autoDomain.recall = [];

    let added = 0;

    for (const r of eligible) {
      const ruleText = (r.rule || '').trim();
      if (!ruleText) continue;

      // 중복 확인 (텍스트 정규화 비교)
      const normalized = ruleText.toLowerCase();
      const isDuplicate = autoDomain.rules.some(
        (existing) => (existing.text || existing || '').toLowerCase() === normalized
      );
      if (isDuplicate) continue;

      // 새 룰 추가
      autoDomain.rules.push({
        text: ruleText,
        confidence: r.confidence,
        source: 'auto-learned',
        addedAt: new Date().toISOString()
      });

      // recall 키워드 병합 (중복 제거)
      if (Array.isArray(r.recall)) {
        for (const kw of r.recall) {
          if (kw && !autoDomain.recall.includes(kw.toLowerCase())) {
            autoDomain.recall.push(kw.toLowerCase());
          }
        }
      }

      added++;
    }

    if (added === 0) return;

    // 최대 20개 제한 — 오래된 것(앞쪽) 제거
    if (autoDomain.rules.length > MAX_RULES_PER_DOMAIN) {
      autoDomain.rules = autoDomain.rules.slice(autoDomain.rules.length - MAX_RULES_PER_DOMAIN);
    }

    // atomic write
    const tmp = carlPath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(carl, null, 2), 'utf8');
    await fs.rename(tmp, carlPath);

    logger.info(
      { carlPath, added, total: autoDomain.rules.length },
      'carl-auto-learner: rules added'
    );
  } catch (err) {
    logger.debug({ err: err.message, workingDir }, 'carl-auto-learner: failed (non-fatal)');
  }
}
