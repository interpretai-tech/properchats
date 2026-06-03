/**
 * Server-side feature flags, derived from env. Everything is OFF unless its env
 * is present, so the app runs with zero configuration.
 *
 * - iaiStoreEnabled: presign media uploads to the backend object store (needs a
 *   storage endpoint on the backend); off by default, so uploads fall back to
 *   inline data URLs.
 */
export const iaiStoreEnabled = (): boolean => process.env.NEXT_PUBLIC_IAI_STORE === "1";
