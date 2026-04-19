/**
 * Legacy cleanup — 구버전(v1.2.57 이전)에서 남긴 찌꺼기 제거.
 *
 * 발견된 증상: 구 installer 가 심은 `com.hivemind.cloudflared` LaunchAgent +
 * `~/bin/cloudflared-start.sh` wrapper 가 새 `com.claw-web.tunnel` 과 같은
 * `claw-web` named tunnel 에 동시 connector 로 붙어 Cloudflare edge 가
 * 간헐적으로 404 를 반환함. 두 wrapper 가 동시 구동되면 connector 가 2배로
 * 생겨 Cloudflare 가 어느 connector 로 라우팅할지 혼란 → 404 확률 상승.
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const LEGACY_LABEL = 'com.hivemind.cloudflared';
const LEGACY_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LEGACY_LABEL}.plist`);
const LEGACY_WRAPPER = path.join(os.homedir(), 'bin', 'cloudflared-start.sh');

export async function cleanupLegacyCloudflared() {
  try {
    const plistExists = fssync.existsSync(LEGACY_PLIST);
    const wrapperExists = fssync.existsSync(LEGACY_WRAPPER);
    if (!plistExists && !wrapperExists) return { skipped: 'none-found' };

    logger.info({ plistExists, wrapperExists }, 'legacy-cleanup: removing old cloudflared wrapper');

    // launchctl bootout (있으면)
    try {
      const uid = os.userInfo().uid;
      await execFileAsync('launchctl', ['bootout', `gui/${uid}/${LEGACY_LABEL}`], { timeout: 5000 });
    } catch { /* 이미 언로드된 상태 — OK */ }

    // plist + wrapper 파일 삭제
    if (plistExists) await fs.unlink(LEGACY_PLIST).catch(() => {});
    if (wrapperExists) await fs.unlink(LEGACY_WRAPPER).catch(() => {});

    // 남은 프로세스 kill — 구 wrapper 는 `--loglevel info` 로 실행되므로 이 패턴만 매칭.
    // 새 `com.claw-web.tunnel` 은 `--loglevel` 없이 실행 → 새 프로세스는 죽지 않음.
    await execFileAsync('pkill', ['-f', 'cloudflared-start.sh'], { timeout: 3000 }).catch(() => {});
    await execFileAsync('pkill', ['-f', 'cloudflared tunnel --no-autoupdate --loglevel info run claw-web'], { timeout: 3000 }).catch(() => {});

    return { ok: true, removed: { plist: plistExists, wrapper: wrapperExists } };
  } catch (err) {
    logger.warn({ err: err.message }, 'legacy-cleanup: non-fatal error');
    return { ok: false, error: err.message };
  }
}
