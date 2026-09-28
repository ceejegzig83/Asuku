import crypto from 'crypto';
import { and, eq } from 'drizzle-orm';
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
  getWhatsAppProvider,
  normalizeNigerianPhone,
  normalizeWebhookEventType,
  PaymentProviderName,
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
  planName?: string;
  amountNaira?: number;
  providerReference?: string;
  failureReason?: string;
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

    // 3. Branch on Normalized Event Type
    if (normalizedEvent === 'PAYMENT_FAILED') {
      const phone = normalizeNigerianPhone(
        input.customerPhone || '+2348034192810'
      );
      const email = input.customerEmail || 'billing@customer-enterprise.ng';
      const name = input.customerName || 'Adaeze Okafor (Sterling FinOps)';
      const planName = input.planName || 'Enterprise Core Subscription';
      const amount = (input.amountNaira || 750000).toFixed(2);
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
            whatsappOptIn: true,
          })
          .returning();
        customer = createdCust;
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
            currency: 'NGN',
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

      // Generate secure cryptographic recovery token
      const recoveryToken = `asuku_${crypto.randomBytes(16).toString('base64url')}`;
      const recoveryTokenHash = crypto
        .createHash('sha256')
        .update(recoveryToken)
        .digest('hex');

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
          currency: 'NGN',
          failureReason:
            input.failureReason ||
            'Insufficient Funds / Issuer Declined Recurring Charge',
          status: 'PENDING',
          recoveryStatus: 'ACTIVE',
          recoveryToken,
          recoveryTokenHash,
          failedAt: now,
          expiresAt,
        })
        .returning();

      // Queue 3 deterministic WhatsApp sequence jobs (Step 1: T+0, Step 2: T+24h, Step 3: T+72h)
      const t24 = new Date(now.getTime() + 24 * 3600 * 1000);
      const t72 = new Date(now.getTime() + 72 * 3600 * 1000);
      const retryUrl = `/r/${recoveryToken}`;
      const formattedAmount = Number(amount).toLocaleString('en-NG', {
        minimumFractionDigits: 2,
      });

      const waProviderName = business.whatsappProvider || 'META';

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
              amount: `NGN ${formattedAmount}`,
              retryUrl,
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
              amount: `NGN ${formattedAmount}`,
              retryUrl,
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
              amount: `NGN ${formattedAmount}`,
              retryUrl,
            },
          },
        ])
        .returning();

      // Worker immediately executes Step 1 (T+0) after verifying status and opt-in
      if (customer.whatsappOptIn) {
        const waAdapter = getWhatsAppProvider(waProviderName);
        const sendResult = await waAdapter.sendTemplate({
          phoneNumber: customer.phone,
          templateName: business.whatsappTemplateImmediate,
          language: 'en',
          variables: {
            customer_name: customer.name,
            business_name: business.name,
            amount: formattedAmount,
            currency: 'NGN',
            payment_link: `${process.env.APP_URL || 'https://asuku.app'}${retryUrl}`,
            subscription_name: subscription.planName,
            recovery_token: recoveryToken,
          },
        });

        await db
          .update(whatsappLogs)
          .set({
            status: 'DELIVERED',
            providerMessageId: sendResult.providerMessageId,
            sentAt: new Date(),
            deliveredAt: new Date(),
            messagePayload: {
              jobId: `${failedPayment.id}:1`,
              step: 'T+0 Immediate',
              template: business.whatsappTemplateImmediate,
              customer: customer.name,
              amount: `NGN ${formattedAmount}`,
              retryUrl,
              apiRequest: sendResult.requestPayload,
            },
          })
          .where(eq(whatsappLogs.id, job1.id));
      } else {
        // Customer opted out of WhatsApp
        await db
          .update(whatsappLogs)
          .set({
            status: 'CANCELLED',
            errorMessage: 'Skipped: Customer whatsapp_opt_in is FALSE',
          })
          .where(eq(whatsappLogs.failedPaymentId, failedPayment.id));
      }

      return {
        status: 'RECOVERY_INITIATED',
        idempotent: false,
        webhookEvent: savedWebhook,
        failedPayment,
        queuedJobs: [job1.id, job2.id, job3.id],
        message: `Verified ${input.provider} failure (${reference}). Created recovery campaign with token ${recoveryToken}, dispatched T+0 WhatsApp message, and scheduled T+24h and T+72h jobs.`,
      };
    }

    // 4. Handle PAYMENT_SUCCESS (charge.success) -> Recover & Cancel Remaining Queue
    if (normalizedEvent === 'PAYMENT_SUCCESS') {
      // Find matching PENDING failed payment by reference or most recent PENDING for business
      const pendingList = await db
        .select()
        .from(failedPayments)
        .where(
          and(
            eq(failedPayments.businessId, input.businessId),
            eq(failedPayments.status, 'PENDING')
          )
        );

      const targetPayment =
        pendingList.find((p) => p.providerReference === input.providerReference) ||
        pendingList[0];

      if (!targetPayment) {
        return {
          status: 'NO_PENDING_PAYMENT_MATCHED',
          idempotent: false,
          webhookEvent: savedWebhook,
          message: 'Webhook verified and stored, but no PENDING failed payment matched.',
        };
      }

      const recovered = await markPaymentRecoveredAndCancelQueue(
        input.businessId,
        targetPayment.id,
        `Verified via ${input.provider} ${input.rawEventType} webhook`
      );

      return {
        status: 'PAYMENT_RECOVERED',
        idempotent: false,
        webhookEvent: savedWebhook,
        failedPayment: recovered.updatedPayment,
        cancelledJobsCount: recovered.cancelledJobsCount,
        message: `Payment ${targetPayment.providerReference} marked RECOVERED. Subscription restored to ACTIVE and ${recovered.cancelledJobsCount} queued WhatsApp follow-up message(s) immediately cancelled.`,
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
 * 3.6 Immediate cancellation after successful payment
 */
export async function markPaymentRecoveredAndCancelQueue(
  businessId: string,
  failedPaymentId: string,
  reason: string
) {
  try {
    const now = new Date();

    const [updatedPayment] = await db
      .update(failedPayments)
      .set({
        status: 'RECOVERED',
        recoveryStatus: 'RECOVERED',
        recoveredAt: now,
      })
      .where(
        and(
          eq(failedPayments.id, failedPaymentId),
          eq(failedPayments.businessId, businessId)
        )
      )
      .returning();

    if (!updatedPayment) {
      throw new Error('Failed payment record not found');
    }

    if (updatedPayment.subscriptionId) {
      await db
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
    const cancelledLogs = await db
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
      updatedPayment,
      cancelledJobsCount: cancelledLogs.length,
    };
  } catch (error) {
    console.error('Error in markPaymentRecoveredAndCancelQueue:', error);
    throw new Error('Failed to mark payment recovered.', { cause: error });
  }
}

/**
 * 3.5 BullMQ Worker Execution Rule: Never send merely because timer expired;
 * verify payment status === 'PENDING' and customer.whatsapp_opt_in immediately before sending.
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

    // Critical Worker Rule: Check payment status immediately before sending
    if (!payment || payment.status !== 'PENDING') {
      await db
        .update(whatsappLogs)
        .set({
          status: 'CANCELLED',
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

    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, log.customerId));

    if (!customer || !customer.whatsappOptIn) {
      await db
        .update(whatsappLogs)
        .set({
          status: 'CANCELLED',
          errorMessage: 'Worker pre-send check aborted: Customer WhatsApp opt-in is FALSE',
        })
        .where(eq(whatsappLogs.id, log.id));

      return {
        executed: false,
        reason: 'Aborted: Customer has opted out of WhatsApp recovery notifications.',
      };
    }

    const [business] = await db
      .select()
      .from(businesses)
      .where(eq(businesses.id, businessId));

    const formattedAmount = Number(payment.amount || 0).toLocaleString('en-NG', {
      minimumFractionDigits: 2,
    });
    const retryUrl = `/r/${payment.recoveryToken}`;

    const waAdapter = getWhatsAppProvider(log.provider || business?.whatsappProvider || 'META');
    const sendResult = await waAdapter.sendTemplate({
      phoneNumber: customer.phone,
      templateName: log.templateName,
      language: 'en',
      variables: {
        customer_name: customer.name,
        business_name: business?.name || 'ASUKU Merchant',
        amount: formattedAmount,
        currency: payment.currency,
        payment_link: `${process.env.APP_URL || 'https://asuku.app'}${retryUrl}`,
        subscription_name: 'Recurring Plan',
        recovery_token: payment.recoveryToken || '',
      },
    });

    const now = new Date();
    const [updatedLog] = await db
      .update(whatsappLogs)
      .set({
        status: 'DELIVERED',
        providerMessageId: sendResult.providerMessageId,
        sentAt: now,
        deliveredAt: now,
        messagePayload: {
          ...(typeof log.messagePayload === 'object' && log.messagePayload !== null
            ? log.messagePayload
            : {}),
          apiRequest: sendResult.requestPayload,
        },
      })
      .where(eq(whatsappLogs.id, log.id))
      .returning();

    return {
      executed: true,
      log: updatedLog,
      message: `Sequence Step ${log.sequenceStep} (${log.templateName}) dispatched via ${log.provider} (${sendResult.providerMessageId}).`,
    };
  } catch (error) {
    console.error('Error in executeQueuedWhatsAppJob:', error);
    throw new Error('Failed to execute queued WhatsApp job.', { cause: error });
  }
}

/**
 * 1.7 & 1.8 Resolve Recovery Link Token & Process Customer Retry Checkout
 */
export async function getRecoveryAttemptByToken(token: string) {
  try {
    const [payment] = await db
      .select()
      .from(failedPayments)
      .where(eq(failedPayments.recoveryToken, token));

    if (!payment) {
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

    const isExpired =
      payment.expiresAt ? new Date(payment.expiresAt).getTime() < Date.now() : false;

    return {
      payment,
      customer,
      business,
      subscription,
      isExpired,
    };
  } catch (error) {
    console.error('Error in getRecoveryAttemptByToken:', error);
    throw new Error('Failed to resolve recovery link token.', { cause: error });
  }
}
