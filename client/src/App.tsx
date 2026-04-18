import { Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './components/layout/AppShell';
import DashboardPage from './pages/DashboardPage';
import AgentsPage from './pages/AgentsPage';
import ProjectsPage from './pages/ProjectsPage';
import ChatPage from './pages/ChatPage';
import SettingsPage from './pages/SettingsPage';
import SkillsPage from './pages/SkillsPage';
import SetupWizard from './pages/SetupWizard';
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

export default function App() {
  useWebSocket();
  useGlobalFileDrop();
  useUnreadGuard();
  useAppearance();
  useUndoShortcut();
  useActivityPing();
  return (
    <>
      <LoginDialog />
      <CommandPalette />
      <FilePalette />
      <GlobalDropOverlay />
      <ToastContainer />
      <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/setup" element={<SetupWizard />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
    </>
  );
}
