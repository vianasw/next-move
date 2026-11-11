import type { QueryServerContext } from "@spacefast/zero/server";

type CryptoCtx = Pick<QueryServerContext, "crypto" | "jwt">;

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function hexToBase64url(hex: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += BASE64URL[(n >> 18) & 63] + BASE64URL[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += BASE64URL[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += BASE64URL[n & 63];
  }
  return out;
}

/**
 * A new unguessable secret such as `nmk_<43 chars>`.
 *
 * Zero handlers have no crypto.getRandomValues, so the entropy comes from the
 * runtime instead: every ctx.jwt.sign call carries a fresh random `jti`, and the
 * signature is keyed by TOKEN_SEED. HMAC-ing that with TOKEN_PEPPER gives 256 bits
 * nobody can predict without both secrets AND the runtime's randomness.
 */
export async function mintSecret(ctx: CryptoCtx, prefix: "nmh" | "nmk"): Promise<string> {
  const seed = await ctx.jwt.sign({ key: "TOKEN_SEED", kid: "mint", claims: { use: prefix }, ttlSeconds: 60 });
  const hex = await ctx.crypto.hmacSha256({ key: "TOKEN_PEPPER", data: `mint:${seed}` });
  return `${prefix}_${hexToBase64url(hex)}`;
}

/** What gets stored and looked up. The secret itself is never persisted. */
export function hashSecret(ctx: CryptoCtx, secret: string): Promise<string> {
  return ctx.crypto.hmacSha256({ key: "TOKEN_PEPPER", data: `store:${secret}` });
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoIn(milliseconds: number): string {
  return new Date(Date.now() + milliseconds).toISOString();
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
