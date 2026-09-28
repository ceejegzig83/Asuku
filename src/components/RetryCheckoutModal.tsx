import React, { useState } from 'react';
import { ShieldCheck, Lock, CheckCircle2, X, ExternalLink, AlertTriangle } from 'lucide-react';
import { FailedPaymentItem } from '../types.ts';

interface RetryCheckoutModalProps {
  payment: FailedPaymentItem | null;
  businessName: string;
  onClose: () => void;
  onRecovered: () => void;
}

export const RetryCheckoutModal: React.FC<RetryCheckoutModalProps> = ({
  payment,
  businessName,
  onClose,
  onRecovered,
}) => {
  const [paymentMethod, setPaymentMethod] = useState<'card' | 'transfer'>('card');
  const [submitting, setSubmitting] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!payment) return null;

  const formattedAmount = payment.amountNumber.toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const queuedCount = payment.sequenceLogs.filter((l) => l.status === 'QUEUED').length;

  const handleCompletePayment = async () => {
    if (!payment.recoveryToken) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/recovery-link/${payment.recoveryToken}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Checkout verification failed');
      }
      setResultMessage(data.message);
      onRecovered();
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Payment failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-xs">
      <div className="w-full max-w-lg border border-slate-800 bg-slate-900 text-slate-100">
        {/* Top bar */}
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <div>
            <p className="text-xs text-slate-400">
              Customer Payment Retry Link · /r/{payment.recoveryToken}
            </p>
            <h3 className="mt-0.5 text-base font-semibold text-white">
              {businessName} — Subscription Recovery
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white transition-colors"
            aria-label="Close modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {/* Amount & Plan Summary */}
          <div className="border-b border-slate-800 pb-5">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-slate-400">Amount Due</span>
              <span className="text-xs text-slate-400 font-mono-tabular">
                Gateway: {payment.provider} · Ref: {payment.providerReference}
              </span>
            </div>
            <div className="mt-2 flex items-baseline justify-between">
              <div className="text-2xl font-semibold text-white font-mono-tabular">
                ₦{formattedAmount}
              </div>
              <span className="text-xs text-slate-300">{payment.planName}</span>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Customer: {payment.customerName} · {payment.customerPhone}
            </p>
            {payment.failureReason && (
              <p className="mt-1 text-xs text-amber-400">
                Previous failure reason: {payment.failureReason}
              </p>
            )}
          </div>

          {resultMessage ? (
            <div className="space-y-4 py-2">
              <div className="flex items-start gap-3 text-emerald-400">
                <CheckCircle2 className="h-5 w-5 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-white">
                    Subscription Payment Verified & Recovered
                  </p>
                  <p className="text-xs text-slate-300 leading-relaxed">
                    {resultMessage}
                  </p>
                </div>
              </div>
              <div className="flex justify-end pt-2">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-xs font-medium bg-emerald-600 text-white hover:bg-emerald-500 transition-colors whitespace-nowrap"
                >
                  Return to Dashboard
                </button>
              </div>
            </div>
          ) : payment.status === 'RECOVERED' ? (
            <div className="space-y-4 py-2">
              <p className="text-sm text-emerald-400">
                This subscription payment was already recovered on{' '}
                <span className="font-mono-tabular">
                  {payment.recoveredAt
                    ? new Date(payment.recoveredAt).toLocaleString('en-NG')
                    : 'record'}
                </span>
                . All subsequent WhatsApp follow-ups were stopped.
              </p>
              <div className="flex justify-end">
                <button
                  onClick={onClose}
                  className="px-4 py-2 text-xs font-medium bg-slate-800 text-slate-200 hover:bg-slate-700 transition-colors whitespace-nowrap"
                >
                  Close Window
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Payment Method Selector */}
              <div className="space-y-3">
                <span className="text-xs text-slate-400 block">
                  Select {payment.provider} Recovery Channel
                </span>
                <div className="flex items-center gap-1 bg-slate-950 p-1 border border-slate-800">
                  <button
                    type="button"
                    onClick={() => setPaymentMethod('card')}
                    className={`flex-1 py-2 px-3 text-xs font-medium transition-colors whitespace-nowrap ${
                      paymentMethod === 'card'
                        ? 'bg-slate-800 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    New Nigerian Debit / Corporate Card
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaymentMethod('transfer')}
                    className={`flex-1 py-2 px-3 text-xs font-medium transition-colors whitespace-nowrap ${
                      paymentMethod === 'transfer'
                        ? 'bg-slate-800 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    NIBSS Instant Bank Transfer
                  </button>
                </div>

                {paymentMethod === 'card' ? (
                  <div className="space-y-3 pt-2 text-xs text-slate-300">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-slate-400 mb-1">Card Number</label>
                        <input
                          type="text"
                          readOnly
                          value="5399 •••• •••• 8841"
                          className="w-full border border-slate-800 bg-slate-950 px-3 py-2 text-slate-200 font-mono-tabular"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-slate-400 mb-1">Expiry</label>
                          <input
                            type="text"
                            readOnly
                            value="09 / 28"
                            className="w-full border border-slate-800 bg-slate-950 px-3 py-2 text-slate-200 font-mono-tabular"
                          />
                        </div>
                        <div>
                          <label className="block text-slate-400 mb-1">CVV</label>
                          <input
                            type="text"
                            readOnly
                            value="•••"
                            className="w-full border border-slate-800 bg-slate-950 px-3 py-2 text-slate-200 font-mono-tabular"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="border-t border-slate-800 pt-3 text-xs text-slate-300 space-y-1">
                    <p className="text-slate-400">
                      Dedicated Virtual Account ({payment.provider} Settlement):
                    </p>
                    <p className="font-mono-tabular text-sm text-white">
                      Providus / Titan Trust · 9948102941 · {businessName}
                    </p>
                  </div>
                )}
              </div>

              {/* Queue Cancellation Notice */}
              <div className="border-t border-slate-800 pt-4 text-xs text-slate-400 space-y-1">
                <div className="flex items-center gap-2 text-slate-300">
                  <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0" />
                  <span>
                    Completing this payment triggers a verified{' '}
                    <span className="font-mono-tabular">charge.success</span> event and
                    immediately cancels{' '}
                    <span className="font-mono-tabular text-white">{queuedCount}</span>{' '}
                    remaining scheduled WhatsApp follow-up message(s).
                  </span>
                </div>
                {payment.expiresAt && (
                  <p className="font-mono-tabular text-slate-400">
                    Token expires: {new Date(payment.expiresAt).toLocaleString('en-NG')}
                  </p>
                )}
              </div>

              {errorMessage && (
                <div className="flex items-center gap-2 text-xs text-red-400">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span>{errorMessage}</span>
                </div>
              )}

              <div className="flex items-center justify-between pt-2">
                <span className="flex items-center gap-1.5 text-xs text-slate-400">
                  <Lock className="h-3.5 w-3.5" />
                  Verified by {payment.provider}
                </span>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white transition-colors whitespace-nowrap"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={handleCompletePayment}
                    className="flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors whitespace-nowrap"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    {submitting
                      ? 'Verifying Transaction...'
                      : `Pay ₦${formattedAmount} & Recover`}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
