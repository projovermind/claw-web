import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');

let cached = null;

/** package.json 의 version. 최초 1회만 읽고 캐시한다. */
export function getAppVersion() {
  if (cached !== null) return cached;
  try {
    cached = JSON.parse(readFileSync(pkgPath, 'utf8')).version || null;
  } catch {
    cached = null;
  }
  return cached;
}
