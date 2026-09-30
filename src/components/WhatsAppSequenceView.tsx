import React, { useState } from 'react';
import {
  Send,
  CheckCircle2,
  XCircle,
  Clock,
  Code2,
  AlertTriangle,
  ShieldAlert,
} from 'lucide-react';
import { Customer, WhatsAppLogItem } from '../types.ts';

interface WhatsAppSequenceViewProps {
  logs: WhatsAppLogItem[];
  customers: Customer[];
  authHeaders: Record<string, string>;
  onRefresh: () => Promise<void>;
}

export const WhatsAppSequenceView: React.FC<WhatsAppSequenceViewProps> = ({
  logs,
  customers,
  authHeaders,
  onRefresh,
}) => {
  const [stepFilter, setStepFilter] = useState<'ALL' | 1 | 2 | 3>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [selectedLog, setSelectedLog] = useState<WhatsAppLogItem | null>(
    logs[0] || null
  );
  const [dispatchingId, setDispatchingId] = useState<string | null>(null);
  const [togglingCustId, setTogglingCustId] = useState<string | null>(null);
  const [workerNotice, setWorkerNotice] = useState<string | null>(null);

  const filteredLogs = logs.filter((l) => {
    if (stepFilter !== 'ALL' && l.sequenceStep !== stepFilter) return false;
    if (statusFilter !== 'ALL' && l.status !== statusFilter) return false;
    return true;
  });

  const handleDispatchNow = async (logId: string) => {
    setDispatchingId(logId);
    setWorkerNotice(null);
    try {
      const res = await fetch('/api/recovery/run-job', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({ whatsappLogId: logId }),
      });
      const data = await res.json();
      setWorkerNotice(
        data.message || data.reason || data.error || 'Worker check completed'
      );
      await onRefresh();
    } catch (err: unknown) {
      setWorkerNotice(
        err instanceof Error ? err.message : 'Worker execution failed'
      );
    } finally {
      setDispatchingId(null);
    }
  };

  const handleToggleCustomerOptIn = async (customer: Customer) => {
    setTogglingCustId(customer.id);
    setWorkerNotice(null);
    try {
      const nextOptIn = !customer.whatsappOptIn;
      const res = await fetch(`/api/customers/${customer.id}/opt-in`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({ whatsappOptIn: nextOptIn }),
      });
      const data = await res.json();
      if (res.ok) {
        if (!nextOptIn && data.cancelledQueuedCount > 0) {
          setWorkerNotice(
            `Opt-in revoked for ${customer.name}. Automatically cancelled ${data.cancelledQueuedCount} queued WhatsApp reminder(s).`
          );
        } else {
          setWorkerNotice(
            `Updated WhatsApp opt-in consent for ${customer.name} to ${
              nextOptIn ? 'OPTED IN' : 'OPTED OUT'
            }.`
          );
        }
      }
      await onRefresh();
    } finally {
      setTogglingCustId(null);
    }
  };

  const stepLabel = (step: number) => {
    if (step === 1) return 'Step 1 · T+0 Immediate';
    if (step === 2) return 'Step 2 · T+24h Reminder';
    return 'Step 3 · T+72h Final Notice';
  };

  const renderStatusState = (log: WhatsAppLogItem) => {
    switch (log.status) {
      case 'READ':
      case 'DELIVERED':
      case 'SENT':
        return (
          <span className="inline-flex items-center gap-1.5 text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {log.status}
          </span>
        );
      case 'QUEUED':
        return (
          <span className="inline-flex items-center gap-1.5 text-amber-400">
            <Clock className="h-3.5 w-3.5" />
            QUEUED
          </span>
        );
      case 'NOT_CONFIGURED':
        return (
          <span className="inline-flex items-center gap-1.5 text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" />
            NOT_CONFIGURED
          </span>
        );
      case 'FAILED':
        return (
          <span className="inline-flex items-center gap-1.5 text-red-400">
            <ShieldAlert className="h-3.5 w-3.5" />
            FAILED
          </span>
        );
      case 'CANCELLED':
      default:
        return (
          <span className="inline-flex items-center gap-1.5 text-slate-400">
            <XCircle className="h-3.5 w-3.5" />
            {log.status}
          </span>
        );
    }
  };

  return (
    <div className="space-y-8">
      {/* Sequence Architecture Overview */}
      <div className="border border-slate-800 bg-slate-900 p-6">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">
              02. Automated WhatsApp Recovery Queue (Meta Cloud API & Termii)
            </h2>
            <p className="mt-1 text-xs text-slate-400 max-w-3xl">
              Deterministic BullMQ job scheduling with PostgreSQL constraint{' '}
              <span className="font-mono-tabular text-slate-200">
                UNIQUE(failed_payment_id, sequence_step)
              </span>
              . Never simulates delivery when provider credentials are missing (
              <span className="font-mono-tabular text-amber-300">
                NOT_CONFIGURED
              </span>
              ) or when an API request errors (
              <span className="font-mono-tabular text-red-400">FAILED</span>).
            </p>
          </div>

          {/* Filter Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 bg-slate-950 p-1 border border-slate-800">
              {(['ALL', 1, 2, 3] as const).map((step) => (
                <button
                  key={String(step)}
                  type="button"
                  onClick={() => setStepFilter(step)}
                  className={`px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
                    stepFilter === step
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {step === 'ALL' ? 'All Steps' : `Step ${step}`}
                </button>
              ))}
            </div>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="border border-slate-800 bg-slate-950 px-3 py-1.5 text-xs text-slate-200"
            >
              <option value="ALL">All Statuses</option>
              <option value="QUEUED">QUEUED</option>
              <option value="SENT">SENT</option>
              <option value="DELIVERED">DELIVERED</option>
              <option value="READ">READ</option>
              <option value="NOT_CONFIGURED">NOT_CONFIGURED</option>
              <option value="FAILED">FAILED</option>
              <option value="CANCELLED">CANCELLED</option>
            </select>
          </div>
        </div>

        {workerNotice && (
          <div className="mt-4 border-t border-slate-800 pt-3 text-xs text-emerald-400 flex items-center justify-between">
            <span>Worker Output: {workerNotice}</span>
            <button
              type="button"
              onClick={() => setWorkerNotice(null)}
              className="text-slate-400 hover:text-white"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>

      {/* Sequence Logs + Template Payload Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 border border-slate-800 bg-slate-900 overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-xs text-slate-400">
                <th className="py-3 px-5 font-medium">Customer · Phone</th>
                <th className="py-3 px-4 font-medium">Sequence Step · Template</th>
                <th className="py-3 px-4 font-medium">Provider</th>
                <th className="py-3 px-4 font-medium">Delivery State</th>
                <th className="py-3 px-4 font-medium text-right">Scheduled For</th>
                <th className="py-3 px-5 font-medium text-right">Worker Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 text-xs">
              {filteredLogs.map((log) => (
                <tr
                  key={log.id}
                  onClick={() => setSelectedLog(log)}
                  className="hover:bg-slate-800/40 cursor-pointer transition-colors"
                >
                  <td className="py-3 px-5">
                    <div className="font-medium text-slate-100">
                      {log.customerName}
                    </div>
                    <div className="font-mono-tabular text-slate-400">
                      {log.phoneNumber}
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <div className="text-slate-200">{stepLabel(log.sequenceStep)}</div>
                    <div className="font-mono-tabular text-slate-400">
                      {log.templateName}
                    </div>
                  </td>
                  <td className="py-3 px-4 font-mono-tabular text-slate-300">
                    {log.provider}
                  </td>
                  <td className="py-3 px-4">
                    {renderStatusState(log)}
                    {log.errorMessage && (
                      <div className="text-[11px] text-slate-400 mt-0.5 max-w-xs truncate">
                        {log.errorCode ? `[${log.errorCode}] ` : ''}
                        {log.errorMessage}
                      </div>
                    )}
                  </td>
                  <td className="py-3 px-4 text-right font-mono-tabular text-slate-400">
                    {new Date(log.scheduledAt).toLocaleString('en-NG', {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td
                    className="py-3 px-5 text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {log.status === 'QUEUED' ? (
                      <button
                        type="button"
                        disabled={dispatchingId === log.id}
                        onClick={() => handleDispatchNow(log.id)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors whitespace-nowrap"
                      >
                        <Send className="h-3 w-3" />
                        {dispatchingId === log.id ? 'Checking...' : 'Dispatch Now'}
                      </button>
                    ) : (
                      <span className="font-mono-tabular text-slate-500">
                        {log.providerMessageId
                          ? log.providerMessageId.slice(0, 14) + '...'
                          : 'No Fake ID'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Right: Template API Payload Inspector */}
        <div className="lg:col-span-4 border border-slate-800 bg-slate-900 p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h3 className="text-sm font-semibold text-white">
              WhatsApp Provider Payload Inspector
            </h3>
            <Code2 className="h-4 w-4 text-slate-400" />
          </div>

          {selectedLog ? (
            <div className="space-y-3 text-xs">
              <div className="space-y-1 text-slate-300">
                <p>
                  Customer:{' '}
                  <span className="text-white font-medium">
                    {selectedLog.customerName}
                  </span>
                </p>
                <p className="font-mono-tabular">
                  Adapter: {selectedLog.provider} · Step {selectedLog.sequenceStep} ·{' '}
                  {selectedLog.status}
                </p>
                {selectedLog.providerMessageId ? (
                  <p className="font-mono-tabular text-emerald-400 break-all">
                    Provider Message ID: {selectedLog.providerMessageId}
                  </p>
                ) : (
                  <p className="font-mono-tabular text-amber-300">
                    Provider Message ID: None (Never faked on {selectedLog.status})
                  </p>
                )}
                {selectedLog.errorMessage && (
                  <p className="text-red-300 leading-relaxed">
                    Diagnostic: {selectedLog.errorCode ? `[${selectedLog.errorCode}] ` : ''}
                    {selectedLog.errorMessage}
                  </p>
                )}
              </div>

              <pre className="overflow-x-auto border border-slate-800 bg-slate-950 p-3.5 text-[11px] leading-relaxed text-slate-300 font-mono-tabular max-h-96">
                {JSON.stringify(selectedLog.messagePayload, null, 2)}
              </pre>
            </div>
          ) : (
            <p className="text-xs text-slate-400">
              Select any WhatsApp log entry on the left to inspect its Meta Graph API or
              Termii template payload.
            </p>
          )}
        </div>
      </div>

      {/* Customer WhatsApp Opt-In Governance Table */}
      <div className="border border-slate-800 bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div>
            <h3 className="text-sm font-semibold text-white">
              Customer WhatsApp Opt-In Governance (customers.whatsapp_opt_in)
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Revoking opt-in immediately cancels all{' '}
              <span className="font-mono-tabular text-slate-200">QUEUED</span> WhatsApp
              reminders for that customer and blocks future sequence dispatches.
            </p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-xs text-slate-400">
                <th className="py-3 px-6 font-medium">Customer</th>
                <th className="py-3 px-4 font-medium">Email</th>
                <th className="py-3 px-4 font-medium">E.164 Phone Number</th>
                <th className="py-3 px-4 font-medium">WhatsApp Opt-In Status</th>
                <th className="py-3 px-4 font-medium text-right">Consent Updated</th>
                <th className="py-3 px-6 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70 text-xs">
              {customers.map((c) => (
                <tr key={c.id} className="hover:bg-slate-800/40 transition-colors">
                  <td className="py-3 px-6 font-medium text-slate-100">{c.name}</td>
                  <td className="py-3 px-4 text-slate-300">{c.email}</td>
                  <td className="py-3 px-4 font-mono-tabular text-slate-300">
                    {c.phone}
                  </td>
                  <td className="py-3 px-4">
                    {c.whatsappOptIn ? (
                      <span className="text-emerald-400">Opted In · Active</span>
                    ) : (
                      <span className="text-amber-400">Opted Out · Blocked</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-right font-mono-tabular text-slate-400">
                    {c.whatsappOptInUpdatedAt
                      ? new Date(c.whatsappOptInUpdatedAt).toLocaleString('en-NG', {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : '—'}
                  </td>
                  <td className="py-3 px-6 text-right">
                    <button
                      type="button"
                      disabled={togglingCustId === c.id}
                      onClick={() => handleToggleCustomerOptIn(c)}
                      className="px-3 py-1.5 text-xs font-medium border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 transition-colors whitespace-nowrap"
                    >
                      {c.whatsappOptIn ? 'Revoke Opt-In' : 'Enable Opt-In'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
