import crypto from 'crypto';

export type PaymentProviderName = 'PAYSTACK' | 'FLUTTERWAVE';
export type InternalPaymentEvent =
  | 'PAYMENT_FAILED'
  | 'PAYMENT_SUCCESS'
  | 'SUBSCRIPTION_DISABLED'
  | 'SUBSCRIPTION_CANCELLED';

export interface WhatsAppTemplateParams {
  phoneNumber: string;
  templateName: string;
  language: string;
  variables: {
    customer_name: string;
    business_name: string;
    amount: string;
    currency: string;
    payment_link: string;
    subscription_name: string;
    recovery_token: string;
  };
}

export interface WhatsAppSendResult {
  provider: 'META' | 'TERMII';
  status: 'SENT' | 'DELIVERED' | 'FAILED' | 'NOT_CONFIGURED';
  providerMessageId: string | null;
  timestamp: string;
  normalizedPhone: string;
  requestPayload: Record<string, unknown>;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface WhatsAppProvider {
  sendTemplate(params: WhatsAppTemplateParams): Promise<WhatsAppSendResult>;
  sendMessage(params: WhatsAppTemplateParams): Promise<WhatsAppSendResult>;
}

export type FetchLike = typeof fetch;

export type NormalizedPaymentStatus =
  | 'SUCCESS'
  | 'PENDING'
  | 'FAILED'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface InitializePaymentInput {
  businessId: string;
  failedPaymentId: string;
  customerId: string;
  subscriptionId?: string | null;
  provider: PaymentProviderName;
  reference: string;
  amountNaira: number;
  currency: string;
  customerEmail: string;
  customerName?: string;
  customerPhone?: string;
  callbackUrl?: string;
}

export interface PaymentInitializationResult {
  initialized: boolean;
  status: 'INITIALIZED' | 'NOT_CONFIGURED' | 'FAILED';
  provider: PaymentProviderName;
  reference: string;
  amountMinor: number;
  amountNaira: number;
  currency: string;
  authorizationUrl: string | null;
  accessCode?: string | null;
  errorCode?: string;
  errorMessage?: string;
}

export interface VerifyPaymentInput {
  reference: string;
  expectedAmountNaira: number;
  expectedCurrency: string;
}

export interface GetTransactionInput {
  reference: string;
  expectedAmountNaira?: number;
  expectedCurrency?: string;
}

export interface VerifiedTransactionResult {
  verified: boolean;
  status: 'VERIFIED' | 'NOT_CONFIGURED' | 'FAILED' | 'MISMATCH';
  normalizedStatus?: NormalizedPaymentStatus;
  provider?: PaymentProviderName;
  reference?: string;
  providerTransactionId?: string;
  amountMinor?: number;
  amountNaira?: number;
  currency?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface PaymentProvider {
  readonly providerName: PaymentProviderName;
  initializePayment(
    input: InitializePaymentInput
  ): Promise<PaymentInitializationResult>;
  verifyPayment(input: VerifyPaymentInput): Promise<VerifiedTransactionResult>;
  getTransaction(input: GetTransactionInput): Promise<VerifiedTransactionResult>;
}

/**
 * Monetary Unit Conversion Helpers:
 * - Database stores NGN in major units as NUMERIC(18,2) (e.g. "250000.00" = ₦250,000.00).
 * - Paystack API requires integer minor units (kobo: ₦250,000.00 = 25000000).
 * - Flutterwave API requires major units (Naira: ₦250,000.00 = 250000), which we also convert
 *   to integer minor units (kobo) for exact comparison without floating-point drift.
 */
export function nairaToKoboMinor(amountNaira: number | string): number {
  const num = Number(amountNaira);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100);
}

export function koboMinorToNaira(amountMinor: number): number {
  if (!Number.isFinite(amountMinor)) return 0;
  return Number((amountMinor / 100).toFixed(2));
}

/**
 * PHASE 1 SECURITY HARDENING — OBJECTIVE 1:
 * Development mock providers must NEVER activate automatically.
 * Production strictly requires ASUKU_MOCK_PROVIDERS=false.
 * Even if ASUKU_MOCK_PROVIDERS=true is set, it is ignored when NODE_ENV === 'production'.
 */
export function isMockProvidersEnabled(): boolean {
  if (
    process.env.NODE_ENV === 'production' ||
    process.env.ASUKU_ENV === 'production'
  ) {
    return false;
  }
  return process.env.ASUKU_MOCK_PROVIDERS === 'true';
}

export function isConfiguredSecret(val?: string): boolean {
  if (!val) return false;
  const trimmed = val.trim();
  if (!trimmed) return false;
  if (
    trimmed.startsWith('your_') ||
    trimmed.startsWith('MY_') ||
    trimmed === 'sk_test_your_paystack_secret_key' ||
    trimmed === 'pk_test_your_paystack_public_key' ||
    trimmed === 'FLWSECK_TEST-your_flutterwave_secret_key' ||
    trimmed === 'FLWPUBK_TEST-your_flutterwave_public_key'
  ) {
    return false;
  }
  return true;
}

export function getPaystackKeyMode(
  secretKey?: string
): 'TEST' | 'LIVE' | 'NOT_CONFIGURED' {
  if (!isConfiguredSecret(secretKey)) return 'NOT_CONFIGURED';
  const trimmed = secretKey!.trim();
  if (trimmed.startsWith('sk_live_')) return 'LIVE';
  return 'TEST';
}

export function isSandboxEnvironment(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.ASUKU_ENV !== 'production'
  );
}

export function getFlutterwaveSecretKey(): string | undefined {
  if (isConfiguredSecret(process.env.FLW_SECRET_KEY)) {
    return process.env.FLW_SECRET_KEY!.trim();
  }
  if (isConfiguredSecret(process.env.FLUTTERWAVE_SECRET_KEY)) {
    return process.env.FLUTTERWAVE_SECRET_KEY!.trim();
  }
  return undefined;
}

export function getFlutterwaveSecretHash(): string | undefined {
  if (isConfiguredSecret(process.env.FLW_SECRET_HASH)) {
    return process.env.FLW_SECRET_HASH!.trim();
  }
  if (isConfiguredSecret(process.env.FLUTTERWAVE_SECRET_HASH)) {
    return process.env.FLUTTERWAVE_SECRET_HASH!.trim();
  }
  return undefined;
}

export interface ProviderHealthStatus {
  provider: 'PAYSTACK' | 'FLUTTERWAVE' | 'META' | 'TERMII';
  category: 'PAYMENT' | 'WHATSAPP';
  status: 'CONFIGURED' | 'NOT_CONFIGURED';
  keyMode?: 'TEST' | 'LIVE' | 'NOT_CONFIGURED';
  webhookConfigured?: boolean;
}

export function getProvidersHealthReport() {
  const paystackConfigured = isConfiguredSecret(process.env.PAYSTACK_SECRET_KEY);
  const paystackKeyMode = getPaystackKeyMode(process.env.PAYSTACK_SECRET_KEY);
  const flwSecretConfigured = Boolean(getFlutterwaveSecretKey());
  const flwHashConfigured = Boolean(getFlutterwaveSecretHash());
  const metaConfigured =
    isConfiguredSecret(process.env.META_WHATSAPP_ACCESS_TOKEN) &&
    isConfiguredSecret(process.env.META_WHATSAPP_PHONE_NUMBER_ID);
  const termiiConfigured =
    isConfiguredSecret(process.env.TERMII_API_KEY) &&
    isConfiguredSecret(process.env.TERMII_DEVICE_ID);

  const providers: Record<string, ProviderHealthStatus> = {
    PAYSTACK: {
      provider: 'PAYSTACK',
      category: 'PAYMENT',
      status: paystackConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED',
      keyMode: paystackKeyMode,
      webhookConfigured: paystackConfigured,
    },
    FLUTTERWAVE: {
      provider: 'FLUTTERWAVE',
      category: 'PAYMENT',
      status:
        flwSecretConfigured && flwHashConfigured
          ? 'CONFIGURED'
          : 'NOT_CONFIGURED',
      webhookConfigured: flwHashConfigured,
    },
    META: {
      provider: 'META',
      category: 'WHATSAPP',
      status: metaConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED',
    },
    TERMII: {
      provider: 'TERMII',
      category: 'WHATSAPP',
      status: termiiConfigured ? 'CONFIGURED' : 'NOT_CONFIGURED',
    },
  };

  return {
    environment:
      process.env.ASUKU_ENV || process.env.NODE_ENV || 'development',
    mockProvidersEnabled: isMockProvidersEnabled(),
    providers,
  };
}

/**
 * Normalizes Nigerian phone numbers into strict E.164 format (+234XXXXXXXXXX)
 */
export function normalizeNigerianPhone(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+234')) return digits;
  if (digits.startsWith('234')) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 11) {
    return `+234${digits.slice(1)}`;
  }
  return digits.startsWith('+') ? digits : `+234${digits}`;
}

/**
 * Constant-time SHA-256 hash helper for recovery tokens
 */
export function hashRecoveryToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * 1.2 Paystack Webhook HMAC-SHA512 raw-body signature verification
 */
export function verifyPaystackSignature(
  rawBody: Buffer,
  signature: string,
  explicitSecret?: string
): boolean {
  if (!signature) return false;
  const envSecret = isConfiguredSecret(process.env.PAYSTACK_SECRET_KEY)
    ? process.env.PAYSTACK_SECRET_KEY!
    : undefined;
  const secret = explicitSecret || envSecret;

  if (!secret) {
    return false;
  }

  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const sigBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== sigBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, sigBuf);
}

/**
 * 1.3 Flutterwave Webhook HMAC-SHA256 / verif-hash verification
 */
export function verifyFlutterwaveSignature(
  rawBody: Buffer,
  signature: string,
  explicitSecretHash?: string
): boolean {
  if (!signature) return false;
  const envSecret = getFlutterwaveSecretHash();
  const secret = explicitSecretHash || envSecret;

  if (!secret) {
    return false;
  }

  // Check HMAC-SHA256 base64 (flutterwave-signature)
  const expectedHmac = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');

  const hmacBuf = Buffer.from(expectedHmac, 'utf8');
  const sigBuf = Buffer.from(signature, 'utf8');
  if (hmacBuf.length === sigBuf.length && crypto.timingSafeEqual(hmacBuf, sigBuf)) {
    return true;
  }

  // Check direct secret-hash equality (verif-hash header)
  const directBuf = Buffer.from(secret, 'utf8');
  if (directBuf.length === sigBuf.length && crypto.timingSafeEqual(directBuf, sigBuf)) {
    return true;
  }

  return false;
}

/**
 * Helper to sign webhook payloads using a provided or configured secret
 */
export function signWebhookPayload(
  provider: PaymentProviderName,
  rawBody: Buffer,
  secretOverride?: string
): string {
  if (provider === 'PAYSTACK') {
    const secret =
      secretOverride ||
      (isConfiguredSecret(process.env.PAYSTACK_SECRET_KEY)
        ? process.env.PAYSTACK_SECRET_KEY!
        : 'sk_test_sandbox_hmac_verifier_key');
    return crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  } else {
    const secret =
      secretOverride ||
      getFlutterwaveSecretHash() ||
      'flw_test_sandbox_hmac_verifier_hash';
    return crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  }
}

/**
 * Normalizes Paystack and Flutterwave event names to internal event taxonomy
 */
export function normalizeWebhookEventType(
  _provider: PaymentProviderName,
  rawEvent: string
): InternalPaymentEvent {
  const lower = rawEvent.toLowerCase();
  if (
    lower.includes('failed') ||
    lower === 'invoice.payment_failed' ||
    lower === 'charge.failed'
  ) {
    return 'PAYMENT_FAILED';
  }
  if (
    lower.includes('success') ||
    lower === 'charge.success' ||
    lower === 'charge.completed'
  ) {
    return 'PAYMENT_SUCCESS';
  }
  if (lower.includes('disable')) {
    return 'SUBSCRIPTION_DISABLED';
  }
  return 'SUBSCRIPTION_CANCELLED';
}

function normalizeProviderPaymentStatus(
  rawStatus?: string
): NormalizedPaymentStatus {
  if (!rawStatus) return 'UNKNOWN';
  const lower = rawStatus.trim().toLowerCase();
  if (lower === 'success' || lower === 'successful' || lower === 'completed') {
    return 'SUCCESS';
  }
  if (
    lower === 'pending' ||
    lower === 'ongoing' ||
    lower === 'processing' ||
    lower === 'queued'
  ) {
    return 'PENDING';
  }
  if (lower === 'abandoned' || lower === 'cancelled' || lower === 'canceled') {
    return 'CANCELLED';
  }
  if (lower === 'failed' || lower === 'reversed' || lower === 'declined') {
    return 'FAILED';
  }
  return 'UNKNOWN';
}

/**
 * PHASE 2B: Paystack Payment Provider Adapter
 * Implements initializePayment, verifyPayment, and getTransaction via server-side Paystack API.
 * Uses integer minor units (kobo) for Paystack API calls and never exposes PAYSTACK_SECRET_KEY.
 */
export class PaystackPaymentProvider implements PaymentProvider {
  readonly providerName = 'PAYSTACK' as const;
  private readonly fetchFn: FetchLike;

  constructor(fetchFn: FetchLike = fetch) {
    this.fetchFn = fetchFn;
  }

  async initializePayment(
    input: InitializePaymentInput
  ): Promise<PaymentInitializationResult> {
    const amountMinor = nairaToKoboMinor(input.amountNaira);
    const amountNaira = koboMinorToNaira(amountMinor);
    const currency = (input.currency || 'NGN').toUpperCase();
    const reference = input.reference.trim();
    const secretKey = process.env.PAYSTACK_SECRET_KEY;

    if (!isConfiguredSecret(secretKey)) {
      if (isMockProvidersEnabled()) {
        return {
          initialized: true,
          status: 'INITIALIZED',
          provider: 'PAYSTACK',
          reference,
          amountMinor,
          amountNaira,
          currency,
          authorizationUrl: `https://checkout.paystack.com/mock_${encodeURIComponent(reference)}`,
          accessCode: `mock_access_${reference}`,
        };
      }
      return {
        initialized: false,
        status: 'NOT_CONFIGURED',
        provider: 'PAYSTACK',
        reference,
        amountMinor,
        amountNaira,
        currency,
        authorizationUrl: null,
        errorCode: 'PAYSTACK_NOT_CONFIGURED',
        errorMessage:
          'Paystack secret key (PAYSTACK_SECRET_KEY) is not configured. Cannot initialize Paystack checkout.',
      };
    }

    if (getPaystackKeyMode(secretKey) === 'LIVE' && isSandboxEnvironment()) {
      return {
        initialized: false,
        status: 'FAILED',
        provider: 'PAYSTACK',
        reference,
        amountMinor,
        amountNaira,
        currency,
        authorizationUrl: null,
        errorCode: 'PAYSTACK_LIVE_KEY_FORBIDDEN_IN_SANDBOX',
        errorMessage:
          'Paystack live secret key (sk_live_*) is forbidden in development/sandbox mode. Use a Paystack test secret key (sk_test_*).',
      };
    }

    try {
      const res = await this.fetchFn(
        'https://api.paystack.co/transaction/initialize',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${secretKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email: input.customerEmail,
            amount: amountMinor, // Paystack requires kobo integer minor units
            currency,
            reference,
            callback_url: input.callbackUrl,
            metadata: {
              businessId: input.businessId,
              failedPaymentId: input.failedPaymentId,
              customerId: input.customerId,
              subscriptionId: input.subscriptionId || null,
            },
          }),
        }
      );

      const data = (await res.json().catch(() => ({}))) as {
        status?: boolean;
        message?: string;
        data?: {
          authorization_url?: string;
          access_code?: string;
          reference?: string;
        };
      };

      if (!res.ok || !data.status || !data.data?.authorization_url) {
        return {
          initialized: false,
          status: 'FAILED',
          provider: 'PAYSTACK',
          reference,
          amountMinor,
          amountNaira,
          currency,
          authorizationUrl: null,
          errorCode: `PAYSTACK_INIT_HTTP_${res.status}`,
          errorMessage:
            data.message ||
            `Paystack initialization failed with HTTP ${res.status}.`,
        };
      }

      return {
        initialized: true,
        status: 'INITIALIZED',
        provider: 'PAYSTACK',
        reference: data.data.reference || reference,
        amountMinor,
        amountNaira,
        currency,
        authorizationUrl: data.data.authorization_url,
        accessCode: data.data.access_code || null,
      };
    } catch (err: unknown) {
      return {
        initialized: false,
        status: 'FAILED',
        provider: 'PAYSTACK',
        reference,
        amountMinor,
        amountNaira,
        currency,
        authorizationUrl: null,
        errorCode: 'PAYSTACK_NETWORK_ERROR',
        errorMessage:
          err instanceof Error
            ? err.message
            : 'Network error initializing Paystack payment.',
      };
    }
  }

  async verifyPayment(
    input: VerifyPaymentInput
  ): Promise<VerifiedTransactionResult> {
    const reference = input.reference.trim();
    const expectedCurrency = (input.expectedCurrency || 'NGN').toUpperCase();
    const expectedMinor = nairaToKoboMinor(input.expectedAmountNaira);
    const expectedNaira = koboMinorToNaira(expectedMinor);
    const secretKey = process.env.PAYSTACK_SECRET_KEY;

    if (!isConfiguredSecret(secretKey)) {
      if (isMockProvidersEnabled()) {
        return {
          verified: true,
          status: 'VERIFIED',
          normalizedStatus: 'SUCCESS',
          provider: 'PAYSTACK',
          reference,
          providerTransactionId: `mock_pstk_tx_${reference}`,
          amountMinor: expectedMinor,
          amountNaira: expectedNaira,
          currency: expectedCurrency,
        };
      }
      return {
        verified: false,
        status: 'NOT_CONFIGURED',
        normalizedStatus: 'UNKNOWN',
        provider: 'PAYSTACK',
        reference,
        errorCode: 'PAYSTACK_NOT_CONFIGURED',
        errorMessage:
          'Paystack secret key (PAYSTACK_SECRET_KEY) is not configured. Cannot verify transaction with Paystack API.',
      };
    }

    if (getPaystackKeyMode(secretKey) === 'LIVE' && isSandboxEnvironment()) {
      return {
        verified: false,
        status: 'FAILED',
        normalizedStatus: 'UNKNOWN',
        provider: 'PAYSTACK',
        reference,
        errorCode: 'PAYSTACK_LIVE_KEY_FORBIDDEN_IN_SANDBOX',
        errorMessage:
          'Paystack live secret key (sk_live_*) is forbidden in development/sandbox mode. Use a Paystack test secret key (sk_test_*).',
      };
    }

    try {
      const res = await this.fetchFn(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${secretKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const data = (await res.json().catch(() => null)) as {
        status?: boolean;
        message?: string;
        data?: {
          id?: number | string;
          status?: string;
          amount?: number;
          currency?: string;
          reference?: string;
        };
      } | null;

      if (!data || typeof data !== 'object') {
        return {
          verified: false,
          status: 'FAILED',
          normalizedStatus: 'UNKNOWN',
          provider: 'PAYSTACK',
          reference,
          errorCode: 'PAYSTACK_INVALID_RESPONSE',
          errorMessage: 'Invalid or non-JSON response from Paystack API.',
        };
      }

      const normalizedStatus = normalizeProviderPaymentStatus(data.data?.status);

      if (!res.ok || !data.status || !data.data) {
        return {
          verified: false,
          status: 'FAILED',
          normalizedStatus,
          provider: 'PAYSTACK',
          reference,
          errorCode: `PAYSTACK_HTTP_${res.status}`,
          errorMessage:
            data.message ||
            `Paystack verification failed with HTTP ${res.status}`,
        };
      }

      // Enforce exact reference matching if provider returned a reference
      if (data.data.reference && data.data.reference.trim() !== reference) {
        return {
          verified: false,
          status: 'MISMATCH',
          normalizedStatus,
          provider: 'PAYSTACK',
          reference: data.data.reference,
          errorCode: 'REFERENCE_MISMATCH',
          errorMessage: `Paystack returned reference '${data.data.reference}' which does not match expected '${reference}'.`,
        };
      }

      if (normalizedStatus !== 'SUCCESS') {
        return {
          verified: false,
          status: 'FAILED',
          normalizedStatus,
          provider: 'PAYSTACK',
          reference,
          errorCode: `PAYSTACK_STATUS_${normalizedStatus}`,
          errorMessage:
            data.message ||
            `Paystack transaction status is '${data.data.status || 'unverified'}'`,
        };
      }

      const paidMinor = Math.round(Number(data.data.amount || 0));
      const paidNaira = koboMinorToNaira(paidMinor);
      const paidCurrency = (data.data.currency || '').toUpperCase();

      if (paidCurrency !== expectedCurrency) {
        return {
          verified: false,
          status: 'MISMATCH',
          normalizedStatus,
          provider: 'PAYSTACK',
          reference,
          amountMinor: paidMinor,
          amountNaira: paidNaira,
          currency: paidCurrency,
          errorCode: 'AMOUNT_OR_CURRENCY_MISMATCH',
          errorMessage: `Verified transaction currency (${paidCurrency}) does not match required (${expectedCurrency}).`,
        };
      }

      if (paidMinor < expectedMinor) {
        return {
          verified: false,
          status: 'MISMATCH',
          normalizedStatus,
          provider: 'PAYSTACK',
          reference,
          amountMinor: paidMinor,
          amountNaira: paidNaira,
          currency: paidCurrency,
          errorCode: 'AMOUNT_OR_CURRENCY_MISMATCH',
          errorMessage: `Verified transaction (${paidCurrency} ${paidNaira}) does not match required (${expectedCurrency} ${expectedNaira}).`,
        };
      }

      return {
        verified: true,
        status: 'VERIFIED',
        normalizedStatus: 'SUCCESS',
        provider: 'PAYSTACK',
        reference,
        providerTransactionId: String(data.data.id || reference),
        amountMinor: paidMinor,
        amountNaira: paidNaira,
        currency: paidCurrency,
      };
    } catch (err: unknown) {
      return {
        verified: false,
        status: 'FAILED',
        normalizedStatus: 'UNKNOWN',
        provider: 'PAYSTACK',
        reference,
        errorCode: 'PAYSTACK_NETWORK_ERROR',
        errorMessage:
          err instanceof Error ? err.message : 'Failed to reach Paystack API',
      };
    }
  }

  async getTransaction(
    input: GetTransactionInput
  ): Promise<VerifiedTransactionResult> {
    return this.verifyPayment({
      reference: input.reference,
      expectedAmountNaira: input.expectedAmountNaira ?? 0,
      expectedCurrency: input.expectedCurrency ?? 'NGN',
    });
  }
}

/**
 * PHASE 2C: Flutterwave Payment Provider Adapter
 * Implements initializePayment, verifyPayment, and getTransaction via server-side Flutterwave v3 API.
 * Never exposes FLW_SECRET_KEY / FLUTTERWAVE_SECRET_KEY.
 */
export class FlutterwavePaymentProvider implements PaymentProvider {
  readonly providerName = 'FLUTTERWAVE' as const;
  private readonly fetchFn: FetchLike;

  constructor(fetchFn: FetchLike = fetch) {
    this.fetchFn = fetchFn;
  }

  async initializePayment(
    input: InitializePaymentInput
  ): Promise<PaymentInitializationResult> {
    const amountMinor = nairaToKoboMinor(input.amountNaira);
    const amountNaira = koboMinorToNaira(amountMinor);
    const currency = (input.currency || 'NGN').toUpperCase();
    const reference = input.reference.trim();
    const flwSecret = getFlutterwaveSecretKey();

    if (!flwSecret) {
      if (isMockProvidersEnabled()) {
        return {
          initialized: true,
          status: 'INITIALIZED',
          provider: 'FLUTTERWAVE',
          reference,
          amountMinor,
          amountNaira,
          currency,
          authorizationUrl: `https://checkout.flutterwave.com/v3/hosted/pay/mock_${encodeURIComponent(reference)}`,
        };
      }
      return {
        initialized: false,
        status: 'NOT_CONFIGURED',
        provider: 'FLUTTERWAVE',
        reference,
        amountMinor,
        amountNaira,
        currency,
        authorizationUrl: null,
        errorCode: 'FLUTTERWAVE_NOT_CONFIGURED',
        errorMessage:
          'Flutterwave secret key (FLW_SECRET_KEY / FLUTTERWAVE_SECRET_KEY) is not configured. Cannot initialize Flutterwave checkout.',
      };
    }

    try {
      const res = await this.fetchFn('https://api.flutterwave.com/v3/payments', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${flwSecret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tx_ref: reference,
          amount: amountNaira, // Flutterwave expects major units (Naira)
          currency,
          redirect_url: input.callbackUrl,
          customer: {
            email: input.customerEmail,
            name: input.customerName,
            phonenumber: input.customerPhone,
          },
          meta: {
            businessId: input.businessId,
            failedPaymentId: input.failedPaymentId,
            customerId: input.customerId,
            subscriptionId: input.subscriptionId || null,
          },
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        status?: string;
        message?: string;
        data?: {
          link?: string;
        };
      };

      if (!res.ok || data.status !== 'success' || !data.data?.link) {
        return {
          initialized: false,
          status: 'FAILED',
          provider: 'FLUTTERWAVE',
          reference,
          amountMinor,
          amountNaira,
          currency,
          authorizationUrl: null,
          errorCode: `FLW_INIT_HTTP_${res.status}`,
          errorMessage:
            data.message ||
            `Flutterwave initialization failed with HTTP ${res.status}.`,
        };
      }

      return {
        initialized: true,
        status: 'INITIALIZED',
        provider: 'FLUTTERWAVE',
        reference,
        amountMinor,
        amountNaira,
        currency,
        authorizationUrl: data.data.link,
      };
    } catch (err: unknown) {
      return {
        initialized: false,
        status: 'FAILED',
        provider: 'FLUTTERWAVE',
        reference,
        amountMinor,
        amountNaira,
        currency,
        authorizationUrl: null,
        errorCode: 'FLW_NETWORK_ERROR',
        errorMessage:
          err instanceof Error
            ? err.message
            : 'Network error initializing Flutterwave payment.',
      };
    }
  }

  async verifyPayment(
    input: VerifyPaymentInput
  ): Promise<VerifiedTransactionResult> {
    const reference = input.reference.trim();
    const expectedCurrency = (input.expectedCurrency || 'NGN').toUpperCase();
    const expectedMinor = nairaToKoboMinor(input.expectedAmountNaira);
    const expectedNaira = koboMinorToNaira(expectedMinor);
    const flwSecret = getFlutterwaveSecretKey();

    if (!flwSecret) {
      if (isMockProvidersEnabled()) {
        return {
          verified: true,
          status: 'VERIFIED',
          normalizedStatus: 'SUCCESS',
          provider: 'FLUTTERWAVE',
          reference,
          providerTransactionId: `mock_flw_tx_${reference}`,
          amountMinor: expectedMinor,
          amountNaira: expectedNaira,
          currency: expectedCurrency,
        };
      }
      return {
        verified: false,
        status: 'NOT_CONFIGURED',
        normalizedStatus: 'UNKNOWN',
        provider: 'FLUTTERWAVE',
        reference,
        errorCode: 'FLUTTERWAVE_NOT_CONFIGURED',
        errorMessage:
          'Flutterwave secret key (FLW_SECRET_KEY) is not configured. Cannot verify transaction with Flutterwave API.',
      };
    }

    try {
      const res = await this.fetchFn(
        `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(
          reference
        )}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${flwSecret}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const data = (await res.json().catch(() => null)) as {
        status?: string;
        message?: string;
        data?: {
          id?: number | string;
          status?: string;
          amount?: number;
          currency?: string;
          tx_ref?: string;
        };
      } | null;

      if (!data || typeof data !== 'object') {
        return {
          verified: false,
          status: 'FAILED',
          normalizedStatus: 'UNKNOWN',
          provider: 'FLUTTERWAVE',
          reference,
          errorCode: 'FLW_INVALID_RESPONSE',
          errorMessage: 'Invalid or non-JSON response from Flutterwave API.',
        };
      }

      const normalizedStatus = normalizeProviderPaymentStatus(data.data?.status);

      if (!res.ok || data.status !== 'success' || !data.data) {
        return {
          verified: false,
          status: 'FAILED',
          normalizedStatus,
          provider: 'FLUTTERWAVE',
          reference,
          errorCode: `FLW_HTTP_${res.status}`,
          errorMessage:
            data.message ||
            `Flutterwave verification failed with HTTP ${res.status}`,
        };
      }

      if (data.data.tx_ref && data.data.tx_ref.trim() !== reference) {
        return {
          verified: false,
          status: 'MISMATCH',
          normalizedStatus,
          provider: 'FLUTTERWAVE',
          reference: data.data.tx_ref,
          errorCode: 'REFERENCE_MISMATCH',
          errorMessage: `Flutterwave returned tx_ref '${data.data.tx_ref}' which does not match expected '${reference}'.`,
        };
      }

      if (normalizedStatus !== 'SUCCESS') {
        return {
          verified: false,
          status: 'FAILED',
          normalizedStatus,
          provider: 'FLUTTERWAVE',
          reference,
          errorCode: `FLW_STATUS_${normalizedStatus}`,
          errorMessage:
            data.message ||
            `Flutterwave transaction status is '${data.data.status || 'unverified'}'`,
        };
      }

      const paidMinor = nairaToKoboMinor(Number(data.data.amount || 0));
      const paidNaira = koboMinorToNaira(paidMinor);
      const paidCurrency = (data.data.currency || '').toUpperCase();

      if (paidCurrency !== expectedCurrency) {
        return {
          verified: false,
          status: 'MISMATCH',
          normalizedStatus,
          provider: 'FLUTTERWAVE',
          reference,
          amountMinor: paidMinor,
          amountNaira: paidNaira,
          currency: paidCurrency,
          errorCode: 'AMOUNT_OR_CURRENCY_MISMATCH',
          errorMessage: `Verified transaction currency (${paidCurrency}) does not match required (${expectedCurrency}).`,
        };
      }

      if (paidMinor < expectedMinor) {
        return {
          verified: false,
          status: 'MISMATCH',
          normalizedStatus,
          provider: 'FLUTTERWAVE',
          reference,
          amountMinor: paidMinor,
          amountNaira: paidNaira,
          currency: paidCurrency,
          errorCode: 'AMOUNT_OR_CURRENCY_MISMATCH',
          errorMessage: `Verified transaction (${paidCurrency} ${paidNaira}) does not match required (${expectedCurrency} ${expectedNaira}).`,
        };
      }

      return {
        verified: true,
        status: 'VERIFIED',
        normalizedStatus: 'SUCCESS',
        provider: 'FLUTTERWAVE',
        reference,
        providerTransactionId: String(data.data.id || reference),
        amountMinor: paidMinor,
        amountNaira: paidNaira,
        currency: paidCurrency,
      };
    } catch (err: unknown) {
      return {
        verified: false,
        status: 'FAILED',
        normalizedStatus: 'UNKNOWN',
        provider: 'FLUTTERWAVE',
        reference,
        errorCode: 'FLW_NETWORK_ERROR',
        errorMessage:
          err instanceof Error ? err.message : 'Failed to reach Flutterwave API',
      };
    }
  }

  async getTransaction(
    input: GetTransactionInput
  ): Promise<VerifiedTransactionResult> {
    return this.verifyPayment({
      reference: input.reference,
      expectedAmountNaira: input.expectedAmountNaira ?? 0,
      expectedCurrency: input.expectedCurrency ?? 'NGN',
    });
  }
}

export function getPaymentProvider(
  providerName: PaymentProviderName,
  fetchFn: FetchLike = fetch
): PaymentProvider {
  if (providerName === 'FLUTTERWAVE') {
    return new FlutterwavePaymentProvider(fetchFn);
  }
  return new PaystackPaymentProvider(fetchFn);
}

/**
 * PHASE 1 & PHASE 2 Unified Verification Helper:
 * Delegates to the normalized PaymentProvider abstraction (PaystackPaymentProvider / FlutterwavePaymentProvider).
 */
export async function verifyTransactionWithProvider(params: {
  provider: PaymentProviderName;
  reference: string;
  expectedAmountNaira: number;
  expectedCurrency: string;
  fetchFn?: FetchLike;
}): Promise<VerifiedTransactionResult> {
  const adapter = getPaymentProvider(params.provider, params.fetchFn);
  return adapter.verifyPayment({
    reference: params.reference,
    expectedAmountNaira: params.expectedAmountNaira,
    expectedCurrency: params.expectedCurrency,
  });
}

/**
 * 3.7 Meta WhatsApp Cloud API Provider Adapter
 * PHASE 1 & 2 HARDENING: Never returns fake message IDs or simulated delivery on missing credentials or errors.
 */
export class MetaWhatsAppProvider implements WhatsAppProvider {
  private readonly fetchFn: FetchLike;

  constructor(fetchFn: FetchLike = fetch) {
    this.fetchFn = fetchFn;
  }

  async sendMessage(params: WhatsAppTemplateParams): Promise<WhatsAppSendResult> {
    return this.sendTemplate(params);
  }

  async sendTemplate(params: WhatsAppTemplateParams): Promise<WhatsAppSendResult> {
    const normalizedPhone = normalizeNigerianPhone(params.phoneNumber);
    const toDigits = normalizedPhone.replace('+', '');
    const nowIso = new Date().toISOString();

    const requestPayload = {
      messaging_product: 'whatsapp',
      to: toDigits,
      type: 'template',
      template: {
        name: params.templateName,
        language: {
          code: params.language || 'en',
        },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: params.variables.customer_name },
              {
                type: 'text',
                text: `${params.variables.currency} ${params.variables.amount}`,
              },
              { type: 'text', text: params.variables.subscription_name },
              { type: 'text', text: params.variables.business_name },
            ],
          },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [
              {
                type: 'text',
                text: params.variables.recovery_token,
              },
            ],
          },
        ],
      },
    };

    const token = process.env.META_WHATSAPP_ACCESS_TOKEN;
    const phoneId = process.env.META_WHATSAPP_PHONE_NUMBER_ID;

    // 1. Check if credentials are configured
    if (!isConfiguredSecret(token) || !isConfiguredSecret(phoneId)) {
      if (isMockProvidersEnabled()) {
        // Explicit dev-only mock provider when ASUKU_MOCK_PROVIDERS=true and NODE_ENV !== 'production'
        return {
          provider: 'META',
          status: 'SENT',
          providerMessageId: `dev_mock_wamid_${crypto.randomBytes(6).toString('hex')}`,
          timestamp: nowIso,
          normalizedPhone,
          requestPayload,
        };
      }

      // Production / standard behavior: return NOT_CONFIGURED, no fake message ID
      return {
        provider: 'META',
        status: 'NOT_CONFIGURED',
        providerMessageId: null,
        timestamp: nowIso,
        normalizedPhone,
        requestPayload,
        errorCode: 'META_CREDENTIALS_MISSING',
        errorMessage:
          'Meta WhatsApp Cloud API credentials (META_WHATSAPP_ACCESS_TOKEN, META_WHATSAPP_PHONE_NUMBER_ID) are not configured.',
      };
    }

    // 2. Execute real API call
    try {
      const res = await this.fetchFn(
        `https://graph.facebook.com/v20.0/${phoneId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestPayload),
        }
      );

      const data = (await res.json().catch(() => ({}))) as {
        messages?: Array<{ id?: string }>;
        error?: { code?: number | string; message?: string };
      };

      if (!res.ok || !data.messages?.[0]?.id) {
        return {
          provider: 'META',
          status: 'FAILED',
          providerMessageId: null,
          timestamp: nowIso,
          normalizedPhone,
          requestPayload,
          errorCode: String(data.error?.code || `HTTP_${res.status}`),
          errorMessage:
            data.error?.message ||
            `Meta WhatsApp API returned HTTP ${res.status} without a message ID.`,
        };
      }

      return {
        provider: 'META',
        status: 'SENT',
        providerMessageId: data.messages[0].id,
        timestamp: nowIso,
        normalizedPhone,
        requestPayload,
      };
    } catch (err: unknown) {
      return {
        provider: 'META',
        status: 'FAILED',
        providerMessageId: null,
        timestamp: nowIso,
        normalizedPhone,
        requestPayload,
        errorCode: 'META_NETWORK_ERROR',
        errorMessage:
          err instanceof Error
            ? err.message
            : 'Network error calling Meta WhatsApp Cloud API.',
      };
    }
  }
}

/**
 * 3.8 Termii WhatsApp Provider Adapter
 * PHASE 1 & 2 HARDENING: Never returns fake message IDs or simulated delivery on missing credentials or errors.
 */
export class TermiiWhatsAppProvider implements WhatsAppProvider {
  private readonly fetchFn: FetchLike;

  constructor(fetchFn: FetchLike = fetch) {
    this.fetchFn = fetchFn;
  }

  async sendMessage(params: WhatsAppTemplateParams): Promise<WhatsAppSendResult> {
    return this.sendTemplate(params);
  }

  async sendTemplate(params: WhatsAppTemplateParams): Promise<WhatsAppSendResult> {
    const normalizedPhone = normalizeNigerianPhone(params.phoneNumber);
    const nowIso = new Date().toISOString();

    const requestPayload = {
      phone_number: normalizedPhone,
      device_id: process.env.TERMII_DEVICE_ID || '',
      template_id: params.templateName,
      data: {
        customer_name: params.variables.customer_name,
        business_name: params.variables.business_name,
        amount: params.variables.amount,
        currency: params.variables.currency,
        subscription_name: params.variables.subscription_name,
        payment_link: params.variables.payment_link,
      },
    };

    const apiKey = process.env.TERMII_API_KEY;
    const deviceId = process.env.TERMII_DEVICE_ID;

    // 1. Check if credentials are configured
    if (!isConfiguredSecret(apiKey) || !isConfiguredSecret(deviceId)) {
      if (isMockProvidersEnabled()) {
        return {
          provider: 'TERMII',
          status: 'SENT',
          providerMessageId: `dev_mock_termii_${crypto.randomBytes(6).toString('hex')}`,
          timestamp: nowIso,
          normalizedPhone,
          requestPayload,
        };
      }

      return {
        provider: 'TERMII',
        status: 'NOT_CONFIGURED',
        providerMessageId: null,
        timestamp: nowIso,
        normalizedPhone,
        requestPayload,
        errorCode: 'TERMII_CREDENTIALS_MISSING',
        errorMessage:
          'Termii WhatsApp credentials (TERMII_API_KEY, TERMII_DEVICE_ID) are not configured.',
      };
    }

    // 2. Execute real API call
    try {
      const res = await this.fetchFn('https://api.ng.termii.com/api/send/template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...requestPayload, api_key: apiKey }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        message_id?: string;
        code?: string | number;
        message?: string;
      };

      if (!res.ok || !data.message_id) {
        return {
          provider: 'TERMII',
          status: 'FAILED',
          providerMessageId: null,
          timestamp: nowIso,
          normalizedPhone,
          requestPayload,
          errorCode: String(data.code || `HTTP_${res.status}`),
          errorMessage:
            data.message ||
            `Termii API returned HTTP ${res.status} without a message_id.`,
        };
      }

      return {
        provider: 'TERMII',
        status: 'SENT',
        providerMessageId: data.message_id,
        timestamp: nowIso,
        normalizedPhone,
        requestPayload,
      };
    } catch (err: unknown) {
      return {
        provider: 'TERMII',
        status: 'FAILED',
        providerMessageId: null,
        timestamp: nowIso,
        normalizedPhone,
        requestPayload,
        errorCode: 'TERMII_NETWORK_ERROR',
        errorMessage:
          err instanceof Error ? err.message : 'Network error calling Termii API.',
      };
    }
  }
}

export function getWhatsAppProvider(
  providerName: string,
  fetchFn: FetchLike = fetch
): WhatsAppProvider {
  if (providerName.toUpperCase() === 'TERMII') {
    return new TermiiWhatsAppProvider(fetchFn);
  }
  return new MetaWhatsAppProvider(fetchFn);
}
