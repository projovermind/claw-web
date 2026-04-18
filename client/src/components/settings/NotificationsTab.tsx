import { useState } from 'react';
import { Bell, BellOff, CheckCircle, XCircle, AlertCircle } from 'lucide-react';
import { usePushNotifications } from '../../hooks/usePushNotifications';
import { api } from '../../lib/api';

export function NotificationsTab() {
  const { permission, subscribed, loading, error, subscribe, unsubscribe } = usePushNotifications();
  const [inactiveMinutes, setInactiveMinutes] = useState(5);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.pushSaveSettings({ inactiveMinutes });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const permissionIcon = permission === 'granted'
    ? <CheckCircle size={14} className="text-emerald-400" />
    : permission === 'denied'
    ? <XCircle size={14} className="text-red-400" />
    : <AlertCircle size={14} className="text-yellow-400" />;

  const permissionLabel = permission === 'granted' ? '허용됨' : permission === 'denied' ? '차단됨' : '미설정';

  return (
    <div className="space-y-6 max-w-xl">
      <section>
        <h3 className="text-sm font-semibold mb-1">푸쉬 알림</h3>
        <p className="text-xs text-zinc-500 mb-4">
          PC에서 자리를 비웠을 때 에이전트 완료 알림을 모바일에 전송합니다.
        </p>

        <div className="flex items-center gap-3 mb-4">
          <span className="text-xs text-zinc-400 flex items-center gap-1">
            브라우저 권한: {permissionIcon} {permissionLabel}
          </span>
        </div>

        <div className="flex items-center gap-3">
          {subscribed ? (
            <button
              onClick={unsubscribe}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 text-sm rounded bg-red-900/40 hover:bg-red-900/60 text-red-300 border border-red-800 transition-colors disabled:opacity-50"
            >
              <BellOff size={14} />
              {loading ? '처리 중...' : '구독 해제'}
            </button>
          ) : (
            <button
              onClick={subscribe}
              disabled={loading || permission === 'denied'}
              className="flex items-center gap-2 px-4 py-2 text-sm rounded bg-emerald-900/40 hover:bg-emerald-900/60 text-emerald-300 border border-emerald-800 transition-colors disabled:opacity-50"
            >
              <Bell size={14} />
              {loading ? '처리 중...' : '구독 시작'}
            </button>
          )}
          {subscribed && (
            <span className="text-xs text-emerald-400 flex items-center gap-1">
              <CheckCircle size={12} /> 이 기기에서 구독 중
            </span>
          )}
        </div>
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        {permission === 'denied' && (
          <p className="mt-2 text-xs text-zinc-500">
            브라우저에서 알림이 차단되어 있습니다. 브라우저 설정에서 허용해 주세요.
          </p>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold mb-1">PC 활성 억제 시간</h3>
        <p className="text-xs text-zinc-500 mb-3">
          마지막 활동 후 이 시간이 지나야 푸쉬 알림을 전송합니다. (현재: {inactiveMinutes}분)
        </p>
        <input
          type="range"
          min={1}
          max={30}
          value={inactiveMinutes}
          onChange={(e) => setInactiveMinutes(Number(e.target.value))}
          className="w-full accent-emerald-500"
        />
        <div className="flex justify-between text-xs text-zinc-500 mt-1">
          <span>1분</span>
          <span>30분</span>
        </div>
      </section>

      <button
        onClick={handleSave}
        disabled={saving}
        className="px-4 py-2 text-sm rounded bg-emerald-600 hover:bg-emerald-500 text-white transition-colors disabled:opacity-50"
      >
        {saved ? '저장됨' : saving ? '저장 중...' : '저장'}
      </button>
    </div>
  );
}
