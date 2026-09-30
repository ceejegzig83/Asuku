import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const paymentProviderEnum = pgEnum('payment_provider', [
  'PAYSTACK',
  'FLUTTERWAVE',
]);

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'ACTIVE',
  'PAST_DUE',
  'CANCELLED',
  'EXPIRED',
  'RECOVERED',
]);

export const failedPaymentStatusEnum = pgEnum('failed_payment_status', [
  'PENDING',
  'RECOVERED',
  'EXPIRED',
  'CANCELLED',
]);

export const recoveryStatusEnum = pgEnum('recovery_status', [
  'ACTIVE',
  'RECOVERED',
  'STOPPED',
  'EXPIRED',
]);

export const messageStatusEnum = pgEnum('message_status', [
  'QUEUED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'NOT_CONFIGURED',
  'CANCELLED',
]);

// Users table linked to Firebase Auth UID
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  name: text('name'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// 2.2 Businesses table (Multi-tenant isolation root + tenant webhook token)
export const businesses = pgTable(
  'businesses',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerUid: text('owner_uid').notNull(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    phone: text('phone'),
    currency: text('currency').notNull().default('NGN'),
    timezone: text('timezone').notNull().default('Africa/Lagos'),
    webhookToken: text('webhook_token'),
    paystackEnabled: boolean('paystack_enabled').notNull().default(true),
    flutterwaveEnabled: boolean('flutterwave_enabled').notNull().default(true),
    whatsappProvider: text('whatsapp_provider').notNull().default('META'),
    whatsappTemplateImmediate: text('whatsapp_template_immediate')
      .notNull()
      .default('payment_failed_recovery'),
    whatsappTemplate24h: text('whatsapp_template_24h')
      .notNull()
      .default('payment_reminder_24h'),
    whatsappTemplate72h: text('whatsapp_template_72h')
      .notNull()
      .default('payment_final_notice_72h'),
    retryLinkExpiryHours: integer('retry_link_expiry_hours').notNull().default(168),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_businesses_email').on(table.email),
    index('idx_businesses_owner').on(table.ownerUid),
    index('idx_businesses_webhook_token').on(table.webhookToken),
  ]
);

// 2.3 Customers table (with explicit WhatsApp opt-in governance audit timestamp)
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    externalCustomerId: text('external_customer_id'),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone').notNull(),
    whatsappOptIn: boolean('whatsapp_opt_in').notNull().default(false),
    whatsappOptInUpdatedAt: timestamp('whatsapp_opt_in_updated_at', {
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_customers_business').on(table.businessId),
    index('idx_customers_phone').on(table.businessId, table.phone),
    index('idx_customers_email').on(table.businessId, table.email),
  ]
);

// 2.4 Subscriptions table
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    provider: paymentProviderEnum('provider').notNull(),
    providerSubscriptionId: text('provider_subscription_id').notNull(),
    planName: text('plan_name').notNull(),
    amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('NGN'),
    status: subscriptionStatusEnum('status').notNull().default('ACTIVE'),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_subscriptions_customer').on(table.customerId),
    index('idx_subscriptions_status').on(table.businessId, table.status),
    uniqueIndex('uq_subscriptions_provider_id').on(
      table.provider,
      table.providerSubscriptionId
    ),
  ]
);

// 2.5 Failed payments table (Stores ONLY SHA-256 recovery_token_hash; plaintext recovery_token is never persisted)
export const failedPayments = pgTable(
  'failed_payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, {
      onDelete: 'set null',
    }),
    provider: paymentProviderEnum('provider').notNull(),
    providerTransactionId: text('provider_transaction_id'),
    providerReference: text('provider_reference'),
    amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
    currency: text('currency').notNull().default('NGN'),
    failureReason: text('failure_reason'),
    status: failedPaymentStatusEnum('status').notNull().default('PENDING'),
    recoveryStatus: recoveryStatusEnum('recovery_status').notNull().default('ACTIVE'),
    recoveryToken: text('recovery_token').unique(),
    recoveryTokenHash: text('recovery_token_hash'),
    recoveryTokenUsedAt: timestamp('recovery_token_used_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }).defaultNow().notNull(),
    recoveredAt: timestamp('recovered_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_failed_payments_business_status').on(table.businessId, table.status),
    index('idx_failed_payments_customer').on(table.customerId),
    index('idx_failed_payments_subscription').on(table.subscriptionId),
    index('idx_failed_payments_reference').on(table.provider, table.providerReference),
    index('idx_failed_payments_token_hash').on(table.recoveryTokenHash),
  ]
);

// 2.6 WhatsApp logs table (with unique index on failed_payment_id + sequence_step)
export const whatsappLogs = pgTable(
  'whatsapp_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    failedPaymentId: uuid('failed_payment_id').references(() => failedPayments.id, {
      onDelete: 'set null',
    }),
    provider: text('provider').notNull(),
    templateName: text('template_name').notNull(),
    sequenceStep: integer('sequence_step').notNull(),
    status: messageStatusEnum('status').notNull().default('QUEUED'),
    providerMessageId: text('provider_message_id'),
    phoneNumber: text('phone_number').notNull(),
    messagePayload: jsonb('message_payload'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_whatsapp_logs_customer').on(table.customerId),
    index('idx_whatsapp_logs_failed_payment').on(table.failedPaymentId),
    index('idx_whatsapp_logs_scheduled').on(table.status, table.scheduledAt),
    uniqueIndex('uq_whatsapp_sequence').on(table.failedPaymentId, table.sequenceStep),
  ]
);

// 2.7 Webhook events table (first line of defense against duplicate webhooks)
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').references(() => businesses.id, {
      onDelete: 'cascade',
    }),
    provider: paymentProviderEnum('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    signature: text('signature'),
    signatureValid: boolean('signature_valid').notNull().default(true),
    processed: boolean('processed').notNull().default(false),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_webhook_events_processed').on(table.processed),
    uniqueIndex('uq_webhook_provider_event').on(table.provider, table.providerEventId),
  ]
);

// Relations
export const businessesRelations = relations(businesses, ({ many }) => ({
  customers: many(customers),
  subscriptions: many(subscriptions),
  failedPayments: many(failedPayments),
  whatsappLogs: many(whatsappLogs),
  webhookEvents: many(webhookEvents),
}));

export const customersRelations = relations(customers, ({ one, many }) => ({
  business: one(businesses, {
    fields: [customers.businessId],
    references: [businesses.id],
  }),
  subscriptions: many(subscriptions),
  failedPayments: many(failedPayments),
  whatsappLogs: many(whatsappLogs),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one, many }) => ({
  business: one(businesses, {
    fields: [subscriptions.businessId],
    references: [businesses.id],
  }),
  customer: one(customers, {
    fields: [subscriptions.customerId],
    references: [customers.id],
  }),
  failedPayments: many(failedPayments),
}));

export const failedPaymentsRelations = relations(failedPayments, ({ one, many }) => ({
  business: one(businesses, {
    fields: [failedPayments.businessId],
    references: [businesses.id],
  }),
  customer: one(customers, {
    fields: [failedPayments.customerId],
    references: [customers.id],
  }),
  subscription: one(subscriptions, {
    fields: [failedPayments.subscriptionId],
    references: [subscriptions.id],
  }),
  whatsappLogs: many(whatsappLogs),
}));

export const whatsappLogsRelations = relations(whatsappLogs, ({ one }) => ({
  business: one(businesses, {
    fields: [whatsappLogs.businessId],
    references: [businesses.id],
  }),
  customer: one(customers, {
    fields: [whatsappLogs.customerId],
    references: [customers.id],
  }),
  failedPayment: one(failedPayments, {
    fields: [whatsappLogs.failedPaymentId],
    references: [failedPayments.id],
  }),
}));
