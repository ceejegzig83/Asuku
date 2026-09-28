import React, { useState } from 'react';
import { Save, CheckCircle2 } from 'lucide-react';
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

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSavedNotice(false);
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
      if (res.ok) {
        await onRefresh();
        setSavedNotice(true);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSave} className="space-y-8 max-w-4xl">
      <div className="border border-slate-800 bg-slate-900 p-6 space-y-6">
        <div className="border-b border-slate-800 pb-4">
          <h2 className="text-lg font-semibold text-white">
            03. Multi-Tenant Business Profile & Provider Adapters
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

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 text-xs">
          <div>
            <label className="block text-slate-400 mb-1.5">
              Registered Nigerian Business Name
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
              Support / Escalation WhatsApp Phone
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
                  Verifies <span className="font-mono-tabular">x-paystack-signature</span>{' '}
                  via HMAC-SHA512 on raw request body.
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
                WhatsApp Messaging Provider & Approved Templates
              </h3>
              <p className="text-slate-400 mt-0.5">
                Switch seamlessly between Meta WhatsApp Cloud API and Termii behind the{' '}
                <span className="font-mono-tabular">WhatsAppProvider</span> interface.
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
              Payment Retry Token Expiration (Hours)
            </label>
            <input
              type="number"
              value={retryLinkExpiryHours}
              onChange={(e) => setRetryLinkExpiryHours(Number(e.target.value))}
              className="w-full border border-slate-800 bg-slate-950 px-3 py-2 text-slate-100 font-mono-tabular"
            />
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-slate-800 pt-5">
          <div>
            {savedNotice && (
              <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
                <CheckCircle2 className="h-4 w-4" />
                Configuration persisted to PostgreSQL
              </span>
            )}
          </div>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? 'Saving Configuration...' : 'Save Workspace Settings'}
          </button>
        </div>
      </div>
    </form>
  );
};
