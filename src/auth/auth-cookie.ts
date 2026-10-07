import { randomUUID } from 'node:crypto';

export const cookieName = (suffix: string) => `${process.env.NODE_ENV === 'production' ? '__Host-' : ''}orfina_${suffix}`;

const cookieValue = (header: string | undefined, name: string) =>
  header?.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);

export const readCookie = (header: string | undefined, name: string) => cookieValue(header, name);

export const serializeCookie = (name: string, value: string, maxAge?: number, options: { httpOnly?: boolean; path?: string } = {}) => {
  const attributes = [`${name}=${encodeURIComponent(value)}`, `Path=${name.startsWith('__Host-') ? '/' : options.path ?? '/api'}`, 'SameSite=Lax'];
  if (options.httpOnly !== false) attributes.push('HttpOnly');
  if (maxAge !== undefined) attributes.push(`Max-Age=${maxAge}`);
  if (process.env.NODE_ENV === 'production') attributes.push('Secure');
  return attributes.join('; ');
};

export const createOAuthState = () => randomUUID();
