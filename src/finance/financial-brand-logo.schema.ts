import { z } from 'zod';

// Keep existing absolute URLs and accept the same-origin SVGs used by the bank catalog.
export const financialBrandLogoSchema = z.union([
  z.string().url(),
  z.string().regex(/^\/assets\/banks\/bank-\d{3}\.svg$/),
]);
