import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createInstancesStore } from '../server/lib/instances-store.js';
import { createDevicesStore } from '../server/lib/devices-store.js';
import { createProvisioner, renderInstallScript, shq, credentialsFromToken, PROVISION_TTL_MS } from '../server/lib/device-provision.js';
import { createDevicesRouter } from '../server/routes/devices.js';
import { createProvisionRouter } from '../server/routes/provision.js';
import { errorHandler } from '../server/middleware/error-handler.js';

const ZONE = 'subinggrae.cc';

/**
 * 가짜 cloudflared — 실제 CLI 가 보이는 동작 중 이 기능이 기대는 것만 흉내 낸다.
 * ① 이미 레코드가 있으면 --overwrite-dns 없이 실패 ② zone 밖 주소는 zone 을 덧붙여 만든다.
 */
function fakeCloudflared({ tunnels = [], records = {} } = {}) {
  // 실측 형식: 살아 있는 터널도 deleted_at 이 Go 영값 문자열로 온다
  const LIVE = '0001-01-01T00:00:00Z';
  const state = { tunnels: tunnels.map((t) => ({ deleted_at: LIVE, ...t })), records: { ...records }, calls: [] };
  let seq = 0;
  const ok = (stdout = '', stderr = '') => ({ code: 0, stdout, stderr });
  const run = async (args) => {
    state.calls.push(args);
    const [a, b, ...rest] = args;
    if (a !== 'tunnel') return { code: 1, stdout: '', stderr: 'unknown' };
    if (b === 'list') return ok(JSON.stringify(state.tunnels));
    if (b === 'create') {
      const id = `00000000-0000-0000-0000-00000000000${++seq}`;
      state.tunnels.push({ id, name: rest[0], deleted_at: LIVE });
      return ok(`Created tunnel ${rest[0]} with id ${id}`);
    }
    if (b === 'delete') {
      const id = rest[rest.length - 1];
      state.tunnels = state.tunnels.filter((t) => t.id !== id);
      return ok();
    }
    if (b === 'token') {
      const id = rest[0];
      return ok(Buffer.from(JSON.stringify({ a: 'acct', t: id, s: 'c2VjcmV0' })).toString('base64') + '\n');
    }
    if (b === 'route' && rest[0] === 'dns') {
      const overwrite = rest.includes('--overwrite-dns');
      const [id, host] = rest.filter((x) => x !== 'dns' && x !== '--overwrite-dns');
      const fqdn = host.endsWith(ZONE) ? host : `${host}.${ZONE}`;
      // 실측: 이미 같은 터널을 가리키면 오류가 아니라 exit 0 + "already configured"
      if (state.records[fqdn] === id && !overwrite) {
        return ok('', `INF ${fqdn} is already configured to route to your tunnel tunnelID=${id}`);
      }
      if (state.records[fqdn] && !overwrite) {
        return { code: 1, stdout: '', stderr: 'Failed to add route: code: 1003, reason: An A, AAAA, or CNAME record with that host already exists.' };
      }
      state.records[fqdn] = id;
      return ok('', `2026-09-23T00:00:00Z INF Added CNAME ${fqdn} which will route to this tunnel tunnelID=${id}`);
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { run, state };
}

async function setup({ cf = fakeCloudflared(), auth = { enabled: true, token: '930214' }, self = { selfId: 'macmini', selfPublicUrl: 'https://subinggrae.cc' }, now } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-'));
  const instancesStore = await createInstancesStore(path.join(dir, 'instances.json'));
  const devicesStore = await createDevicesStore(path.join(dir, 'devices.json'));
  if (self) await instancesStore.setSelf(self);
  await devicesStore.create({ id: 'macmini', name: '맥미니 M4', url: 'https://subinggrae.cc', order: 1 });
  const provisioner = createProvisioner({
    instancesStore,
    devicesStore,
    webConfig: { auth },
    provisionDir: path.join(dir, 'provision'),
    runCloudflared: cf.run,
    ...(now ? { now } : {})
  });
  return { dir, instancesStore, devicesStore, provisioner, cf };
}

const nonceOf = (command) => /\/api\/provision\/([a-f0-9]{32})\)$/.exec(command)?.[1];

function bashSyntaxOk(script) {
  const r = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
  return { ok: r.status === 0, err: r.stderr };
}

describe('device provision — 새 기계에 설치', () => {
  it('새 기계: 터널을 만들고 DNS 를 새 터널로 잇고, 연합 토큰을 서로 엇갈리게 심는다', async () => {
    const { provisioner, instancesStore, devicesStore, cf } = await setup();
    const out = await provisioner.provision({ name: 'Studio', hostname: 'studio.subinggrae.cc', note: 'M2 Max' });

    expect(out.deviceId).toBe('studio');
    expect(out.tunnelCreated).toBe(true);
    expect(out.newUiToken).toBeNull();
    expect(out.command).toMatch(/^bash <\(curl -fsSL https:\/\/subinggrae\.cc\/api\/provision\/[a-f0-9]{32}\)$/);

    // DNS 가 **새 터널** 을 가리킨다(맥미니 본 터널로 잡힌 2026-09-23 사고의 반대 방향 확인)
    const tunnel = cf.state.tunnels.find((t) => t.name === 'claw-web-studio');
    expect(cf.state.records['studio.subinggrae.cc']).toBe(tunnel.id);
    // 이름이 아니라 ID 로 라우팅했다
    const route = cf.state.calls.find((c) => c[1] === 'route');
    expect(route).toContain(tunnel.id);
    expect(route).not.toContain('claw-web-studio');

    const raw = instancesStore.getRaw();
    expect(raw.instances.studio.baseUrl).toBe('https://studio.subinggrae.cc');
    const fromOrigin = raw.instances.studio.token;
    const toOrigin = raw.inboundTokens.studio;
    expect(fromOrigin).toMatch(/^[a-f0-9]{48}$/);
    expect(toOrigin).toMatch(/^[a-f0-9]{48}$/);
    expect(fromOrigin).not.toBe(toOrigin);

    expect(devicesStore.getById('studio')).toMatchObject({ name: 'Studio', url: 'https://studio.subinggrae.cc', order: 2, note: 'M2 Max' });

    const script = await provisioner.getScript(nonceOf(out.command));
    expect(bashSyntaxOk(script)).toEqual({ ok: true, err: '' });
    // 새 기계 쪽에선 방향이 뒤집힌다: 내가 받는 토큰(inbound) = 이 기계가 보내는 토큰
    expect(script).toContain(`"token":"${toOrigin}","inboundToken":"${fromOrigin}"`);
    expect(script).toContain(`"selfId":"studio","selfPublicUrl":"https://studio.subinggrae.cc"`);
    expect(script).toContain(`TUNNEL_ID='${tunnel.id}'`);
    expect(script).toContain(`UI_TOKEN='930214'`);
    expect(script).toContain(`"TunnelID":"${tunnel.id}"`);
    // 새 기계의 기존 cloudflared 설정을 덮지 않는다 — 전용 설정 파일에만 쓴다
    expect(script).not.toMatch(/>\s*"?\$HOME\/\.cloudflared\/config\.yml/);
    expect(script).toContain('CFG="$HOME/.cloudflared/claw-web-$DEVICE_ID.yml"');
  });

  it('재설치: 기존 터널을 재사용하고, DNS 가 엉뚱한 터널(2026-09-23: 맥미니 본 터널)을 가리키면 바로잡는다', async () => {
    const cf = fakeCloudflared({
      tunnels: [
        { id: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'claw-web-studio' },
        { id: 'macmini-main-tunnel', name: 'claw-web' }
      ],
      records: { 'studio.subinggrae.cc': 'macmini-main-tunnel' }
    });
    const { provisioner, instancesStore } = await setup({ cf });
    await instancesStore.createInstance('studio', { baseUrl: 'https://studio.subinggrae.cc', token: 'old', inboundToken: 'old-in' });

    // 확인 없이 다시 만들면 거절 — 지금 돌고 있는 연합을 조용히 끊지 않는다
    await expect(provisioner.provision({ name: 'studio', hostname: 'studio.subinggrae.cc' }))
      .rejects.toMatchObject({ code: 'ALREADY_PROVISIONED', status: 409 });
    expect(cf.state.calls).toEqual([]);
    expect(instancesStore.getRaw().instances.studio.token).toBe('old');

    const out = await provisioner.provision({ name: 'studio', hostname: 'studio.subinggrae.cc', reinstall: true });
    expect(out.tunnelCreated).toBe(false);
    expect(out.tunnelId).toBe('aaaaaaaa-0000-0000-0000-000000000001');
    expect(cf.state.calls.some((c) => c.includes('--overwrite-dns'))).toBe(true);
    expect(cf.state.calls.some((c) => c[1] === 'create')).toBe(false);
    expect(cf.state.records['studio.subinggrae.cc']).toBe('aaaaaaaa-0000-0000-0000-000000000001');
    // 토큰은 새로 발급된다(재설치 = 새 기계가 새 토큰을 받는다)
    expect(instancesStore.getRaw().instances.studio.token).not.toBe('old');
  });

  it('재설치 — 레코드가 이미 이 터널을 가리키면 그대로 통과한다(덮어쓰기 없이)', async () => {
    const cf = fakeCloudflared({
      tunnels: [{ id: 'bbbbbbbb-0000-0000-0000-000000000002', name: 'claw-web-studio' }],
      records: { 'studio.subinggrae.cc': 'bbbbbbbb-0000-0000-0000-000000000002' }
    });
    const { provisioner } = await setup({ cf });
    const out = await provisioner.provision({ name: 'studio', hostname: 'studio.subinggrae.cc' });
    expect(out).toMatchObject({ tunnelCreated: false, tunnelId: 'bbbbbbbb-0000-0000-0000-000000000002' });
    expect(cf.state.calls.some((c) => c.includes('--overwrite-dns'))).toBe(false);
  });

  it('삭제된 터널은 재사용하지 않는다', async () => {
    const cf = fakeCloudflared({
      tunnels: [{ id: 'dead', name: 'claw-web-studio', deleted_at: '2026-09-01T00:00:00Z' }]
    });
    const { provisioner } = await setup({ cf });
    const out = await provisioner.provision({ name: 'studio', hostname: 'studio.subinggrae.cc' });
    expect(out.tunnelCreated).toBe(true);
    expect(out.tunnelId).not.toBe('dead');
  });

  it('이미 다른 곳이 쓰는 주소는 덮어쓰지 않고, 방금 만든 터널도 지운다', async () => {
    const cf = fakeCloudflared({ records: { 'crm.subinggrae.cc': 'someone-else' } });
    const { provisioner, instancesStore, devicesStore } = await setup({ cf });

    await expect(provisioner.provision({ name: 'studio', hostname: 'crm.subinggrae.cc' }))
      .rejects.toMatchObject({ code: 'HOSTNAME_TAKEN', status: 409 });
    expect(cf.state.records['crm.subinggrae.cc']).toBe('someone-else');
    expect(cf.state.calls.some((c) => c.includes('--overwrite-dns'))).toBe(false);
    expect(cf.state.tunnels).toEqual([]);
    expect(instancesStore.getInstance('studio')).toBeNull();
    expect(devicesStore.getById('studio')).toBeNull();
  });

  it('이 기계와 다른 도메인이면 cloudflared 를 부르기 전에 거절한다', async () => {
    const { provisioner, cf } = await setup();
    await expect(provisioner.provision({ name: 'studio', hostname: 'studio.sonamoo.cc' }))
      .rejects.toMatchObject({ code: 'ZONE_MISMATCH' });
    expect(cf.state.calls).toEqual([]);
  });

  it('cloudflared 가 zone 을 덧붙여 엉뚱한 레코드를 만들면 실패로 알린다', async () => {
    // 끝 두 라벨은 같지만 실제 인증서 zone 이 다른 경우(사후 검증)
    const cf = fakeCloudflared();
    const run = async (args) => {
      if (args[1] === 'route') return { code: 0, stdout: '', stderr: 'INF Added CNAME box.co.kr.subinggrae.cc which will route' };
      return cf.run(args);
    };
    const { provisioner } = await setup({ cf: { run, state: cf.state }, self: { selfId: 'macmini', selfPublicUrl: 'https://a.co.kr' } });
    await expect(provisioner.provision({ name: 'box', hostname: 'box.co.kr' }))
      .rejects.toMatchObject({ code: 'ZONE_MISMATCH' });
  });

  it('입력 검증 — 주소 형식·자기 자신·이름', async () => {
    const { provisioner } = await setup();
    await expect(provisioner.provision({ name: 'x', hostname: 'not a host' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(provisioner.provision({ name: 'x', hostname: 'subinggrae.cc' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(provisioner.provision({ name: '맥스튜디오', hostname: 'studio.subinggrae.cc' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(provisioner.provision({ name: 'macmini', hostname: 'mm.subinggrae.cc' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // 한글 이름이라도 id 를 따로 주면 된다
    const out = await provisioner.provision({ name: '맥스튜디오', id: 'studio', hostname: 'https://studio.subinggrae.cc/' });
    expect(out).toMatchObject({ deviceId: 'studio', hostname: 'studio.subinggrae.cc' });
  });

  it('이 기계의 공개 주소가 비어 있으면 화면이 넘긴 주소로 채우고, selfId 도 정한다', async () => {
    const { provisioner, instancesStore } = await setup({ self: null });
    await expect(provisioner.provision({ name: 'studio', hostname: 'studio.subinggrae.cc' }))
      .rejects.toMatchObject({ code: 'NEED_SELF_URL' });
    await expect(provisioner.provision({ name: 'studio', hostname: 'studio.subinggrae.cc', originUrl: 'http://localhost:3838' }))
      .rejects.toMatchObject({ code: 'NEED_SELF_URL' });

    const out = await provisioner.provision({ name: 'studio', hostname: 'studio.subinggrae.cc', originUrl: 'https://subinggrae.cc/' });
    expect(out.originId).toBe('subinggrae');
    expect(instancesStore.getPublic()).toMatchObject({ selfId: 'subinggrae', selfPublicUrl: 'https://subinggrae.cc' });
  });

  it('이 기계가 인증을 껐으면 새 기계용 토큰을 새로 만들어 화면에 준다', async () => {
    const { provisioner } = await setup({ auth: { enabled: false, token: null } });
    const out = await provisioner.provision({ name: 'studio', hostname: 'studio.subinggrae.cc' });
    expect(out.newUiToken).toMatch(/^\d{6}$/);
    expect(await provisioner.getScript(nonceOf(out.command))).toContain(`UI_TOKEN='${out.newUiToken}'`);
  });

  it('설치 주소는 24시간 뒤 만료되고, 형식이 틀린 키는 파일을 찾지도 않는다', async () => {
    let t = 1_000_000;
    const { provisioner } = await setup({ now: () => t });
    const out = await provisioner.provision({ name: 'studio', hostname: 'studio.subinggrae.cc' });
    const nonce = nonceOf(out.command);
    expect(await provisioner.getScript(nonce)).toBeTruthy();
    t += PROVISION_TTL_MS + 1;
    expect(await provisioner.getScript(nonce)).toBeNull();
    expect(await provisioner.getScript('../../instances')).toBeNull();
    expect(await provisioner.getScript('z'.repeat(32))).toBeNull();
  });
});

describe('설치 스크립트 — 사람이 적은 글이 셸로 새지 않는다', () => {
  it('shq 는 어떤 문자열도 그대로 되돌린다', () => {
    for (const s of [`a'b`, `'; touch /tmp/pwned; echo '`, '$(id)', '`id`', 'a"b\\c', '맥스튜디오 "M2"']) {
      const back = execFileSync('bash', ['-c', `printf %s ${shq(s)}`], { encoding: 'utf8' });
      expect(back).toBe(s);
    }
  });

  it('따옴표·명령치환이 든 이름·메모로도 문법이 깨지지 않는다', () => {
    const script = renderInstallScript({
      issuedAt: 0,
      hostname: 'studio.subinggrae.cc',
      deviceId: 'studio',
      deviceName: `스튜디오'; rm -rf ~; echo '$(id)`,
      note: '`id` "x"',
      tunnelId: 't-1',
      credentials: credentialsFromToken(Buffer.from(JSON.stringify({ a: 'a', t: 't-1', s: 's' })).toString('base64')),
      uiToken: '930214',
      originId: 'macmini',
      originName: `맥미니 '1'`,
      originDeviceId: 'macmini',
      originUrl: 'https://subinggrae.cc',
      tokenFromOrigin: 'f'.repeat(48),
      tokenToOrigin: 't'.repeat(48),
      serverMode: true
    });
    expect(bashSyntaxOk(script)).toEqual({ ok: true, err: '' });
    // 이름은 반드시 인용된 채로만 들어간다
    expect(script).toContain(shq(`스튜디오'; rm -rf ~; echo '$(id)`));
    // 단일 인용 구간(shq 가 만든 'a'\''b' 형태 포함)을 걷어 내면 어디에도 남지 않는다 = 셸이 해석하지 않는다
    const unquoted = script.replace(/'[^']*'(?:\\''[^']*')*/g, '');
    expect(unquoted).not.toContain('rm -rf ~');
    expect(unquoted).not.toContain('$(id)');
  });
});

describe('라우트', () => {
  let app, provisioner;
  beforeEach(async () => {
    const s = await setup();
    provisioner = s.provisioner;
    app = express();
    app.use(express.json());
    app.use('/api/provision', createProvisionRouter({ provisioner }));
    app.use('/api/devices', createDevicesRouter({ devicesStore: s.devicesStore, provisioner }));
    app.use(errorHandler);
  });

  it('POST /api/devices/provision → 원라이너, GET /api/provision/:키 → 스크립트', async () => {
    const res = await request(app).post('/api/devices/provision').send({ name: 'studio', hostname: 'studio.subinggrae.cc' });
    expect(res.status).toBe(201);
    const nonce = nonceOf(res.body.command);
    const got = await request(app).get(`/api/provision/${nonce}`);
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toMatch(/shellscript/);
    expect(got.headers['cache-control']).toBe('no-store');
    expect(got.text.startsWith('#!/bin/bash')).toBe(true);
  });

  it('모르는 키는 404 이고, 받은 쪽 bash 가 조용히 성공하지 않게 exit 1 을 돌려준다', async () => {
    const got = await request(app).get(`/api/provision/${'a'.repeat(32)}`);
    expect(got.status).toBe(404);
    expect(got.text).toContain('exit 1');
  });

  it('검증 실패는 사유 코드와 함께 4xx', async () => {
    const res = await request(app).post('/api/devices/provision').send({ name: 'studio', hostname: 'studio.sonamoo.cc' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('ZONE_MISMATCH');
  });
});
