import { Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { randomBytes, createHash } from 'node:crypto';
import { GoogleProfile } from './auth.service';

const keys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export function googleAuthorization(callback: string, clientId = process.env.GOOGLE_CLIENT_ID ?? '') {
  const state = randomBytes(32).toString('hex');
  const nonce = randomBytes(32).toString('hex');
  const verifier = randomBytes(32).toString('base64url');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: 'code',
    scope: 'openid email profile', state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', prompt: 'select_account' }).toString();
  return { state, nonce, verifier, url: url.toString() };
}
export async function exchangeGoogle(code: string, verifier: string, nonce: string, callback: string,
  clientId = process.env.GOOGLE_CLIENT_ID ?? '', clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''): Promise<GoogleProfile> {
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, code_verifier: verifier, redirect_uri: callback, client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code' }) });
  if (!response.ok) throw new Error('GOOGLE_EXCHANGE_FAILED');
  const result = await response.json() as { id_token?: string };
  if (!result.id_token) throw new Error('GOOGLE_IDENTITY_MISSING');
  const { payload } = await jwtVerify(result.id_token, keys, { issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: clientId, algorithms: ['RS256'] });
  if (payload.nonce !== nonce || typeof payload.exp !== 'number' || typeof payload.sub !== 'string' || typeof payload.email !== 'string' || payload.email_verified !== true) throw new Error('GOOGLE_IDENTITY_INVALID');
  return { googleId: payload.sub, email: payload.email, emailVerified: true,
    hostedDomain: typeof payload.hd === 'string' ? payload.hd : undefined,
    name: typeof payload.name === 'string' ? payload.name : payload.email,
    avatarUrl: typeof payload.picture === 'string' ? payload.picture : undefined };
}
@Injectable()
export class GoogleIdentityService {
  callback() { return process.env.GOOGLE_CALLBACK_URL ?? 'http://localhost:3000/api/auth/google/callback'; }
  authorization() { return googleAuthorization(this.callback()); }
  exchange(code: string, verifier: string, nonce: string) { return exchangeGoogle(code, verifier, nonce, this.callback()); }
}
