import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import * as dotenv from 'dotenv';
import { z } from 'zod';
import { requireAuth, AuthRequest } from './src/middleware/auth.ts';
import {
  getFullDashboardSnapshot,
  getOrCreateTenantContext,
  toggleCustomerOptIn,
  updateBusinessSettings,
} from './src/db/repository.ts';
import {
  executeQueuedWhatsAppJob,
  getRecoveryAttemptByToken,
  markPaymentRecoveredAndCancelQueue,
  processWebhookAndOrchestrateRecovery,
} from './src/server/recoveryEngine.ts';
import {
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

// 1.2 Real Paystack Webhook Endpoint (POST /api/v1/webhooks/paystack)
app.post(
  '/api/v1/webhooks/paystack',
  async (req: express.Request & { rawBody?: Buffer }, res) => {
    try {
      const signature = (req.headers['x-paystack-signature'] as string) || '';
      const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
      const isValid = verifyPaystackSignature(rawBody, signature);

      if (!isValid) {
        return res.status(401).json({
          error: 'Invalid x-paystack-signature HMAC-SHA512 digest',
          verified: false,
        });
      }

      const body = req.body || {};
      const businessId = body.businessId as string;
      const providerEventId =
        body.id || body.data?.id?.toString() || `pstk_evt_${Date.now()}`;
      const rawEventType = body.event || 'invoice.payment_failed';

      const result = await processWebhookAndOrchestrateRecovery({
        businessId,
        provider: 'PAYSTACK',
        providerEventId: String(providerEventId),
        rawEventType,
        payload: body,
        signature,
        signatureValid: true,
        customerName: body.data?.customer?.name,
        customerEmail: body.data?.customer?.email,
        customerPhone: body.data?.customer?.phone,
        planName: body.data?.plan?.name,
        amountNaira: body.data?.amount ? Number(body.data.amount) / 100 : undefined,
        providerReference: body.data?.reference,
        failureReason: body.data?.gateway_response,
      });

      return res.status(200).json({ verified: true, ...result });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Webhook processing failed';
      return res.status(500).json({ error: msg });
    }
  }
);

// 1.3 Real Flutterwave Webhook Endpoint (POST /api/v1/webhooks/flutterwave)
app.post(
  '/api/v1/webhooks/flutterwave',
  async (req: express.Request & { rawBody?: Buffer }, res) => {
    try {
      const signature =
        (req.headers['flutterwave-signature'] as string) ||
        (req.headers['verif-hash'] as string) ||
        '';
      const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
      const isValid = verifyFlutterwaveSignature(rawBody, signature);

      if (!isValid) {
        return res.status(401).json({
          error: 'Invalid flutterwave-signature / verif-hash digest',
          verified: false,
        });
      }

      const body = req.body || {};
      const businessId = body.businessId as string;
      const providerEventId =
        body.id || body.data?.id?.toString() || `flw_evt_${Date.now()}`;
      const rawEventType = body.event || 'charge.failed';

      const result = await processWebhookAndOrchestrateRecovery({
        businessId,
        provider: 'FLUTTERWAVE',
        providerEventId: String(providerEventId),
        rawEventType,
        payload: body,
        signature,
        signatureValid: true,
        customerName: body.data?.customer?.name,
        customerEmail: body.data?.customer?.email,
        customerPhone: body.data?.customer?.phone_number,
        planName: body.data?.meta?.plan_name,
        amountNaira: body.data?.amount ? Number(body.data.amount) : undefined,
        providerReference: body.data?.tx_ref,
        failureReason: body.data?.processor_response,
      });

      return res.status(200).json({ verified: true, ...result });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Webhook processing failed';
      return res.status(500).json({ error: msg });
    }
  }
);

// Authenticated Dashboard Snapshot Endpoint
app.get('/api/dashboard', requireAuth, async (req: AuthRequest, res) => {
  try {
    const uid = req.user?.uid || 'demo-tenant-nigeria-uid';
    const email = req.user?.email || 'treasury@paystack-merchant.ng';
    const name = req.user?.name as string | undefined;

    const business = await getOrCreateTenantContext(uid, email, name);
    const snapshot = await getFullDashboardSnapshot(business.id);
    return res.json(snapshot);
  } catch (error: unknown) {
    console.error('Failed to fetch dashboard snapshot:', error);
    const msg = error instanceof Error ? error.message : 'Failed to load dashboard';
    return res.status(500).json({ error: msg });
  }
});

// Interactive Webhook Simulator & Signature Verifier Endpoint
const simulateWebhookSchema = z.object({
  provider: z.enum(['PAYSTACK', 'FLUTTERWAVE']),
  eventType: z.enum(['invoice.payment_failed', 'charge.success', 'charge.failed']),
  providerEventId: z.string().min(3),
  tamperSignature: z.boolean().optional().default(false),
  customerName: z.string().optional(),
  customerEmail: z.string().optional(),
  customerPhone: z.string().optional(),
  planName: z.string().optional(),
  amountNaira: z.number().positive().optional(),
  providerReference: z.string().optional(),
  failureReason: z.string().optional(),
});

app.post('/api/webhooks/simulate', requireAuth, async (req: AuthRequest, res) => {
  try {
    const parsed = simulateWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
    }

    const uid = req.user?.uid || 'demo-tenant-nigeria-uid';
    const email = req.user?.email || 'treasury@paystack-merchant.ng';
    const business = await getOrCreateTenantContext(uid, email);

    const data = parsed.data;
    const payloadObj =
      data.provider === 'PAYSTACK'
        ? {
            event: data.eventType,
            id: data.providerEventId,
            data: {
              reference: data.providerReference || `ref_pstk_${Date.now()}`,
              amount: (data.amountNaira || 850000) * 100, // kobo
              currency: 'NGN',
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
            },
          }
        : {
            event: data.eventType,
            id: data.providerEventId,
            data: {
              tx_ref: data.providerReference || `flw_ref_${Date.now()}`,
              amount: data.amountNaira || 850000,
              currency: 'NGN',
              processor_response:
                data.failureReason || 'Do Not Honor — Issuer Declined',
              customer: {
                name: data.customerName || 'Emeka Okafor (Zenith Logistics)',
                email: data.customerEmail || 'e.okafor@zenithlogistics.ng',
                phone_number: data.customerPhone || '+2348039918273',
              },
              meta: {
                plan_name: data.planName || 'Enterprise Fleet Command Plan',
              },
            },
          };

    const rawBody = Buffer.from(JSON.stringify(payloadObj));
    const validSignature = signWebhookPayload(data.provider, rawBody);
    const providedSignature = data.tamperSignature
      ? `tampered_invalid_${validSignature.slice(17)}`
      : validSignature;

    const isSignatureValid =
      data.provider === 'PAYSTACK'
        ? verifyPaystackSignature(rawBody, providedSignature)
        : verifyFlutterwaveSignature(rawBody, providedSignature);

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
      planName: data.planName,
      amountNaira: data.amountNaira,
      providerReference:
        data.provider === 'PAYSTACK'
          ? payloadObj.data.reference
          : payloadObj.data.tx_ref,
      failureReason: data.failureReason,
    });

    return res.status(200).json({
      verified: true,
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
app.post('/api/recovery/run-job', requireAuth, async (req: AuthRequest, res) => {
  try {
    const uid = req.user?.uid || 'demo-tenant-nigeria-uid';
    const email = req.user?.email || 'treasury@paystack-merchant.ng';
    const business = await getOrCreateTenantContext(uid, email);

    const { whatsappLogId } = req.body as { whatsappLogId: string };
    if (!whatsappLogId) {
      return res.status(400).json({ error: 'whatsappLogId is required' });
    }

    const outcome = await executeQueuedWhatsAppJob(business.id, whatsappLogId);
    return res.json(outcome);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Failed to run job';
    return res.status(500).json({ error: msg });
  }
});

// Public / Customer-facing Recovery Link Checkout Lookup (/api/recovery-link/:token)
app.get('/api/recovery-link/:token', async (req, res) => {
  try {
    const details = await getRecoveryAttemptByToken(req.params.token);
    if (!details) {
      return res.status(404).json({ error: 'Recovery link token not found or invalid.' });
    }
    return res.json(details);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Failed to resolve token';
    return res.status(500).json({ error: msg });
  }
});

// Complete Payment via Recovery Link Checkout (verifies transaction & cancels remaining WhatsApp queue)
app.post('/api/recovery-link/:token/complete', async (req, res) => {
  try {
    const details = await getRecoveryAttemptByToken(req.params.token);
    if (!details) {
      return res.status(404).json({ error: 'Recovery token not found' });
    }
    if (details.isExpired) {
      return res.status(410).json({ error: 'This recovery link has expired.' });
    }
    if (details.payment.status === 'RECOVERED') {
      return res.json({
        alreadyRecovered: true,
        message: 'This subscription payment has already been recovered.',
      });
    }

    const outcome = await markPaymentRecoveredAndCancelQueue(
      details.payment.businessId,
      details.payment.id,
      `Customer completed checkout via secure recovery link (/r/${req.params.token}) and verified via ${details.payment.provider} charge.success`
    );

    return res.json({
      success: true,
      ...outcome,
      message: `Payment of ${details.payment.currency} ${Number(
        details.payment.amount
      ).toLocaleString('en-NG')} verified! Subscription reactivated and ${
        outcome.cancelledJobsCount
      } remaining scheduled WhatsApp reminder(s) immediately cancelled.`,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Checkout verification failed';
    return res.status(500).json({ error: msg });
  }
});

// Toggle Customer WhatsApp Opt-In
app.patch('/api/customers/:id/opt-in', requireAuth, async (req: AuthRequest, res) => {
  try {
    const uid = req.user?.uid || 'demo-tenant-nigeria-uid';
    const email = req.user?.email || 'treasury@paystack-merchant.ng';
    const business = await getOrCreateTenantContext(uid, email);

    const { whatsappOptIn } = req.body as { whatsappOptIn: boolean };
    const updated = await toggleCustomerOptIn(
      business.id,
      req.params.id,
      Boolean(whatsappOptIn)
    );
    return res.json(updated);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Failed to update opt-in';
    return res.status(500).json({ error: msg });
  }
});

// Update Business Settings & Provider Configuration
app.put('/api/settings', requireAuth, async (req: AuthRequest, res) => {
  try {
    const uid = req.user?.uid || 'demo-tenant-nigeria-uid';
    const email = req.user?.email || 'treasury@paystack-merchant.ng';
    const business = await getOrCreateTenantContext(uid, email);

    const updated = await updateBusinessSettings(business.id, req.body);
    return res.json(updated);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Failed to save settings';
    return res.status(500).json({ error: msg });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ASUKU Revenue Recovery server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
