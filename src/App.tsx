import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  BookOpen,
  Building2,
  DoorOpen,
  FileText,
  Gauge,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  Users,
  Wallet,
  Wrench,
  X,
} from 'lucide-react';
import { AccountingView, OrgSettingsView, ReportsAndNotificationsView } from './components/AccountingAndReportsView';
import { DashboardView, PropertiesView } from './components/DashboardAndPropertiesView';
import { LoginView } from './components/LoginView';
import { EvictionSettlementView, MaintenanceView } from './components/MaintenanceAndEvictionView';
import { ContractsView, PartiesView } from './components/PartiesAndContractsView';
import { PlatformAdminView } from './components/PlatformAdminView';
import { CollectorPortalView, RenterPortalView, UnitOwnerPortalView } from './components/RolePortalsView';
import { CollectionsView, ServicesView } from './components/ServicesAndCollectionsView';
import { ErrorBanner, LoadingRows, secondaryBtnCls } from './components/UiPrimitives';
import { apiFetch, AuthUser, OrganizationInfo, ROLE_LABELS } from './lib/api';

interface NavItem {
  id: string;
  label: string;
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  permissionDomain?: string;
  ownerOnly?: boolean;
}

const ADMIN_NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'لوحة المؤشرات', icon: LayoutDashboard },
  { id: 'properties', label: 'العقارات والوحدات', icon: Building2, permissionDomain: 'properties' },
  { id: 'parties', label: 'الأطراف', icon: Users, permissionDomain: 'parties' },
  { id: 'contracts', label: 'العقود والأقساط', icon: FileText, permissionDomain: 'contracts' },
  { id: 'services', label: 'الخدمات والعدادات', icon: Gauge, permissionDomain: 'services' },
  { id: 'collections', label: 'التحصيل والصناديق', icon: Wallet, permissionDomain: 'collections' },
  { id: 'maintenance', label: 'الصيانة', icon: Wrench, permissionDomain: 'maintenance' },
  { id: 'evictions', label: 'الإخلاء والتسوية', icon: DoorOpen, permissionDomain: 'evictions' },
  { id: 'accounting', label: 'المحاسبة والمطابقة', icon: BookOpen, permissionDomain: 'accounting' },
  { id: 'reports', label: 'التقارير والإشعارات', icon: BarChart3, permissionDomain: 'reports' },
  { id: 'settings', label: 'إعدادات المنشأة', icon: Settings, permissionDomain: 'settings' },
];

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [org, setOrg] = useState<OrganizationInfo | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const loadMe = useCallback(async (preserveTab = false) => {
    setAuthError(null);
    try {
      const res = await apiFetch<{ user: AuthUser | null; organization: OrganizationInfo | null }>('/api/auth/session');
      setUser(res.user);
      setOrg(res.organization);
      if (!preserveTab) {
        setActiveTab('dashboard');
      }
    } catch (err: any) {
      setAuthError(err?.message || 'تعذر التحقق من الجلسة');
    } finally {
      setAuthChecked(true);
    }
  }, []);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  async function handleLogout() {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST', body: '{}' });
    } catch {
      // Ignore network errors on logout and clear local view
    }
    setUser(null);
    setOrg(null);
    setMobileMenuOpen(false);
  }

  const visibleNavItems = useMemo(() => {
    if (!user) return [];
    if (user.role === 'OWNER') return ADMIN_NAV_ITEMS;
    if (user.role !== 'STAFF') return [];
    const perms = user.staffPermissions ?? {};
    return ADMIN_NAV_ITEMS.filter((item) => {
      if (item.ownerOnly) return false;
      if (!item.permissionDomain) return true;
      return Boolean(perms[item.permissionDomain]?.read);
    });
  }, [user]);

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-lg p-6">
          <div className="text-sm font-semibold text-slate-800 mb-4">جاري تحميل منصة مِلاك...</div>
          <LoadingRows rows={4} />
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginView onLoggedIn={loadMe} />;
  }

  const isSidebarShell = user.role === 'OWNER' || user.role === 'STAFF';
  const currentTab = visibleNavItems.some((n) => n.id === activeTab)
    ? activeTab
    : visibleNavItems[0]?.id ?? 'dashboard';

  function renderMainContent() {
    if (!user) return null;
    if (user.role === 'SUPER_ADMIN') {
      return <PlatformAdminView user={user} />;
    }
    if (!org) {
      return <ErrorBanner message="تعذر تحميل بيانات المنشأة المرتبطة بالحساب." />;
    }
    if (user.role === 'COLLECTOR') {
      return <CollectorPortalView org={org} />;
    }
    if (user.role === 'RENTER') {
      return <RenterPortalView org={org} />;
    }
    if (user.role === 'UNIT_OWNER') {
      return <UnitOwnerPortalView org={org} />;
    }

    switch (currentTab) {
      case 'dashboard':
        return <DashboardView org={org} onNavigate={setActiveTab} />;
      case 'properties':
        return <PropertiesView user={user} org={org} />;
      case 'parties':
        return <PartiesView org={org} />;
      case 'contracts':
        return <ContractsView org={org} />;
      case 'services':
        return <ServicesView org={org} />;
      case 'collections':
        return <CollectionsView org={org} />;
      case 'maintenance':
        return <MaintenanceView org={org} />;
      case 'evictions':
        return <EvictionSettlementView user={user} org={org} />;
      case 'accounting':
        return <AccountingView user={user} org={org} />;
      case 'reports':
        return <ReportsAndNotificationsView org={org} />;
      case 'settings':
        return <OrgSettingsView user={user} org={org} onOrgUpdated={() => loadMe(true)} />;
      default:
        return <DashboardView org={org} onNavigate={setActiveTab} />;
    }
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 flex flex-col">
      <header className="sticky top-0 z-30 h-14 bg-white border-b border-slate-200 px-4 lg:px-6 flex items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          {isSidebarShell && (
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="فتح القائمة الجانبية"
              className="lg:hidden p-2 -mr-2 text-slate-600 hover:text-slate-900 rounded-md"
            >
              <Menu className="w-5 h-5" aria-hidden="true" />
            </button>
          )}
          <div className="flex items-center gap-2 text-teal-800 shrink-0">
            <Building2 className="w-5 h-5 shrink-0" aria-hidden="true" />
            <span className="font-bold text-base text-slate-900 whitespace-nowrap">مِلاك</span>
          </div>
          {org ? (
            <div className="hidden sm:flex items-center gap-2 text-xs text-slate-500 truncate">
              <span aria-hidden="true">·</span>
              <span className="font-medium text-slate-700 truncate">{org.name}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono text-slate-500 shrink-0">{org.base_currency}</span>
            </div>
          ) : (
            <div className="hidden sm:flex items-center gap-2 text-xs text-slate-500">
              <span aria-hidden="true">·</span>
              <span className="font-medium text-slate-700">إدارة المنصة المركزية</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <div className="text-left sm:text-right hidden md:block">
            <div className="text-xs font-semibold text-slate-900 leading-tight">{user.fullName}</div>
            <div className="text-[11px] text-slate-500 leading-tight">
              {ROLE_LABELS[user.role] ?? user.role}
            </div>
          </div>
          <button type="button" onClick={handleLogout} className={secondaryBtnCls}>
            <LogOut className="w-4 h-4" aria-hidden="true" />
            <span>خروج</span>
          </button>
        </div>
      </header>

      <div className="flex-1 flex min-w-0">
        {isSidebarShell && (
          <>
            <aside className="hidden lg:block w-60 bg-white border-l border-slate-200 shrink-0">
              <nav aria-label="القائمة الرئيسية" className="p-3 space-y-1 sticky top-14">
                {visibleNavItems.map((item) => {
                  const Icon = item.icon;
                  const active = currentTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setActiveTab(item.id)}
                      aria-current={active ? 'page' : undefined}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-md transition-colors text-right whitespace-nowrap ${
                        active
                          ? 'bg-teal-50 text-teal-900 font-semibold'
                          : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" aria-hidden={true} />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </nav>
            </aside>

            {mobileMenuOpen && (
              <div className="fixed inset-0 z-50 lg:hidden flex">
                <div
                  className="fixed inset-0 bg-slate-900/40"
                  onClick={() => setMobileMenuOpen(false)}
                  aria-hidden="true"
                />
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-label="القائمة الجانبية"
                  className="relative z-10 w-64 max-w-[80vw] bg-white h-full border-l border-slate-200 flex flex-col"
                >
                  <div className="h-14 px-4 border-b border-slate-200 flex items-center justify-between">
                    <span className="font-bold text-slate-900">التنقل</span>
                    <button
                      type="button"
                      onClick={() => setMobileMenuOpen(false)}
                      aria-label="إغلاق القائمة"
                      className="p-1.5 text-slate-500 hover:text-slate-900 rounded-md"
                    >
                      <X className="w-5 h-5" aria-hidden="true" />
                    </button>
                  </div>
                  <nav aria-label="قائمة الجوال" className="p-3 space-y-1 overflow-y-auto flex-1">
                    {visibleNavItems.map((item) => {
                      const Icon = item.icon;
                      const active = currentTab === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => {
                            setActiveTab(item.id);
                            setMobileMenuOpen(false);
                          }}
                          aria-current={active ? 'page' : undefined}
                          className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm rounded-md transition-colors text-right whitespace-nowrap ${
                            active
                              ? 'bg-teal-50 text-teal-900 font-semibold'
                              : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                          }`}
                        >
                          <Icon className="w-4 h-4 shrink-0" aria-hidden={true} />
                          <span>{item.label}</span>
                        </button>
                      );
                    })}
                  </nav>
                </div>
              </div>
            )}
          </>
        )}

        <main className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto w-full">
          {authError && (
            <div className="mb-4">
              <ErrorBanner message={authError} onDismiss={() => setAuthError(null)} />
            </div>
          )}
          {renderMainContent()}
        </main>
      </div>
    </div>
  );
}
