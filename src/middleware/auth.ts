import { Request, Response, NextFunction } from 'express';
import { adminAuth } from '../lib/firebase-admin.ts';
import { DecodedIdToken } from 'firebase-admin/auth';

export interface AuthRequest extends Request {
  user?: DecodedIdToken;
}

/**
 * PHASE 1 SECURITY HARDENING — OBJECTIVE 2:
 * Demo authentication (x-asuku-demo-tenant) must NEVER work in production.
 * Production authentication strictly requires a verified Firebase ID token.
 * The demo header is only accepted when:
 *   1. NODE_ENV !== 'production'
 *   2. ASUKU_DEMO_MODE === 'true'
 */
export function isDemoModeAllowed(): boolean {
  if (process.env.NODE_ENV === 'production') {
    return false;
  }
  return process.env.ASUKU_DEMO_MODE === 'true';
}

export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split('Bearer ')[1];
    try {
      const decodedToken = await adminAuth.verifyIdToken(token);
      req.user = decodedToken;
      return next();
    } catch (error) {
      console.error('Error verifying Firebase ID token:', error);
      return res.status(401).json({
        error: 'Unauthorized: Invalid or expired Firebase authentication token.',
      });
    }
  }

  // Only allow demo tenant fallback if explicitly enabled in non-production
  const demoHeader = req.headers['x-asuku-demo-tenant'];
  if (isDemoModeAllowed() && demoHeader === 'asuku-demo-nigeria') {
    req.user = {
      uid: 'demo-tenant-nigeria-uid',
      email: 'treasury@paystack-merchant.ng',
      name: 'Adebayo Ogunlesi (Dev Demo Mode)',
    } as unknown as DecodedIdToken;
    return next();
  }

  return res.status(401).json({
    error:
      'Unauthorized: Firebase Authentication Bearer token required. Demo header authentication is disabled (ASUKU_DEMO_MODE=false).',
    code: 'AUTH_REQUIRED',
  });
};
