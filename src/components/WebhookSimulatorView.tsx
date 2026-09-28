import React, { useState } from 'react';
import {
  Play,
  Copy,
  ShieldAlert,
  CheckCircle2,
  Repeat,
  FileJson,
  ArrowRight,
} from 'lucide-react';
import { WebhookEventItem } from '../types.ts';

interface WebhookSimulatorViewProps {
  webhookEvents: WebhookEventItem[];
  authHeaders: Record<string, string>;
  onRefresh: () => Promise<void>;
}

export const WebhookSimulatorView: React.FC<WebhookSimulatorViewProps> = ({
  webhookEvents,
  authHeaders,
  onRefresh,
}) => {
  const [provider, setProvider] = useState<'PAYSTACK' | 'FLUTTERWAVE'>('PAYSTACK');
  const [eventType, setEventType] = useState<
    'invoice.payment_failed' | 'charge.failed' | 'charge.success'
  >('invoice.payment_failed');
  const [providerEventId, setProviderEventId] = useState(
    () => `evt_pstk_${Math.floor(100000 + Math.random() * 900000)}`
  );
  const [customerName, setCustomerName] = useState(
    'Folake Adeyemi (Lagoon Retail Cloud)'
  );
  const [customerEmail, setCustomerEmail] = useState('f.adeyemi@lagoonretail.ng');
  const [customerPhone, setCustomerPhone] = useState('08037719284');
  const [planName, setPlanName] = useState('Enterprise POS & Settlement Suite');
  const [amountNaira, setAmountNaira] = useState(1450000);
  const [providerReference, setProviderReference] = useState(
    () => `ref_pstk_${Math.floor(1000 + Math.random() * 9000)}`
  );
  const [failureReason, setFailureReason] = useState(
    'Insufficient Funds on Corporate GTBank Mastercard (*3319)'
  );
  const [tamperSignature, setTamperSignature] = useState(false);

  const [running, setRunning] = useState(false);
  const [lastResponse, setLastResponse] = useState<{
    httpStatus: number;
    body: Record<string, unknown>;
  } | null>(null);
  const [selectedWebhook, setSelectedWebhook] = useState<WebhookEventItem | null>(
    webhookEvents[0] || null
  );

  const dispatchSimulation = async (overrideParams?: {
    keepSameEventId?: boolean;
    forceTamper?: boolean;
    forceEventType?: 'invoice.payment_failed' | 'charge.failed' | 'charge.success';
  }) => {
    setRunning(true);
    try {
      const targetEventId = overrideParams?.keepSameEventId
        ? providerEventId
        : providerEventId;
      const targetTamper =
        overrideParams?.forceTamper !== undefined
          ? overrideParams.forceTamper
          : tamperSignature;
      const targetEvent = overrideParams?.forceEventType || eventType;

      const res = await fetch('/api/webhooks/simulate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          provider,
          eventType: targetEvent,
          providerEventId: targetEventId,
          tamperSignature: targetTamper,
          customerName,
          customerEmail,
          customerPhone,
          planName,
          amountNaira: Number(amountNaira),
          providerReference,
          failureReason,
        }),
      });

      const data = await res.json();
      setLastResponse({ httpStatus: res.status, body: data });
      await onRefresh();
    } catch (err: unknown) {
      setLastResponse({
        httpStatus: 500,
        body: {
          error: err instanceof Error ? err.message : 'Simulation request failed',
        },
      });
    } finally {
      setRunning(false);
    }
  };

  const generateFreshEventId = () => {
    const prefix = provider === 'PAYSTACK' ? 'evt_pstk_' : 'evt_flw_';
    const nextId = `${prefix}${Math.floor(100000 + Math.random() * 900000)}`;
    const nextRef =
      provider === 'PAYSTACK'
        ? `ref_pstk_${Math.floor(1000 + Math.random() * 9000)}`
        : `flw_ref_${Math.floor(1000 + Math.random() * 9000)}`;
    setProviderEventId(nextId);
    setProviderReference(nextRef);
  };

  return (
    <div className="space-y-8">
      {/* Architectural Pipeline Banner */}
      <div className="border border-slate-800 bg-slate-900 p-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">
              01. Cryptographic Webhook Verification & Idempotency Lab
            </h2>
            <p className="mt-1 text-xs text-slate-400 max-w-3xl">
              Test the end-to-end ingestion algorithm: raw-body HMAC verification (
              <span className="font-mono-tabular text-slate-200">
                x-paystack-signature
              </span>{' '}
              SHA-512 &{' '}
              <span className="font-mono-tabular text-slate-200">
                flutterwave-signature
              </span>{' '}
              SHA-256), unique constraint idempotency on{' '}
              <span className="font-mono-tabular text-slate-200">
                (provider, provider_event_id)
              </span>
              , and automatic WhatsApp queue cancellation upon recovery.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300 font-mono-tabular">
            <span>Webhook</span>
            <ArrowRight className="h-3.5 w-3.5 text-slate-500" />
            <span>Verify HMAC</span>
            <ArrowRight className="h-3.5 w-3.5 text-slate-500" />
            <span>Idempotent Insert</span>
            <ArrowRight className="h-3.5 w-3.5 text-slate-500" />
            <span>Queue T+0 / 24h / 72h</span>
          </div>
        </div>
      </div>

      {/* Simulator Controls + Live Response */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Webhook Dispatch Form */}
        <div className="lg:col-span-7 border border-slate-800 bg-slate-900 p-6 space-y-5">
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <h3 className="text-sm font-semibold text-white">
              Configure Incoming Provider Webhook
            </h3>
            <button
              type="button"
              onClick={generateFreshEventId}
              className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors whitespace-nowrap"
            >
              Generate Fresh Event ID & Reference
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block text-slate-400 mb-1.5">Payment Provider</label>
              <div className="flex items-center gap-1 bg-slate-950 p-1 border border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    setProvider('PAYSTACK');
                    setEventType('invoice.payment_failed');
                    setProviderEventId(
                      `evt_pstk_${Math.floor(100000 + Math.random() * 900000)}`
                    );
                  }}
                  className={`flex-1 py-1.5 px-3 font-medium transition-colors whitespace-nowrap ${
                    provider === 'PAYSTACK'
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Paystack (SHA-512)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setProvider('FLUTTERWAVE');
                    setEventType('charge.failed');
                    setProviderEventId(
                      `evt_flw_${Math.floor(100000 + Math.random() * 900000)}`
                    );
                  }}
                  className={`flex-1 py-1.5 px-3 font-medium transition-colors whitespace-nowrap ${
                    provider === 'FLUTTERWAVE'
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Flutterwave (SHA-256)
                </button>
              </div>
            </div>

            <div>
              <label className="block text-slate-400 mb-1.5">Webhook Event Type</label>
              <select
                value={eventType}
                onChange={(e) =>
                  setEventType(
                    e.target.value as
                      | 'invoice.payment_failed'
                      | 'charge.failed'
                      | 'charge.success'
                  )
                }
                className="w-full border border-slate-800 bg-slate-950 px-3 py-2 text-slate-100 font-mono-tabular"
              >
                <option value="invoice.payment_failed">
                  invoice.payment_failed (Trigger Recovery)
                </option>
                <option value="charge.failed">
                  charge.failed (Trigger Recovery)
                </option>
                <option value="charge.success">
                  charge.success (Verify & Cancel Queue)
                </option>
              </select>
            </div>

            <div>
              <label className="block text-slate-400 mb-1.5">
                Provider Event ID (Idempotency Key)
              </label>
              <input
                type="text"
                value={providerEventId}
                onChange={(e) => setProviderEventId(e.target.value)}
                className="w-full border border-slate-800 bg-slate-950 px-3 py-2 text-slate-100 font-mono-tabular"
              />
            </div>

            <div>
              <label className="block text-slate-400 mb-1.5">
                Transaction Reference
              </label>
              <input
                type="text"
                value={providerReference}
                onChange={(e) => setProviderReference(e.target.value)}
                className="w-full border border-slate-800 bg-slate-950 px-3 py-2 text-slate-100 font-mono-tabular"
              />
            </div>

            <div>
              <label className="block text-slate-400 mb-1.5">Customer Name</label>
              <input
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                className="w-full border border-slate-800 bg-slate-950 px-3 py-2 text-slate-100"
              />
            </div>

            <div>
              <label className="block text-slate-400 mb-1.5">
                Nigerian WhatsApp Phone (Auto-Normalized to +234)
              </label>
              <input
                type="text"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                className="w-full border border-slate-800 bg-slate-950 px-3 py-2 text-slate-100 font-mono-tabular"
              />
            </div>

            <div>
              <label className="block text-slate-400 mb-1.5">
                Subscription Plan Name
              </label>
              <input
                type="text"
                value={planName}
                onChange={(e) => setPlanName(e.target.value)}
                className="w-full border border-slate-800 bg-slate-950 px-3 py-2 text-slate-100"
              />
            </div>

            <div>
              <label className="block text-slate-400 mb-1.5">Amount (NGN ₦)</label>
              <input
                type="number"
                value={amountNaira}
                onChange={(e) => setAmountNaira(Number(e.target.value))}
                className="w-full border border-slate-800 bg-slate-950 px-3 py-2 text-slate-100 font-mono-tabular"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="block text-slate-400 mb-1.5">
                Gateway Decline / Failure Reason
              </label>
              <input
                type="text"
                value={failureReason}
                onChange={(e) => setFailureReason(e.target.value)}
                className="w-full border border-slate-800 bg-slate-950 px-3 py-2 text-slate-100"
              />
            </div>
          </div>

          {/* Security toggle */}
          <div className="flex items-center justify-between border-t border-slate-800 pt-4">
            <label className="flex items-center gap-2.5 text-xs text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={tamperSignature}
                onChange={(e) => setTamperSignature(e.target.checked)}
                className="h-4 w-4 accent-emerald-500"
              />
              <span>
                Intentionally corrupt HMAC signature header (test{' '}
                <span className="font-mono-tabular text-amber-400">
                  HTTP 401 Unauthorized
                </span>{' '}
                rejection)
              </span>
            </label>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="button"
              disabled={running}
              onClick={() => dispatchSimulation({ forceTamper: false })}
              className="flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              <Play className="h-3.5 w-3.5" />
              {running ? 'Processing Webhook...' : '1. Send Signed Webhook'}
            </button>

            <button
              type="button"
              disabled={running}
              onClick={() =>
                dispatchSimulation({ keepSameEventId: true, forceTamper: false })
              }
              className="flex items-center gap-2 px-4 py-2 text-xs font-medium border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              <Repeat className="h-3.5 w-3.5" />
              2. Replay Same Event ID (Idempotency Check)
            </button>

            <button
              type="button"
              disabled={running}
              onClick={() => dispatchSimulation({ forceTamper: true })}
              className="flex items-center gap-2 px-4 py-2 text-xs font-medium border border-red-900/60 bg-red-950/40 text-red-300 hover:bg-red-950/70 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              <ShieldAlert className="h-3.5 w-3.5" />
              3. Test Tampered Signature (401)
            </button>
          </div>
        </div>

        {/* Right: Verification Output Console */}
        <div className="lg:col-span-5 border border-slate-800 bg-slate-900 p-6 flex flex-col justify-between space-y-4">
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <h3 className="text-sm font-semibold text-white">
                Webhook Verification Response
              </h3>
              {lastResponse && (
                <span
                  className={`text-xs font-mono-tabular ${
                    lastResponse.httpStatus === 200
                      ? 'text-emerald-400'
                      : 'text-red-400'
                  }`}
                >
                  HTTP {lastResponse.httpStatus}
                </span>
              )}
            </div>

            {lastResponse ? (
              <div className="space-y-3 text-xs">
                <div className="flex items-start gap-2.5">
                  {lastResponse.httpStatus === 200 ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                  ) : (
                    <ShieldAlert className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                  )}
                  <p className="text-slate-200 leading-relaxed">
                    {String(
                      lastResponse.body.message ||
                        lastResponse.body.error ||
                        'Processed'
                    )}
                  </p>
                </div>

                <pre className="overflow-x-auto border border-slate-800 bg-slate-950 p-3.5 text-[11px] leading-relaxed text-slate-300 font-mono-tabular max-h-80">
                  {JSON.stringify(lastResponse.body, null, 2)}
                </pre>
              </div>
            ) : (
              <div className="py-12 text-center space-y-2">
                <FileJson className="h-6 w-6 text-slate-500 mx-auto" />
                <p className="text-xs text-slate-400">
                  Click &ldquo;1. Send Signed Webhook&rdquo; to execute HMAC signature
                  verification, idempotent persistence, and BullMQ recovery scheduling.
                </p>
              </div>
            )}
          </div>

          <div className="border-t border-slate-800 pt-4 text-xs text-slate-400 space-y-1">
            <p className="text-slate-300 font-medium">Production Endpoints Active:</p>
            <p className="font-mono-tabular">POST /api/v1/webhooks/paystack</p>
            <p className="font-mono-tabular">POST /api/v1/webhooks/flutterwave</p>
          </div>
        </div>
      </div>

      {/* Persisted Webhook Events Ledger */}
      <div className="border border-slate-800 bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div>
            <h3 className="text-sm font-semibold text-white">
              Idempotent Webhook Events Ledger (webhook_events)
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Enforced by PostgreSQL unique index{' '}
              <span className="font-mono-tabular text-slate-300">
                UNIQUE(provider, provider_event_id)
              </span>
            </p>
          </div>
          <span className="text-xs text-slate-400 font-mono-tabular">
            {webhookEvents.length} recorded events
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-xs text-slate-400">
                <th className="py-3 px-6 font-medium">Provider · Event ID</th>
                <th className="py-3 px-4 font-medium">Event Type</th>
                <th className="py-3 px-4 font-medium">HMAC Signature Digest</th>
                <th className="py-3 px-4 font-medium">State</th>
                <th className="py-3 px-6 font-medium text-right">Processed At</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 text-xs">
              {webhookEvents.map((evt) => (
                <tr
                  key={evt.id}
                  onClick={() => setSelectedWebhook(evt)}
                  className="hover:bg-slate-800/40 cursor-pointer transition-colors"
                >
                  <td className="py-3 px-6 font-mono-tabular text-slate-200">
                    {evt.provider} · {evt.providerEventId}
                  </td>
                  <td className="py-3 px-4 font-mono-tabular text-slate-300">
                    {evt.eventType}
                  </td>
                  <td className="py-3 px-4 font-mono-tabular text-slate-400 max-w-xs truncate">
                    {evt.signature || 'verified'}
                  </td>
                  <td className="py-3 px-4 text-emerald-400">
                    Verified · Processed
                  </td>
                  <td className="py-3 px-6 text-right font-mono-tabular text-slate-400">
                    {evt.processedAt
                      ? new Date(evt.processedAt).toLocaleString('en-NG')
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selectedWebhook && (
          <div className="border-t border-slate-800 p-6 bg-slate-950/60">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-slate-300 font-mono-tabular">
                Raw Event Payload · {selectedWebhook.provider} ·{' '}
                {selectedWebhook.providerEventId}
              </span>
              <button
                type="button"
                onClick={() => {
                  setProvider(selectedWebhook.provider);
                  setProviderEventId(selectedWebhook.providerEventId);
                }}
                className="flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 transition-colors whitespace-nowrap"
              >
                <Copy className="h-3.5 w-3.5" />
                Load Event ID into Simulator to Test Duplicate Replay
              </button>
            </div>
            <pre className="overflow-x-auto text-[11px] text-slate-300 font-mono-tabular">
              {JSON.stringify(selectedWebhook.payload, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
};
