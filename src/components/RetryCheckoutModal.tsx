import React, { useState } from 'react';
import {
  ShieldCheck,
  Lock,
  CheckCircle2,
  X,
  ExternalLink,
  AlertTriangle,
  KeyRound,
} from 'lucide-react';
import { FailedPaymentItem } from '../types.ts';

interface RetryCheckoutModalProps {
  payment: FailedPaymentItem | null;
  issuedRawToken: string | null;
  businessName: string;
  onClose: () => void;
  onRecovered: () => void;
}

export const RetryCheckoutModal: React.FC<RetryCheckoutModalProps> = ({
  payment,
  issuedRawToken,
  businessName,
  onClose,
  onRecovered,
}) => {
  const [transactionReference, setTransactionReference] = useState<string>('');
  const [initializingCheckout, setInitializingCheckout] = useState(false);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [checkoutAmountMinor, setCheckoutAmountMinor] = useState<number | null>(
    null
  );
  const [submitting, setSubmitting] = useState(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!payment) return null;

  const effectiveRef = transactionReference || payment.providerReference || '';

  const formattedAmount = payment.amountNumber.toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const queuedCount = payment.sequenceLogs.filter(
    (l) => l.status === 'QUEUED'
  ).length;

  const handleInitializeCheckout = async () => {
    if (!issuedRawToken) {
      setErrorMessage('One-time raw recovery token is required.');
      return;
    }
    setInitializingCheckout(true);
    setErrorMessage(null);
    try {
      const res = await fetch(
        `/api/recovery-link/${issuedRawToken}/initialize`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }
      );
      const data = await res.json();
      if (!res.ok || !data.initialized) {
        throw new Error(
          data.errorMessage ||
            data.error ||
            `${payment.provider} checkout initialization failed (${data.status || res.status}).`
        );
      }
      setCheckoutUrl(data.authorizationUrl || null);
      setCheckoutAmountMinor(
        typeof data.amountMinor === 'number' ? data.amountMinor : null
      );
      if (data.reference) {
        setTransactionReference(data.reference);
      }
    } catch (err: unknown) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Checkout initialization failed'
      );
    } finally {
      setInitializingCheckout(false);
    }
  };

  const handleCompletePayment = async () => {
    if (!issuedRawToken) {
      setErrorMessage('One-time raw recovery token is required.');
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/recovery-link/${issuedRawToken}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transactionReference: effectiveRef,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(
          data.error ||
            'Backend payment verification rejected completion. Unverified client requests cannot mark payments recovered.'
        );
      }
      setResultMessage(data.message);
      onRecovered();
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Verification failed');
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
            <p className="text-xs text-slate-400 font-mono-tabular">
              SHA-256 Token Hash:{' '}
              {payment.recoveryTokenHash
                ? `${payment.recoveryTokenHash.slice(0, 20)}...`
                : 'Verified'}
            </p>
            <h3 className="mt-0.5 text-base font-semibold text-white">
              {businessName} — Hardened Recovery Checkout
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
          {(payment.providerReference?.startsWith('ASUKU-TEST-FAILED-') ||
            payment.customerName.includes('ASUKU TEST CUSTOMER')) && (
            <div className="border border-amber-800/60 bg-amber-950/30 p-3 text-xs text-amber-300 font-mono-tabular">
              DEVELOPMENT / TEST RECORD ({payment.providerReference}) — Isolated local test record. No card was charged and no live Paystack, Flutterwave, or WhatsApp API was contacted.
            </div>
          )}
          {/* Amount & Plan Summary */}
          <div className="border-b border-slate-800 pb-5">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-slate-400">Exact Amount Required</span>
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
                    Provider API Verification Succeeded & Recovered
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
                This subscription payment was recovered on{' '}
                <span className="font-mono-tabular">
                  {payment.recoveredAt
                    ? new Date(payment.recoveredAt).toLocaleString('en-NG')
                    : 'record'}
                </span>
                . The one-time recovery token has been consumed and all remaining
                WhatsApp reminders were cancelled.
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
              {/* Security Proof: Token Hash + Provider Verification Input */}
              <div className="space-y-4 text-xs">
                <div className="border border-slate-800 bg-slate-950 p-3.5 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-emerald-400 font-medium">
                      <KeyRound className="h-3.5 w-3.5" />
                      <span>One-Time Token Issued (Plaintext Never Stored in DB)</span>
                    </div>
                    <button
                      type="button"
                      disabled={initializingCheckout || !issuedRawToken}
                      onClick={handleInitializeCheckout}
                      className="px-2.5 py-1 text-[11px] font-medium border border-slate-700 bg-slate-900 text-slate-200 hover:border-emerald-500 hover:text-white disabled:opacity-50 transition-colors whitespace-nowrap"
                    >
                      {initializingCheckout
                        ? 'Initializing...'
                        : `Initialize ${payment.provider} Checkout`}
                    </button>
                  </div>
                  <p className="font-mono-tabular text-[11px] text-slate-300 break-all">
                    /r/{issuedRawToken || 'generating...'}
                  </p>
                  {checkoutUrl && (
                    <div className="pt-2 border-t border-slate-800 space-y-1">
                      <p className="text-[11px] text-emerald-400 font-mono-tabular">
                        Initialized {payment.provider} Checkout (
                        {checkoutAmountMinor?.toLocaleString('en-NG')} kobo):
                      </p>
                      <a
                        href={checkoutUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-[11px] text-emerald-300 underline break-all"
                      >
                        <span>{checkoutUrl}</span>
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-slate-400 mb-1.5">
                    Provider Transaction Reference to Verify (Exact Match Required)
                  </label>
                  <input
                    type="text"
                    value={effectiveRef}
                    onChange={(e) => setTransactionReference(e.target.value)}
                    className="w-full border border-slate-800 bg-slate-950 px-3 py-2 text-slate-100 font-mono-tabular"
                  />
                  <p className="mt-1 text-[11px] text-slate-400">
                    The backend calls the {payment.provider} Verification API to
                    confirm transaction status, exact amount (₦{formattedAmount}),
                    currency ({payment.currency}), and reference before marking
                    RECOVERED.
                  </p>
                </div>
              </div>

              {/* Queue Cancellation Notice */}
              <div className="border-t border-slate-800 pt-4 text-xs text-slate-400 space-y-1">
                <div className="flex items-center gap-2 text-slate-300">
                  <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0" />
                  <span>
                    Rule 1 Enforced: Client requests never mark a payment recovered
                    without server-side provider verification or a signed{' '}
                    <span className="font-mono-tabular">charge.success</span> webhook.
                    ({queuedCount} queued WhatsApp reminder(s) awaiting cancellation).
                  </span>
                </div>
                {payment.expiresAt && (
                  <p className="font-mono-tabular text-slate-400">
                    Token expires: {new Date(payment.expiresAt).toLocaleString('en-NG')}
                  </p>
                )}
              </div>

              {errorMessage && (
                <div className="border border-red-900/60 bg-red-950/40 p-3 flex items-start gap-2 text-xs text-red-300">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-red-400" />
                  <span>{errorMessage}</span>
                </div>
              )}

              <div className="flex items-center justify-between pt-2">
                <span className="flex items-center gap-1.5 text-xs text-slate-400">
                  <Lock className="h-3.5 w-3.5" />
                  Server-Side {payment.provider} Verification
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
                    disabled={submitting || !issuedRawToken}
                    onClick={handleCompletePayment}
                    className="flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors whitespace-nowrap"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    {submitting
                      ? 'Verifying with Provider...'
                      : `Verify with ${payment.provider} & Complete`}
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
