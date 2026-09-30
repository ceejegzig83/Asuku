import React, { useState } from 'react';
import { Save, CheckCircle2, AlertTriangle, Shield } from 'lucide-react';
import { Business } from '../types.ts';

interface SettingsViewProps {
  business: Business;
  authHeaders: Record<string, string>;
  onRefresh: () => Promise<void>;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  business,
  authHeaders,
  onRefresh,
}) => {
  const [name, setName] = useState(business.name);
  const [phone, setPhone] = useState(business.phone || '+2348094421900');
  const [paystackEnabled, setPaystackEnabled] = useState(business.paystackEnabled);
  const [flutterwaveEnabled, setFlutterwaveEnabled] = useState(
    business.flutterwaveEnabled
  );
  const [whatsappProvider, setWhatsappProvider] = useState<'META' | 'TERMII'>(
    business.whatsappProvider
  );
  const [whatsappTemplateImmediate, setWhatsappTemplateImmediate] = useState(
    business.whatsappTemplateImmediate
  );
  const [whatsappTemplate24h, setWhatsappTemplate24h] = useState(
    business.whatsappTemplate24h
  );
  const [whatsappTemplate72h, setWhatsappTemplate72h] = useState(
    business.whatsappTemplate72h
  );
  const [retryLinkExpiryHours, setRetryLinkExpiryHours] = useState(
    business.retryLinkExpiryHours
  );
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSavedNotice(false);
    setValidationError(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          name,
          phone,
          paystackEnabled,
          flutterwaveEnabled,
          whatsappProvider,
          whatsappTemplateImmediate,
          whatsappTemplate24h,
          whatsappTemplate72h,
          retryLinkExpiryHours: Number(retryLinkExpiryHours),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setValidationError(data.error || 'Settings validation failed');
        return;
      }
      await onRefresh();
      setSavedNotice(true);
    } catch (err: unknown) {
      setValidationError(
        err instanceof Error ? err.message : 'Failed to save settings'
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSave} className="space-y-8 max-w-4xl">
      <div className="border border-slate-800 bg-slate-900 p-6 space-y-6">
        <div className="border-b border-slate-800 pb-4">
          <h2 className="text-lg font-semibold text-white">
            03. Multi-Tenant Business Profile & Validated Provider Settings
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Tenant ID:{' '}
            <span className="font-mono-tabular text-slate-200">{business.id}</span> ·
            Timezone:{' '}
            <span className="font-mono-tabular text-slate-200">
              {business.timezone}
            </span>{' '}
            · Currency:{' '}
            <span className="font-mono-tabular text-slate-200">
              {business.currency}
            </span>
          </p>
        </div>

        {/* Tenant-Bound Webhook URLs (Objective 6) */}
        <div className="border border-slate-800 bg-slate-950 p-4 space-y-2 text-xs">
          <div className="flex items-center gap-2 text-emerald-400 font-medium">
            <Shield className="h-4 w-4" />
            <span>
              Cryptographic Tenant-Scoped Webhook Endpoints (Objective 6 Hardened)
            </span>
          </div>
          <p className="text-slate-400">
            Configure these tenant-isolated URLs in your Paystack and Flutterwave
            dashboards. Unverified <span className="font-mono-tabular">businessId</span>{' '}
            fields in request bodies are never trusted.
          </p>
          <div className="space-y-1 font-mono-tabular text-slate-200 pt-1">
            <div>
              Paystack: POST /api/v1/webhooks/paystack/{business.webhookToken}
            </div>
            <div>
              Flutterwave: POST /api/v1/webhooks/flutterwave/{business.webhookToken}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 text-xs">
          <div>
            <label className="block text-slate-400 mb-1.5">
              Registered Nigerian Business Name (2–120 chars)
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-slate-100"
            />
          </div>

          <div>
            <label className="block text-slate-400 mb-1.5">
              Support WhatsApp Phone (Nigerian E.164 +234... or 080...)
            </label>
            <input
              type="text"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-slate-100 font-mono-tabular"
            />
          </div>
        </div>

        {/* Payment Gateways */}
        <div className="border-t border-slate-800 pt-5 space-y-3">
          <h3 className="text-sm font-semibold text-white">
            Active Payment Webhook Adapters
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <label className="flex items-start gap-3 border border-slate-800 bg-slate-950 p-4 cursor-pointer">
              <input
                type="checkbox"
                checked={paystackEnabled}
                onChange={(e) => setPaystackEnabled(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-emerald-500"
              />
              <div>
                <div className="font-semibold text-white">Paystack Adapter</div>
                <p className="text-slate-400 mt-0.5">
                  Verifies{' '}
                  <span className="font-mono-tabular">x-paystack-signature</span> via
                  HMAC-SHA512 on raw request body.
                </p>
              </div>
            </label>

            <label className="flex items-start gap-3 border border-slate-800 bg-slate-950 p-4 cursor-pointer">
              <input
                type="checkbox"
                checked={flutterwaveEnabled}
                onChange={(e) => setFlutterwaveEnabled(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-emerald-500"
              />
              <div>
                <div className="font-semibold text-white">Flutterwave Adapter</div>
                <p className="text-slate-400 mt-0.5">
                  Verifies{' '}
                  <span className="font-mono-tabular">flutterwave-signature</span>{' '}
                  (HMAC-SHA256) and <span className="font-mono-tabular">verif-hash</span>.
                </p>
              </div>
            </label>
          </div>
        </div>

        {/* WhatsApp Provider & Approved Template Configuration */}
        <div className="border-t border-slate-800 pt-5 space-y-4 text-xs">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-white">
                WhatsApp Messaging Provider & Approved Templates (Zod Validated)
              </h3>
              <p className="text-slate-400 mt-0.5">
                Template names must match{' '}
                <span className="font-mono-tabular">^[a-z0-9_]&#123;3,64&#125;$</span>.
              </p>
            </div>
            <div className="flex items-center gap-1 bg-slate-950 p-1 border border-slate-800">
              <button
                type="button"
                onClick={() => setWhatsappProvider('META')}
                className={`px-3 py-1.5 font-medium transition-colors whitespace-nowrap ${
                  whatsappProvider === 'META'
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Meta Cloud API
              </button>
              <button
                type="button"
                onClick={() => setWhatsappProvider('TERMII')}
                className={`px-3 py-1.5 font-medium transition-colors whitespace-nowrap ${
                  whatsappProvider === 'TERMII'
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Termii Nigeria
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-slate-400 mb-1.5">
                Step 1 (T+0 Immediate) Template
              </label>
              <input
                type="text"
                value={whatsappTemplateImmediate}
                onChange={(e) => setWhatsappTemplateImmediate(e.target.value)}
                className="w-full border border-slate-800 bg-slate-950 px-3 py-2 text-slate-100 font-mono-tabular"
              />
            </div>

            <div>
              <label className="block text-slate-400 mb-1.5">
                Step 2 (T+24h Reminder) Template
              </label>
              <input
                type="text"
                value={whatsappTemplate24h}
                onChange={(e) => setWhatsappTemplate24h(e.target.value)}
                className="w-full border border-slate-800 bg-slate-950 px-3 py-2 text-slate-100 font-mono-tabular"
              />
            </div>

            <div>
              <label className="block text-slate-400 mb-1.5">
                Step 3 (T+72h Final Notice) Template
              </label>
              <input
                type="text"
                value={whatsappTemplate72h}
                onChange={(e) => setWhatsappTemplate72h(e.target.value)}
                className="w-full border border-slate-800 bg-slate-950 px-3 py-2 text-slate-100 font-mono-tabular"
              />
            </div>
          </div>

          <div className="max-w-xs pt-2">
            <label className="block text-slate-400 mb-1.5">
              Payment Retry Token Expiration (1–720 Hours)
            </label>
            <input
              type="number"
              value={retryLinkExpiryHours}
              onChange={(e) => setRetryLinkExpiryHours(Number(e.target.value))}
              className="w-full border border-slate-800 bg-slate-950 px-3 py-2 text-slate-100 font-mono-tabular"
            />
          </div>
        </div>

        {validationError && (
          <div className="border border-red-900/60 bg-red-950/40 p-3.5 flex items-center gap-2 text-xs text-red-300">
            <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
            <span>Zod Validation Error: {validationError}</span>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-slate-800 pt-5">
          <div>
            {savedNotice && (
              <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
                <CheckCircle2 className="h-4 w-4" />
                Validated configuration persisted to PostgreSQL
              </span>
            )}
          </div>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? 'Validating & Saving...' : 'Save Workspace Settings'}
          </button>
        </div>
      </div>
    </form>
  );
};
