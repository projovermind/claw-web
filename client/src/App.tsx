import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import AppShell from './components/layout/AppShell';
import { useWebSocket } from './hooks/useWebSocket';
import { useGlobalFileDrop } from './hooks/useGlobalFileDrop';
import { useUnreadGuard } from './hooks/useUnreadGuard';
import { useAppearance } from './hooks/useAppearance';
import { useUndoShortcut } from './hooks/useUndoShortcut';
import { useActivityPing } from './hooks/useActivityPing';
import GlobalDropOverlay from './components/layout/GlobalDropOverlay';
import LoginDialog from './components/auth/LoginDialog';
import CommandPalette from './components/palette/CommandPalette';
import FilePalette from './components/palette/FilePalette';
import ToastContainer from './components/layout/ToastContainer';
import ProgressToasts from './components/common/ProgressToasts';
import { FileDiffHost } from './components/chat/FileDiffModal';

// Route-level code splitting: each page becomes its own chunk and is only
// fetched when the user navigates to it. Heavy pages (Terminal/xterm,
// Chat/markdown, Files) stay out of the initial bundle.
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const AgentsPage = lazy(() => import('./pages/AgentsPage'));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage'));
const ChatPage = lazy(() => import('./pages/ChatPage'));
const TerminalPage = lazy(() => import('./pages/TerminalPage'));
const FilesPage = lazy(() => import('./pages/FilesPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const SkillsPage = lazy(() => import('./pages/SkillsPage'));
const SetupWizard = lazy(() => import('./pages/SetupWizard'));

function PageFallback() {
  return (
    <div className="flex items-center justify-center h-full w-full text-zinc-500 text-sm">
      <div className="flex items-center gap-2">
        <div className="w-3 h-3 rounded-full bg-zinc-700 animate-pulse" />
        <span>loading…</span>
      </div>
    </div>
  );
}

export default function App() {
  useWebSocket();
  useGlobalFileDrop();
  useUnreadGuard();
  useAppearance();
  useUndoShortcut();
  useActivityPing();

  // 푸시 알림 클릭 → SW 가 postMessage 로 url 전달 → react-router 로 soft-navigate
  const navigate = useNavigate();
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const handler = (ev: MessageEvent) => {
      if (ev.data?.type === 'sw-navigate' && typeof ev.data.url === 'string') {
        navigate(ev.data.url);
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, [navigate]);

  // cold-resume 안전망: SW 가 저장한 pending nav URL 확인 후 이동 + 캐시 삭제
  useEffect(() => {
    if (!('caches' in window)) return;
    (async () => {
      try {
        const cache = await caches.open('claw-pending-nav');
        const resp = await cache.match('/__pending_nav__');
        if (!resp) return;
        const target = await resp.text();
        await cache.delete('/__pending_nav__');
        const u = new URL(target);
        if (u.origin === window.location.origin) {
          navigate(u.pathname + u.search + u.hash);
        }
      } catch {
        // caches API 미지원 환경 무시
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <LoginDialog />
      <CommandPalette />
      <FilePalette />
      <GlobalDropOverlay />
      <ToastContainer />
      <ProgressToasts />
      <FileDiffHost />
      <Routes>
        <Route element={<AppShell />}>
          <Route
            index
            element={
              <Suspense fallback={<PageFallback />}>
                <DashboardPage />
              </Suspense>
            }
          />
          <Route
            path="/agents"
            element={
              <Suspense fallback={<PageFallback />}>
                <AgentsPage />
              </Suspense>
            }
          />
          <Route
            path="/projects"
            element={
              <Suspense fallback={<PageFallback />}>
                <ProjectsPage />
              </Suspense>
            }
          />
          <Route
            path="/skills"
            element={
              <Suspense fallback={<PageFallback />}>
                <SkillsPage />
              </Suspense>
            }
          />
          <Route
            path="/chat"
            element={
              <Suspense fallback={<PageFallback />}>
                <ChatPage />
              </Suspense>
            }
          />
          <Route
            path="/terminal"
            element={
              <Suspense fallback={<PageFallback />}>
                <TerminalPage />
              </Suspense>
            }
          />
          <Route
            path="/files"
            element={
              <Suspense fallback={<PageFallback />}>
                <FilesPage />
              </Suspense>
            }
          />
          <Route
            path="/settings"
            element={
              <Suspense fallback={<PageFallback />}>
                <SettingsPage />
              </Suspense>
            }
          />
          <Route
            path="/setup"
            element={
              <Suspense fallback={<PageFallback />}>
                <SetupWizard />
              </Suspense>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </>
  );
}
