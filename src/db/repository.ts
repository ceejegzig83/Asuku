import crypto from 'crypto';
import { desc, eq, and } from 'drizzle-orm';
import { db } from './index.ts';
import {
  businesses,
  customers,
  failedPayments,
  subscriptions,
  users,
  webhookEvents,
  whatsappLogs,
} from './schema.ts';

export async function getOrCreateTenantContext(
  uid: string,
  email: string,
  displayName?: string
) {
  try {
    await db
      .insert(users)
      .values({
        uid,
        email,
        name: displayName || email.split('@')[0],
      })
      .onConflictDoUpdate({
        target: users.uid,
        set: {
          email,
          name: displayName || email.split('@')[0],
        },
      });

    const existingBusinesses = await db
      .select()
      .from(businesses)
      .where(eq(businesses.ownerUid, uid));

    let business = existingBusinesses[0];

    if (!business) {
      const uniqueEmail =
        uid === 'demo-tenant-nigeria-uid'
          ? 'revenue-ops@paystack-enterprise.ng'
          : email;

      const byEmail = await db
        .select()
        .from(businesses)
        .where(eq(businesses.email, uniqueEmail));

      if (byEmail[0]) {
        business = byEmail[0];
      } else {
        const inserted = await db
          .insert(businesses)
          .values({
            ownerUid: uid,
            name:
              uid === 'demo-tenant-nigeria-uid'
                ? 'VantagePay Commerce Nigeria Ltd'
                : `${displayName || 'Asuku'} Technologies Ltd`,
            email: uniqueEmail,
            phone: '+2348094421900',
            currency: 'NGN',
            timezone: 'Africa/Lagos',
            paystackEnabled: true,
            flutterwaveEnabled: true,
            whatsappProvider: 'META',
            whatsappTemplateImmediate: 'payment_failed_recovery',
            whatsappTemplate24h: 'payment_reminder_24h',
            whatsappTemplate72h: 'payment_final_notice_72h',
            retryLinkExpiryHours: 168,
          })
          .returning();
        business = inserted[0];
      }
    }

    await seedBusinessIfEmpty(business.id);
    return business;
  } catch (error) {
    console.error('Database query failed in getOrCreateTenantContext:', error);
    throw new Error('Failed to initialize tenant workspace.', { cause: error });
  }
}

export async function seedBusinessIfEmpty(businessId: string) {
  try {
    const existingCustomers = await db
      .select()
      .from(customers)
      .where(eq(customers.businessId, businessId));

    if (existingCustomers.length > 0) {
      return;
    }

    const now = new Date();
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600 * 1000);
    const hoursAhead = (h: number) => new Date(now.getTime() + h * 3600 * 1000);

    const seedCustomerRows = await db
      .insert(customers)
      .values([
        {
          businessId,
          externalCustomerId: 'CUS_pstk_98231a',
          name: 'Chukwuma Nwosu (Lekki Fleet Logistics)',
          email: 'c.nwosu@lekkifleet.ng',
          phone: '+2348034192810',
          whatsappOptIn: true,
        },
        {
          businessId,
          externalCustomerId: 'CUS_pstk_77412b',
          name: 'Dr. Amina Bello (MedCore Diagnostics Abuja)',
          email: 'abello@medcorediagnostics.com.ng',
          phone: '+2348091123409',
          whatsappOptIn: true,
        },
        {
          businessId,
          externalCustomerId: 'CUS_flw_55190c',
          name: 'Tunde Bakare (Yaba Cloud Infrastructure)',
          email: 'tunde@yabacloud.io',
          phone: '+2348128837104',
          whatsappOptIn: true,
        },
        {
          businessId,
          externalCustomerId: 'CUS_pstk_33108d',
          name: 'Ngozi Eze (Rivers PetroServ Enterprise)',
          email: 'ngozi.eze@riverspetro.ng',
          phone: '+2347065541920',
          whatsappOptIn: true,
        },
        {
          businessId,
          externalCustomerId: 'CUS_flw_21984e',
          name: 'Oluwaseun Adeyemi (Ibadan Retail POS Hub)',
          email: 'seun@ibadanretail.ng',
          phone: '+2348023310982',
          whatsappOptIn: true,
        },
        {
          businessId,
          externalCustomerId: 'CUS_pstk_19044f',
          name: 'Ibrahim Musa (Kano Agro Commodities)',
          email: 'imusa@kanoagro.com.ng',
          phone: '+2348057723190',
          whatsappOptIn: false,
        },
      ])
      .returning();

    const [c1, c2, c3, c4, c5, c6] = seedCustomerRows;

    const seedSubRows = await db
      .insert(subscriptions)
      .values([
        {
          businessId,
          customerId: c1.id,
          provider: 'PAYSTACK',
          providerSubscriptionId: 'SUB_pstk_fleet_ent_01',
          planName: 'Enterprise Fleet Telemetry (50 Vehicles)',
          amount: '1850000.00',
          currency: 'NGN',
          status: 'PAST_DUE',
          currentPeriodStart: hoursAgo(720),
          currentPeriodEnd: hoursAgo(6),
        },
        {
          businessId,
          customerId: c2.id,
          provider: 'PAYSTACK',
          providerSubscriptionId: 'SUB_pstk_medcore_pro_02',
          planName: 'Hospital ERP & Lab Cloud Annual',
          amount: '1250000.00',
          currency: 'NGN',
          status: 'RECOVERED',
          currentPeriodStart: hoursAgo(48),
          currentPeriodEnd: hoursAhead(672),
        },
        {
          businessId,
          customerId: c3.id,
          provider: 'FLUTTERWAVE',
          providerSubscriptionId: 'SUB_flw_yaba_k8s_03',
          planName: 'Dedicated High-Availability Cluster',
          amount: '950000.00',
          currency: 'NGN',
          status: 'PAST_DUE',
          currentPeriodStart: hoursAgo(750),
          currentPeriodEnd: hoursAgo(28),
        },
        {
          businessId,
          customerId: c4.id,
          provider: 'PAYSTACK',
          providerSubscriptionId: 'SUB_pstk_petro_sec_04',
          planName: 'Pipeline Compliance & Audit Suite',
          amount: '2400000.00',
          currency: 'NGN',
          status: 'RECOVERED',
          currentPeriodStart: hoursAgo(96),
          currentPeriodEnd: hoursAhead(624),
        },
        {
          businessId,
          customerId: c5.id,
          provider: 'FLUTTERWAVE',
          providerSubscriptionId: 'SUB_flw_retail_pos_05',
          planName: 'Multi-Branch Inventory Sync (12 Stores)',
          amount: '480000.00',
          currency: 'NGN',
          status: 'PAST_DUE',
          currentPeriodStart: hoursAgo(740),
          currentPeriodEnd: hoursAgo(2),
        },
        {
          businessId,
          customerId: c6.id,
          provider: 'PAYSTACK',
          providerSubscriptionId: 'SUB_pstk_agro_trade_06',
          planName: 'Commodity Settlement Analytics',
          amount: '620000.00',
          currency: 'NGN',
          status: 'EXPIRED',
          currentPeriodStart: hoursAgo(900),
          currentPeriodEnd: hoursAgo(180),
        },
      ])
      .returning();

    const [s1, s2, s3, s4, s5, s6] = seedSubRows;

    const makeToken = (slug: string) => {
      const token = `asuku_${slug}_${crypto.randomBytes(8).toString('base64url')}`;
      const hash = crypto.createHash('sha256').update(token).digest('hex');
      return { token, hash };
    };

    const t1 = makeToken('lekki');
    const t2 = makeToken('medcore');
    const t3 = makeToken('yaba');
    const t4 = makeToken('petro');
    const t5 = makeToken('ibadan');
    const t6 = makeToken('kano');

    const seedFailedRows = await db
      .insert(failedPayments)
      .values([
        {
          businessId,
          customerId: c1.id,
          subscriptionId: s1.id,
          provider: 'PAYSTACK',
          providerTransactionId: 'TXN_pstk_9901824',
          providerReference: 'ref_pstk_lekki_8821',
          amount: '1850000.00',
          currency: 'NGN',
          failureReason: 'Insufficient Funds on Corporate Zenith Visa Card (*4921)',
          status: 'PENDING',
          recoveryStatus: 'ACTIVE',
          recoveryToken: t1.token,
          recoveryTokenHash: t1.hash,
          failedAt: hoursAgo(5),
          expiresAt: hoursAhead(163),
        },
        {
          businessId,
          customerId: c2.id,
          subscriptionId: s2.id,
          provider: 'PAYSTACK',
          providerTransactionId: 'TXN_pstk_9901102',
          providerReference: 'ref_pstk_medcore_4410',
          amount: '1250000.00',
          currency: 'NGN',
          failureReason: 'Issuer Declined: Card Recurring Limit Exceeded (GTBank *8812)',
          status: 'RECOVERED',
          recoveryStatus: 'RECOVERED',
          recoveryToken: t2.token,
          recoveryTokenHash: t2.hash,
          failedAt: hoursAgo(38),
          recoveredAt: hoursAgo(12),
          expiresAt: hoursAhead(130),
        },
        {
          businessId,
          customerId: c3.id,
          subscriptionId: s3.id,
          provider: 'FLUTTERWAVE',
          providerTransactionId: 'FLW_TX_7729104',
          providerReference: 'flw_ref_yaba_3109',
          amount: '950000.00',
          currency: 'NGN',
          failureReason: ' Do Not Honor — Bank 3DS Token Expired (Access Bank *1104)',
          status: 'PENDING',
          recoveryStatus: 'ACTIVE',
          recoveryToken: t3.token,
          recoveryTokenHash: t3.hash,
          failedAt: hoursAgo(27),
          expiresAt: hoursAhead(141),
        },
        {
          businessId,
          customerId: c4.id,
          subscriptionId: s4.id,
          provider: 'PAYSTACK',
          providerTransactionId: 'TXN_pstk_8821900',
          providerReference: 'ref_pstk_petro_9012',
          amount: '2400000.00',
          currency: 'NGN',
          failureReason: 'Expired Corporate Mastercard (*5539)',
          status: 'RECOVERED',
          recoveryStatus: 'RECOVERED',
          recoveryToken: t4.token,
          recoveryTokenHash: t4.hash,
          failedAt: hoursAgo(82),
          recoveredAt: hoursAgo(78),
          expiresAt: hoursAhead(86),
        },
        {
          businessId,
          customerId: c5.id,
          subscriptionId: s5.id,
          provider: 'FLUTTERWAVE',
          providerTransactionId: 'FLW_TX_6610922',
          providerReference: 'flw_ref_ibadan_7731',
          amount: '480000.00',
          currency: 'NGN',
          failureReason: 'Issuer Switch Timeout (NIBSS Interbank Delay)',
          status: 'PENDING',
          recoveryStatus: 'ACTIVE',
          recoveryToken: t5.token,
          recoveryTokenHash: t5.hash,
          failedAt: hoursAgo(1),
          expiresAt: hoursAhead(167),
        },
        {
          businessId,
          customerId: c6.id,
          subscriptionId: s6.id,
          provider: 'PAYSTACK',
          providerTransactionId: 'TXN_pstk_7100291',
          providerReference: 'ref_pstk_kano_1198',
          amount: '620000.00',
          currency: 'NGN',
          failureReason: 'Customer Opted Out of WhatsApp Recovery Channel',
          status: 'EXPIRED',
          recoveryStatus: 'EXPIRED',
          recoveryToken: t6.token,
          recoveryTokenHash: t6.hash,
          failedAt: hoursAgo(180),
          expiresAt: hoursAgo(12),
        },
      ])
      .returning();

    const [fp1, fp2, fp3, fp4, fp5] = seedFailedRows;

    // Seed WhatsApp sequence logs (T+0, T+24h, T+72h) demonstrating idempotency & auto-cancellation
    await db.insert(whatsappLogs).values([
      // fp1: Failed 5h ago -> Step 1 READ, Step 2 QUEUED (+19h), Step 3 QUEUED (+67h)
      {
        businessId,
        customerId: c1.id,
        failedPaymentId: fp1.id,
        provider: 'META',
        templateName: 'payment_failed_recovery',
        sequenceStep: 1,
        status: 'READ',
        providerMessageId: 'wamid.HBgNMjM0ODAzNDE5MjgxMFUCABEYEjA5MThB',
        phoneNumber: c1.phone,
        scheduledAt: hoursAgo(5),
        sentAt: hoursAgo(5),
        deliveredAt: hoursAgo(5),
        readAt: hoursAgo(4),
        messagePayload: {
          template: 'payment_failed_recovery',
          step: 'T+0 Immediate',
          customer: c1.name,
          amount: 'NGN 1,850,000.00',
          retryUrl: `/r/${t1.token}`,
        },
      },
      {
        businessId,
        customerId: c1.id,
        failedPaymentId: fp1.id,
        provider: 'META',
        templateName: 'payment_reminder_24h',
        sequenceStep: 2,
        status: 'QUEUED',
        phoneNumber: c1.phone,
        scheduledAt: hoursAhead(19),
        messagePayload: {
          template: 'payment_reminder_24h',
          step: 'T+24h Follow-Up',
          customer: c1.name,
          amount: 'NGN 1,850,000.00',
          retryUrl: `/r/${t1.token}`,
        },
      },
      {
        businessId,
        customerId: c1.id,
        failedPaymentId: fp1.id,
        provider: 'META',
        templateName: 'payment_final_notice_72h',
        sequenceStep: 3,
        status: 'QUEUED',
        phoneNumber: c1.phone,
        scheduledAt: hoursAhead(67),
        messagePayload: {
          template: 'payment_final_notice_72h',
          step: 'T+72h Final Reminder',
          customer: c1.name,
          amount: 'NGN 1,850,000.00',
          retryUrl: `/r/${t1.token}`,
        },
      },

      // fp2: Recovered after Step 2 -> Step 1 READ, Step 2 READ, Step 3 CANCELLED automatically!
      {
        businessId,
        customerId: c2.id,
        failedPaymentId: fp2.id,
        provider: 'META',
        templateName: 'payment_failed_recovery',
        sequenceStep: 1,
        status: 'READ',
        providerMessageId: 'wamid.HBgNMjM0ODA5MTEyMzQwOVUCABEYEjcxOTJC',
        phoneNumber: c2.phone,
        scheduledAt: hoursAgo(38),
        sentAt: hoursAgo(38),
        deliveredAt: hoursAgo(38),
        readAt: hoursAgo(36),
        messagePayload: {
          template: 'payment_failed_recovery',
          step: 'T+0 Immediate',
          customer: c2.name,
          amount: 'NGN 1,250,000.00',
          retryUrl: `/r/${t2.token}`,
        },
      },
      {
        businessId,
        customerId: c2.id,
        failedPaymentId: fp2.id,
        provider: 'META',
        templateName: 'payment_reminder_24h',
        sequenceStep: 2,
        status: 'READ',
        providerMessageId: 'wamid.HBgNMjM0ODA5MTEyMzQwOVUCABEYEjg4MTFD',
        phoneNumber: c2.phone,
        scheduledAt: hoursAgo(14),
        sentAt: hoursAgo(14),
        deliveredAt: hoursAgo(14),
        readAt: hoursAgo(12),
        messagePayload: {
          template: 'payment_reminder_24h',
          step: 'T+24h Follow-Up',
          customer: c2.name,
          amount: 'NGN 1,250,000.00',
          retryUrl: `/r/${t2.token}`,
        },
      },
      {
        businessId,
        customerId: c2.id,
        failedPaymentId: fp2.id,
        provider: 'META',
        templateName: 'payment_final_notice_72h',
        sequenceStep: 3,
        status: 'CANCELLED',
        phoneNumber: c2.phone,
        scheduledAt: hoursAhead(34),
        errorMessage: 'Auto-cancelled: Payment verified via charge.success webhook',
        messagePayload: {
          template: 'payment_final_notice_72h',
          step: 'T+72h Final Reminder',
          customer: c2.name,
          amount: 'NGN 1,250,000.00',
          retryUrl: `/r/${t2.token}`,
        },
      },

      // fp3: Failed 27h ago -> Step 1 READ, Step 2 DELIVERED, Step 3 QUEUED
      {
        businessId,
        customerId: c3.id,
        failedPaymentId: fp3.id,
        provider: 'TERMII',
        templateName: 'payment_failed_recovery',
        sequenceStep: 1,
        status: 'READ',
        providerMessageId: 'termii_9928174a01',
        phoneNumber: c3.phone,
        scheduledAt: hoursAgo(27),
        sentAt: hoursAgo(27),
        deliveredAt: hoursAgo(27),
        readAt: hoursAgo(25),
        messagePayload: {
          template: 'payment_failed_recovery',
          step: 'T+0 Immediate',
          customer: c3.name,
          amount: 'NGN 950,000.00',
          retryUrl: `/r/${t3.token}`,
        },
      },
      {
        businessId,
        customerId: c3.id,
        failedPaymentId: fp3.id,
        provider: 'TERMII',
        templateName: 'payment_reminder_24h',
        sequenceStep: 2,
        status: 'DELIVERED',
        providerMessageId: 'termii_9928174b02',
        phoneNumber: c3.phone,
        scheduledAt: hoursAgo(3),
        sentAt: hoursAgo(3),
        deliveredAt: hoursAgo(3),
        messagePayload: {
          template: 'payment_reminder_24h',
          step: 'T+24h Follow-Up',
          customer: c3.name,
          amount: 'NGN 950,000.00',
          retryUrl: `/r/${t3.token}`,
        },
      },
      {
        businessId,
        customerId: c3.id,
        failedPaymentId: fp3.id,
        provider: 'TERMII',
        templateName: 'payment_final_notice_72h',
        sequenceStep: 3,
        status: 'QUEUED',
        phoneNumber: c3.phone,
        scheduledAt: hoursAhead(45),
        messagePayload: {
          template: 'payment_final_notice_72h',
          step: 'T+72h Final Reminder',
          customer: c3.name,
          amount: 'NGN 950,000.00',
          retryUrl: `/r/${t3.token}`,
        },
      },

      // fp4: Recovered immediately after Step 1 -> Step 1 READ, Step 2 CANCELLED, Step 3 CANCELLED
      {
        businessId,
        customerId: c4.id,
        failedPaymentId: fp4.id,
        provider: 'META',
        templateName: 'payment_failed_recovery',
        sequenceStep: 1,
        status: 'READ',
        providerMessageId: 'wamid.HBgNMjM0NzA2NTU0MTkyMFUCABEYEjM0OTFE',
        phoneNumber: c4.phone,
        scheduledAt: hoursAgo(82),
        sentAt: hoursAgo(82),
        deliveredAt: hoursAgo(82),
        readAt: hoursAgo(80),
        messagePayload: {
          template: 'payment_failed_recovery',
          step: 'T+0 Immediate',
          customer: c4.name,
          amount: 'NGN 2,400,000.00',
          retryUrl: `/r/${t4.token}`,
        },
      },
      {
        businessId,
        customerId: c4.id,
        failedPaymentId: fp4.id,
        provider: 'META',
        templateName: 'payment_reminder_24h',
        sequenceStep: 2,
        status: 'CANCELLED',
        phoneNumber: c4.phone,
        scheduledAt: hoursAgo(58),
        errorMessage: 'Auto-cancelled: Payment verified via charge.success webhook',
        messagePayload: {
          template: 'payment_reminder_24h',
          step: 'T+24h Follow-Up',
          customer: c4.name,
          amount: 'NGN 2,400,000.00',
          retryUrl: `/r/${t4.token}`,
        },
      },
      {
        businessId,
        customerId: c4.id,
        failedPaymentId: fp4.id,
        provider: 'META',
        templateName: 'payment_final_notice_72h',
        sequenceStep: 3,
        status: 'CANCELLED',
        phoneNumber: c4.phone,
        scheduledAt: hoursAgo(10),
        errorMessage: 'Auto-cancelled: Payment verified via charge.success webhook',
        messagePayload: {
          template: 'payment_final_notice_72h',
          step: 'T+72h Final Reminder',
          customer: c4.name,
          amount: 'NGN 2,400,000.00',
          retryUrl: `/r/${t4.token}`,
        },
      },

      // fp5: Failed 1h ago -> Step 1 DELIVERED, Step 2 QUEUED, Step 3 QUEUED
      {
        businessId,
        customerId: c5.id,
        failedPaymentId: fp5.id,
        provider: 'META',
        templateName: 'payment_failed_recovery',
        sequenceStep: 1,
        status: 'DELIVERED',
        providerMessageId: 'wamid.HBgNMjM0ODAyMzMxMDk4MlUCABEYEjY2MTBF',
        phoneNumber: c5.phone,
        scheduledAt: hoursAgo(1),
        sentAt: hoursAgo(1),
        deliveredAt: hoursAgo(1),
        messagePayload: {
          template: 'payment_failed_recovery',
          step: 'T+0 Immediate',
          customer: c5.name,
          amount: 'NGN 480,000.00',
          retryUrl: `/r/${t5.token}`,
        },
      },
      {
        businessId,
        customerId: c5.id,
        failedPaymentId: fp5.id,
        provider: 'META',
        templateName: 'payment_reminder_24h',
        sequenceStep: 2,
        status: 'QUEUED',
        phoneNumber: c5.phone,
        scheduledAt: hoursAhead(23),
        messagePayload: {
          template: 'payment_reminder_24h',
          step: 'T+24h Follow-Up',
          customer: c5.name,
          amount: 'NGN 480,000.00',
          retryUrl: `/r/${t5.token}`,
        },
      },
      {
        businessId,
        customerId: c5.id,
        failedPaymentId: fp5.id,
        provider: 'META',
        templateName: 'payment_final_notice_72h',
        sequenceStep: 3,
        status: 'QUEUED',
        phoneNumber: c5.phone,
        scheduledAt: hoursAhead(71),
        messagePayload: {
          template: 'payment_final_notice_72h',
          step: 'T+72h Final Reminder',
          customer: c5.name,
          amount: 'NGN 480,000.00',
          retryUrl: `/r/${t5.token}`,
        },
      },
    ]);

    // Seed webhook events log
    await db.insert(webhookEvents).values([
      {
        businessId,
        provider: 'PAYSTACK',
        providerEventId: `evt_pstk_${businessId.slice(0, 6)}_001`,
        eventType: 'invoice.payment_failed',
        signature: '9f8e1c4a22b0931d87e6410c23a1994827d112309ab88c1e...',
        signatureValid: true,
        processed: true,
        processedAt: hoursAgo(5),
        payload: {
          event: 'invoice.payment_failed',
          data: {
            reference: 'ref_pstk_lekki_8821',
            amount: 185000000,
            currency: 'NGN',
            customer: { email: 'c.nwosu@lekkifleet.ng', phone: '+2348034192810' },
            gateway_response: 'Insufficient Funds on Corporate Zenith Visa Card (*4921)',
          },
        },
      },
      {
        businessId,
        provider: 'PAYSTACK',
        providerEventId: `evt_pstk_${businessId.slice(0, 6)}_002`,
        eventType: 'charge.success',
        signature: '3c4b77a9102e4f8812d00491a7723bc99102e4a8120c3b91...',
        signatureValid: true,
        processed: true,
        processedAt: hoursAgo(12),
        payload: {
          event: 'charge.success',
          data: {
            reference: 'ref_pstk_medcore_4410',
            amount: 125000000,
            currency: 'NGN',
            customer: { email: 'abello@medcorediagnostics.com.ng' },
            status: 'success',
          },
        },
      },
      {
        businessId,
        provider: 'FLUTTERWAVE',
        providerEventId: `evt_flw_${businessId.slice(0, 6)}_003`,
        eventType: 'charge.failed',
        signature: 'K8mN2pQ9vX1zL4rT7wY0bC3dF6gH9jK2lM5nP8qR1s=',
        signatureValid: true,
        processed: true,
        processedAt: hoursAgo(27),
        payload: {
          event: 'charge.failed',
          data: {
            tx_ref: 'flw_ref_yaba_3109',
            amount: 950000,
            currency: 'NGN',
            customer: { email: 'tunde@yabacloud.io', phone_number: '+2348128837104' },
            processor_response: 'Do Not Honor — Bank 3DS Token Expired',
          },
        },
      },
    ]);
  } catch (error) {
    console.error('Error seeding initial tenant data:', error);
  }
}

export async function getFullDashboardSnapshot(businessId: string) {
  try {
    const [business] = await db
      .select()
      .from(businesses)
      .where(eq(businesses.id, businessId));

    const customerList = await db
      .select()
      .from(customers)
      .where(eq(customers.businessId, businessId))
      .orderBy(desc(customers.createdAt));

    const subscriptionList = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.businessId, businessId))
      .orderBy(desc(subscriptions.createdAt));

    const failedPaymentList = await db
      .select()
      .from(failedPayments)
      .where(eq(failedPayments.businessId, businessId))
      .orderBy(desc(failedPayments.failedAt));

    const whatsappLogList = await db
      .select()
      .from(whatsappLogs)
      .where(eq(whatsappLogs.businessId, businessId))
      .orderBy(desc(whatsappLogs.scheduledAt));

    const webhookEventList = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.businessId, businessId))
      .orderBy(desc(webhookEvents.createdAt));

    // Map customers and subscriptions by ID for rich joined view
    const customerMap = new Map(customerList.map((c) => [c.id, c]));
    const subscriptionMap = new Map(subscriptionList.map((s) => [s.id, s]));
    const failedPaymentMap = new Map(failedPaymentList.map((fp) => [fp.id, fp]));

    let totalFailedRevenue = 0;
    let totalRecoveredRevenue = 0;
    let pendingRecoveryRevenue = 0;
    let recoveredCount = 0;
    let activeCampaignsCount = 0;
    const customersWithFailedSet = new Set<string>();

    for (const fp of failedPaymentList) {
      const amt = parseFloat(fp.amount || '0');
      totalFailedRevenue += amt;
      if (fp.status === 'RECOVERED') {
        totalRecoveredRevenue += amt;
        recoveredCount += 1;
      } else if (fp.status === 'PENDING') {
        pendingRecoveryRevenue += amt;
        customersWithFailedSet.add(fp.customerId);
      }
      if (fp.recoveryStatus === 'ACTIVE' && fp.status === 'PENDING') {
        activeCampaignsCount += 1;
      }
    }

    const totalFailedCount = failedPaymentList.length;
    const recoveryRate =
      totalFailedCount > 0
        ? Number(((recoveredCount / totalFailedCount) * 100).toFixed(2))
        : 0;

    const revenueRecoveryRate =
      totalFailedRevenue > 0
        ? Number(((totalRecoveredRevenue / totalFailedRevenue) * 100).toFixed(2))
        : 0;

    const enrichedFailedPayments = failedPaymentList.map((fp) => {
      const customer = customerMap.get(fp.customerId);
      const subscription = fp.subscriptionId
        ? subscriptionMap.get(fp.subscriptionId)
        : undefined;
      const logs = whatsappLogList
        .filter((l) => l.failedPaymentId === fp.id)
        .sort((a, b) => a.sequenceStep - b.sequenceStep);
      return {
        ...fp,
        amountNumber: parseFloat(fp.amount || '0'),
        customerName: customer?.name || 'Unknown Customer',
        customerEmail: customer?.email || '',
        customerPhone: customer?.phone || '',
        whatsappOptIn: customer?.whatsappOptIn ?? false,
        planName: subscription?.planName || 'Recurring Subscription',
        providerSubscriptionId: subscription?.providerSubscriptionId || '',
        sequenceLogs: logs,
      };
    });

    const enrichedSubscriptions = subscriptionList.map((sub) => {
      const customer = customerMap.get(sub.customerId);
      return {
        ...sub,
        amountNumber: parseFloat(sub.amount || '0'),
        customerName: customer?.name || 'Unknown Customer',
        customerEmail: customer?.email || '',
        customerPhone: customer?.phone || '',
      };
    });

    const enrichedWhatsappLogs = whatsappLogList.map((log) => {
      const customer = customerMap.get(log.customerId);
      const fp = log.failedPaymentId ? failedPaymentMap.get(log.failedPaymentId) : undefined;
      return {
        ...log,
        customerName: customer?.name || 'Unknown Customer',
        paymentReference: fp?.providerReference || '',
        paymentAmount: fp ? parseFloat(fp.amount || '0') : 0,
        paymentStatus: fp?.status || 'PENDING',
      };
    });

    return {
      business,
      metrics: {
        totalFailedRevenue,
        totalRecoveredRevenue,
        pendingRecoveryRevenue,
        recoveryRate,
        revenueRecoveryRate,
        totalFailedCount,
        recoveredCount,
        activeCampaignsCount,
        customersWithFailedCount: customersWithFailedSet.size,
      },
      customers: customerList,
      subscriptions: enrichedSubscriptions,
      failedPayments: enrichedFailedPayments,
      whatsappLogs: enrichedWhatsappLogs,
      webhookEvents: webhookEventList,
    };
  } catch (error) {
    console.error('Database query failed in getFullDashboardSnapshot:', error);
    throw new Error('Failed to load dashboard data.', { cause: error });
  }
}

export async function updateBusinessSettings(
  businessId: string,
  updates: {
    name?: string;
    phone?: string;
    paystackEnabled?: boolean;
    flutterwaveEnabled?: boolean;
    whatsappProvider?: string;
    whatsappTemplateImmediate?: string;
    whatsappTemplate24h?: string;
    whatsappTemplate72h?: string;
    retryLinkExpiryHours?: number;
  }
) {
  try {
    const [updated] = await db
      .update(businesses)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(businesses.id, businessId))
      .returning();
    return updated;
  } catch (error) {
    console.error('Database query failed in updateBusinessSettings:', error);
    throw new Error('Failed to update business settings.', { cause: error });
  }
}

export async function toggleCustomerOptIn(
  businessId: string,
  customerId: string,
  whatsappOptIn: boolean
) {
  try {
    const [updated] = await db
      .update(customers)
      .set({ whatsappOptIn, updatedAt: new Date() })
      .where(and(eq(customers.id, customerId), eq(customers.businessId, businessId)))
      .returning();
    return updated;
  } catch (error) {
    console.error('Database query failed in toggleCustomerOptIn:', error);
    throw new Error('Failed to update customer WhatsApp opt-in status.', {
      cause: error,
    });
  }
}
