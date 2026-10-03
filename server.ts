import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import * as dotenv from 'dotenv';
import { z } from 'zod';
import {
  requireAuth,
  AuthRequest,
  isDemoModeAllowed,
} from './src/middleware/auth.ts';
import {
  getFullDashboardSnapshot,
  getOrCreateTenantContext,
  toggleCustomerOptIn,
  updateBusinessSettings,
} from './src/db/repository.ts';
import {
  executeQueuedWhatsAppJob,
  getRecoveryAttemptByToken,
  initializeMerchantPaymentRetry,
  initializeRecoveryPaymentByToken,
  issueOneTimeRecoveryToken,
  processWebhookAndOrchestrateRecovery,
  resolveWebhookTenant,
  verifyAndCompleteRecoveryByToken,
} from './src/server/recoveryEngine.ts';
import {
  getFlutterwaveSecretHash,
  getFlutterwaveSecretKey,
  getProvidersHealthReport,
  isConfiguredSecret,
  isMockProvidersEnabled,
  signWebhookPayload,
  verifyFlutterwaveSignature,
  verifyPaystackSignature,
} from './src/server/providers.ts';

dotenv.config();

const app = express();
const PORT = 3000;

// Capture raw request body for cryptographic HMAC webhook verification alongside JSON parsing
app.use(
  express.json({
    verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  })
);

// Public runtime security status endpoint (does not leak secrets)
app.get('/api/auth/status', (_req, res) => {
  return res.json({
    demoModeEnabled: isDemoModeAllowed(),
    mockProvidersEnabled: isMockProvidersEnabled(),
    paystackConfigured: isConfiguredSecret(process.env.PAYSTACK_SECRET_KEY),
    flutterwaveConfigured:
      Boolean(getFlutterwaveSecretKey()) && Boolean(getFlutterwaveSecretHash()),
    metaWhatsappConfigured:
      isConfiguredSecret(process.env.META_WHATSAPP_ACCESS_TOKEN) &&
      isConfiguredSecret(process.env.META_WHATSAPP_PHONE_NUMBER_ID),
    termiiConfigured:
      isConfiguredSecret(process.env.TERMII_API_KEY) &&
      isConfiguredSecret(process.env.TERMII_DEVICE_ID),
  });
});

// Safe Provider Health Check Endpoint (Inspects configuration without making live external API calls or exposing secrets)
app.get('/api/providers/health', requireAuth, (_req: AuthRequest, res) => {
  return res.json(getProvidersHealthReport());
});

// 1.2 Real Paystack Webhook Endpoint (Supports tenant-scoped /api/v1/webhooks/paystack/:webhookToken and /api/v1/webhooks/paystack)
const handlePaystackWebhook = async (
  req: express.Request & { rawBody?: Buffer },
  res: express.Response
) => {
  try {
    const signature = (req.headers['x-paystack-signature'] as string) || '';
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
    const isValid = verifyPaystackSignature(rawBody, signature);

    if (!isValid) {
      return res.status(401).json({
        error:
          'Invalid x-paystack-signature HMAC-SHA512 digest or PAYSTACK_SECRET_KEY not configured.',
        verified: false,
      });
    }

    const body = req.body || {};
    const webhookToken =
      req.params.webhookToken ||
      (req.headers['x-asuku-webhook-token'] as string | undefined);
    const providerSubscriptionId =
      body.data?.subscription?.subscription_code ||
      body.data?.subscription_code ||
      undefined;
    const providerReference = body.data?.reference || undefined;
    const claimedMetadataBusinessId =
      body.data?.metadata?.businessId || body.businessId || undefined;

    // PHASE 1 OBJECTIVE 6: Secure tenant identification (never blindly trust body.businessId)
    const tenantResolution = await resolveWebhookTenant({
      provider: 'PAYSTACK',
      webhookToken,
      providerSubscriptionId,
      providerReference,
      claimedMetadataBusinessId,
    });

    if (!tenantResolution.business) {
      return res.status(tenantResolution.statusCode || 400).json({
        error: tenantResolution.error,
        verified: true,
      });
    }

    const providerEventId =
      body.id || body.data?.id?.toString() || `pstk_evt_${Date.now()}`;
    const rawEventType = body.event || 'invoice.payment_failed';

    const result = await processWebhookAndOrchestrateRecovery({
      businessId: tenantResolution.business.id,
      provider: 'PAYSTACK',
      providerEventId: String(providerEventId),
      rawEventType,
      payload: body,
      signature,
      signatureValid: true,
      customerName: body.data?.customer?.name,
      customerEmail: body.data?.customer?.email,
      customerPhone: body.data?.customer?.phone,
      customerWhatsappOptIn: body.data?.metadata?.whatsapp_opt_in,
      planName: body.data?.plan?.name,
      amountNaira: body.data?.amount ? Number(body.data.amount) / 100 : undefined,
      currency: body.data?.currency || 'NGN',
      providerReference,
      providerSubscriptionId,
      failureReason: body.data?.gateway_response,
    });

    return res.status(200).json({ verified: true, ...result });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Webhook processing failed';
    return res.status(500).json({ error: msg });
  }
};

app.post('/api/v1/webhooks/paystack', handlePaystackWebhook);
app.post('/api/v1/webhooks/paystack/:webhookToken', handlePaystackWebhook);

// 1.3 Real Flutterwave Webhook Endpoint (Supports tenant-scoped /api/v1/webhooks/flutterwave/:webhookToken and /api/v1/webhooks/flutterwave)
const handleFlutterwaveWebhook = async (
  req: express.Request & { rawBody?: Buffer },
  res: express.Response
) => {
  try {
    const signature =
      (req.headers['flutterwave-signature'] as string) ||
      (req.headers['verif-hash'] as string) ||
      '';
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
    const isValid = verifyFlutterwaveSignature(rawBody, signature);

    if (!isValid) {
      return res.status(401).json({
        error:
          'Invalid flutterwave-signature / verif-hash digest or FLW_SECRET_HASH not configured.',
        verified: false,
      });
    }

    const body = req.body || {};
    const webhookToken =
      req.params.webhookToken ||
      (req.headers['x-asuku-webhook-token'] as string | undefined);
    const providerSubscriptionId =
      body.data?.meta?.subscription_id || undefined;
    const providerReference = body.data?.tx_ref || undefined;
    const claimedMetadataBusinessId =
      body.data?.meta?.businessId || body.businessId || undefined;

    // PHASE 1 OBJECTIVE 6: Secure tenant identification
    const tenantResolution = await resolveWebhookTenant({
      provider: 'FLUTTERWAVE',
      webhookToken,
      providerSubscriptionId,
      providerReference,
      claimedMetadataBusinessId,
    });

    if (!tenantResolution.business) {
      return res.status(tenantResolution.statusCode || 400).json({
        error: tenantResolution.error,
        verified: true,
      });
    }

    const providerEventId =
      body.id || body.data?.id?.toString() || `flw_evt_${Date.now()}`;
    const rawEventType = body.event || 'charge.failed';

    const result = await processWebhookAndOrchestrateRecovery({
      businessId: tenantResolution.business.id,
      provider: 'FLUTTERWAVE',
      providerEventId: String(providerEventId),
      rawEventType,
      payload: body,
      signature,
      signatureValid: true,
      customerName: body.data?.customer?.name,
      customerEmail: body.data?.customer?.email,
      customerPhone: body.data?.customer?.phone_number,
      customerWhatsappOptIn: body.data?.meta?.whatsapp_opt_in,
      planName: body.data?.meta?.plan_name,
      amountNaira: body.data?.amount ? Number(body.data.amount) : undefined,
      currency: body.data?.currency || 'NGN',
      providerReference,
      providerSubscriptionId,
      failureReason: body.data?.processor_response,
    });

    return res.status(200).json({ verified: true, ...result });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Webhook processing failed';
    return res.status(500).json({ error: msg });
  }
};

app.post('/api/v1/webhooks/flutterwave', handleFlutterwaveWebhook);
app.post('/api/v1/webhooks/flutterwave/:webhookToken', handleFlutterwaveWebhook);

// Helper to extract verified user from AuthRequest without hardcoded demo fallbacks
function getVerifiedUserOrThrow(req: AuthRequest) {
  if (!req.user || !req.user.uid || !req.user.email) {
    throw new Error('Unauthorized: Authenticated user context missing.');
  }
  return {
    uid: req.user.uid,
    email: req.user.email,
    name: req.user.name as string | undefined,
  };
}

// Authenticated Dashboard Snapshot Endpoint
app.get('/api/dashboard', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { uid, email, name } = getVerifiedUserOrThrow(req);
    const business = await getOrCreateTenantContext(uid, email, name);
    const snapshot = await getFullDashboardSnapshot(business.id);
    return res.json(snapshot);
  } catch (error: unknown) {
    console.error('Failed to fetch dashboard snapshot:', error);
    const msg = error instanceof Error ? error.message : 'Failed to load dashboard';
    return res.status(500).json({ error: msg });
  }
});

// Interactive Webhook Simulator & Signature Verifier Endpoint (Tenant derived strictly from authenticated session)
const simulateWebhookSchema = z
  .object({
    provider: z.enum(['PAYSTACK', 'FLUTTERWAVE']),
    eventType: z.enum(['invoice.payment_failed', 'charge.success', 'charge.failed']),
    providerEventId: z.string().trim().min(3).max(128),
    tamperSignature: z.boolean().optional().default(false),
    customerName: z.string().trim().min(2).max(120).optional(),
    customerEmail: z.string().trim().email().optional(),
    customerPhone: z
      .string()
      .trim()
      .regex(
        /^(\+?234|0)[789][01]\d{8}$/,
        'Customer phone must be a valid Nigerian number (+234... or 080...)'
      )
      .optional(),
    customerWhatsappOptIn: z.boolean().optional().default(true),
    planName: z.string().trim().min(2).max(120).optional(),
    amountNaira: z.number().positive().max(1000000000).optional(),
    currency: z.string().trim().length(3).optional().default('NGN'),
    providerReference: z.string().trim().min(3).max(128).optional(),
    failureReason: z.string().trim().max(250).optional(),
  })
  .strict();

app.post('/api/webhooks/simulate', requireAuth, async (req: AuthRequest, res) => {
  try {
    const parsed = simulateWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues[0]?.message || 'Invalid webhook simulation input',
      });
    }

    const { uid, email, name } = getVerifiedUserOrThrow(req);
    // Tenant is ALWAYS derived from the authenticated session, never from request body
    const business = await getOrCreateTenantContext(uid, email, name);

    const data = parsed.data;
    const reference =
      data.providerReference ||
      (data.provider === 'PAYSTACK'
        ? `ref_pstk_${Date.now()}`
        : `flw_ref_${Date.now()}`);

    const payloadObj =
      data.provider === 'PAYSTACK'
        ? {
            event: data.eventType,
            id: data.providerEventId,
            data: {
              reference,
              amount: Math.round((data.amountNaira || 850000) * 100), // kobo
              currency: data.currency.toUpperCase(),
              gateway_response:
                data.failureReason || 'Insufficient Funds on Corporate Card',
              customer: {
                name: data.customerName || 'Emeka Okafor (Zenith Logistics)',
                email: data.customerEmail || 'e.okafor@zenithlogistics.ng',
                phone: data.customerPhone || '+2348039918273',
              },
              plan: {
                name: data.planName || 'Enterprise Fleet Command Plan',
              },
              metadata: {
                whatsapp_opt_in: data.customerWhatsappOptIn,
              },
            },
          }
        : {
            event: data.eventType,
            id: data.providerEventId,
            data: {
              tx_ref: reference,
              amount: data.amountNaira || 850000,
              currency: data.currency.toUpperCase(),
              processor_response:
                data.failureReason || 'Do Not Honor — Issuer Declined',
              customer: {
                name: data.customerName || 'Emeka Okafor (Zenith Logistics)',
                email: data.customerEmail || 'e.okafor@zenithlogistics.ng',
                phone_number: data.customerPhone || '+2348039918273',
              },
              meta: {
                plan_name: data.planName || 'Enterprise Fleet Command Plan',
                whatsapp_opt_in: data.customerWhatsappOptIn,
              },
            },
          };

    const rawBody = Buffer.from(JSON.stringify(payloadObj));
    const sandboxSecret =
      data.provider === 'PAYSTACK'
        ? isConfiguredSecret(process.env.PAYSTACK_SECRET_KEY)
          ? process.env.PAYSTACK_SECRET_KEY!
          : `whsec_pstk_${business.webhookToken || business.id}`
        : isConfiguredSecret(process.env.FLW_SECRET_HASH)
        ? process.env.FLW_SECRET_HASH!
        : `whsec_flw_${business.webhookToken || business.id}`;

    const validSignature = signWebhookPayload(
      data.provider,
      rawBody,
      sandboxSecret
    );
    const providedSignature = data.tamperSignature
      ? `tampered_invalid_${validSignature.slice(17)}`
      : validSignature;

    const isSignatureValid =
      data.provider === 'PAYSTACK'
        ? verifyPaystackSignature(rawBody, providedSignature, sandboxSecret)
        : verifyFlutterwaveSignature(rawBody, providedSignature, sandboxSecret);

    if (!isSignatureValid) {
      return res.status(401).json({
        status: 'SIGNATURE_REJECTED',
        verified: false,
        expectedHeader:
          data.provider === 'PAYSTACK'
            ? 'x-paystack-signature (HMAC-SHA512)'
            : 'flutterwave-signature (HMAC-SHA256)',
        providedSignature,
        message: `HTTP 401 Unauthorized: Cryptographic signature verification failed for ${data.provider}. Webhook rejected before touching database or queues.`,
      });
    }

    const result = await processWebhookAndOrchestrateRecovery({
      businessId: business.id,
      provider: data.provider,
      providerEventId: data.providerEventId,
      rawEventType: data.eventType,
      payload: payloadObj,
      signature: providedSignature,
      signatureValid: true,
      customerName: data.customerName,
      customerEmail: data.customerEmail,
      customerPhone: data.customerPhone,
      customerWhatsappOptIn: data.customerWhatsappOptIn,
      planName: data.planName,
      amountNaira: data.amountNaira,
      currency: data.currency,
      providerReference: reference,
      failureReason: data.failureReason,
    });

    return res.status(200).json({
      verified: true,
      tenantWebhookUrl: `/api/v1/webhooks/${data.provider.toLowerCase()}/${
        business.webhookToken
      }`,
      signatureHeader:
        data.provider === 'PAYSTACK'
          ? 'x-paystack-signature'
          : 'flutterwave-signature',
      signatureDigest: providedSignature,
      ...result,
    });
  } catch (error: unknown) {
    console.error('Webhook simulation error:', error);
    const msg = error instanceof Error ? error.message : 'Simulation failed';
    return res.status(500).json({ error: msg });
  }
});

// Trigger a queued WhatsApp recovery step (T+24h or T+72h) from Worker Console
const runJobSchema = z
  .object({
    whatsappLogId: z.string().uuid('Invalid whatsappLogId UUID'),
  })
  .strict();

app.post('/api/recovery/run-job', requireAuth, async (req: AuthRequest, res) => {
  try {
    const parsed = runJobSchema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
    }

    const { uid, email, name } = getVerifiedUserOrThrow(req);
    const business = await getOrCreateTenantContext(uid, email, name);

    const outcome = await executeQueuedWhatsAppJob(
      business.id,
      parsed.data.whatsappLogId
    );
    return res.json(outcome);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Failed to run job';
    return res.status(500).json({ error: msg });
  }
});

// PHASE 1 OBJECTIVE 5: Issue/Rotate a One-Time Recovery Token for a Failed Payment (Stores ONLY SHA-256 hash in DB)
app.post(
  '/api/failed-payments/:id/issue-token',
  requireAuth,
  async (req: AuthRequest, res) => {
    try {
      const { uid, email, name } = getVerifiedUserOrThrow(req);
      const business = await getOrCreateTenantContext(uid, email, name);

      const issued = await issueOneTimeRecoveryToken(business.id, req.params.id);
      return res.json(issued);
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : 'Failed to issue recovery token';
      return res.status(400).json({ error: msg });
    }
  }
);

// PHASE 2: Authenticated Merchant Payment Initialization for a Pending Failed Payment
app.post(
  '/api/failed-payments/:id/initialize',
  requireAuth,
  async (req: AuthRequest, res) => {
    try {
      const { uid, email, name } = getVerifiedUserOrThrow(req);
      const business = await getOrCreateTenantContext(uid, email, name);

      const result = await initializeMerchantPaymentRetry(
        business.id,
        req.params.id
      );
      return res.status(result.httpStatus).json(result);
    } catch (error: unknown) {
      const msg =
        error instanceof Error
          ? error.message
          : 'Failed to initialize payment checkout';
      return res.status(500).json({ error: msg });
    }
  }
);

// Public / Customer-facing Recovery Link Checkout Lookup (/api/recovery-link/:token)
// Looks up strictly by SHA-256(token) against failed_payments.recovery_token_hash
app.get('/api/recovery-link/:token', async (req, res) => {
  try {
    const details = await getRecoveryAttemptByToken(req.params.token);
    if (!details) {
      return res.status(404).json({
        error:
          'Recovery link token not found or invalid (verified via SHA-256 token hash).',
      });
    }
    return res.json(details);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Failed to resolve token';
    return res.status(500).json({ error: msg });
  }
});

// PHASE 2: Initialize Provider Checkout via One-Time Recovery Token
// Server loads authoritative amount, currency, reference, and provider from DB (ignores any client-supplied amount/reference)
app.post('/api/recovery-link/:token/initialize', async (req, res) => {
  try {
    const result = await initializeRecoveryPaymentByToken(req.params.token);
    return res.status(result.httpStatus).json(result);
  } catch (error: unknown) {
    const msg =
      error instanceof Error
        ? error.message
        : 'Failed to initialize recovery payment';
    return res.status(500).json({ error: msg });
  }
});

// PHASE 1 OBJECTIVE 3 & 4: Complete Payment via Recovery Link Checkout
// Requires transactionReference and verifies transaction with Paystack/Flutterwave API before marking recovered!
const completeRecoverySchema = z
  .object({
    transactionReference: z
      .string()
      .trim()
      .min(3, 'Transaction reference is required for provider verification')
      .max(128),
  })
  .strict();

app.post('/api/recovery-link/:token/complete', async (req, res) => {
  try {
    const parsed = completeRecoverySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error:
          parsed.error.issues[0]?.message ||
          'Transaction reference is required to verify payment with provider.',
      });
    }

    const result = await verifyAndCompleteRecoveryByToken(
      req.params.token,
      parsed.data.transactionReference
    );

    return res.status(result.httpStatus).json(result);
  } catch (error: unknown) {
    const msg =
      error instanceof Error ? error.message : 'Checkout verification failed';
    return res.status(500).json({ error: msg });
  }
});

// PHASE 1 OBJECTIVE 8: Toggle Customer WhatsApp Opt-In with strict Zod validation & automatic queue cancellation
const toggleOptInSchema = z
  .object({
    whatsappOptIn: z.boolean(),
  })
  .strict();

app.patch(
  '/api/customers/:id/opt-in',
  requireAuth,
  async (req: AuthRequest, res) => {
    try {
      const parsed = toggleOptInSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error:
            parsed.error.issues[0]?.message ||
            'whatsappOptIn must be a boolean value.',
        });
      }

      const { uid, email, name } = getVerifiedUserOrThrow(req);
      const business = await getOrCreateTenantContext(uid, email, name);

      const result = await toggleCustomerOptIn(
        business.id,
        req.params.id,
        parsed.data.whatsappOptIn
      );
      return res.json(result);
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : 'Failed to update opt-in';
      return res.status(500).json({ error: msg });
    }
  }
);

// PHASE 1 OBJECTIVE 7: Strict Zod Validation & Whitelisting on Business Settings
const updateSettingsSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2, 'Business name must be at least 2 characters')
      .max(120, 'Business name must not exceed 120 characters'),
    phone: z
      .string()
      .trim()
      .regex(
        /^(\+?234|0)[789][01]\d{8}$/,
        'Support phone must be a valid Nigerian phone number (+234... or 080...)'
      ),
    paystackEnabled: z.boolean(),
    flutterwaveEnabled: z.boolean(),
    whatsappProvider: z.enum(['META', 'TERMII']),
    whatsappTemplateImmediate: z
      .string()
      .trim()
      .regex(
        /^[a-z0-9_]{3,64}$/,
        'Immediate template name must be lowercase alphanumeric with underscores (3–64 chars)'
      ),
    whatsappTemplate24h: z
      .string()
      .trim()
      .regex(
        /^[a-z0-9_]{3,64}$/,
        '24h template name must be lowercase alphanumeric with underscores (3–64 chars)'
      ),
    whatsappTemplate72h: z
      .string()
      .trim()
      .regex(
        /^[a-z0-9_]{3,64}$/,
        '72h template name must be lowercase alphanumeric with underscores (3–64 chars)'
      ),
    retryLinkExpiryHours: z
      .number()
      .int('Expiry hours must be an integer')
      .min(1, 'Expiry hours must be at least 1 hour')
      .max(720, 'Expiry hours cannot exceed 720 hours (30 days)'),
  })
  .strict();

app.put('/api/settings', requireAuth, async (req: AuthRequest, res) => {
  try {
    const parsed = updateSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues[0]?.message || 'Invalid settings payload',
        issues: parsed.error.issues,
      });
    }

    const { uid, email, name } = getVerifiedUserOrThrow(req);
    const business = await getOrCreateTenantContext(uid, email, name);

    const updated = await updateBusinessSettings(business.id, parsed.data);
    return res.json(updated);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Failed to save settings';
    return res.status(500).json({ error: msg });
  }
});

async function startServer() {
  const httpServer = createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const hmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: hmrDisabled ? false : { server: httpServer },
        watch: hmrDisabled ? null : {},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`ASUKU Revenue Recovery server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
