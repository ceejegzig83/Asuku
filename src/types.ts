export type PaymentProvider = 'PAYSTACK' | 'FLUTTERWAVE';
export type SubscriptionStatus = 'ACTIVE' | 'PAST_DUE' | 'CANCELLED' | 'EXPIRED' | 'RECOVERED';
export type FailedPaymentStatus = 'PENDING' | 'RECOVERED' | 'EXPIRED' | 'CANCELLED';
export type RecoveryStatus = 'ACTIVE' | 'RECOVERED' | 'STOPPED' | 'EXPIRED';
export type MessageStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'CANCELLED';

export interface Business {
  id: string;
  ownerUid: string;
  name: string;
  email: string;
  phone: string | null;
  currency: string;
  timezone: string;
  paystackEnabled: boolean;
  flutterwaveEnabled: boolean;
  whatsappProvider: 'META' | 'TERMII';
  whatsappTemplateImmediate: string;
  whatsappTemplate24h: string;
  whatsappTemplate72h: string;
  retryLinkExpiryHours: number;
  createdAt: string;
  updatedAt: string;
}

export interface Customer {
  id: string;
  businessId: string;
  externalCustomerId: string | null;
  name: string;
  email: string | null;
  phone: string;
  whatsappOptIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionItem {
  id: string;
  businessId: string;
  customerId: string;
  provider: PaymentProvider;
  providerSubscriptionId: string;
  planName: string;
  amount: string;
  amountNumber: number;
  currency: string;
  status: SubscriptionStatus;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
}

export interface WhatsAppLogItem {
  id: string;
  businessId: string;
  customerId: string;
  failedPaymentId: string | null;
  provider: string;
  templateName: string;
  sequenceStep: number;
  status: MessageStatus;
  providerMessageId: string | null;
  phoneNumber: string;
  messagePayload: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  scheduledAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  customerName?: string;
  paymentReference?: string;
  paymentAmount?: number;
  paymentStatus?: FailedPaymentStatus;
}

export interface FailedPaymentItem {
  id: string;
  businessId: string;
  customerId: string;
  subscriptionId: string | null;
  provider: PaymentProvider;
  providerTransactionId: string | null;
  providerReference: string | null;
  amount: string;
  amountNumber: number;
  currency: string;
  failureReason: string | null;
  status: FailedPaymentStatus;
  recoveryStatus: RecoveryStatus;
  recoveryToken: string | null;
  failedAt: string;
  recoveredAt: string | null;
  expiresAt: string | null;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  whatsappOptIn: boolean;
  planName: string;
  providerSubscriptionId: string;
  sequenceLogs: WhatsAppLogItem[];
}

export interface WebhookEventItem {
  id: string;
  businessId: string | null;
  provider: PaymentProvider;
  providerEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  signature: string | null;
  signatureValid: boolean;
  processed: boolean;
  processedAt: string | null;
  createdAt: string;
}

export interface DashboardMetrics {
  totalFailedRevenue: number;
  totalRecoveredRevenue: number;
  pendingRecoveryRevenue: number;
  recoveryRate: number;
  revenueRecoveryRate: number;
  totalFailedCount: number;
  recoveredCount: number;
  activeCampaignsCount: number;
  customersWithFailedCount: number;
}

export interface DashboardSnapshot {
  business: Business;
  metrics: DashboardMetrics;
  customers: Customer[];
  subscriptions: SubscriptionItem[];
  failedPayments: FailedPaymentItem[];
  whatsappLogs: WhatsAppLogItem[];
  webhookEvents: WebhookEventItem[];
}
