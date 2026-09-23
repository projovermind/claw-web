import { Router } from 'express';

/**
 * 「새 기계에 설치」 스크립트 배포 — UI 인증 **앞에** 마운트된다.
 *
 * 새 기계는 아직 아무 토큰도 모른다. 원라이너에 UI 토큰을 박으면 셸 히스토리·화면 공유에
 * 토큰이 남으므로, 대신 추측 불가능한 일회용 키(128비트)로 24시간만 연다. 키를 모르면 404 다
 * (있는지 없는지도 알려주지 않는다).
 */
export function createProvisionRouter({ provisioner }) {
  const router = Router();
  router.get('/:nonce', async (req, res) => {
    const script = await provisioner.getScript(req.params.nonce);
    if (!script) return res.status(404).type('text/plain').send('echo "설치 주소가 만료됐거나 없습니다 — 설정 → 기기 에서 다시 만드세요." >&2; exit 1\n');
    res.set('Cache-Control', 'no-store');
    res.type('text/x-shellscript').send(script);
  });
  return router;
}
