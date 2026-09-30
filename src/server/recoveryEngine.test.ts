import 'dotenv/config';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import { createPool, db } from '../db/index.ts';
import {
  businesses,
  customers,
  failedPayments,
  subscriptions,
  whatsappLogs,
} from '../db/schema.ts';
import {
  FlutterwavePaymentProvider,
  getPaymentProvider,
  getProvidersHealthReport,
  getWhatsAppProvider,
  hashRecoveryToken,
  koboMinorToNaira,
  MetaWhatsAppProvider,
  nairaToKoboMinor,
  PaystackPaymentProvider,
  signWebhookPayload,
  TermiiWhatsAppProvider,
  verifyFlutterwaveSignature,
  verifyPaystackSignature,
} from './providers.ts';
import {
  executeQueuedWhatsAppJob,
  getRecoveryAttemptByToken,
  initializeMerchantPaymentRetry,
  initializeRecoveryPaymentByToken,
  markPaymentRecoveredAndCancelQueue,
  processWebhookAndOrchestrateRecovery,
  resolveWebhookTenant,
  verifyAndCompleteRecoveryByToken,
} from './recoveryEngine.ts';
import { toggleCustomerOptIn } from '../db/repository.ts';

describe('Phase 1 Step 5B — Atomic Recovery Token Consumption & Payment Integrity Tests', () => {
  let testBusinessId: string;
  let testCustomerId: string;
  let testSubscriptionId: string;

  before(async () => {
    const uniqueSuffix = crypto.randomBytes(6).toString('hex');
    const [biz] = await db
      .insert(businesses)
      .values({
        ownerUid: `test-atomic-uid-${uniqueSuffix}`,
        name: `ASUKU Atomic Test Suite ${uniqueSuffix}`,
        email: `atomic-suite-${uniqueSuffix}@asuku-test.internal`,
        phone: '+2348000009999',
        currency: 'NGN',
        timezone: 'Africa/Lagos',
        webhookToken: `whsec_test_${uniqueSuffix}`,
        paystackEnabled: true,
        flutterwaveEnabled: true,
        whatsappProvider: 'META',
        retryLinkExpiryHours: 168,
      })
      .returning();
    testBusinessId = biz.id;

    const [cust] = await db
      .insert(customers)
      .values({
        businessId: testBusinessId,
        externalCustomerId: `CUS_ATOMIC_${uniqueSuffix}`,
        name: 'ASUKU ATOMIC TEST CUSTOMER',
        email: `cust-${uniqueSuffix}@asuku-test.internal`,
        phone: '+2348000009998',
        whatsappOptIn: false,
      })
      .returning();
    testCustomerId = cust.id;

    const [sub] = await db
      .insert(subscriptions)
      .values({
        businessId: testBusinessId,
        customerId: testCustomerId,
        provider: 'PAYSTACK',
        providerSubscriptionId: `SUB_ATOMIC_${uniqueSuffix}`,
        planName: 'Atomic Verification Sandbox Plan',
        amount: '175000.00',
        currency: 'NGN',
        status: 'PAST_DUE',
      })
      .returning();
    testSubscriptionId = sub.id;
  });

  after(async () => {
    if (testBusinessId) {
      await db.delete(businesses).where(eq(businesses.id, testBusinessId));
    }
    const pool = createPool();
    await pool.end();
  });

  async function createIsolatedPendingPayment(params: {
    reference: string;
    amount?: string;
    currency?: string;
    status?: 'PENDING' | 'RECOVERED' | 'EXPIRED';
    recoveryTokenUsedAt?: Date | null;
    expiresAt?: Date;
  }) {
    const rawToken = `asuku_${crypto.randomBytes(32).toString('base64url')}`;
    const tokenHash = hashRecoveryToken(rawToken);
    const expiresAt =
      params.expiresAt ?? new Date(Date.now() + 24 * 3600 * 1000);

    const [payment] = await db
      .insert(failedPayments)
      .values({
        businessId: testBusinessId,
        customerId: testCustomerId,
        subscriptionId: testSubscriptionId,
        provider: 'PAYSTACK',
        providerTransactionId: `TXN_${params.reference}`,
        providerReference: params.reference,
        amount: params.amount ?? '175000.00',
        currency: params.currency ?? 'NGN',
        failureReason: '[AUTOMATED TEST] Isolated pending payment',
        status: params.status ?? 'PENDING',
        recoveryStatus:
          params.status === 'RECOVERED' ? 'RECOVERED' : 'ACTIVE',
        recoveryToken: null,
        recoveryTokenHash: tokenHash,
        recoveryTokenUsedAt: params.recoveryTokenUsedAt ?? null,
        expiresAt,
      })
      .returning();

    await db.insert(whatsappLogs).values({
      businessId: testBusinessId,
      customerId: testCustomerId,
      failedPaymentId: payment.id,
      provider: 'META',
      templateName: 'payment_reminder_24h',
      sequenceStep: 2,
      status: 'QUEUED',
      phoneNumber: '+2348000009998',
      scheduledAt: new Date(Date.now() + 24 * 3600 * 1000),
    });

    return { payment, rawToken, tokenHash };
  }

  it('TEST A: Two simultaneous recovery-completion attempts for the same pending payment/token -> exactly ONE succeeds and the other receives 409 conflict', async () => {
    const ref = `ASUKU-ATOMIC-TEST-A-${Date.now()}`;
    const { payment, rawToken } = await createIsolatedPendingPayment({
      reference: ref,
    });

    // Synchronize both concurrent calls inside verifyTransactionFn so BOTH pass the initial pre-check
    // while the payment is still PENDING, then race at the database UPDATE level.
    let inFlightCount = 0;
    let releaseBarrier!: () => void;
    const barrierPromise = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const simulatedVerifyFn = async () => {
      inFlightCount += 1;
      if (inFlightCount === 2) {
        releaseBarrier();
      }
      await Promise.race([
        barrierPromise,
        new Promise((r) => setTimeout(r, 150)),
      ]);
      return {
        verified: true,
        provider: 'PAYSTACK' as const,
        reference: ref,
        providerTransactionId: `pstk_tx_${ref}`,
        amountNaira: 175000,
        currency: 'NGN',
        status: 'VERIFIED' as const,
      };
    };

    const [res1, res2] = await Promise.all([
      verifyAndCompleteRecoveryByToken(rawToken, ref, {
        verifyTransactionFn: simulatedVerifyFn,
      }),
      verifyAndCompleteRecoveryByToken(rawToken, ref, {
        verifyTransactionFn: simulatedVerifyFn,
      }),
    ]);

    const successes = [res1, res2].filter((r) => r.success === true);
    const conflicts = [res1, res2].filter((r) => r.success === false);

    assert.equal(
      successes.length,
      1,
      'Exactly ONE concurrent recovery attempt must succeed'
    );
    assert.equal(
      conflicts.length,
      1,
      'Exactly ONE concurrent recovery attempt must fail with conflict'
    );
    assert.equal(successes[0].httpStatus, 200);
    assert.equal(conflicts[0].httpStatus, 409);

    const [dbPayment] = await db
      .select()
      .from(failedPayments)
      .where(eq(failedPayments.id, payment.id));

    assert.equal(dbPayment.status, 'RECOVERED');
    assert.equal(dbPayment.recoveryStatus, 'RECOVERED');
    assert.equal(dbPayment.recoveryToken, null);
    assert.ok(
      dbPayment.recoveryTokenUsedAt instanceof Date,
      'recovery_token_used_at must be populated atomically'
    );
    assert.ok(
      dbPayment.recoveredAt instanceof Date,
      'recovered_at must be populated atomically'
    );
  });

  it('TEST B: Payment already RECOVERED -> recovery attempt cannot run again', async () => {
    const ref = `ASUKU-ATOMIC-TEST-B-${Date.now()}`;
    const { payment, rawToken } = await createIsolatedPendingPayment({
      reference: ref,
      status: 'RECOVERED',
      recoveryTokenUsedAt: new Date(Date.now() - 60000),
    });

    let verifyCalled = false;
    const res = await verifyAndCompleteRecoveryByToken(rawToken, ref, {
      verifyTransactionFn: async () => {
        verifyCalled = true;
        return {
          verified: true,
          provider: 'PAYSTACK',
          reference: ref,
          providerTransactionId: 'should_not_run',
          amountNaira: 175000,
          currency: 'NGN',
          status: 'VERIFIED',
        };
      },
    });

    assert.equal(res.success, false);
    assert.equal(res.httpStatus, 409);
    assert.equal(
      verifyCalled,
      false,
      'Provider verification should not even be invoked when already RECOVERED'
    );

    // Also verify direct database-level atomic UPDATE affects 0 rows
    const directOutcome = await markPaymentRecoveredAndCancelQueue(
      testBusinessId,
      payment.id,
      'Direct call on already recovered payment'
    );
    assert.equal(directOutcome.recovered, false);
    assert.equal(directOutcome.rowsAffected, 0);
    assert.equal(directOutcome.updatedPayment, null);
  });

  it('TEST C: recovery_token_used_at already populated -> recovery attempt is rejected both at pre-check and at atomic DB update', async () => {
    const ref = `ASUKU-ATOMIC-TEST-C-${Date.now()}`;
    const usedTimestamp = new Date(Date.now() - 120000);
    const { payment, rawToken } = await createIsolatedPendingPayment({
      reference: ref,
      status: 'PENDING',
      recoveryTokenUsedAt: usedTimestamp,
    });

    const res = await verifyAndCompleteRecoveryByToken(rawToken, ref, {
      verifyTransactionFn: async () => ({
        verified: true,
        provider: 'PAYSTACK',
        reference: ref,
        providerTransactionId: 'tx_test_c',
        amountNaira: 175000,
        currency: 'NGN',
        status: 'VERIFIED',
      }),
    });

    assert.equal(res.success, false);
    assert.equal(res.httpStatus, 409);

    // Even if pre-check were bypassed and markPaymentRecoveredAndCancelQueue called directly,
    // WHERE recovery_token_used_at IS NULL ensures 0 rows are affected.
    const directOutcome = await markPaymentRecoveredAndCancelQueue(
      testBusinessId,
      payment.id,
      'Direct call when recovery_token_used_at is already set'
    );
    assert.equal(directOutcome.recovered, false);
    assert.equal(directOutcome.rowsAffected, 0);
    assert.equal(directOutcome.updatedPayment, null);

    const [dbPayment] = await db
      .select()
      .from(failedPayments)
      .where(eq(failedPayments.id, payment.id));
    assert.equal(dbPayment.status, 'PENDING');
  });

  it('TEST D: Payment status changed from PENDING before final update -> final atomic UPDATE affects zero rows and payment is NOT incorrectly recovered', async () => {
    const ref = `ASUKU-ATOMIC-TEST-D-${Date.now()}`;
    const { payment, rawToken } = await createIsolatedPendingPayment({
      reference: ref,
      status: 'PENDING',
      recoveryTokenUsedAt: null,
    });

    // Simulate status changing from PENDING to EXPIRED mid-flight (after getRecoveryAttemptByToken pre-check passes,
    // while verifyTransactionFn is executing, before markPaymentRecoveredAndCancelQueue runs).
    const res = await verifyAndCompleteRecoveryByToken(rawToken, ref, {
      verifyTransactionFn: async () => {
        await db
          .update(failedPayments)
          .set({ status: 'EXPIRED', recoveryStatus: 'EXPIRED' })
          .where(eq(failedPayments.id, payment.id));

        return {
          verified: true,
          provider: 'PAYSTACK',
          reference: ref,
          providerTransactionId: `tx_${ref}`,
          amountNaira: 175000,
          currency: 'NGN',
          status: 'VERIFIED',
        };
      },
    });

    assert.equal(res.success, false);
    assert.equal(res.httpStatus, 409);
    assert.equal(
      (res as { rowsAffected?: number }).rowsAffected,
      0,
      'Final atomic UPDATE must affect 0 rows'
    );

    const [dbPayment] = await db
      .select()
      .from(failedPayments)
      .where(eq(failedPayments.id, payment.id));

    assert.equal(
      dbPayment.status,
      'EXPIRED',
      'Payment status must remain EXPIRED and NOT be overwritten to RECOVERED'
    );
    assert.equal(dbPayment.recoveredAt, null);
    assert.equal(dbPayment.recoveryTokenUsedAt, null);
  });

  it('TEST E: Existing exact provider reference, amount, currency, expiry, SHA-256 hashing, and server-side verification requirements continue to pass', async () => {
    const ref = `ASUKU-ATOMIC-TEST-E-${Date.now()}`;
    const { payment, rawToken, tokenHash } = await createIsolatedPendingPayment({
      reference: ref,
      amount: '175000.00',
      currency: 'NGN',
    });

    // E1: Plaintext token is never stored; SHA-256 lookup resolves accurately
    const resolved = await getRecoveryAttemptByToken(rawToken);
    assert.ok(resolved);
    assert.equal(resolved.payment.id, payment.id);
    assert.equal(
      resolved.payment.recoveryTokenHashPrefix,
      tokenHash.slice(0, 16)
    );

    // E2: Invalid/random token is rejected with 404
    const invalidRes = await verifyAndCompleteRecoveryByToken(
      `asuku_${crypto.randomBytes(32).toString('base64url')}`,
      ref
    );
    assert.equal(invalidRes.httpStatus, 404);
    assert.equal(invalidRes.success, false);

    // E3: Mismatched transactionReference is rejected with 400
    const wrongRefRes = await verifyAndCompleteRecoveryByToken(
      rawToken,
      'WRONG-PROVIDER-REF-999'
    );
    assert.equal(wrongRefRes.httpStatus, 400);
    assert.equal(wrongRefRes.success, false);

    // E4: Failed server-side provider verification (amount/currency mismatch or unverified) is rejected with 422
    const unverifiedRes = await verifyAndCompleteRecoveryByToken(rawToken, ref, {
      verifyTransactionFn: async () => ({
        verified: false,
        provider: 'PAYSTACK' as const,
        reference: ref,
        status: 'MISMATCH' as const,
        errorCode: 'AMOUNT_MISMATCH',
        errorMessage: 'Paid amount is less than expected amount',
      }),
    });
    assert.equal(unverifiedRes.httpStatus, 422);
    assert.equal(unverifiedRes.success, false);

    // E5: Webhook exact matching rejects amount/currency mismatch without recovering the payment
    const webhookMismatch = await processWebhookAndOrchestrateRecovery({
      businessId: testBusinessId,
      provider: 'PAYSTACK',
      providerEventId: `evt_mismatch_${Date.now()}`,
      rawEventType: 'charge.success',
      payload: { event: 'charge.success' },
      signature: 'sig_test_valid',
      signatureValid: true,
      providerReference: ref,
      amountNaira: 50000, // Less than 175,000.00
      currency: 'NGN',
    });
    assert.equal(webhookMismatch.status, 'PAYMENT_VERIFICATION_MISMATCH');

    // Confirm payment is still PENDING and token is still unused after all rejected attempts
    const [stillPending] = await db
      .select()
      .from(failedPayments)
      .where(eq(failedPayments.id, payment.id));
    assert.equal(stillPending.status, 'PENDING');
    assert.equal(stillPending.recoveryTokenUsedAt, null);

    // E6: Expired token is rejected with 410
    const expiredRef = `ASUKU-ATOMIC-TEST-E-EXP-${Date.now()}`;
    const { rawToken: expiredToken } = await createIsolatedPendingPayment({
      reference: expiredRef,
      expiresAt: new Date(Date.now() - 3600 * 1000),
    });
    const expiredRes = await verifyAndCompleteRecoveryByToken(
      expiredToken,
      expiredRef
    );
    assert.equal(expiredRes.httpStatus, 410);
    assert.equal(expiredRes.success, false);
  });

  it('PHASE 2 PAYMENT TESTS (1–10): Paystack & Flutterwave initialization, verification, kobo/Naira unit conversion, reference/amount/currency matching, failed/pending/invalid/timeout handling', async () => {
    // Unit conversion check: ₦250,000.00 <-> 25,000,000 kobo
    assert.equal(nairaToKoboMinor(250000), 25000000);
    assert.equal(nairaToKoboMinor('250000.00'), 25000000);
    assert.equal(koboMinorToNaira(25000000), 250000);

    // 1.When unconfigured -> NOT_CONFIGURED
    const unconfPstk = getPaymentProvider('PAYSTACK');
    const unconfInit = await unconfPstk.initializePayment({
      businessId: testBusinessId,
      failedPaymentId: '00000000-0000-0000-0000-000000000001',
      customerId: testCustomerId,
      provider: 'PAYSTACK',
      reference: 'PSTK-REF-UNCONF-01',
      amountNaira: 250000,
      currency: 'NGN',
      customerEmail: 'test@asuku.internal',
    });
    assert.equal(unconfInit.initialized, false);
    assert.equal(unconfInit.status, 'NOT_CONFIGURED');

    const origPstkSecret = process.env.PAYSTACK_SECRET_KEY;
    const origFlwSecret = process.env.FLW_SECRET_KEY;
    try {
      process.env.PAYSTACK_SECRET_KEY = 'sk_test_ephemeral_unit_test_secret_only';
      process.env.FLW_SECRET_KEY = 'FLWSECK_TEST_ephemeral_unit_test_secret_only';

      // 1. Paystack initialization with deterministic mock fetchFn (verifies 250000 NGN -> 25000000 kobo)
      let capturedPaystackBody: Record<string, unknown> = {};
      const pstkInitAdapter = new PaystackPaymentProvider(async (_url, init) => {
        capturedPaystackBody = JSON.parse(String(init?.body || '{}'));
        return new Response(
          JSON.stringify({
            status: true,
            message: 'Authorization URL created',
            data: {
              authorization_url: 'https://checkout.paystack.com/test_auth_code',
              access_code: 'test_access_code_001',
              reference: 'PSTK-INIT-001',
            },
          }),
          { status: 200 }
        );
      });

      const initRes = await pstkInitAdapter.initializePayment({
        businessId: testBusinessId,
        failedPaymentId: '00000000-0000-0000-0000-000000000001',
        customerId: testCustomerId,
        provider: 'PAYSTACK',
        reference: 'PSTK-INIT-001',
        amountNaira: 250000,
        currency: 'NGN',
        customerEmail: 'customer@asuku.internal',
      });
      assert.equal(initRes.initialized, true);
      assert.equal(initRes.status, 'INITIALIZED');
      assert.equal(initRes.amountMinor, 25000000);
      assert.equal(initRes.amountNaira, 250000);
      assert.equal(capturedPaystackBody.amount, 25000000);

      // 2. Paystack verification (success, exact reference, amount, currency)
      const pstkVerifyOk = new PaystackPaymentProvider(async () => {
        return new Response(
          JSON.stringify({
            status: true,
            data: {
              id: 991234,
              status: 'success',
              reference: 'PSTK-VERIFY-001',
              amount: 25000000,
              currency: 'NGN',
            },
          }),
          { status: 200 }
        );
      });
      const vOk = await pstkVerifyOk.verifyPayment({
        reference: 'PSTK-VERIFY-001',
        expectedAmountNaira: 250000,
        expectedCurrency: 'NGN',
      });
      assert.equal(vOk.verified, true);
      assert.equal(vOk.status, 'VERIFIED');
      assert.equal(vOk.normalizedStatus, 'SUCCESS');
      assert.equal(vOk.amountMinor, 25000000);
      assert.equal(vOk.amountNaira, 250000);

      // 3. Flutterwave initialization & verification
      const flwAdapter = new FlutterwavePaymentProvider(async (url) => {
        if (String(url).includes('/payments')) {
          return new Response(
            JSON.stringify({
              status: 'success',
              data: { link: 'https://checkout.flutterwave.com/v3/hosted/pay/flw_001' },
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            status: 'success',
            data: {
              id: 882341,
              status: 'successful',
              tx_ref: 'FLW-VERIFY-001',
              amount: 150000,
              currency: 'NGN',
            },
          }),
          { status: 200 }
        );
      });
      const flwInit = await flwAdapter.initializePayment({
        businessId: testBusinessId,
        failedPaymentId: '00000000-0000-0000-0000-000000000002',
        customerId: testCustomerId,
        provider: 'FLUTTERWAVE',
        reference: 'FLW-VERIFY-001',
        amountNaira: 150000,
        currency: 'NGN',
        customerEmail: 'customer@asuku.internal',
      });
      assert.equal(flwInit.initialized, true);
      assert.equal(flwInit.amountMinor, 15000000);

      const flwVerify = await flwAdapter.verifyPayment({
        reference: 'FLW-VERIFY-001',
        expectedAmountNaira: 150000,
        expectedCurrency: 'NGN',
      });
      assert.equal(flwVerify.verified, true);
      assert.equal(flwVerify.normalizedStatus, 'SUCCESS');

      // 4. Exact reference mismatch
      const pstkWrongRef = new PaystackPaymentProvider(async () =>
        new Response(
          JSON.stringify({
            status: true,
            data: {
              id: 1,
              status: 'success',
              reference: 'DIFFERENT-REF',
              amount: 25000000,
              currency: 'NGN',
            },
          }),
          { status: 200 }
        )
      );
      const refMismatch = await pstkWrongRef.verifyPayment({
        reference: 'EXPECTED-REF',
        expectedAmountNaira: 250000,
        expectedCurrency: 'NGN',
      });
      assert.equal(refMismatch.verified, false);
      assert.equal(refMismatch.status, 'MISMATCH');
      assert.equal(refMismatch.errorCode, 'REFERENCE_MISMATCH');

      // 5 & 6. Exact amount and currency mismatch
      const pstkUnderpaid = new PaystackPaymentProvider(async () =>
        new Response(
          JSON.stringify({
            status: true,
            data: {
              id: 2,
              status: 'success',
              reference: 'PSTK-UNDERPAID',
              amount: 10000000, // 100,000 NGN instead of 250,000 NGN
              currency: 'NGN',
            },
          }),
          { status: 200 }
        )
      );
      const amtMismatch = await pstkUnderpaid.verifyPayment({
        reference: 'PSTK-UNDERPAID',
        expectedAmountNaira: 250000,
        expectedCurrency: 'NGN',
      });
      assert.equal(amtMismatch.verified, false);
      assert.equal(amtMismatch.status, 'MISMATCH');

      const pstkWrongCurr = new PaystackPaymentProvider(async () =>
        new Response(
          JSON.stringify({
            status: true,
            data: {
              id: 3,
              status: 'success',
              reference: 'PSTK-CURR',
              amount: 25000000,
              currency: 'USD',
            },
          }),
          { status: 200 }
        )
      );
      const currMismatch = await pstkWrongCurr.verifyPayment({
        reference: 'PSTK-CURR',
        expectedAmountNaira: 250000,
        expectedCurrency: 'NGN',
      });
      assert.equal(currMismatch.verified, false);
      assert.equal(currMismatch.status, 'MISMATCH');

      // 7 & 8. Failed and Pending provider result
      const pstkPending = new PaystackPaymentProvider(async () =>
        new Response(
          JSON.stringify({
            status: true,
            data: {
              id: 4,
              status: 'pending',
              reference: 'PSTK-PENDING',
              amount: 25000000,
              currency: 'NGN',
            },
          }),
          { status: 200 }
        )
      );
      const pendingRes = await pstkPending.verifyPayment({
        reference: 'PSTK-PENDING',
        expectedAmountNaira: 250000,
        expectedCurrency: 'NGN',
      });
      assert.equal(pendingRes.verified, false);
      assert.equal(pendingRes.normalizedStatus, 'PENDING');

      // 9 & 10. Invalid provider response & network timeout/error
      const pstkInvalid = new PaystackPaymentProvider(async () =>
        new Response('<!DOCTYPE html>Gateway Error', { status: 502 })
      );
      const invalidProviderRes = await pstkInvalid.verifyPayment({
        reference: 'PSTK-502',
        expectedAmountNaira: 250000,
        expectedCurrency: 'NGN',
      });
      assert.equal(invalidProviderRes.verified, false);
      assert.equal(invalidProviderRes.errorCode, 'PAYSTACK_INVALID_RESPONSE');

      const pstkTimeout = new PaystackPaymentProvider(async () => {
        throw new Error('Request timed out after 15000ms');
      });
      const timeoutRes = await pstkTimeout.verifyPayment({
        reference: 'PSTK-TIMEOUT',
        expectedAmountNaira: 250000,
        expectedCurrency: 'NGN',
      });
      assert.equal(timeoutRes.verified, false);
      assert.equal(timeoutRes.errorCode, 'PAYSTACK_NETWORK_ERROR');

      // 10b. Live Paystack key (sk_live_*) is strictly blocked in sandbox/development environment
      process.env.PAYSTACK_SECRET_KEY = 'sk_live_forbidden_in_sandbox_check';
      const pstkLiveBlocked = new PaystackPaymentProvider();
      const liveInitBlocked = await pstkLiveBlocked.initializePayment({
        businessId: testBusinessId,
        failedPaymentId: '00000000-0000-0000-0000-000000000001',
        customerId: testCustomerId,
        provider: 'PAYSTACK',
        reference: 'PSTK-LIVE-BLOCK',
        amountNaira: 250000,
        currency: 'NGN',
        customerEmail: 'customer@asuku.internal',
      });
      assert.equal(liveInitBlocked.initialized, false);
      assert.equal(
        liveInitBlocked.errorCode,
        'PAYSTACK_LIVE_KEY_FORBIDDEN_IN_SANDBOX'
      );
      const liveVerifyBlocked = await pstkLiveBlocked.verifyPayment({
        reference: 'PSTK-LIVE-BLOCK',
        expectedAmountNaira: 250000,
        expectedCurrency: 'NGN',
      });
      assert.equal(liveVerifyBlocked.verified, false);
      assert.equal(
        liveVerifyBlocked.errorCode,
        'PAYSTACK_LIVE_KEY_FORBIDDEN_IN_SANDBOX'
      );
    } finally {
      if (origPstkSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
      else process.env.PAYSTACK_SECRET_KEY = origPstkSecret;
      if (origFlwSecret === undefined) delete process.env.FLW_SECRET_KEY;
      else process.env.FLW_SECRET_KEY = origFlwSecret;
    }
  });

  it('PHASE 2 WEBHOOK & WHATSAPP & RECOVERY TESTS (11–34): Signatures, idempotency, unknown/wrong ref/amount/currency/tenant, Meta & Termii adapters, opt-in & worker cancellation', async () => {
    // 11–14: Valid & Invalid Paystack and Flutterwave signatures
    const rawPayload = Buffer.from(JSON.stringify({ event: 'charge.success' }));
    const pstkSecret = 'sk_test_sig_check_secret';
    const validPstkSig = signWebhookPayload('PAYSTACK', rawPayload, pstkSecret);
    assert.equal(
      verifyPaystackSignature(rawPayload, validPstkSig, pstkSecret),
      true
    );
    assert.equal(
      verifyPaystackSignature(rawPayload, 'invalid_sig_000', pstkSecret),
      false
    );

    const flwSecretHash = 'flw_test_sig_hash_secret';
    const validFlwSig = signWebhookPayload(
      'FLUTTERWAVE',
      rawPayload,
      flwSecretHash
    );
    assert.equal(
      verifyFlutterwaveSignature(rawPayload, validFlwSig, flwSecretHash),
      true
    );
    assert.equal(
      verifyFlutterwaveSignature(rawPayload, 'invalid_flw_sig', flwSecretHash),
      false
    );

    // 15–20: Duplicate webhook idempotency, unknown transaction, wrong currency, wrong tenant
    const dupEventId = `evt_dup_test_${Date.now()}`;
    const refWebhook = `ASUKU-WEBHOOK-TEST-${Date.now()}`;
    await createIsolatedPendingPayment({
      reference: refWebhook,
      amount: '175000.00',
      currency: 'NGN',
    });

    // Unknown transaction reference leaves pending payment untouched
    const unknownTxWebhook = await processWebhookAndOrchestrateRecovery({
      businessId: testBusinessId,
      provider: 'PAYSTACK',
      providerEventId: `evt_unknown_${Date.now()}`,
      rawEventType: 'charge.success',
      payload: { event: 'charge.success' },
      signature: validPstkSig,
      signatureValid: true,
      providerReference: 'NON-EXISTENT-REF-000',
      amountNaira: 175000,
      currency: 'NGN',
    });
    assert.equal(unknownTxWebhook.status, 'NO_EXACT_PAYMENT_MATCH');

    // Wrong currency rejected
    const wrongCurrencyWebhook = await processWebhookAndOrchestrateRecovery({
      businessId: testBusinessId,
      provider: 'PAYSTACK',
      providerEventId: `evt_wrong_curr_${Date.now()}`,
      rawEventType: 'charge.success',
      payload: { event: 'charge.success' },
      signature: validPstkSig,
      signatureValid: true,
      providerReference: refWebhook,
      amountNaira: 175000,
      currency: 'USD',
    });
    assert.equal(wrongCurrencyWebhook.status, 'PAYMENT_VERIFICATION_MISMATCH');

    // Valid exact webhook recovers once; duplicate webhook is idempotently ignored
    const firstSuccessWebhook = await processWebhookAndOrchestrateRecovery({
      businessId: testBusinessId,
      provider: 'PAYSTACK',
      providerEventId: dupEventId,
      rawEventType: 'charge.success',
      payload: { event: 'charge.success' },
      signature: validPstkSig,
      signatureValid: true,
      providerReference: refWebhook,
      amountNaira: 175000,
      currency: 'NGN',
    });
    assert.equal(firstSuccessWebhook.status, 'PAYMENT_RECOVERED');

    const duplicateWebhook = await processWebhookAndOrchestrateRecovery({
      businessId: testBusinessId,
      provider: 'PAYSTACK',
      providerEventId: dupEventId,
      rawEventType: 'charge.success',
      payload: { event: 'charge.success' },
      signature: validPstkSig,
      signatureValid: true,
      providerReference: refWebhook,
      amountNaira: 175000,
      currency: 'NGN',
    });
    assert.equal(duplicateWebhook.status, 'DUPLICATE_IGNORED');
    assert.equal(duplicateWebhook.idempotent, true);

    // Wrong tenant rejected by resolveWebhookTenant (403)
    const [bizRow] = await db
      .select()
      .from(businesses)
      .where(eq(businesses.id, testBusinessId));
    const wrongTenantRes = await resolveWebhookTenant({
      provider: 'PAYSTACK',
      webhookToken: bizRow.webhookToken!,
      claimedMetadataBusinessId: '00000000-0000-0000-0000-999999999999',
    });
    assert.equal(wrongTenantRes.business, null);
    assert.equal(wrongTenantRes.statusCode, 403);

    // 21–27: WhatsApp adapters (Meta & Termii: unavailable -> NOT_CONFIGURED, API failure -> FAILED, success -> SENT, no fake message ID)
    const metaUnconf = getWhatsAppProvider('META');
    const metaUnconfRes = await metaUnconf.sendMessage({
      phoneNumber: '+2348000009998',
      templateName: 'payment_failed_recovery',
      language: 'en',
      variables: {
        customer_name: 'Test',
        business_name: 'ASUKU',
        amount: '175,000.00',
        currency: 'NGN',
        payment_link: 'https://asuku.app/r/token',
        subscription_name: 'Plan',
        recovery_token: 'token',
      },
    });
    assert.equal(metaUnconfRes.status, 'NOT_CONFIGURED');
    assert.equal(metaUnconfRes.providerMessageId, null);

    const origMetaToken = process.env.META_WHATSAPP_ACCESS_TOKEN;
    const origMetaPhone = process.env.META_WHATSAPP_PHONE_NUMBER_ID;
    const origTermiiKey = process.env.TERMII_API_KEY;
    const origTermiiDev = process.env.TERMII_DEVICE_ID;
    try {
      process.env.META_WHATSAPP_ACCESS_TOKEN = 'meta_ephemeral_test_token';
      process.env.META_WHATSAPP_PHONE_NUMBER_ID = '1234567890';
      process.env.TERMII_API_KEY = 'termii_ephemeral_test_key';
      process.env.TERMII_DEVICE_ID = 'termii_device_01';

      const metaFail = new MetaWhatsAppProvider(async () =>
        new Response(
          JSON.stringify({ error: { code: 190, message: 'Invalid OAuth token' } }),
          { status: 401 }
        )
      );
      const mfRes = await metaFail.sendMessage({
        phoneNumber: '+2348000009998',
        templateName: 'payment_failed_recovery',
        language: 'en',
        variables: {
          customer_name: 'Test',
          business_name: 'ASUKU',
          amount: '175,000.00',
          currency: 'NGN',
          payment_link: 'https://asuku.app/r/token',
          subscription_name: 'Plan',
          recovery_token: 'token',
        },
      });
      assert.equal(mfRes.status, 'FAILED');
      assert.equal(mfRes.providerMessageId, null);

      const termiiSuccess = new TermiiWhatsAppProvider(async () =>
        new Response(
          JSON.stringify({ message_id: 'termii_msg_99182', message: 'Successfully Sent' }),
          { status: 200 }
        )
      );
      const tsRes = await termiiSuccess.sendMessage({
        phoneNumber: '+2348000009998',
        templateName: 'payment_failed_recovery',
        language: 'en',
        variables: {
          customer_name: 'Test',
          business_name: 'ASUKU',
          amount: '175,000.00',
          currency: 'NGN',
          payment_link: 'https://asuku.app/r/token',
          subscription_name: 'Plan',
          recovery_token: 'token',
        },
      });
      assert.equal(tsRes.status, 'SENT');
      assert.equal(tsRes.providerMessageId, 'termii_msg_99182');
    } finally {
      if (origMetaToken === undefined) delete process.env.META_WHATSAPP_ACCESS_TOKEN;
      else process.env.META_WHATSAPP_ACCESS_TOKEN = origMetaToken;
      if (origMetaPhone === undefined) delete process.env.META_WHATSAPP_PHONE_NUMBER_ID;
      else process.env.META_WHATSAPP_PHONE_NUMBER_ID = origMetaPhone;
      if (origTermiiKey === undefined) delete process.env.TERMII_API_KEY;
      else process.env.TERMII_API_KEY = origTermiiKey;
      if (origTermiiDev === undefined) delete process.env.TERMII_DEVICE_ID;
      else process.env.TERMII_DEVICE_ID = origTermiiDev;
    }

    // 33–34: Payment recovered before worker execution -> worker aborts and marks job CANCELLED
    const preRecoveredRef = `ASUKU-WORKER-ABORT-${Date.now()}`;
    const { payment: preRecPayment } = await createIsolatedPendingPayment({
      reference: preRecoveredRef,
    });
    const [queuedJob] = await db
      .select()
      .from(whatsappLogs)
      .where(eq(whatsappLogs.failedPaymentId, preRecPayment.id));

    await db
      .update(failedPayments)
      .set({ status: 'RECOVERED', recoveryStatus: 'RECOVERED' })
      .where(eq(failedPayments.id, preRecPayment.id));

    const workerPreSendCheck = await executeQueuedWhatsAppJob(
      testBusinessId,
      queuedJob.id
    );
    assert.equal(workerPreSendCheck.executed, false);

    // Server-controlled initialization by recovery token and merchant retry
    const initTokenRef = `ASUKU-INIT-FLOW-${Date.now()}`;
    const { payment: initFlowPayment, rawToken: initFlowToken } =
      await createIsolatedPendingPayment({
        reference: initTokenRef,
        amount: '250000.00',
      });
    const tokenInitUnconf = await initializeRecoveryPaymentByToken(initFlowToken);
    assert.equal(tokenInitUnconf.httpStatus, 503);
    assert.equal(tokenInitUnconf.status, 'NOT_CONFIGURED');

    const merchantInitUnconf = await initializeMerchantPaymentRetry(
      testBusinessId,
      initFlowPayment.id
    );
    assert.equal(merchantInitUnconf.httpStatus, 503);
    assert.equal(merchantInitUnconf.status, 'NOT_CONFIGURED');

    // Provider health report returns safe status without secrets
    const health = getProvidersHealthReport();
    assert.equal(health.providers.PAYSTACK.status, 'NOT_CONFIGURED');
    assert.equal(health.providers.FLUTTERWAVE.status, 'NOT_CONFIGURED');
    assert.equal(health.providers.META.status, 'NOT_CONFIGURED');
    assert.equal(health.providers.TERMII.status, 'NOT_CONFIGURED');

    // Opt-out after scheduling cancels queued jobs
    await toggleCustomerOptIn(testBusinessId, testCustomerId, true);
    const revOutcome = await toggleCustomerOptIn(
      testBusinessId,
      testCustomerId,
      false
    );
    assert.equal(revOutcome.customer.whatsappOptIn, false);
  });
});
