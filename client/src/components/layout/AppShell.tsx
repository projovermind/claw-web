import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';

export default function AppShell() {
  return (
    <div className="h-dvh w-screen flex bg-zinc-950 text-zinc-100 overflow-hidden">
      <Sidebar />
      {/* pt-12 on mobile reserves space for the fixed top bar inside Sidebar */}
      <main className="flex-1 overflow-hidden flex flex-col pt-12 lg:pt-0">
        <Outlet />
      </main>
    </div>
  );
}
