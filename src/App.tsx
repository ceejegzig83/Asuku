import React, { useEffect, useState, useCallback } from 'react';
import { signInWithPopup, onAuthStateChanged, signOut, User } from 'firebase/auth';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import {
  Search,
  ExternalLink,
  RefreshCw,
  LogIn,
  LogOut,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  AlertCircle,
  X,
  Lock,
  ShieldCheck,
} from 'lucide-react';
import { auth, googleAuthProvider } from './lib/firebase.ts';
import {
  DashboardSnapshot,
  FailedPaymentItem,
  SecurityRuntimeConfig,
} from './types.ts';
import { RetryCheckoutModal } from './components/RetryCheckoutModal.tsx';
import { WebhookSimulatorView } from './components/WebhookSimulatorView.tsx';
import { WhatsAppSequenceView } from './components/WhatsAppSequenceView.tsx';
import { SettingsView } from './components/SettingsView.tsx';

type NavTab = 'overview' | 'failed-payments' | 'whatsapp' | 'webhooks' | 'settings';

export default function App() {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [authInitialized, setAuthInitialized] = useState<boolean>(false);
  const [statusLoaded, setStatusLoaded] = useState<boolean>(false);
  const [idToken, setIdToken] = useState<string | null>(null);
  const [securityConfig, setSecurityConfig] =
    useState<SecurityRuntimeConfig | null>(null);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<NavTab>('failed-payments');
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Filters for Failed Payments table
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<
    'ALL' | 'PENDING' | 'RECOVERED' | 'EXPIRED'
  >('ALL');
  const [providerFilter, setProviderFilter] = useState<
    'ALL' | 'PAYSTACK' | 'FLUTTERWAVE'
  >('ALL');

  // Active payment + one-time issued raw token for Customer Retry Checkout modal (/r/:token)
  const [checkoutPayment, setCheckoutPayment] =
    useState<FailedPaymentItem | null>(null);
  const [issuedRawToken, setIssuedRawToken] = useState<string | null>(null);

  // Fetch public runtime security posture once on mount
  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/status')
      .then((r) => r.json())
      .then((cfg: SecurityRuntimeConfig) => {
        if (!cancelled) {
          setSecurityConfig(cfg);
          setStatusLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatusLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep Firebase Auth state & ID token in memory (never in localStorage)
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      if (user) {
        const token = await user.getIdToken();
        setIdToken(token);
      } else {
        setIdToken(null);
      }
      setAuthInitialized(true);
    });
    return () => unsub();
  }, []);

  const demoModeEnabled = Boolean(securityConfig?.demoModeEnabled);

  const getAuthHeaders = useCallback((): Record<string, string> => {
    if (idToken) {
      return { Authorization: `Bearer ${idToken}` };
    }
    if (demoModeEnabled) {
      return { 'x-asuku-demo-tenant': 'asuku-demo-nigeria' };
    }
    return {};
  }, [idToken, demoModeEnabled]);

  const fetchDashboard = useCallback(async () => {
    if (!authInitialized || !statusLoaded) return;
    // If neither Firebase token nor explicit ASUKU_DEMO_MODE=true is active, require sign-in
    if (!idToken && !demoModeEnabled) {
      setLoading(false);
      setSnapshot(null);
      return;
    }

    setError(null);
    try {
      const res = await fetch('/api/dashboard', {
        headers: getAuthHeaders(),
      });
      if (res.status === 401) {
        setSnapshot(null);
        setLoading(false);
        return;
      }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to load dashboard data');
      }
      const data = (await res.json()) as DashboardSnapshot;
      setSnapshot(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to load dashboard');
    } finally {
      setLoading(false);
    }
  }, [authInitialized, statusLoaded, idToken, demoModeEnabled, getAuthHeaders]);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  const handleGoogleSignIn = async () => {
    setAuthError(null);
    try {
      const cred = await signInWithPopup(auth, googleAuthProvider);
      const token = await cred.user.getIdToken();
      setIdToken(token);
      setAuthModalOpen(false);
    } catch (err: unknown) {
      setAuthError(
        err instanceof Error
          ? err.message
          : 'Google Sign-In popup was closed or blocked.'
      );
    }
  };

  const handleSignOut = async () => {
    await signOut(auth);
    setIdToken(null);
    setSnapshot(null);
  };

  // PHASE 1 OBJECTIVE 5: Mint a fresh one-time token (storing ONLY its SHA-256 hash in PostgreSQL) when opening Retry Checkout
  const handleOpenRetryCheckout = async (fp: FailedPaymentItem) => {
    setCheckoutPayment(fp);
    setIssuedRawToken(null);
    if (fp.status !== 'PENDING') {
      return;
    }
    try {
      const res = await fetch(`/api/failed-payments/${fp.id}/issue-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
      });
      const data = await res.json();
      if (res.ok && data.rawToken) {
        setIssuedRawToken(data.rawToken);
        await fetchDashboard();
      }
    } catch (err) {
      console.error('Failed to issue one-time recovery token:', err);
    }
  };

  const formatNaira = (amount: number) =>
    `₦${amount.toLocaleString('en-NG', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;

  const filteredFailedPayments = (snapshot?.failedPayments || []).filter((fp) => {
    if (statusFilter !== 'ALL' && fp.status !== statusFilter) return false;
    if (providerFilter !== 'ALL' && fp.provider !== providerFilter) return false;
    if (searchQuery.trim() !== '') {
      const q = searchQuery.toLowerCase();
      const matchName = fp.customerName.toLowerCase().includes(q);
      const matchRef = (fp.providerReference || '').toLowerCase().includes(q);
      const matchPlan = fp.planName.toLowerCase().includes(q);
      const matchPhone = fp.customerPhone.toLowerCase().includes(q);
      if (!matchName && !matchRef && !matchPlan && !matchPhone) return false;
    }
    return true;
  });

  const chartData = (snapshot?.failedPayments || []).map((fp) => ({
    name: fp.customerName.split('(')[0].trim(),
    Failed: fp.amountNumber,
    Recovered: fp.status === 'RECOVERED' ? fp.amountNumber : 0,
    Pending: fp.status === 'PENDING' ? fp.amountNumber : 0,
  }));

  const funnelStats = {
    step1Sent: (snapshot?.whatsappLogs || []).filter(
      (l) =>
        l.sequenceStep === 1 &&
        (l.status === 'SENT' || l.status === 'DELIVERED' || l.status === 'READ')
    ).length,
    step1NotConfigured: (snapshot?.whatsappLogs || []).filter(
      (l) => l.status === 'NOT_CONFIGURED' || l.status === 'FAILED'
    ).length,
    step2Sent: (snapshot?.whatsappLogs || []).filter(
      (l) =>
        l.sequenceStep === 2 &&
        (l.status === 'SENT' || l.status === 'DELIVERED' || l.status === 'READ')
    ).length,
    step2Queued: (snapshot?.whatsappLogs || []).filter(
      (l) => l.sequenceStep === 2 && l.status === 'QUEUED'
    ).length,
    step3Queued: (snapshot?.whatsappLogs || []).filter(
      (l) => l.sequenceStep === 3 && l.status === 'QUEUED'
    ).length,
    autoCancelled: (snapshot?.whatsappLogs || []).filter(
      (l) => l.status === 'CANCELLED'
    ).length,
  };

  const requiresFirebaseLogin =
    authInitialized &&
    statusLoaded &&
    !firebaseUser &&
    !demoModeEnabled;

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-100 flex flex-col">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-800 bg-[#090d16]/95 px-6 py-4 backdrop-blur-xs">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#overview"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('overview');
          }}
          className="text-lg font-bold tracking-tight text-white whitespace-nowrap"
        >
          ASUKU
        </a>

        {/* Zone 2: 5 clean text navigation links */}
        <nav className="hidden md:flex items-center gap-7 text-xs font-medium text-slate-400">
          <button
            type="button"
            onClick={() => setActiveTab('overview')}
            className={`py-1 transition-colors whitespace-nowrap ${
              activeTab === 'overview'
                ? 'text-white underline underline-offset-8 decoration-emerald-500 decoration-2'
                : 'hover:text-slate-100'
            }`}
          >
            Overview
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('failed-payments')}
            className={`py-1 transition-colors whitespace-nowrap ${
              activeTab === 'failed-payments'
                ? 'text-white underline underline-offset-8 decoration-emerald-500 decoration-2'
                : 'hover:text-slate-100'
            }`}
          >
            Failed Payments
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('whatsapp')}
            className={`py-1 transition-colors whitespace-nowrap ${
              activeTab === 'whatsapp'
                ? 'text-white underline underline-offset-8 decoration-emerald-500 decoration-2'
                : 'hover:text-slate-100'
            }`}
          >
            WhatsApp Automation
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('webhooks')}
            className={`py-1 transition-colors whitespace-nowrap ${
              activeTab === 'webhooks'
                ? 'text-white underline underline-offset-8 decoration-emerald-500 decoration-2'
                : 'hover:text-slate-100'
            }`}
          >
            Webhook Lab
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('settings')}
            className={`py-1 transition-colors whitespace-nowrap ${
              activeTab === 'settings'
                ? 'text-white underline underline-offset-8 decoration-emerald-500 decoration-2'
                : 'hover:text-slate-100'
            }`}
          >
            Settings
          </button>
        </nav>

        {/* Zone 3: 1-2 primary actions */}
        <div className="flex items-center gap-3">
          {snapshot && (
            <button
              type="button"
              onClick={() => setActiveTab('webhooks')}
              className="px-3.5 py-2 text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-500 transition-colors whitespace-nowrap"
            >
              Simulate Webhook
            </button>
          )}

          {firebaseUser ? (
            <button
              type="button"
              onClick={handleSignOut}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-slate-800 bg-slate-900 text-slate-300 hover:text-white transition-colors whitespace-nowrap"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign Out
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setAuthModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-slate-800 bg-slate-900 text-slate-200 hover:border-slate-700 transition-colors whitespace-nowrap"
            >
              <LogIn className="h-3.5 w-3.5" />
              Merchant Sign In
            </button>
          )}
        </div>
      </header>

      {/* Main Content Container */}
      <main className="mx-auto w-full max-w-[1380px] flex-1 px-6 py-8 space-y-8">
        {requiresFirebaseLogin ? (
          /* PHASE 1 OBJECTIVE 2: Strict Production Authentication Gate when ASUKU_DEMO_MODE=false */
          <div className="mx-auto max-w-2xl border border-slate-800 bg-slate-900 overflow-hidden my-8">
            <div className="relative h-48 w-full bg-slate-800">
              <img
                src="/src/assets/images/hero_fintech_lagos_1790626875953.jpg"
                alt="ASUKU Revenue Recovery Command Center"
                referrerPolicy="no-referrer"
                className="h-full w-full object-cover"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-slate-900/60 to-transparent" />
              <div className="absolute bottom-4 left-6 right-6">
                <div className="flex items-center gap-2 text-xs text-emerald-400 font-medium">
                  <Lock className="h-3.5 w-3.5" />
                  <span>Phase 1 Security Hardening Active (ASUKU_DEMO_MODE=false)</span>
                </div>
                <h1 className="mt-1 text-xl font-semibold text-white">
                  ASUKU Revenue Recovery — Merchant Authentication Required
                </h1>
              </div>
            </div>

            <div className="p-6 space-y-5">
              <p className="text-xs text-slate-300 leading-relaxed">
                Unauthenticated demo header access (<span className="font-mono-tabular">x-asuku-demo-tenant</span>) is disabled by default. Sign in with your Google account via Firebase Authentication to access your isolated multi-tenant PostgreSQL workspace.
              </p>

              <div className="border border-slate-800 bg-slate-950 p-4 space-y-1.5 text-xs text-slate-400">
                <div className="flex items-center gap-2 text-slate-200 font-medium">
                  <ShieldCheck className="h-4 w-4 text-emerald-400" />
                  <span>Enforced Backend Security Controls:</span>
                </div>
                <p>
                  1. Firebase ID Token verification via{' '}
                  <span className="font-mono-tabular">firebase-admin</span> · 2.
                  SHA-256 hashed recovery tokens · 3. Exact payment reference/amount
                  matching · 4. Honest WhatsApp <span className="font-mono-tabular">NOT_CONFIGURED</span> / <span className="font-mono-tabular">FAILED</span> reporting.
                </p>
              </div>

              {authError && (
                <div className="border border-red-900/60 bg-red-950/40 p-3 text-xs text-red-300">
                  {authError}
                </div>
              )}

              <button
                type="button"
                onClick={handleGoogleSignIn}
                className="w-full py-3 px-4 text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-500 transition-colors whitespace-nowrap"
              >
                Sign In with Google (Firebase Authentication)
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Workspace Context Header */}
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-slate-800 pb-6">
              <div className="space-y-1">
                <div className="text-xs text-slate-400">
                  <span>
                    {snapshot?.business.name || 'Loading Merchant Workspace...'}
                  </span>
                  <span className="mx-2" aria-hidden="true">
                    ·
                  </span>
                  <span>
                    Auth: {firebaseUser ? 'Firebase Verified' : 'Dev Demo Mode'}
                  </span>
                  <span className="mx-2" aria-hidden="true">
                    ·
                  </span>
                  <span>
                    Mock Providers:{' '}
                    {securityConfig?.mockProvidersEnabled ? 'Enabled (Dev)' : 'Disabled'}
                  </span>
                </div>
                <h1 className="text-2xl font-semibold tracking-tight text-white">
                  ASUKU Revenue Recovery — Automated Subscription Recovery
                </h1>
              </div>

              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2.5 pr-2">
                  <div className="h-8 w-8 overflow-hidden bg-slate-800 shrink-0">
                    <img
                      src="/src/assets/images/avatar_merchant_founder_1790626861596.jpg"
                      alt="Merchant Executive Profile"
                      referrerPolicy="no-referrer"
                      className="h-full w-full object-cover"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                  </div>
                  <div className="text-xs">
                    <div className="font-medium text-slate-200">
                      {firebaseUser?.displayName ||
                        firebaseUser?.email ||
                        'Adebayo Ogunlesi'}
                    </div>
                    <div className="text-slate-400">
                      {firebaseUser
                        ? 'Firebase Authenticated Tenant'
                        : 'Dev Demo Mode Tenant'}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={fetchDashboard}
                  className="inline-flex items-center gap-1.5 border border-slate-800 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 hover:text-white transition-colors whitespace-nowrap"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Refresh
                </button>
              </div>
            </div>

            {error && (
              <div className="border border-red-900/70 bg-red-950/30 p-4 text-xs text-red-300 flex items-center justify-between">
                <span>{error}</span>
                <button
                  type="button"
                  onClick={fetchDashboard}
                  className="underline hover:text-white"
                >
                  Retry
                </button>
              </div>
            )}

            {loading || !snapshot ? (
              <div className="space-y-6">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 border border-slate-800 bg-slate-900 divide-y sm:divide-y-0 sm:divide-x divide-slate-800">
                  {Array.from({ length: 6 }).map((_, idx) => (
                    <div key={idx} className="p-5 space-y-2 animate-pulse">
                      <div className="h-3 w-24 bg-slate-800" />
                      <div className="h-6 w-32 bg-slate-800" />
                    </div>
                  ))}
                </div>
                <div className="h-80 border border-slate-800 bg-slate-900 animate-pulse" />
              </div>
            ) : (
              <>
                {/* TAB 1: OVERVIEW */}
                {activeTab === 'overview' && (
                  <div className="space-y-8">
                    {/* 6 Core KPI Metrics Bar */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 border border-slate-800 bg-slate-900 divide-y sm:divide-y-0 sm:divide-x divide-slate-800">
                      <div className="p-5">
                        <div className="text-xs text-slate-400">
                          Total Failed Revenue
                        </div>
                        <div className="mt-2 text-xl font-semibold text-white font-mono-tabular">
                          {formatNaira(snapshot.metrics.totalFailedRevenue)}
                        </div>
                        <div className="mt-1 text-xs text-slate-400 font-mono-tabular">
                          {snapshot.metrics.totalFailedCount} failed charges
                        </div>
                      </div>

                      <div className="p-5">
                        <div className="text-xs text-slate-400">
                          Total Recovered Revenue
                        </div>
                        <div className="mt-2 text-xl font-semibold text-emerald-400 font-mono-tabular">
                          {formatNaira(snapshot.metrics.totalRecoveredRevenue)}
                        </div>
                        <div className="mt-1 text-xs text-slate-400 font-mono-tabular">
                          {snapshot.metrics.revenueRecoveryRate}% of NGN volume
                        </div>
                      </div>

                      <div className="p-5">
                        <div className="text-xs text-slate-400">
                          Recovery Conversion Rate
                        </div>
                        <div className="mt-2 text-xl font-semibold text-white font-mono-tabular">
                          {snapshot.metrics.recoveryRate.toFixed(2)}%
                        </div>
                        <div className="mt-1 text-xs text-slate-400 font-mono-tabular">
                          {snapshot.metrics.recoveredCount} of{' '}
                          {snapshot.metrics.totalFailedCount} recovered
                        </div>
                      </div>

                      <div className="p-5">
                        <div className="text-xs text-slate-400">
                          Customers with Failed Payments
                        </div>
                        <div className="mt-2 text-xl font-semibold text-amber-400 font-mono-tabular">
                          {snapshot.metrics.customersWithFailedCount}
                        </div>
                        <div className="mt-1 text-xs text-slate-400 font-mono-tabular">
                          {formatNaira(snapshot.metrics.pendingRecoveryRevenue)} at
                          risk
                        </div>
                      </div>

                      <div className="p-5">
                        <div className="text-xs text-slate-400">
                          Recovered Subscriptions
                        </div>
                        <div className="mt-2 text-xl font-semibold text-emerald-400 font-mono-tabular">
                          {snapshot.metrics.recoveredCount}
                        </div>
                        <div className="mt-1 text-xs text-slate-400">
                          Restored to Active
                        </div>
                      </div>

                      <div className="p-5">
                        <div className="text-xs text-slate-400">
                          Active Recovery Campaigns
                        </div>
                        <div className="mt-2 text-xl font-semibold text-white font-mono-tabular">
                          {snapshot.metrics.activeCampaignsCount}
                        </div>
                        <div className="mt-1 text-xs text-slate-400">
                          T+0 · T+24h · T+72h
                        </div>
                      </div>
                    </div>

                    {/* Charts & WhatsApp Sequence Funnel Row */}
                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                      <div className="lg:col-span-8 border border-slate-800 bg-slate-900 p-6">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-6">
                          <div>
                            <h2 className="text-sm font-semibold text-white">
                              Subscription Revenue Recovery Performance (NGN)
                            </h2>
                            <p className="text-xs text-slate-400 mt-0.5">
                              Comparison of failed subscription charges vs. verified
                              recovered payments across Paystack and Flutterwave
                            </p>
                          </div>
                          <div className="text-xs text-slate-400 font-mono-tabular">
                            <span>Recovered (Green)</span>
                            <span className="mx-2">·</span>
                            <span>Pending (Amber)</span>
                          </div>
                        </div>

                        <div className="h-64 w-full">
                          <ResponsiveContainer width="100%" height="100%">
                            <BarChart data={chartData} barGap={4}>
                              <CartesianGrid
                                strokeDasharray="3 3"
                                stroke="#1e293b"
                                vertical={false}
                              />
                              <XAxis
                                dataKey="name"
                                stroke="#94a3b8"
                                fontSize={11}
                                tickLine={false}
                              />
                              <YAxis
                                stroke="#94a3b8"
                                fontSize={11}
                                tickLine={false}
                                tickFormatter={(v) =>
                                  `₦${(Number(v) / 1000000).toFixed(1)}M`
                                }
                              />
                              <Tooltip
                                contentStyle={{
                                  backgroundColor: '#0f172a',
                                  borderColor: '#1e293b',
                                  fontSize: '12px',
                                  color: '#f8fafc',
                                }}
                                formatter={(value: unknown) => [
                                  formatNaira(Number(value)),
                                  '',
                                ]}
                              />
                              <Bar
                                dataKey="Recovered"
                                fill="#16a34a"
                                name="Recovered Revenue"
                              />
                              <Bar
                                dataKey="Pending"
                                fill="#d97706"
                                name="Pending Recovery"
                              />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                      </div>

                      <div className="lg:col-span-4 border border-slate-800 bg-slate-900 p-6 flex flex-col justify-between">
                        <div className="space-y-4">
                          <div>
                            <h2 className="text-sm font-semibold text-white">
                              WhatsApp Recovery Sequence Activity
                            </h2>
                            <p className="text-xs text-slate-400 mt-0.5">
                              Honest provider status reporting (never fakes delivery)
                            </p>
                          </div>

                          <div className="divide-y divide-slate-800 text-xs">
                            <div className="py-3 flex items-center justify-between">
                              <div>
                                <div className="text-slate-200 font-medium">
                                  Step 1: Immediate (T+0)
                                </div>
                                <div className="text-slate-400">
                                  Sent / Delivered vs. Not Configured
                                </div>
                              </div>
                              <span className="font-mono-tabular text-emerald-400 font-semibold">
                                {funnelStats.step1Sent} sent ·{' '}
                                <span className="text-amber-300">
                                  {funnelStats.step1NotConfigured} unconfigured
                                </span>
                              </span>
                            </div>

                            <div className="py-3 flex items-center justify-between">
                              <div>
                                <div className="text-slate-200 font-medium">
                                  Step 2: 24-Hour Follow-Up (T+24h)
                                </div>
                                <div className="text-slate-400">
                                  Pre-send worker checks payment & opt-in
                                </div>
                              </div>
                              <span className="font-mono-tabular text-slate-200">
                                {funnelStats.step2Sent} sent ·{' '}
                                {funnelStats.step2Queued} queued
                              </span>
                            </div>

                            <div className="py-3 flex items-center justify-between">
                              <div>
                                <div className="text-slate-200 font-medium">
                                  Step 3: 72-Hour Final Notice (T+72h)
                                </div>
                                <div className="text-slate-400">
                                  Final retry warning before expiration
                                </div>
                              </div>
                              <span className="font-mono-tabular text-amber-400">
                                {funnelStats.step3Queued} queued
                              </span>
                            </div>

                            <div className="py-3 flex items-center justify-between">
                              <div>
                                <div className="text-slate-200 font-medium">
                                  Cancelled (Recovery or Opt-Out)
                                </div>
                                <div className="text-slate-400">
                                  Stopped on charge.success or opt-out
                                </div>
                              </div>
                              <span className="font-mono-tabular text-emerald-400">
                                {funnelStats.autoCancelled} stopped
                              </span>
                            </div>
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={() => setActiveTab('whatsapp')}
                          className="mt-4 w-full py-2 px-4 text-xs font-medium border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 transition-colors whitespace-nowrap"
                        >
                          Inspect WhatsApp Queue & Payloads
                        </button>
                      </div>
                    </div>

                    {/* Recent Failed Payments & Active Recovery Campaigns Table */}
                    <div className="border border-slate-800 bg-slate-900">
                      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-800 px-6 py-4">
                        <div>
                          <h2 className="text-sm font-semibold text-white">
                            Failed Subscription Payments & Active Recovery Sequences
                          </h2>
                          <p className="text-xs text-slate-400 mt-0.5">
                            Recovery tokens are stored exclusively as SHA-256 hashes (
                            <span className="font-mono-tabular text-slate-300">
                              recovery_token_hash
                            </span>
                            ).
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          <div className="relative">
                            <Search className="h-3.5 w-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                            <input
                              type="text"
                              placeholder="Search customer, plan, ref..."
                              value={searchQuery}
                              onChange={(e) => setSearchQuery(e.target.value)}
                              className="border border-slate-800 bg-slate-950 pl-8 pr-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 w-56"
                            />
                          </div>

                          <div className="flex items-center gap-1 bg-slate-950 p-1 border border-slate-800">
                            {(
                              ['ALL', 'PENDING', 'RECOVERED', 'EXPIRED'] as const
                            ).map((st) => (
                              <button
                                key={st}
                                type="button"
                                onClick={() => setStatusFilter(st)}
                                className={`px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap ${
                                  statusFilter === st
                                    ? 'bg-slate-800 text-white'
                                    : 'text-slate-400 hover:text-slate-200'
                                }`}
                              >
                                {st === 'ALL'
                                  ? 'All'
                                  : st.charAt(0) + st.slice(1).toLowerCase()}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                          <thead>
                            <tr className="border-b border-slate-800 text-xs text-slate-400">
                              <th className="py-3 px-6 font-medium">
                                Customer · Subscription Plan
                              </th>
                              <th className="py-3 px-4 font-medium">
                                Provider · Reference
                              </th>
                              <th className="py-3 px-4 font-medium text-right">
                                Amount (NGN)
                              </th>
                              <th className="py-3 px-4 font-medium">
                                Recovery State
                              </th>
                              <th className="py-3 px-4 font-medium">
                                WhatsApp Sequence (T+0 / 24h / 72h)
                              </th>
                              <th className="py-3 px-6 font-medium text-right">
                                Customer Retry Link
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-800/70 text-xs">
                            {filteredFailedPayments.map((fp) => {
                              const isDevTestRecord =
                                fp.providerReference?.startsWith(
                                  'ASUKU-TEST-FAILED-'
                                ) ||
                                fp.providerReference?.startsWith(
                                  'ASUKU-FLUTTERWAVE-SANDBOX-'
                                ) ||
                                fp.customerName.includes('ASUKU TEST CUSTOMER') ||
                                fp.customerName.includes(
                                  'ASUKU FLUTTERWAVE SANDBOX TEST'
                                );
                              return (
                              <tr
                                key={fp.id}
                                className={`transition-colors ${
                                  isDevTestRecord
                                    ? 'bg-amber-950/20 hover:bg-amber-950/30'
                                    : 'hover:bg-slate-800/40'
                                }`}
                              >
                                <td className="py-3.5 px-6">
                                  <div className="font-medium text-white flex flex-wrap items-center gap-1.5">
                                    <span>{fp.customerName}</span>
                                    {isDevTestRecord && (
                                      <span className="text-amber-400 font-mono-tabular">
                                        · DEVELOPMENT / TEST RECORD (NO LIVE CHARGE)
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-slate-400 mt-0.5">
                                    {fp.planName} ·{' '}
                                    <span className="font-mono-tabular">
                                      {fp.customerPhone}
                                    </span>
                                  </div>
                                  {fp.failureReason && (
                                    <div className="text-[11px] text-slate-400 mt-0.5">
                                      Reason: {fp.failureReason}
                                    </div>
                                  )}
                                </td>

                                <td className="py-3.5 px-4 font-mono-tabular text-slate-300">
                                  <div>{fp.provider}</div>
                                  <div className="text-slate-400">
                                    {fp.providerReference}
                                  </div>
                                </td>

                                <td className="py-3.5 px-4 text-right font-mono-tabular font-semibold text-white">
                                  {formatNaira(fp.amountNumber)}
                                </td>

                                <td className="py-3.5 px-4">
                                  {fp.status === 'RECOVERED' ? (
                                    <span className="inline-flex items-center gap-1.5 text-emerald-400 font-medium">
                                      <CheckCircle2 className="h-3.5 w-3.5" />
                                      Recovered
                                    </span>
                                  ) : fp.status === 'PENDING' ? (
                                    <span className="inline-flex items-center gap-1.5 text-amber-400 font-medium">
                                      <Clock className="h-3.5 w-3.5" />
                                      Pending · Active
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1.5 text-red-400 font-medium">
                                      <AlertCircle className="h-3.5 w-3.5" />
                                      {fp.status}
                                    </span>
                                  )}
                                </td>

                                <td className="py-3.5 px-4 font-mono-tabular text-slate-300">
                                  {fp.sequenceLogs.length > 0 ? (
                                    <div className="space-y-0.5">
                                      {fp.sequenceLogs.map((log) => (
                                        <div
                                          key={log.id}
                                          className="text-[11px] flex items-center gap-1.5"
                                        >
                                          <span className="text-slate-400">
                                            {log.sequenceStep === 1
                                              ? 'T+0:'
                                              : log.sequenceStep === 2
                                              ? 'T+24h:'
                                              : 'T+72h:'}
                                          </span>
                                          <span
                                            className={
                                              log.status === 'READ' ||
                                              log.status === 'DELIVERED' ||
                                              log.status === 'SENT'
                                                ? 'text-emerald-400'
                                                : log.status === 'QUEUED'
                                                ? 'text-amber-400'
                                                : log.status === 'NOT_CONFIGURED'
                                                ? 'text-amber-300'
                                                : log.status === 'FAILED'
                                                ? 'text-red-400'
                                                : 'text-slate-500'
                                            }
                                          >
                                            {log.status}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <span className="text-slate-500">
                                      No Messages Dispatched
                                    </span>
                                  )}
                                </td>

                                <td className="py-3.5 px-6 text-right">
                                  <button
                                    type="button"
                                    onClick={() => handleOpenRetryCheckout(fp)}
                                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                                      fp.status === 'PENDING'
                                        ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                                        : 'border border-slate-700 bg-slate-800 text-slate-300 hover:text-white'
                                    }`}
                                  >
                                    <ExternalLink className="h-3.5 w-3.5" />
                                    {fp.status === 'PENDING'
                                      ? 'Issue & Test Token'
                                      : 'View Receipt'}
                                  </button>
                                </td>
                              </tr>
                            );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}

                {/* TAB 2: FAILED PAYMENTS & SUBSCRIPTIONS LEDGER */}
                {activeTab === 'failed-payments' && (
                  <div className="space-y-8">
                    <div className="border border-slate-800 bg-slate-900 p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div>
                        <h2 className="text-lg font-semibold text-white">
                          Failed Payments & SHA-256 Hashed Recovery Tokens
                        </h2>
                        <p className="text-xs text-slate-400 mt-1">
                          Plaintext tokens are never persisted in PostgreSQL; only{' '}
                          <span className="font-mono-tabular text-slate-200">
                            recovery_token_hash
                          </span>{' '}
                          is stored.
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={fetchDashboard}
                          className="inline-flex items-center gap-1.5 border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 transition-colors whitespace-nowrap"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          Refresh Failed Payments
                        </button>
                        <select
                          value={providerFilter}
                          onChange={(e) =>
                            setProviderFilter(
                              e.target.value as 'ALL' | 'PAYSTACK' | 'FLUTTERWAVE'
                            )
                          }
                          className="border border-slate-800 bg-slate-950 px-3 py-1.5 text-xs text-slate-200"
                        >
                          <option value="ALL">All Providers</option>
                          <option value="PAYSTACK">Paystack Only</option>
                          <option value="FLUTTERWAVE">Flutterwave Only</option>
                        </select>
                      </div>
                    </div>

                    {filteredFailedPayments.some(
                      (fp) =>
                        fp.providerReference?.startsWith(
                          'ASUKU-TEST-FAILED-'
                        ) ||
                        fp.providerReference?.startsWith(
                          'ASUKU-FLUTTERWAVE-SANDBOX-'
                        )
                    ) && (
                      <div className="border border-amber-800/60 bg-amber-950/30 px-6 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                        <div className="text-amber-300 font-medium">
                          DEVELOPMENT / SANDBOX TEST RECORDS ACTIVE:{' '}
                          <span className="font-mono-tabular text-white">
                            {filteredFailedPayments
                              .filter(
                                (fp) =>
                                  fp.providerReference?.startsWith(
                                    'ASUKU-TEST-FAILED-'
                                  ) ||
                                  fp.providerReference?.startsWith(
                                    'ASUKU-FLUTTERWAVE-SANDBOX-'
                                  )
                              )
                              .map(
                                (fp) =>
                                  `${fp.providerReference} (${fp.customerName})`
                              )
                              .join(' · ')}
                          </span>
                        </div>
                        <div className="text-amber-400/90 font-mono-tabular">
                          No live card charged · No WhatsApp sent · SHA-256 token hash only
                        </div>
                      </div>
                    )}

                    <div className="border border-slate-800 bg-slate-900 overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-slate-800 text-xs text-slate-400">
                            <th className="py-3 px-6 font-medium">Customer</th>
                            <th className="py-3 px-4 font-medium">
                              Subscription Plan
                            </th>
                            <th className="py-3 px-4 font-medium">
                              Gateway · Exact Reference
                            </th>
                            <th className="py-3 px-4 font-medium text-right">
                              Amount
                            </th>
                            <th className="py-3 px-4 font-medium">
                              Stored SHA-256 Token Hash
                            </th>
                            <th className="py-3 px-4 font-medium">Status</th>
                            <th className="py-3 px-6 font-medium text-right">
                              Action
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/70 text-xs">
                          {filteredFailedPayments.map((fp) => {
                            const isDevTestRecord =
                              fp.providerReference?.startsWith(
                                'ASUKU-TEST-FAILED-'
                              ) ||
                              fp.providerReference?.startsWith(
                                'ASUKU-FLUTTERWAVE-SANDBOX-'
                              ) ||
                              fp.customerName.includes('ASUKU TEST CUSTOMER') ||
                              fp.customerName.includes(
                                'ASUKU FLUTTERWAVE SANDBOX TEST'
                              );
                            return (
                            <tr
                              key={fp.id}
                              className={`transition-colors ${
                                isDevTestRecord
                                  ? 'bg-amber-950/20 hover:bg-amber-950/30'
                                  : 'hover:bg-slate-800/40'
                              }`}
                            >
                              <td className="py-3.5 px-6">
                                <div className="font-medium text-white">
                                  {fp.customerName}
                                </div>
                                {isDevTestRecord && (
                                  <div className="text-amber-400 font-mono-tabular mt-0.5">
                                    {fp.providerReference?.startsWith(
                                      'ASUKU-FLUTTERWAVE-SANDBOX-'
                                    )
                                      ? 'FLUTTERWAVE SANDBOX TEST · NO LIVE CHARGE'
                                      : 'DEVELOPMENT / TEST RECORD · NO LIVE CHARGE'}
                                  </div>
                                )}
                                <div className="font-mono-tabular text-slate-400 mt-0.5">
                                  {fp.customerPhone}
                                </div>
                              </td>
                              <td className="py-3.5 px-4 text-slate-200">
                                <div>{fp.planName}</div>
                                {fp.failureReason && (
                                  <div className="text-[11px] text-slate-400 mt-0.5">
                                    {fp.failureReason}
                                  </div>
                                )}
                              </td>
                              <td className="py-3.5 px-4 font-mono-tabular text-slate-300">
                                {fp.provider} · {fp.providerReference}
                              </td>
                              <td className="py-3.5 px-4 text-right font-mono-tabular font-semibold text-white">
                                {formatNaira(fp.amountNumber)}
                              </td>
                              <td className="py-3.5 px-4 font-mono-tabular text-slate-400">
                                {fp.recoveryTokenHash
                                  ? `sha256:${fp.recoveryTokenHash.slice(0, 16)}...`
                                  : '—'}
                              </td>
                              <td className="py-3.5 px-4">
                                <span
                                  className={
                                    fp.status === 'RECOVERED'
                                      ? 'text-emerald-400 font-medium'
                                      : fp.status === 'PENDING'
                                      ? 'text-amber-400 font-medium'
                                      : 'text-red-400 font-medium'
                                  }
                                >
                                  {fp.status}
                                </span>
                              </td>
                              <td className="py-3.5 px-6 text-right">
                                <button
                                  type="button"
                                  onClick={() => handleOpenRetryCheckout(fp)}
                                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 transition-colors whitespace-nowrap"
                                >
                                  Open Checkout
                                  <ArrowUpRight className="h-3.5 w-3.5" />
                                </button>
                              </td>
                            </tr>
                          );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* TAB 3: WHATSAPP AUTOMATION */}
                {activeTab === 'whatsapp' && (
                  <WhatsAppSequenceView
                    logs={snapshot.whatsappLogs}
                    customers={snapshot.customers}
                    authHeaders={getAuthHeaders()}
                    onRefresh={fetchDashboard}
                  />
                )}

                {/* TAB 4: WEBHOOK LAB */}
                {activeTab === 'webhooks' && (
                  <WebhookSimulatorView
                    webhookEvents={snapshot.webhookEvents}
                    failedPayments={snapshot.failedPayments}
                    webhookToken={snapshot.business.webhookToken}
                    authHeaders={getAuthHeaders()}
                    onRefresh={fetchDashboard}
                  />
                )}

                {/* TAB 5: SETTINGS */}
                {activeTab === 'settings' && (
                  <SettingsView
                    business={snapshot.business}
                    authHeaders={getAuthHeaders()}
                    onRefresh={fetchDashboard}
                  />
                )}
              </>
            )}
          </>
        )}
      </main>

      {/* Quiet Editorial Footer */}
      <footer className="border-t border-slate-800/80 py-6 px-6 text-xs text-slate-500">
        <div className="mx-auto max-w-[1380px] flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            ASUKU Revenue Recovery — Automated Subscription Payment Recovery for
            Nigerian Businesses
          </div>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setActiveTab('webhooks')}
              className="hover:text-slate-300 transition-colors"
            >
              Paystack & Flutterwave Webhooks
            </button>
            <span>·</span>
            <button
              type="button"
              onClick={() => setActiveTab('whatsapp')}
              className="hover:text-slate-300 transition-colors"
            >
              Meta Cloud API & Termii
            </button>
          </div>
        </div>
      </footer>

      {/* Customer Payment Retry Checkout Modal (/r/:token) */}
      <RetryCheckoutModal
        payment={checkoutPayment}
        issuedRawToken={issuedRawToken}
        businessName={snapshot?.business.name || 'ASUKU Merchant'}
        onClose={() => {
          setCheckoutPayment(null);
          setIssuedRawToken(null);
        }}
        onRecovered={fetchDashboard}
      />

      {/* Firebase Google Sign-In Modal */}
      {authModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md border border-slate-800 bg-slate-900 overflow-hidden">
            <div className="relative h-40 w-full bg-slate-800">
              <img
                src="/src/assets/images/hero_fintech_lagos_1790626875953.jpg"
                alt="ASUKU Lagos Fintech Operations"
                referrerPolicy="no-referrer"
                className="h-full w-full object-cover"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-slate-900 via-slate-900/60 to-transparent" />
              <button
                type="button"
                onClick={() => setAuthModalOpen(false)}
                className="absolute top-3 right-3 p-1.5 bg-slate-900/80 text-slate-300 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
              <div className="absolute bottom-4 left-6 right-6">
                <h3 className="text-base font-semibold text-white">
                  ASUKU Merchant Authentication
                </h3>
                <p className="text-xs text-slate-300">
                  Multi-tenant B2B isolation powered by Firebase Auth & PostgreSQL
                </p>
              </div>
            </div>

            <div className="p-6 space-y-4">
              <p className="text-xs text-slate-300 leading-relaxed">
                Sign in with your Google account to authenticate with Firebase and
                access your multi-tenant PostgreSQL workspace.
              </p>

              {authError && (
                <div className="border border-red-900/60 bg-red-950/40 p-3 text-xs text-red-300">
                  {authError}
                </div>
              )}

              <div className="space-y-2.5 pt-2">
                <button
                  type="button"
                  onClick={handleGoogleSignIn}
                  className="w-full py-2.5 px-4 text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-500 transition-colors whitespace-nowrap"
                >
                  Continue with Google Sign-In
                </button>
                <button
                  type="button"
                  onClick={() => setAuthModalOpen(false)}
                  className="w-full py-2 px-4 text-xs font-medium border border-slate-800 bg-slate-950 text-slate-300 hover:text-white transition-colors whitespace-nowrap"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
