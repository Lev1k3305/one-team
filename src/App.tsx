import React, { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { SyncProvider } from './context/SyncContext';
import { AppProvider, useApp } from './context/AppContext';
import { reminderService } from './services/reminderService';
import { Sidebar } from './components/layout/Sidebar';
import { Header } from './components/layout/Header';
import { MobileNav } from './components/layout/MobileNav';
import { QuickCreateModal } from './components/modals/QuickCreateModal';
import { DashboardPage } from './pages/DashboardPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { ProjectsPage } from './pages/ProjectsPage';
import { StrategyPage } from './pages/StrategyPage';
import { TeamPage } from './pages/TeamPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { FinancePage } from './pages/FinancePage';
import { ClientsPage } from './pages/ClientsPage';
import { SettingsPage } from './pages/SettingsPage';
import { GoalModal } from './components/strategy/GoalModal';
import { PriorityModal } from './components/strategy/PriorityModal';
import { PlanItemModal } from './components/strategy/PlanItemModal';
import { MissionModal } from './components/strategy/MissionModal';
import { VisionModal } from './components/strategy/VisionModal';
import { AuthScreen } from './components/auth/AuthScreen';
import { WorkspaceSetupModal } from './components/workspace/WorkspaceSetupModal';
import { WorkspaceSwitcher } from './components/workspace/WorkspaceSwitcher';
import { isSupabaseConfigured } from './services/supabaseClient';
import { setupNativeDeepLinks } from './services/native/deepLinkService';
import {
  LayoutDashboard,
  KanbanSquare,
  FolderGit2,
  Target,
  Users,
  BarChart3,
  Wallet,
  Building2,
  Settings as SettingsIcon,
  X,
  Loader2,
} from 'lucide-react';
import { PageId } from './types';
import { Avatar } from './components/common/Avatar';

const MainLayout: React.FC = () => {
  const { activePage, setActivePage, settings } = useApp();
  const { currentWorkspace, workspaces } = useAuth();
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const isTestBypass = typeof window !== 'undefined' && Boolean((window as any).__TEST_BYPASS_AUTH__);

  useEffect(() => {
    reminderService.startScheduler();
    return () => reminderService.stopScheduler();
  }, []);

  const navItems: { id: PageId; label: string; icon: React.ElementType }[] = [
    { id: 'dashboard', label: 'Главная', icon: LayoutDashboard },
    { id: 'workspace', label: 'Рабочее пространство', icon: KanbanSquare },
    { id: 'projects', label: 'Проекты', icon: FolderGit2 },
    { id: 'strategy', label: 'Стратегия', icon: Target },
    { id: 'team', label: 'Команда', icon: Users },
    { id: 'analytics', label: 'Аналитика', icon: BarChart3 },
    { id: 'finance', label: 'Финансы', icon: Wallet },
    { id: 'clients', label: 'Клиенты', icon: Building2 },
    { id: 'settings', label: 'Настройки', icon: SettingsIcon },
  ];

  return (
    <div className="flex h-screen w-full bg-[#F5F7FB] dark:bg-[#0B0F19] text-slate-900 dark:text-slate-100 overflow-hidden font-sans antialiased selection:bg-blue-600 selection:text-white transition-colors duration-200">
      {/* Desktop Persistent Sidebar (8 sections) */}
      <Sidebar />

      {/* Mobile Drawer Backdrop & Panel */}
      {mobileDrawerOpen && (
        <div className="fixed inset-0 z-50 tablet-hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/70 backdrop-blur-xs transition-opacity"
            onClick={() => setMobileDrawerOpen(false)}
          />
          <div className="relative w-80 max-w-[85vw] bg-[#111827] text-white flex flex-col justify-between p-4 z-10 shadow-2xl overflow-y-auto pt-safe pb-safe">
            <div>
              {/* Header */}
              <div className="flex items-center justify-between pb-3.5 border-b border-slate-800">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-blue-700 to-cyan-400 flex items-center justify-center">
                    <span className="text-white font-extrabold text-sm">A</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="font-bold text-sm tracking-wider text-white">
                      ONE TEAM
                    </span>
                    <span className="text-[10px] text-slate-400 uppercase font-medium">
                      Mobile Workspace
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => setMobileDrawerOpen(false)}
                  className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                  aria-label="Закрыть меню"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Mobile Workspace Switcher */}
              <div className="py-3 border-b border-slate-800/80">
                <WorkspaceSwitcher collapsed={false} />
              </div>

              {/* Navigation Items (9 sections) */}
              <nav className="space-y-1 mt-3">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  const isActive = activePage === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => {
                        setActivePage(item.id);
                        setMobileDrawerOpen(false);
                      }}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs font-semibold transition-colors touch-target ${
                        isActive
                          ? 'bg-blue-600 text-white shadow-md shadow-blue-900/30'
                          : 'text-slate-400 hover:text-white hover:bg-slate-800/60'
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </nav>
            </div>

            {/* User Profile in mobile drawer */}
            <div
              onClick={() => {
                setActivePage('settings');
                setMobileDrawerOpen(false);
              }}
              className="p-3 bg-slate-800/60 hover:bg-slate-800 rounded-xl flex items-center gap-3 cursor-pointer mt-4 border border-slate-700/40"
            >
              <Avatar
                src={settings.currentUser.avatar}
                name={settings.currentUser.name}
                size="sm"
                showOnlineStatus
                isOnline={true}
              />
              <div className="truncate flex-1">
                <div className="text-xs font-semibold text-white truncate">
                  {settings.currentUser.name}
                </div>
                <div className="text-[11px] text-slate-400 truncate">
                  {settings.currentUser.position}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main Workspace Frame */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Header */}
        <Header onMobileMenuToggle={() => setMobileDrawerOpen(true)} />

        {/* Dynamic Page Content Viewport for 9 Pages */}
        <main className="flex-1 overflow-y-auto overflow-x-hidden px-3.5 py-4 sm:px-6 sm:py-6 lg:px-8 lg:py-7 pb-20 tablet-pb-7 pl-safe pr-safe">
          {activePage === 'dashboard' && <DashboardPage />}
          {activePage === 'workspace' && <WorkspacePage />}
          {activePage === 'projects' && <ProjectsPage />}
          {activePage === 'strategy' && <StrategyPage />}
          {activePage === 'team' && <TeamPage />}
          {activePage === 'analytics' && <AnalyticsPage />}
          {activePage === 'finance' && <FinancePage />}
          {activePage === 'clients' && <ClientsPage />}
          {activePage === 'settings' && <SettingsPage />}
        </main>

        {/* Mobile bottom nav */}
        <MobileNav onOpenMenu={() => setMobileDrawerOpen(true)} />
      </div>

      {/* Global Quick Create Modal */}
      <QuickCreateModal />

      {/* Workspace Setup Modal if User has zero workspaces */}
      <WorkspaceSetupModal isOpen={!isTestBypass && workspaces.length === 0 && Boolean(currentWorkspace === null)} />

      {/* Strategy Management Modals */}
      <GoalModal />
      <PriorityModal />
      <PlanItemModal />
      <MissionModal />
      <VisionModal />
    </div>
  );
};

const RootNavigator: React.FC = () => {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="h-screen w-full bg-[#080C14] flex flex-col items-center justify-center text-white space-y-4">
        <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
        <p className="text-xs text-slate-400 font-medium">Загрузка платформы ONE TEAM...</p>
      </div>
    );
  }

  // If user is not authenticated in cloud environment, display AuthScreen
  const isTestBypass = typeof window !== 'undefined' && Boolean((window as any).__TEST_BYPASS_AUTH__);
  if (isSupabaseConfigured && !user && !isTestBypass) {
    return <AuthScreen />;
  }

  return (
    <SyncProvider>
      <AppProvider>
        <MainLayout />
      </AppProvider>
    </SyncProvider>
  );
};

export default function App() {
  useEffect(() => {
    setupNativeDeepLinks();
  }, []);

  return (
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>
  );
}
