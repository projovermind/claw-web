import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 「새 기계에 설치」 — 설정 → 기기 → 기기 추가에서 부른다.
 *
 * 이 기계(origin)가 할 수 있는 것은 여기서 전부 끝낸다:
 *   ① Cloudflare 터널 생성(이미 있으면 재사용) ② DNS 연결 ③ 연합 토큰 한 쌍 발급
 *   ④ 인스턴스·기기 등록 ⑤ 새 기계가 돌릴 설치 스크립트 생성 → 일회용 주소로 내준다.
 * 새 기계에서는 원라이너 한 줄만 치면 된다. 브라우저 승인이 필요한 `cloudflared tunnel login` 은
 * 이 기계의 cert.pem 으로 대신하므로 새 기계엔 필요 없다. 남는 수동 단계는 Claude 로그인 하나다.
 *
 * ⚠️ cloudflared 를 부를 때는 항상 빈 config 를 넘긴다. 이 기계의 ~/.cloudflared/config.yml 에
 * `tunnel:` 이 있으면 `route dns <이름>` 의 대상이 **이 기계 본 터널로 바뀐다**(2026-09-23 실측 —
 * studio 주소가 맥미니 터널로 잡혔다). 터널도 이름이 아니라 ID 로 지정한다.
 */

const TUNNEL_PREFIX = 'claw-web-';
export const PROVISION_TTL_MS = 24 * 60 * 60 * 1000;
const CF_TIMEOUT_MS = 60_000;

const ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export class ProvisionError extends Error {
  constructor(message, code = 'PROVISION_FAILED', status = 400) {
    super(message);
    this.name = 'ProvisionError';
    this.code = code;
    this.status = status;
  }
}

/** 셸 단일 인용 — 사람이 적은 이름·메모도 스크립트에 들어가므로 전부 이걸로 감싼다. */
export function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export const slugify = (s) =>
  String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

/** 끝 두 라벨 — `studio.subinggrae.cc` → `subinggrae.cc`. zone 추정용(엄밀하지 않아 사후 검증을 같이 한다). */
export function baseDomain(hostname) {
  const parts = String(hostname).toLowerCase().split('.').filter(Boolean);
  return parts.slice(-2).join('.');
}

/** `cloudflared tunnel token` 이 주는 base64 → 터널 자격증명 파일 내용. */
export function credentialsFromToken(token) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(token).trim(), 'base64').toString('utf8'));
  } catch {
    throw new ProvisionError('터널 토큰을 해석하지 못했습니다.', 'BAD_TUNNEL_TOKEN', 500);
  }
  const { a, t, s } = parsed ?? {};
  if (!a || !t || !s) throw new ProvisionError('터널 토큰에 필요한 값이 없습니다.', 'BAD_TUNNEL_TOKEN', 500);
  return { AccountTag: a, TunnelSecret: s, TunnelID: t };
}

// ── cloudflared 호출 ─────────────────────────────────────────

function findCloudflared() {
  const candidates = [
    process.env.CLOUDFLARED_BIN,
    '/opt/homebrew/bin/cloudflared',
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared'
  ].filter(Boolean);
  return candidates.find((p) => fssync.existsSync(p)) ?? 'cloudflared';
}

/**
 * 실제 cloudflared 를 부르는 기본 러너. 테스트는 같은 모양의 가짜를 넘긴다.
 * @returns {(args: string[]) => Promise<{code:number, stdout:string, stderr:string}>}
 */
export function createCloudflaredRunner({ bin = findCloudflared(), home = os.homedir() } = {}) {
  const emptyConfig = path.join(os.tmpdir(), 'claw-web-cloudflared-empty.yml');
  return async function run(args) {
    if (!fssync.existsSync(emptyConfig)) fssync.writeFileSync(emptyConfig, '{}\n');
    return new Promise((resolve) => {
      execFile(
        bin,
        ['--config', emptyConfig, ...args],
        { timeout: CF_TIMEOUT_MS, env: { ...process.env, HOME: home }, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') + (err && typeof err.code !== 'number' ? `\n${err.message}` : '') });
        }
      );
    });
  };
}

async function ensureTunnel(run, name) {
  const list = await run(['tunnel', 'list', '--output', 'json']);
  if (list.code !== 0) {
    throw new ProvisionError(
      `cloudflared 터널 목록을 못 읽었습니다 — 이 기계에 cloudflared 로그인(cert.pem)이 있어야 합니다. ${tail(list.stderr)}`,
      'CLOUDFLARED_UNAVAILABLE',
      500
    );
  }
  const found = parseTunnels(list.stdout).find((t) => t.name === name && isLive(t));
  if (found) return { id: found.id, created: false };

  const created = await run(['tunnel', 'create', name]);
  if (created.code !== 0) throw new ProvisionError(`터널 생성 실패: ${tail(created.stderr)}`, 'TUNNEL_CREATE_FAILED', 500);
  const again = await run(['tunnel', 'list', '--output', 'json']);
  const fresh = parseTunnels(again.stdout).find((t) => t.name === name && isLive(t));
  if (!fresh) throw new ProvisionError('터널을 만들었는데 목록에서 찾지 못했습니다.', 'TUNNEL_CREATE_FAILED', 500);
  return { id: fresh.id, created: true };
}

// ⚠️ cloudflared 는 살아 있는 터널의 deleted_at 을 비우지 않고 Go 의 영값 "0001-01-01T00:00:00Z" 로 준다
// (실측). `!t.deleted_at` 로 거르면 모든 터널이 삭제된 것으로 보여 재설치가 같은 이름을 또 만든다.
const isLive = (t) => !t?.deleted_at || String(t.deleted_at).startsWith('0001-01-01');

function parseTunnels(stdout) {
  try {
    const arr = JSON.parse(stdout || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

const tail = (s) => String(s ?? '').trim().split('\n').filter((l) => !/\bWRN\b/.test(l)).slice(-3).join(' ').slice(0, 400);

async function routeDns(run, tunnelId, hostname, { tunnelExisted }) {
  let out = await run(['tunnel', 'route', 'dns', tunnelId, hostname]);
  if (out.code !== 0 && /already exists|record with that host/i.test(out.stderr + out.stdout)) {
    // 재설치(같은 기기를 다시 등록)면 레코드가 이미 그 터널을 가리키는 게 정상이다. 새 터널인데
    // 레코드가 있다면 그 이름을 다른 무언가가 쓰고 있다 — 덮어쓰면 그 서비스가 죽는다.
    if (!tunnelExisted) {
      throw new ProvisionError(
        `${hostname} 은(는) 이미 다른 곳에서 쓰는 주소입니다. 덮어쓰지 않았습니다 — 다른 주소를 고르세요.`,
        'HOSTNAME_TAKEN',
        409
      );
    }
    out = await run(['tunnel', 'route', 'dns', '--overwrite-dns', tunnelId, hostname]);
  }
  if (out.code !== 0) throw new ProvisionError(`DNS 연결 실패: ${tail(out.stderr)}`, 'DNS_ROUTE_FAILED', 500);

  // cloudflared 는 인증서의 zone 밖 주소를 받으면 zone 을 뒤에 덧붙여 엉뚱한 레코드를 만든다.
  const added = /CNAME\s+(\S+)/i.exec(out.stderr + '\n' + out.stdout)?.[1]?.replace(/\.$/, '').toLowerCase();
  if (added && added !== hostname) {
    throw new ProvisionError(
      `cloudflared 가 ${hostname} 대신 ${added} 레코드를 만들었습니다 — 이 기계의 Cloudflare 인증서 zone 밖 주소입니다. Cloudflare DNS 에서 ${added} 를 지워 주세요.`,
      'ZONE_MISMATCH',
      400
    );
  }
}

// ── 설치 스크립트 ────────────────────────────────────────────

/**
 * 새 기계에서 돌 스크립트. macOS(launchd) · Linux/WSL(systemd --user) 를 실행 시점에 가른다.
 * 값은 전부 shq() 로 감싸 넣는다 — 이름·메모는 사람이 적은 글이다.
 */
export function renderInstallScript(v) {
  const originInstanceCreate = JSON.stringify({
    id: v.originId, label: v.originName, baseUrl: v.originUrl,
    token: v.tokenToOrigin, inboundToken: v.tokenFromOrigin, enabled: true
  });
  const originInstancePatch = JSON.stringify({
    label: v.originName, baseUrl: v.originUrl,
    token: v.tokenToOrigin, inboundToken: v.tokenFromOrigin, enabled: true
  });
  const originDevice = { name: v.originName, url: v.originUrl, order: 1 };
  const selfDevice = { name: v.deviceName, url: `https://${v.hostname}`, order: 2, ...(v.note ? { note: v.note } : {}) };

  return `#!/bin/bash
# claw-web 새 기계 설치 — ${v.originUrl} 의 「설정 → 기기 → 새 기계에 설치」가 만든 스크립트.
# 터널 비밀값·연합 토큰이 들어 있다. 공유·커밋 금지. 발급: ${new Date(v.issuedAt).toISOString()}
set -uo pipefail
G='\\033[0;32m'; Y='\\033[1;33m'; R='\\033[0;31m'; C='\\033[0;36m'; N='\\033[0m'
ok(){ printf "\${G}  ✓ %s\${N}\\n" "$*"; }; warn(){ printf "\${Y}  ⚠ %s\${N}\\n" "$*"; }
die(){ printf "\${R}  ✗ %s\${N}\\n" "$*"; exit 1; }; step(){ printf "\\n\${C}▸ %s\${N}\\n" "$*"; }

HOST=${shq(v.hostname)}
DEVICE_ID=${shq(v.deviceId)}
TUNNEL_ID=${shq(v.tunnelId)}
UI_TOKEN=${shq(v.uiToken)}
ORIGIN_ID=${shq(v.originId)}
SERVER_MODE=${v.serverMode ? 1 : 0}
CLAW_DIR="\${CLAW_WEB_DIR:-$HOME/claw-web}"
OS="$(uname)"

[ "$(id -u)" != 0 ] || die "sudo 없이 일반 사용자로 실행하세요"
printf "\\n🦞 \${C}claw-web 새 기계 설치\${N} — %s (%s)\\n" ${shq(v.deviceName)} "$HOST"

step "1/6 필수 프로그램"
if [ "$OS" = Darwin ]; then
  xcode-select -p >/dev/null 2>&1 || { xcode-select --install 2>/dev/null; die "Xcode 명령줄 도구 설치 창이 떴습니다 — 끝나면 같은 명령을 다시 실행하세요"; }
  if [ ! -x /opt/homebrew/bin/brew ] && [ ! -x /usr/local/bin/brew ]; then
    echo "  (맥 로그인 비밀번호를 물으면 입력하세요)"
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || die "Homebrew 설치 실패"
  fi
  BREW=/opt/homebrew/bin/brew; [ -x "$BREW" ] || BREW=/usr/local/bin/brew
  eval "$("$BREW" shellenv)"
  grep -q 'brew shellenv' "$HOME/.zprofile" 2>/dev/null || echo "eval \\"\\$($BREW shellenv)\\"" >> "$HOME/.zprofile"
  brew install node cloudflared >/dev/null 2>&1 || brew install node cloudflared || die "brew install 실패"
elif [ "$OS" = Linux ]; then
  for p in git curl; do command -v "$p" >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y -qq "$p"; } || die "$p 설치 실패"; done
  if ! command -v cloudflared >/dev/null; then
    arch=$(dpkg --print-architecture 2>/dev/null || echo amd64)
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-\${arch}.deb" -o /tmp/cloudflared.deb \\
      && sudo dpkg -i /tmp/cloudflared.deb >/dev/null && rm -f /tmp/cloudflared.deb || die "cloudflared 설치 실패"
  fi
else
  die "지원하지 않는 OS: $OS (macOS · Linux/WSL 만)"
fi
ok "git · cloudflared $(cloudflared --version 2>/dev/null | head -1 | awk '{print $3}')"

step "2/6 claw-web 설치 (clone → 빌드 → 자동시작)"
curl -fsSL https://raw.githubusercontent.com/projovermind/claw-web/main/scripts/bootstrap.sh \\
  | CLAW_WEB_DIR="$CLAW_DIR" CLAW_YES=1 CLAW_TOKEN="$UI_TOKEN" CLAW_WORKDIR="$HOME" bash >"$HOME/claw-install.log" 2>&1 \\
  || { tail -30 "$HOME/claw-install.log"; die "claw-web 설치 실패 (로그 ~/claw-install.log)"; }
export NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"; [ -s "$NVM_DIR/nvm.sh" ] && { set +u; . "$NVM_DIR/nvm.sh"; set -u; }
for i in $(seq 1 40); do curl -s -o /dev/null -m 2 http://127.0.0.1:3838/api/health && break; sleep 1; done
curl -s -o /dev/null -m 2 http://127.0.0.1:3838/api/health || die "claw-web 이 3838 에서 안 뜹니다 (로그 ~/claw-install.log)"
command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code --loglevel=error --no-fund --no-audit >/dev/null 2>&1 || warn "Claude CLI 설치 실패 — 수동: npm install -g @anthropic-ai/claude-code"
ok "claw-web 실행 중 ($CLAW_DIR)"

step "3/6 터널 → https://$HOST"
# 기존 ~/.cloudflared/config.yml 은 건드리지 않는다 — 이 기계가 이미 다른 터널을 돌리고 있을 수 있다.
mkdir -p "$HOME/.cloudflared"
CRED="$HOME/.cloudflared/$TUNNEL_ID.json"; CFG="$HOME/.cloudflared/claw-web-$DEVICE_ID.yml"
( umask 077; printf '%s\\n' ${shq(JSON.stringify(v.credentials))} > "$CRED" )
cat > "$CFG" <<YML
tunnel: $TUNNEL_ID
credentials-file: $CRED
protocol: http2
ingress:
  - hostname: $HOST
    service: http://localhost:3838
    originRequest:
      connectTimeout: 30s
      tcpKeepAlive: 30s
  - service: http_status:404
YML
CF_BIN="$(command -v cloudflared)"
if [ "$OS" = Darwin ]; then
  PL="$HOME/Library/LaunchAgents/com.claw-web.tunnel.plist"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/claw-web"
  cat > "$PL" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.claw-web.tunnel</string>
  <key>ProgramArguments</key><array>
    <string>$CF_BIN</string><string>--no-autoupdate</string>
    <string>--config</string><string>$CFG</string><string>tunnel</string><string>run</string>
  </array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/claw-web/tunnel.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/claw-web/tunnel.log</string>
</dict></plist>
PLIST
  launchctl bootout "gui/$(id -u)/com.claw-web.tunnel" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PL" || die "터널 서비스 등록 실패"
else
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/claw-web-tunnel.service" <<UNIT
[Unit]
Description=claw-web tunnel ($HOST)
After=network.target
[Service]
ExecStart=$CF_BIN --no-autoupdate --config $CFG tunnel run
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
UNIT
  export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  systemctl --user daemon-reload && systemctl --user enable --now claw-web-tunnel || die "터널 서비스 등록 실패 (systemd --user 필요)"
fi
ok "터널 서비스 등록"

step "4/6 연합 · 기기 등록 (↔ $ORIGIN_ID)"
API=http://127.0.0.1:3838/api
call(){ curl -s -o /dev/null -w '%{http_code}' -X "$1" "$API$2" -H "Authorization: Bearer $UI_TOKEN" -H 'Content-Type: application/json' -d "$3"; }
upsert(){ # upsert <목록경로> <id> <생성 JSON> <수정 JSON>
  local c; c=$(call POST "$1" "$3")
  case "$c" in 2*) return 0 ;; 409) c=$(call PATCH "$1/$2" "$4") ;; esac
  case "$c" in 2*) return 0 ;; *) return 1 ;; esac
}
c=$(call PATCH /instances/_self ${shq(JSON.stringify({ selfId: v.deviceId, selfPublicUrl: `https://${v.hostname}` }))}); case "$c" in 2*) ;; *) die "selfId 설정 실패 (HTTP $c)";; esac
upsert /instances "$ORIGIN_ID" ${shq(originInstanceCreate)} ${shq(originInstancePatch)} || die "연합 인스턴스 등록 실패"
upsert /devices ${shq(v.originDeviceId)} ${shq(JSON.stringify({ id: v.originDeviceId, ...originDevice }))} ${shq(JSON.stringify(originDevice))} || warn "기기 목록(원본) 등록 실패"
upsert /devices "$DEVICE_ID" ${shq(JSON.stringify({ id: v.deviceId, ...selfDevice }))} ${shq(JSON.stringify(selfDevice))} || warn "기기 목록(자기) 등록 실패"
ok "selfId=$DEVICE_ID ↔ $ORIGIN_ID"

step "5/6 상시 가동 설정"
if [ "$SERVER_MODE" = 1 ] && [ "$OS" = Darwin ]; then
  echo "  (잠자기 끄기 · 정전 후 자동 켜짐 — 맥 로그인 비밀번호를 물으면 입력하세요)"
  sudo pmset -a sleep 0 disksleep 0 womp 1 autorestart 1 2>/dev/null && ok "pmset 적용" || warn "전원 설정 건너뜀 — 잠들면 원격 작업이 끊깁니다"
elif [ "$SERVER_MODE" = 1 ]; then
  sudo loginctl enable-linger "$(id -un)" 2>/dev/null && ok "linger 활성" || warn "linger 미설정 — 로그아웃하면 서비스가 멈출 수 있습니다"
else
  ok "건너뜀"
fi

step "6/6 외부 접속 확인"
code=""
for i in $(seq 1 24); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "https://$HOST/api/health" || true)
  { [ "$code" = 200 ] || [ "$code" = 401 ]; } && break; sleep 5
done
{ [ "$code" = 200 ] || [ "$code" = 401 ]; } && ok "https://$HOST 응답 (HTTP $code)" || warn "외부 응답 아직 없음 (HTTP \${code:-none}) — DNS 전파에 1~2분 걸릴 수 있습니다"

printf "\\n\${G}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${N}\\n"
printf "\${G}  설치 완료\${N}  https://%s\\n" "$HOST"
printf "\${G}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\${N}\\n"
printf "\\n\${Y}  남은 한 가지 — Claude 로그인 (브라우저 승인이라 자동화 불가)\${N}\\n"
printf "    이 창에  claude  입력 → 로그인 → 끝나면 /exit\\n\\n"
`;
}

// ── 프로비저너 ───────────────────────────────────────────────

export function createProvisioner({
  instancesStore,
  devicesStore,
  webConfig,
  provisionDir,
  runCloudflared = createCloudflaredRunner(),
  now = () => Date.now()
}) {
  async function sweepExpired() {
    let names = [];
    try { names = await fs.readdir(provisionDir); } catch { return; }
    await Promise.all(names.filter((n) => n.endsWith('.json')).map(async (n) => {
      const p = path.join(provisionDir, n);
      try {
        const meta = JSON.parse(await fs.readFile(p, 'utf8'));
        if (!(meta.expiresAt > now())) await fs.rm(p, { force: true });
      } catch { await fs.rm(p, { force: true }); }
    }));
  }

  async function upsertInstance(id, data) {
    if (instancesStore.getInstance(id)) return instancesStore.updateInstance(id, data);
    return instancesStore.createInstance(id, data);
  }

  async function upsertDevice(device) {
    const { id, ...rest } = device;
    if (devicesStore.getById(id)) return devicesStore.update(id, rest);
    return devicesStore.create(device);
  }

  return {
    /**
     * @param {{ name: string, hostname: string, id?: string, note?: string, serverMode?: boolean, originUrl?: string, reinstall?: boolean }} input
     *   originUrl: 이 기계의 공개 주소 — 아직 등록 안 돼 있을 때만 쓴다(UI 가 window.location.origin 을 넣는다).
     */
    async provision(input) {
      const name = String(input?.name ?? '').trim();
      const hostname = String(input?.hostname ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      const deviceId = slugify(input?.id || name);
      if (!name) throw new ProvisionError('이름을 적어 주세요.', 'INVALID_INPUT');
      if (!ID_RE.test(deviceId)) throw new ProvisionError('이름에서 id 를 만들 수 없습니다 — 영문/숫자를 포함해 주세요.', 'INVALID_INPUT');
      if (!HOST_RE.test(hostname)) throw new ProvisionError(`주소 형식이 아닙니다: ${hostname || '(비어 있음)'}`, 'INVALID_INPUT');

      // 이 기계의 연합 정체성 — 새 기계가 콜백할 주소와 이름이다.
      let originUrl = instancesStore.getSelfPublicUrl();
      if (!originUrl) {
        const candidate = String(input?.originUrl ?? '').trim().replace(/\/+$/, '');
        if (!/^https:\/\//.test(candidate) || /localhost|127\.0\.0\.1/.test(candidate)) {
          throw new ProvisionError('이 기계의 공개 주소(https)를 알 수 없습니다 — 외부 주소로 접속한 화면에서 다시 시도하세요.', 'NEED_SELF_URL');
        }
        originUrl = candidate;
      }
      const originHost = new URL(originUrl).hostname;
      let originId = instancesStore.getSelfId();
      if (!originId || originId === 'self') originId = slugify(originHost.split('.')[0]) || 'origin';
      if (originId === deviceId) throw new ProvisionError(`이 기계와 같은 id(${deviceId}) 입니다 — 이름을 바꿔 주세요.`, 'INVALID_INPUT');
      if (hostname === originHost) throw new ProvisionError('이 기계 자신의 주소입니다.', 'INVALID_INPUT');
      if (baseDomain(hostname) !== baseDomain(originHost)) {
        throw new ProvisionError(
          `주소는 이 기계와 같은 도메인(*.${baseDomain(originHost)}) 아래여야 합니다 — 터널 DNS 를 이 기계의 Cloudflare 인증서로 만듭니다.`,
          'ZONE_MISMATCH'
        );
      }

      // 이미 연합이 걸린 기기를 다시 만들면 토큰이 교체돼 **지금 돌고 있는 연결이 끊긴다**.
      // 화면에서 확인을 받은 경우(reinstall)에만 진행한다.
      if (instancesStore.getInstance(deviceId) && input?.reinstall !== true) {
        throw new ProvisionError(
          `이미 등록된 기기(${deviceId})입니다 — 다시 만들면 연합 토큰이 바뀌어 지금 연결이 끊기고, 그 기계에서 새 명령을 다시 돌려야 합니다.`,
          'ALREADY_PROVISIONED',
          409
        );
      }

      const tunnelName = `${TUNNEL_PREFIX}${deviceId}`;
      const tunnel = await ensureTunnel(runCloudflared, tunnelName);
      try {
        await routeDns(runCloudflared, tunnel.id, hostname, { tunnelExisted: !tunnel.created });
      } catch (err) {
        // 방금 만든 터널은 되돌린다 — 실패한 시도가 계정에 빈 터널을 남기지 않게.
        if (tunnel.created) await runCloudflared(['tunnel', 'delete', '-f', tunnel.id]).catch(() => {});
        throw err;
      }
      const tok = await runCloudflared(['tunnel', 'token', tunnel.id]);
      if (tok.code !== 0) throw new ProvisionError(`터널 토큰 발급 실패: ${tail(tok.stderr)}`, 'TUNNEL_TOKEN_FAILED', 500);
      const credentials = credentialsFromToken(tok.stdout.trim().split('\n').pop());

      // 연합 토큰 한 쌍. from = 이 기계 → 새 기계(위임), to = 새 기계 → 이 기계(결과 콜백).
      const tokenFromOrigin = randomBytes(24).toString('hex');
      const tokenToOrigin = randomBytes(24).toString('hex');

      await instancesStore.setSelf({ selfId: originId, selfPublicUrl: originUrl });
      await upsertInstance(deviceId, {
        label: name,
        baseUrl: `https://${hostname}`,
        token: tokenFromOrigin,
        inboundToken: tokenToOrigin,
        enabled: true
      });
      const nextOrder = Math.max(0, ...devicesStore.getAll().map((d) => d.order ?? 0)) + 1;
      const existingDevice = devicesStore.getById(deviceId);
      await upsertDevice({
        id: deviceId,
        name,
        url: `https://${hostname}`,
        order: existingDevice?.order ?? nextOrder,
        ...(input?.note ? { note: String(input.note).slice(0, 200) } : {})
      });

      // 새 기계의 UI 토큰은 이 기계와 같게 — 사람이 기억할 토큰이 하나여야 한다.
      // 이 기계가 인증을 끈 상태면 새 기계가 인터넷에 무인증으로 열리므로 새로 만든다.
      const uiToken = (webConfig?.auth?.enabled && webConfig.auth.token) || String(100000 + (randomBytes(4).readUInt32BE() % 900000));

      const selfDevice = devicesStore.getAll().find((d) => {
        try { return new URL(d.url).origin === new URL(originUrl).origin; } catch { return false; }
      });
      const issuedAt = now();
      const script = renderInstallScript({
        issuedAt,
        hostname,
        deviceId,
        deviceName: name,
        note: input?.note ? String(input.note).slice(0, 200) : '',
        tunnelId: tunnel.id,
        credentials,
        uiToken,
        originId,
        originName: selfDevice?.name ?? originHost,
        originDeviceId: selfDevice?.id ?? slugify(originId),
        originUrl,
        tokenFromOrigin,
        tokenToOrigin,
        serverMode: input?.serverMode !== false
      });

      await fs.mkdir(provisionDir, { recursive: true, mode: 0o700 });
      await sweepExpired();
      const nonce = randomBytes(16).toString('hex');
      const expiresAt = issuedAt + PROVISION_TTL_MS;
      await fs.writeFile(path.join(provisionDir, `${nonce}.json`), JSON.stringify({ deviceId, expiresAt, script }), { mode: 0o600 });

      const scriptUrl = `${originUrl.replace(/\/+$/, '')}/api/provision/${nonce}`;
      return {
        deviceId,
        hostname,
        tunnelId: tunnel.id,
        tunnelCreated: tunnel.created,
        originId,
        // 이 기계와 같은 토큰이면 굳이 내보내지 않는다 — 새로 만든 경우에만 화면에 보여야 한다.
        newUiToken: webConfig?.auth?.enabled && webConfig.auth.token ? null : uiToken,
        expiresAt,
        command: `bash <(curl -fsSL ${scriptUrl})`
      };
    },

    /** 일회용 주소로 스크립트를 꺼낸다. 없거나 만료면 null. */
    async getScript(nonce) {
      if (!/^[a-f0-9]{32}$/.test(String(nonce ?? ''))) return null;
      try {
        const meta = JSON.parse(await fs.readFile(path.join(provisionDir, `${nonce}.json`), 'utf8'));
        if (!(meta.expiresAt > now())) return null;
        return meta.script;
      } catch {
        return null;
      }
    }
  };
}
