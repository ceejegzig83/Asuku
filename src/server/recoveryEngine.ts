import crypto from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  businesses,
  customers,
  failedPayments,
  subscriptions,
  webhookEvents,
  whatsappLogs,
} from '../db/schema.ts';
import {
  FetchLike,
  getPaymentProvider,
  getWhatsAppProvider,
  hashRecoveryToken,
  normalizeNigerianPhone,
  normalizeWebhookEventType,
  PaymentProvider,
  PaymentProviderName,
  verifyTransactionWithProvider,
} from './providers.ts';

export interface IncomingWebhookInput {
  businessId: string;
  provider: PaymentProviderName;
  providerEventId: string;
  rawEventType: string;
  payload: Record<string, unknown>;
  signature: string;
  signatureValid: boolean;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  customerWhatsappOptIn?: boolean;
  planName?: string;
  amountNaira?: number;
  currency?: string;
  providerReference?: string;
  providerSubscriptionId?: string;
  failureReason?: string;
}

/**
 * PHASE 1 SECURITY HARDENING — OBJECTIVE 6:
 * Secure Webhook Tenant Identification
 * Never trust an unverified top-level `body.businessId` from an external request.
 * Resolve the tenant strictly via:
 *   1. Cryptographic tenant `webhookToken` in the URL/header, OR
 *   2. Existing `providerSubscriptionId` / `providerReference` owned by the tenant.
 * Reject cross-tenant metadata mismatches with 403.
 */
export async function resolveWebhookTenant(params: {
  provider: PaymentProviderName;
  webhookToken?: string;
  providerSubscriptionId?: string;
  providerReference?: string;
  claimedMetadataBusinessId?: string;
}): Promise<{
  business: typeof businesses.$inferSelect | null;
  error?: string;
  statusCode?: number;
}> {
  try {
    let resolvedBusiness: typeof businesses.$inferSelect | undefined;

    // 1. Resolve via cryptographic tenant webhook token
    if (params.webhookToken) {
      const [byToken] = await db
        .select()
        .from(businesses)
        .where(eq(businesses.webhookToken, params.webhookToken));

      if (!byToken || !byToken.webhookToken) {
        return {
          business: null,
          statusCode: 401,
          error: 'Invalid tenant webhook token.',
        };
      }

      const expectedBuf = Buffer.from(byToken.webhookToken, 'utf8');
      const providedBuf = Buffer.from(params.webhookToken, 'utf8');
      if (
        expectedBuf.length !== providedBuf.length ||
        !crypto.timingSafeEqual(expectedBuf, providedBuf)
      ) {
        return {
          business: null,
          statusCode: 401,
          error: 'Invalid tenant webhook token signature.',
        };
      }
      resolvedBusiness = byToken;
    }

    // 2. If no webhook token, resolve via existing subscription ID
    if (!resolvedBusiness && params.providerSubscriptionId) {
      const [sub] = await db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.provider, params.provider),
            eq(subscriptions.providerSubscriptionId, params.providerSubscriptionId)
          )
        );
      if (sub) {
        const [biz] = await db
          .select()
          .from(businesses)
          .where(eq(businesses.id, sub.businessId));
        resolvedBusiness = biz;
      }
    }

    // 3. Or resolve via existing failed payment reference
    if (!resolvedBusiness && params.providerReference) {
      const [fp] = await db
        .select()
        .from(failedPayments)
        .where(
          and(
            eq(failedPayments.provider, params.provider),
            eq(failedPayments.providerReference, params.providerReference)
          )
        );
      if (fp) {
        const [biz] = await db
          .select()
          .from(businesses)
          .where(eq(businesses.id, fp.businessId));
        resolvedBusiness = biz;
      }
    }

    if (!resolvedBusiness) {
      return {
        business: null,
        statusCode: 400,
        error:
          'Unable to securely identify tenant for webhook. Use your tenant-scoped webhook URL (/api/v1/webhooks/:provider/:webhookToken) or match an existing subscription/reference.',
      };
    }

    // 4. Prevent cross-tenant spoofing if metadata claims a different businessId
    if (
      params.claimedMetadataBusinessId &&
      params.claimedMetadataBusinessId !== resolvedBusiness.id
    ) {
      return {
        business: null,
        statusCode: 403,
        error:
          'Cross-tenant security violation: Webhook payload metadata businessId does not match resolved tenant.',
      };
    }

    return { business: resolvedBusiness };
  } catch (error) {
    console.error('Error in resolveWebhookTenant:', error);
    return {
      business: null,
      statusCode: 500,
      error: 'Internal error resolving webhook tenant.',
    };
  }
}

/**
 * 1.4 & 1.5 Idempotent Webhook Processing + Queue Orchestration
 */
export async function processWebhookAndOrchestrateRecovery(
  input: IncomingWebhookInput
) {
  try {
    // 1. Check idempotency in webhook_events (UNIQUE(provider, provider_event_id))
    const existingEvent = await db
      .select()
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.provider, input.provider),
          eq(webhookEvents.providerEventId, input.providerEventId)
        )
      );

    if (existingEvent.length > 0) {
      return {
        status: 'DUPLICATE_IGNORED',
        idempotent: true,
        webhookEvent: existingEvent[0],
        message: `Webhook (${input.provider}:${input.providerEventId}) already processed. Returning HTTP 200 without duplicate WhatsApp dispatch.`,
      };
    }

    // 2. Persist webhook_event record
    const [savedWebhook] = await db
      .insert(webhookEvents)
      .values({
        businessId: input.businessId,
        provider: input.provider,
        providerEventId: input.providerEventId,
        eventType: input.rawEventType,
        payload: input.payload,
        signature: input.signature,
        signatureValid: input.signatureValid,
        processed: true,
        processedAt: new Date(),
      })
      .returning();

    const normalizedEvent = normalizeWebhookEventType(
      input.provider,
      input.rawEventType
    );

    const [business] = await db
      .select()
      .from(businesses)
      .where(eq(businesses.id, input.businessId));

    if (!business) {
      throw new Error('Business tenant not found');
    }

    // 3. Branch on Normalized Event Type: PAYMENT_FAILED
    if (normalizedEvent === 'PAYMENT_FAILED') {
      const phone = normalizeNigerianPhone(
        input.customerPhone || '+2348034192810'
      );
      const email = input.customerEmail || 'billing@customer-enterprise.ng';
      const name = input.customerName || 'Adaeze Okafor (Sterling FinOps)';
      const planName = input.planName || 'Enterprise Core Subscription';
      const amount = (input.amountNaira || 750000).toFixed(2);
      const currency = (input.currency || 'NGN').toUpperCase();
      const reference =
        input.providerReference ||
        `ref_${input.provider.toLowerCase()}_${crypto.randomBytes(4).toString('hex')}`;

      // Resolve or create customer
      const existingCust = await db
        .select()
        .from(customers)
        .where(
          and(
            eq(customers.businessId, input.businessId),
            eq(customers.phone, phone)
          )
        );

      let customer = existingCust[0];
      if (!customer) {
        // PHASE 1 OBJECTIVE 8: New customers default to whatsappOptIn = false unless explicit opt-in consent is provided
        const explicitOptIn =
          typeof input.customerWhatsappOptIn === 'boolean'
            ? input.customerWhatsappOptIn
            : false;
        const [createdCust] = await db
          .insert(customers)
          .values({
            businessId: input.businessId,
            externalCustomerId: `CUS_${input.provider.toLowerCase()}_${crypto
              .randomBytes(3)
              .toString('hex')}`,
            name,
            email,
            phone,
            whatsappOptIn: explicitOptIn,
            whatsappOptInUpdatedAt: new Date(),
          })
          .returning();
        customer = createdCust;
      } else if (typeof input.customerWhatsappOptIn === 'boolean') {
        const [updatedCust] = await db
          .update(customers)
          .set({
            whatsappOptIn: input.customerWhatsappOptIn,
            whatsappOptInUpdatedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(customers.id, customer.id))
          .returning();
        if (updatedCust) customer = updatedCust;
      }

      // Resolve or create subscription
      const existingSub = await db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.businessId, input.businessId),
            eq(subscriptions.customerId, customer.id)
          )
        );

      let subscription = existingSub[0];
      if (!subscription) {
        const [createdSub] = await db
          .insert(subscriptions)
          .values({
            businessId: input.businessId,
            customerId: customer.id,
            provider: input.provider,
            providerSubscriptionId: `SUB_${input.provider.toLowerCase()}_${crypto
              .randomBytes(4)
              .toString('hex')}`,
            planName,
            amount,
            currency,
            status: 'PAST_DUE',
            currentPeriodStart: new Date(Date.now() - 30 * 86400000),
            currentPeriodEnd: new Date(),
          })
          .returning();
        subscription = createdSub;
      } else {
        const [updatedSub] = await db
          .update(subscriptions)
          .set({ status: 'PAST_DUE', updatedAt: new Date() })
          .where(eq(subscriptions.id, subscription.id))
          .returning();
        subscription = updatedSub;
      }

      // PHASE 1 OBJECTIVE 5: Generate 32-byte base64url recovery token and store ONLY its SHA-256 hash in PostgreSQL
      const rawRecoveryToken = `asuku_${crypto.randomBytes(32).toString('base64url')}`;
      const recoveryTokenHash = hashRecoveryToken(rawRecoveryToken);

      const now = new Date();
      const expiresAt = new Date(
        now.getTime() + (business.retryLinkExpiryHours || 168) * 3600 * 1000
      );

      const [failedPayment] = await db
        .insert(failedPayments)
        .values({
          businessId: input.businessId,
          customerId: customer.id,
          subscriptionId: subscription.id,
          provider: input.provider,
          providerTransactionId: `TXN_${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
          providerReference: reference,
          amount,
          currency,
          failureReason:
            input.failureReason ||
            'Insufficient Funds / Issuer Declined Recurring Charge',
          status: 'PENDING',
          recoveryStatus: customer.whatsappOptIn ? 'ACTIVE' : 'STOPPED',
          recoveryToken: null, // Plaintext token is NEVER stored in the database
          recoveryTokenHash,
          failedAt: now,
          expiresAt,
        })
        .returning();

      const waProviderName = business.whatsappProvider || 'META';
      const formattedAmount = Number(amount).toLocaleString('en-NG', {
        minimumFractionDigits: 2,
      });

      // PHASE 1 OBJECTIVE 8: Strict WhatsApp Opt-In Governance check BEFORE queuing messages
      if (!customer.whatsappOptIn) {
        const [blockedLog] = await db
          .insert(whatsappLogs)
          .values({
            businessId: input.businessId,
            customerId: customer.id,
            failedPaymentId: failedPayment.id,
            provider: waProviderName,
            templateName: business.whatsappTemplateImmediate,
            sequenceStep: 1,
            status: 'CANCELLED',
            phoneNumber: customer.phone,
            scheduledAt: now,
            errorCode: 'OPT_IN_REQUIRED',
            errorMessage:
              'Blocked by WhatsApp Opt-In Governance: Customer has not granted whatsapp_opt_in consent.',
            messagePayload: {
              jobId: `${failedPayment.id}:1`,
              step: 'T+0 Immediate (Blocked)',
              customer: customer.name,
              whatsappOptIn: false,
            },
          })
          .returning();

        return {
          status: 'RECOVERY_BLOCKED_NO_OPT_IN',
          idempotent: false,
          webhookEvent: savedWebhook,
          failedPayment: { ...failedPayment, recoveryToken: null },
          issuedRecoveryToken: rawRecoveryToken,
          queuedJobs: [blockedLog.id],
          message: `Verified ${input.provider} failure (${reference}). Recovery token hashed (SHA-256), but WhatsApp sequence was blocked because customer (${customer.phone}) has whatsapp_opt_in = FALSE.`,
        };
      }

      // Customer is opted in -> Queue 3 deterministic sequence steps
      const t24 = new Date(now.getTime() + 24 * 3600 * 1000);
      const t72 = new Date(now.getTime() + 72 * 3600 * 1000);
      const redactedRetryPath = `/r/[SHA256:${recoveryTokenHash.slice(0, 12)}...]`;

      const [job1, job2, job3] = await db
        .insert(whatsappLogs)
        .values([
          {
            businessId: input.businessId,
            customerId: customer.id,
            failedPaymentId: failedPayment.id,
            provider: waProviderName,
            templateName: business.whatsappTemplateImmediate,
            sequenceStep: 1,
            status: 'QUEUED',
            phoneNumber: customer.phone,
            scheduledAt: now,
            messagePayload: {
              jobId: `${failedPayment.id}:1`,
              step: 'T+0 Immediate',
              template: business.whatsappTemplateImmediate,
              customer: customer.name,
              amount: `${currency} ${formattedAmount}`,
              tokenHashPrefix: recoveryTokenHash.slice(0, 16),
            },
          },
          {
            businessId: input.businessId,
            customerId: customer.id,
            failedPaymentId: failedPayment.id,
            provider: waProviderName,
            templateName: business.whatsappTemplate24h,
            sequenceStep: 2,
            status: 'QUEUED',
            phoneNumber: customer.phone,
            scheduledAt: t24,
            messagePayload: {
              jobId: `${failedPayment.id}:2`,
              step: 'T+24h Follow-Up',
              template: business.whatsappTemplate24h,
              customer: customer.name,
              amount: `${currency} ${formattedAmount}`,
              tokenHashPrefix: recoveryTokenHash.slice(0, 16),
            },
          },
          {
            businessId: input.businessId,
            customerId: customer.id,
            failedPaymentId: failedPayment.id,
            provider: waProviderName,
            templateName: business.whatsappTemplate72h,
            sequenceStep: 3,
            status: 'QUEUED',
            phoneNumber: customer.phone,
            scheduledAt: t72,
            messagePayload: {
              jobId: `${failedPayment.id}:3`,
              step: 'T+72h Final Notice',
              template: business.whatsappTemplate72h,
              customer: customer.name,
              amount: `${currency} ${formattedAmount}`,
              tokenHashPrefix: recoveryTokenHash.slice(0, 16),
            },
          },
        ])
        .returning();

      // PHASE 1 OBJECTIVE 1: Worker executes Step 1 (T+0) and records honest provider status (SENT, FAILED, or NOT_CONFIGURED)
      const waAdapter = getWhatsAppProvider(waProviderName);
      const sendResult = await waAdapter.sendTemplate({
        phoneNumber: customer.phone,
        templateName: business.whatsappTemplateImmediate,
        language: 'en',
        variables: {
          customer_name: customer.name,
          business_name: business.name,
          amount: formattedAmount,
          currency,
          payment_link: `${process.env.APP_URL || 'https://asuku.app'}/r/${rawRecoveryToken}`,
          subscription_name: subscription.planName,
          recovery_token: rawRecoveryToken,
        },
      });

      // Redact raw token from stored payload so plaintext token never enters PostgreSQL
      const sanitizedApiRequest = JSON.parse(
        JSON.stringify(sendResult.requestPayload).replaceAll(
          rawRecoveryToken,
          `[SHA256:${recoveryTokenHash.slice(0, 12)}...]`
        )
      );

      await db
        .update(whatsappLogs)
        .set({
          status: sendResult.status,
          providerMessageId: sendResult.providerMessageId,
          sentAt:
            sendResult.status === 'SENT' || sendResult.status === 'DELIVERED'
              ? new Date()
              : null,
          deliveredAt: sendResult.status === 'DELIVERED' ? new Date() : null,
          errorCode: sendResult.errorCode || null,
          errorMessage: sendResult.errorMessage || null,
          messagePayload: {
            jobId: `${failedPayment.id}:1`,
            step: 'T+0 Immediate',
            template: business.whatsappTemplateImmediate,
            customer: customer.name,
            amount: `${currency} ${formattedAmount}`,
            retryUrl: redactedRetryPath,
            providerStatus: sendResult.status,
            apiRequest: sanitizedApiRequest,
          },
        })
        .where(eq(whatsappLogs.id, job1.id));

      return {
        status: 'RECOVERY_INITIATED',
        idempotent: false,
        webhookEvent: savedWebhook,
        failedPayment: { ...failedPayment, recoveryToken: null },
        issuedRecoveryToken: rawRecoveryToken,
        step1DeliveryStatus: sendResult.status,
        step1ErrorMessage: sendResult.errorMessage || null,
        queuedJobs: [job1.id, job2.id, job3.id],
        message:
          sendResult.status === 'SENT' || sendResult.status === 'DELIVERED'
            ? `Verified ${input.provider} failure (${reference}). Stored SHA-256 token hash, dispatched T+0 WhatsApp (${sendResult.providerMessageId}), and queued T+24h & T+72h jobs.`
            : `Verified ${input.provider} failure (${reference}) and stored SHA-256 token hash. T+0 WhatsApp status: ${sendResult.status} (${sendResult.errorMessage}).`,
      };
    }

    // 4. PHASE 1 OBJECTIVE 4: Exact Payment Matching for PAYMENT_SUCCESS (charge.success)
    if (normalizedEvent === 'PAYMENT_SUCCESS') {
      if (!input.providerReference || !input.providerReference.trim()) {
        return {
          status: 'MISSING_PAYMENT_REFERENCE',
          idempotent: false,
          webhookEvent: savedWebhook,
          message:
            'Webhook recorded, but rejected recovery: Missing transaction reference for exact payment matching.',
        };
      }

      // Query ONLY for an exact match on (businessId, provider, providerReference, status='PENDING')
      // NEVER fall back to pendingList[0]!
      const exactMatches = await db
        .select()
        .from(failedPayments)
        .where(
          and(
            eq(failedPayments.businessId, input.businessId),
            eq(failedPayments.provider, input.provider),
            eq(failedPayments.providerReference, input.providerReference.trim()),
            eq(failedPayments.status, 'PENDING')
          )
        );

      const targetPayment = exactMatches[0];

      if (!targetPayment) {
        return {
          status: 'NO_EXACT_PAYMENT_MATCH',
          idempotent: false,
          webhookEvent: savedWebhook,
          message: `No PENDING failed payment matched exact criteria (provider=${input.provider}, reference=${input.providerReference}). Unrelated pending payments were not modified.`,
        };
      }

      // Verify exact amount and currency integrity (comparing integer minor units / kobo to avoid floating-point drift)
      const expectedAmount = Number(targetPayment.amount || 0);
      const expectedMinor = Math.round(expectedAmount * 100);
      const expectedCurrency = (targetPayment.currency || 'NGN').toUpperCase();
      const webhookAmount =
        input.amountNaira !== undefined ? Number(input.amountNaira) : NaN;
      const webhookMinor = Math.round(webhookAmount * 100);
      const webhookCurrency = (input.currency || 'NGN').toUpperCase();

      if (
        Number.isNaN(webhookAmount) ||
        webhookCurrency !== expectedCurrency ||
        webhookMinor !== expectedMinor
      ) {
        return {
          status: 'PAYMENT_VERIFICATION_MISMATCH',
          idempotent: false,
          webhookEvent: savedWebhook,
          message: `Security Integrity Check Failed: Webhook amount/currency (${webhookCurrency} ${webhookAmount}) does not match exact pending failed payment (${expectedCurrency} ${expectedAmount}) for reference ${targetPayment.providerReference}.`,
        };
      }

      const recovered = await markPaymentRecoveredAndCancelQueue(
        input.businessId,
        targetPayment.id,
        `Verified exact match (${input.provider}:${targetPayment.providerReference}, ${expectedCurrency} ${expectedAmount}) via ${input.rawEventType}`
      );

      if (!recovered.recovered || !recovered.updatedPayment) {
        return {
          status: 'PAYMENT_ALREADY_RECOVERED_OR_INELIGIBLE',
          idempotent: false,
          webhookEvent: savedWebhook,
          message: `Payment (${targetPayment.providerReference}) was already recovered or is no longer eligible (atomic update affected 0 rows).`,
        };
      }

      return {
        status: 'PAYMENT_RECOVERED',
        idempotent: false,
        webhookEvent: savedWebhook,
        failedPayment: recovered.updatedPayment,
        cancelledJobsCount: recovered.cancelledJobsCount,
        message: `Exact payment match verified (${targetPayment.providerReference}). Payment marked RECOVERED, subscription restored, and ${recovered.cancelledJobsCount} queued WhatsApp reminder(s) cancelled.`,
      };
    }

    return {
      status: 'EVENT_RECORDED',
      idempotent: false,
      webhookEvent: savedWebhook,
      message: `Event ${input.rawEventType} verified and recorded.`,
    };
  } catch (error) {
    console.error('Error in processWebhookAndOrchestrateRecovery:', error);
    throw new Error('Failed to process webhook event.', { cause: error });
  }
}

/**
 * 3.6 Immediate cancellation after successful payment + Phase 1 Step 5B Atomic Consumption:
 * Atomically updates `failed_payments` ONLY when:
 *   WHERE id = ?
 *     AND business_id = ?
 *     AND status = 'PENDING'
 *     AND recovery_token_used_at IS NULL
 * Sets recovery state (`status = 'RECOVERED'`, `recovery_status = 'RECOVERED'`, `recovered_at = now`)
 * and token consumption timestamp (`recovery_token_used_at = now`) in the SAME atomic database UPDATE.
 * If 0 rows are affected, returns `recovered: false` without reporting success.
 */
export async function markPaymentRecoveredAndCancelQueue(
  businessId: string,
  failedPaymentId: string,
  reason: string
) {
  try {
    return await db.transaction(async (tx) => {
      const now = new Date();

      const updatedRows = await tx
        .update(failedPayments)
        .set({
          status: 'RECOVERED',
          recoveryStatus: 'RECOVERED',
          recoveredAt: now,
          recoveryTokenUsedAt: now,
        })
        .where(
          and(
            eq(failedPayments.id, failedPaymentId),
            eq(failedPayments.businessId, businessId),
            eq(failedPayments.status, 'PENDING'),
            isNull(failedPayments.recoveryTokenUsedAt)
          )
        )
        .returning();

      const updatedPayment = updatedRows[0];

      if (!updatedPayment) {
        return {
          recovered: false as const,
          rowsAffected: 0,
          updatedPayment: null,
          cancelledJobsCount: 0,
        };
      }

      if (updatedPayment.subscriptionId) {
        await tx
          .update(subscriptions)
          .set({
            status: 'RECOVERED',
            currentPeriodStart: now,
            currentPeriodEnd: new Date(now.getTime() + 30 * 86400000),
            updatedAt: now,
          })
          .where(eq(subscriptions.id, updatedPayment.subscriptionId));
      }

      // Cancel all remaining QUEUED WhatsApp sequence steps for this failedPaymentId
      const cancelledLogs = await tx
        .update(whatsappLogs)
        .set({
          status: 'CANCELLED',
          errorMessage: `Auto-cancelled: ${reason}`,
        })
        .where(
          and(
            eq(whatsappLogs.failedPaymentId, failedPaymentId),
            eq(whatsappLogs.status, 'QUEUED')
          )
        )
        .returning();

      return {
        recovered: true as const,
        rowsAffected: updatedRows.length,
        updatedPayment: { ...updatedPayment, recoveryToken: null },
        cancelledJobsCount: cancelledLogs.length,
      };
    });
  } catch (error) {
    console.error('Error in markPaymentRecoveredAndCancelQueue:', error);
    throw new Error('Failed to mark payment recovered.', { cause: error });
  }
}

/**
 * 3.5 BullMQ Worker Execution Rule + Phase 1 Objective 1 & 8:
 * 1. Verify payment status === 'PENDING'
 * 2. Verify customer.whatsappOptIn === true
 * 3. Dispatch via provider and store real status (SENT / FAILED / NOT_CONFIGURED), never fake DELIVERED.
 */
export async function executeQueuedWhatsAppJob(
  businessId: string,
  whatsappLogId: string
) {
  try {
    const [log] = await db
      .select()
      .from(whatsappLogs)
      .where(
        and(
          eq(whatsappLogs.id, whatsappLogId),
          eq(whatsappLogs.businessId, businessId)
        )
      );

    if (!log) {
      throw new Error('Queued WhatsApp job not found');
    }

    if (log.status !== 'QUEUED') {
      return {
        executed: false,
        reason: `Job is already in ${log.status} state.`,
      };
    }

    if (!log.failedPaymentId) {
      throw new Error('No associated failed payment ID');
    }

    const [payment] = await db
      .select()
      .from(failedPayments)
      .where(eq(failedPayments.id, log.failedPaymentId));

    // Critical Worker Rule 1: Check payment status immediately before sending
    if (!payment || payment.status !== 'PENDING') {
      await db
        .update(whatsappLogs)
        .set({
          status: 'CANCELLED',
          errorCode: 'PAYMENT_NOT_PENDING',
          errorMessage: `Worker pre-send check aborted: Payment status is ${
            payment?.status || 'UNKNOWN'
          }`,
        })
        .where(eq(whatsappLogs.id, log.id));

      return {
        executed: false,
        reason: `Aborted by pre-send safety check: Payment is already ${payment?.status}.`,
      };
    }

    // Critical Worker Rule 2 (Objective 8): Check customer WhatsApp Opt-In governance
    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, log.customerId));

    if (!customer || !customer.whatsappOptIn) {
      await db
        .update(whatsappLogs)
        .set({
          status: 'CANCELLED',
          errorCode: 'OPT_IN_REQUIRED',
          errorMessage:
            'Worker pre-send check aborted: Customer WhatsApp opt-in is FALSE',
        })
        .where(eq(whatsappLogs.id, log.id));

      return {
        executed: false,
        reason:
          'Aborted by Opt-In Governance: Customer has not granted WhatsApp opt-in consent.',
      };
    }

    const [business] = await db
      .select()
      .from(businesses)
      .where(eq(businesses.id, businessId));

    // Rotate/mint a fresh one-time token for the retry URL and store ONLY its SHA-256 hash
    const rawToken = `asuku_${crypto.randomBytes(32).toString('base64url')}`;
    const tokenHash = hashRecoveryToken(rawToken);
    await db
      .update(failedPayments)
      .set({ recoveryToken: null, recoveryTokenHash: tokenHash })
      .where(eq(failedPayments.id, payment.id));

    const formattedAmount = Number(payment.amount || 0).toLocaleString('en-NG', {
      minimumFractionDigits: 2,
    });

    const waAdapter = getWhatsAppProvider(
      log.provider || business?.whatsappProvider || 'META'
    );
    const sendResult = await waAdapter.sendTemplate({
      phoneNumber: customer.phone,
      templateName: log.templateName,
      language: 'en',
      variables: {
        customer_name: customer.name,
        business_name: business?.name || 'ASUKU Merchant',
        amount: formattedAmount,
        currency: payment.currency,
        payment_link: `${process.env.APP_URL || 'https://asuku.app'}/r/${rawToken}`,
        subscription_name: 'Recurring Plan',
        recovery_token: rawToken,
      },
    });

    const sanitizedApiRequest = JSON.parse(
      JSON.stringify(sendResult.requestPayload).replaceAll(
        rawToken,
        `[SHA256:${tokenHash.slice(0, 12)}...]`
      )
    );

    const now = new Date();
    const [updatedLog] = await db
      .update(whatsappLogs)
      .set({
        status: sendResult.status,
        providerMessageId: sendResult.providerMessageId,
        sentAt:
          sendResult.status === 'SENT' || sendResult.status === 'DELIVERED'
            ? now
            : null,
        deliveredAt: sendResult.status === 'DELIVERED' ? now : null,
        errorCode: sendResult.errorCode || null,
        errorMessage: sendResult.errorMessage || null,
        messagePayload: {
          ...(typeof log.messagePayload === 'object' && log.messagePayload !== null
            ? log.messagePayload
            : {}),
          providerStatus: sendResult.status,
          apiRequest: sanitizedApiRequest,
        },
      })
      .where(eq(whatsappLogs.id, log.id))
      .returning();

    return {
      executed: sendResult.status === 'SENT' || sendResult.status === 'DELIVERED',
      status: sendResult.status,
      log: updatedLog,
      message:
        sendResult.status === 'SENT' || sendResult.status === 'DELIVERED'
          ? `Sequence Step ${log.sequenceStep} (${log.templateName}) sent via ${log.provider} (Message ID: ${sendResult.providerMessageId}).`
          : `Sequence Step ${log.sequenceStep} returned status ${sendResult.status}: ${sendResult.errorMessage}`,
    };
  } catch (error) {
    console.error('Error in executeQueuedWhatsAppJob:', error);
    throw new Error('Failed to execute queued WhatsApp job.', { cause: error });
  }
}

/**
 * PHASE 1 OBJECTIVE 5:
 * Issues a fresh one-time cryptographic recovery token for an authenticated merchant's
 * pending failed payment, storing ONLY its SHA-256 hash in PostgreSQL.
 */
export async function issueOneTimeRecoveryToken(
  businessId: string,
  failedPaymentId: string
) {
  try {
    const [payment] = await db
      .select()
      .from(failedPayments)
      .where(
        and(
          eq(failedPayments.id, failedPaymentId),
          eq(failedPayments.businessId, businessId)
        )
      );

    if (!payment) {
      throw new Error('Failed payment record not found in your tenant workspace.');
    }

    const [business] = await db
      .select()
      .from(businesses)
      .where(eq(businesses.id, businessId));

    const rawToken = `asuku_${crypto.randomBytes(32).toString('base64url')}`;
    const tokenHash = hashRecoveryToken(rawToken);
    const expiresAt = new Date(
      Date.now() + (business?.retryLinkExpiryHours || 168) * 3600 * 1000
    );

    await db
      .update(failedPayments)
      .set({
        recoveryToken: null, // Never store plaintext token
        recoveryTokenHash: tokenHash,
        expiresAt,
      })
      .where(eq(failedPayments.id, payment.id));

    return {
      rawToken,
      tokenHash,
      expiresAt,
    };
  } catch (error) {
    console.error('Error in issueOneTimeRecoveryToken:', error);
    throw new Error('Failed to issue recovery token.', { cause: error });
  }
}

/**
 * PHASE 1 OBJECTIVE 3 & 5:
 * Resolve Recovery Link Token by computing SHA-256(rawToken) and querying `recovery_token_hash`.
 * Never queries plaintext tokens and returns only sanitized checkout fields.
 */
export async function getRecoveryAttemptByToken(rawToken: string) {
  try {
    if (!rawToken || rawToken.length < 16) {
      return null;
    }

    const computedHash = hashRecoveryToken(rawToken);

    const [payment] = await db
      .select()
      .from(failedPayments)
      .where(eq(failedPayments.recoveryTokenHash, computedHash));

    if (!payment || !payment.recoveryTokenHash) {
      return null;
    }

    // Constant-time comparison of SHA-256 hex digest
    const storedBuf = Buffer.from(payment.recoveryTokenHash, 'utf8');
    const computedBuf = Buffer.from(computedHash, 'utf8');
    if (
      storedBuf.length !== computedBuf.length ||
      !crypto.timingSafeEqual(storedBuf, computedBuf)
    ) {
      return null;
    }

    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, payment.customerId));

    const [business] = await db
      .select()
      .from(businesses)
      .where(eq(businesses.id, payment.businessId));

    const subscription = payment.subscriptionId
      ? (
          await db
            .select()
            .from(subscriptions)
            .where(eq(subscriptions.id, payment.subscriptionId))
        )[0]
      : null;

    const isExpired = payment.expiresAt
      ? new Date(payment.expiresAt).getTime() < Date.now()
      : false;

    const isUsed =
      payment.status === 'RECOVERED' || payment.recoveryTokenUsedAt !== null;

    return {
      payment: {
        id: payment.id,
        businessId: payment.businessId,
        provider: payment.provider,
        providerReference: payment.providerReference,
        amount: payment.amount,
        currency: payment.currency,
        failureReason: payment.failureReason,
        status: payment.status,
        recoveryTokenHashPrefix: payment.recoveryTokenHash.slice(0, 16),
        recoveryTokenUsedAt: payment.recoveryTokenUsedAt,
        expiresAt: payment.expiresAt,
        recoveredAt: payment.recoveredAt,
      },
      customer: customer
        ? {
            name: customer.name,
            phone: customer.phone,
          }
        : null,
      business: business
        ? {
            name: business.name,
            currency: business.currency,
          }
        : null,
      subscription: subscription
        ? {
            planName: subscription.planName,
          }
        : null,
      isExpired,
      isUsed,
    };
  } catch (error) {
    console.error('Error in getRecoveryAttemptByToken:', error);
    throw new Error('Failed to resolve recovery link token.', { cause: error });
  }
}

export interface VerifyAndCompleteRecoveryOptions {
  verifyTransactionFn?: typeof verifyTransactionWithProvider;
}

/**
 * PHASE 1 OBJECTIVE 3, 4 & STEP 5B:
 * Hardened Recovery Link Completion with Atomic One-Time Token Consumption:
 * 1. Never trusts frontend claims of payment success.
 * 2. Verifies the transaction with the payment provider API (Paystack/Flutterwave)
 *    checking status, exact amount, currency, and reference.
 * 3. Atomically updates failed_payments with WHERE id = ? AND business_id = ? AND status = 'PENDING' AND recovery_token_used_at IS NULL.
 * 4. If the atomic UPDATE affects 0 rows (e.g., concurrent request already consumed token or status changed),
 *    returns 409 Conflict and does NOT report successful recovery.
 */
export async function verifyAndCompleteRecoveryByToken(
  rawToken: string,
  transactionReference: string,
  options?: VerifyAndCompleteRecoveryOptions
) {
  const details = await getRecoveryAttemptByToken(rawToken);
  if (!details) {
    return {
      httpStatus: 404,
      success: false,
      error: 'Invalid or unknown recovery link token (SHA-256 hash not found).',
    };
  }

  if (details.isExpired) {
    return {
      httpStatus: 410,
      success: false,
      error: 'This recovery link has expired and can no longer be used.',
    };
  }

  if (details.isUsed || details.payment.status === 'RECOVERED') {
    return {
      httpStatus: 409,
      success: false,
      errorCode: 'TOKEN_ALREADY_USED_OR_RECOVERED',
      error:
        'This one-time recovery token has already been used or the payment is already recovered.',
    };
  }

  if (details.payment.status !== 'PENDING') {
    return {
      httpStatus: 409,
      success: false,
      errorCode: 'PAYMENT_NOT_ELIGIBLE',
      error: `Payment is no longer eligible for recovery (current status: ${details.payment.status}).`,
    };
  }

  // Enforce exact reference correspondence
  if (
    details.payment.providerReference &&
    transactionReference.trim() !== details.payment.providerReference
  ) {
    return {
      httpStatus: 400,
      success: false,
      error: `Transaction reference mismatch: provided '${transactionReference}' does not match failed payment reference '${details.payment.providerReference}'.`,
    };
  }

  // Verify transaction directly with Paystack / Flutterwave server-side API
  const verifyFn =
    options?.verifyTransactionFn ?? verifyTransactionWithProvider;
  const verification = await verifyFn({
    provider: details.payment.provider,
    reference: transactionReference.trim(),
    expectedAmountNaira: Number(details.payment.amount),
    expectedCurrency: details.payment.currency,
  });

  if (!verification.verified) {
    const statusCode = verification.status === 'NOT_CONFIGURED' ? 503 : 422;
    return {
      httpStatus: statusCode,
      success: false,
      verificationStatus: verification.status,
      errorCode: verification.errorCode,
      error:
        verification.errorMessage ||
        'Payment provider verification failed. Never trusting unverified frontend completion.',
    };
  }

  const outcome = await markPaymentRecoveredAndCancelQueue(
    details.payment.businessId,
    details.payment.id,
    `Verified with ${details.payment.provider} API (tx=${verification.providerTransactionId}, ref=${transactionReference})`
  );

  if (!outcome.recovered || !outcome.updatedPayment) {
    return {
      httpStatus: 409,
      success: false,
      rowsAffected: 0,
      errorCode: 'ATOMIC_CONSUMPTION_CONFLICT',
      error:
        'Recovery token was already consumed, payment was already recovered, or payment is no longer eligible (atomic update affected 0 rows).',
    };
  }

  return {
    httpStatus: 200,
    success: true,
    verificationStatus: verification.status,
    ...outcome,
    message: `Verified ${details.payment.currency} ${Number(
      details.payment.amount
    ).toLocaleString('en-NG')} with ${
      details.payment.provider
    } API! One-time token consumed, subscription reactivated, and ${
      outcome.cancelledJobsCount
    } remaining scheduled WhatsApp reminder(s) immediately cancelled.`,
  };
}

export interface InitializeRecoveryPaymentOptions {
  fetchFn?: FetchLike;
  paymentProvider?: PaymentProvider;
  callbackUrl?: string;
}

/**
 * PHASE 2 PAYMENT INITIALIZATION FLOW (By Recovery Token):
 * 1. Validates SHA-256 recovery token, expiry, single-use, and PENDING status.
 * 2. Loads authoritative amount, currency, provider, providerReference, customer, subscription,
 *    and businessId from PostgreSQL — NEVER trusting frontend amount or reference values.
 * 3. Calls the PaymentProvider interface (PaystackPaymentProvider / FlutterwavePaymentProvider)
 *    to initialize checkout and returns only safe checkout metadata.
 */
export async function initializeRecoveryPaymentByToken(
  rawToken: string,
  options?: InitializeRecoveryPaymentOptions
) {
  const details = await getRecoveryAttemptByToken(rawToken);
  if (!details) {
    return {
      httpStatus: 404,
      initialized: false,
      status: 'FAILED' as const,
      error: 'Invalid or unknown recovery link token (SHA-256 hash not found).',
    };
  }

  if (details.isExpired) {
    return {
      httpStatus: 410,
      initialized: false,
      status: 'FAILED' as const,
      error: 'This recovery link has expired and can no longer be used.',
    };
  }

  if (details.isUsed || details.payment.status === 'RECOVERED') {
    return {
      httpStatus: 409,
      initialized: false,
      status: 'FAILED' as const,
      errorCode: 'TOKEN_ALREADY_USED_OR_RECOVERED',
      error:
        'This one-time recovery token has already been used or the payment is already recovered.',
    };
  }

  if (details.payment.status !== 'PENDING') {
    return {
      httpStatus: 409,
      initialized: false,
      status: 'FAILED' as const,
      errorCode: 'PAYMENT_NOT_ELIGIBLE',
      error: `Payment is no longer eligible for recovery (current status: ${details.payment.status}).`,
    };
  }

  const [paymentRow] = await db
    .select()
    .from(failedPayments)
    .where(eq(failedPayments.id, details.payment.id));

  if (!paymentRow || paymentRow.status !== 'PENDING') {
    return {
      httpStatus: 409,
      initialized: false,
      status: 'FAILED' as const,
      error: 'Payment record is no longer in PENDING state.',
    };
  }

  const [customerRow] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, paymentRow.customerId));

  // Ensure deterministic server-controlled reference exists on the failed_payment record
  let authoritativeReference = paymentRow.providerReference?.trim();
  if (!authoritativeReference) {
    authoritativeReference = `asuku_ref_${paymentRow.provider.toLowerCase()}_${paymentRow.id.slice(0, 8)}`;
    await db
      .update(failedPayments)
      .set({ providerReference: authoritativeReference })
      .where(eq(failedPayments.id, paymentRow.id));
  }

  const adapter =
    options?.paymentProvider ??
    getPaymentProvider(paymentRow.provider, options?.fetchFn);

  const initResult = await adapter.initializePayment({
    businessId: paymentRow.businessId,
    failedPaymentId: paymentRow.id,
    customerId: paymentRow.customerId,
    subscriptionId: paymentRow.subscriptionId,
    provider: paymentRow.provider,
    reference: authoritativeReference,
    amountNaira: Number(paymentRow.amount),
    currency: paymentRow.currency,
    customerEmail: customerRow?.email || 'billing@customer.ng',
    customerName: customerRow?.name,
    customerPhone: customerRow?.phone,
    callbackUrl:
      options?.callbackUrl ||
      `${process.env.APP_URL || 'https://asuku.app'}/r/${rawToken}`,
  });

  if (!initResult.initialized) {
    const httpStatus = initResult.status === 'NOT_CONFIGURED' ? 503 : 502;
    return {
      httpStatus,
      ...initResult,
    };
  }

  return {
    httpStatus: 200,
    ...initResult,
  };
}

/**
 * PHASE 2 PAYMENT INITIALIZATION FLOW (Authenticated Merchant Retry):
 * Verifies tenant ownership (`WHERE id = failedPaymentId AND business_id = businessId`),
 * loads authoritative payment/customer/subscription data from PostgreSQL, and initializes
 * checkout through the PaymentProvider abstraction.
 */
export async function initializeMerchantPaymentRetry(
  businessId: string,
  failedPaymentId: string,
  options?: InitializeRecoveryPaymentOptions
) {
  const [paymentRow] = await db
    .select()
    .from(failedPayments)
    .where(
      and(
        eq(failedPayments.id, failedPaymentId),
        eq(failedPayments.businessId, businessId)
      )
    );

  if (!paymentRow) {
    return {
      httpStatus: 404,
      initialized: false,
      status: 'FAILED' as const,
      error: 'Failed payment record not found in your tenant workspace.',
    };
  }

  if (
    paymentRow.status !== 'PENDING' ||
    paymentRow.recoveryTokenUsedAt !== null
  ) {
    return {
      httpStatus: 409,
      initialized: false,
      status: 'FAILED' as const,
      errorCode: 'PAYMENT_NOT_ELIGIBLE',
      error: `Payment is already ${paymentRow.status} or its recovery token has already been consumed.`,
    };
  }

  const [customerRow] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, paymentRow.customerId));

  let authoritativeReference = paymentRow.providerReference?.trim();
  if (!authoritativeReference) {
    authoritativeReference = `asuku_ref_${paymentRow.provider.toLowerCase()}_${paymentRow.id.slice(0, 8)}`;
    await db
      .update(failedPayments)
      .set({ providerReference: authoritativeReference })
      .where(eq(failedPayments.id, paymentRow.id));
  }

  const adapter =
    options?.paymentProvider ??
    getPaymentProvider(paymentRow.provider, options?.fetchFn);

  const initResult = await adapter.initializePayment({
    businessId: paymentRow.businessId,
    failedPaymentId: paymentRow.id,
    customerId: paymentRow.customerId,
    subscriptionId: paymentRow.subscriptionId,
    provider: paymentRow.provider,
    reference: authoritativeReference,
    amountNaira: Number(paymentRow.amount),
    currency: paymentRow.currency,
    customerEmail: customerRow?.email || 'billing@customer.ng',
    customerName: customerRow?.name,
    customerPhone: customerRow?.phone,
    callbackUrl: options?.callbackUrl || process.env.APP_URL || 'https://asuku.app',
  });

  if (!initResult.initialized) {
    const httpStatus = initResult.status === 'NOT_CONFIGURED' ? 503 : 502;
    return {
      httpStatus,
      ...initResult,
    };
  }

  return {
    httpStatus: 200,
    ...initResult,
  };
}
