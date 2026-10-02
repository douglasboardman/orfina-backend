import { randomUUID } from 'node:crypto';

const cookieValue = (header: string | undefined, name: string) =>
  header?.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);

export const readCookie = (header: string | undefined, name: string) => cookieValue(header, name);

export const serializeCookie = (name: string, value: string, maxAge?: number) => {
  const attributes = [`${name}=${encodeURIComponent(value)}`, 'Path=/api', 'HttpOnly', 'SameSite=Lax'];
  if (maxAge !== undefined) attributes.push(`Max-Age=${maxAge}`);
  if (process.env.NODE_ENV === 'production') attributes.push('Secure');
  return attributes.join('; ');
};

export const createOAuthState = () => randomUUID();
