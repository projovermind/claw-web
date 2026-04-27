import path from 'node:path';
import fssync from 'node:fs';
import fs from 'node:fs/promises';

/**
 * 백엔드/계정의 configDir 을 결정. 비어있으면 자동 폴백 경로 생성.
 *
 * 폴백 규칙: ~/.claude-claw/account-{id}
 *  - 동일 호스트 내에서 백엔드별 격리 보장 (macOS keychain 충돌 회피)
 *  - 신규 가입자나 configDir 미설정 레거시 백엔드 모두 자동 처리
 *
 * @param {string} id      backend / account id
 * @param {string|null|undefined} configDir  현재 설정값 (선택)
 * @returns {string}  실제 사용 경로 (절대경로)
 */
export function resolveConfigDir(id, configDir) {
  if (configDir && configDir.trim()) return configDir;
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return path.join(home, '.claude-claw', `account-${id}`);
}

/**
 * configDir 폴백 경로를 보장 (없으면 생성). sync 버전.
 * 멱등 — 이미 있으면 no-op.
 */
export function ensureConfigDirSync(dir) {
  if (!dir) return false;
  if (fssync.existsSync(dir)) return true;
  try {
    fssync.mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * configDir 폴백 경로를 보장 (없으면 생성). async 버전.
 */
export async function ensureConfigDir(dir) {
  if (!dir) return false;
  try {
    await fs.mkdir(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
