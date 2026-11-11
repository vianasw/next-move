// Field encryption and pseudonyms, built on the one keyed primitive Zero's sandbox has:
// HMAC-SHA256 under the DATA_KEY secret. Handler code names the key and never sees its
// value; neither does anyone reading the Space's variables (secrets are write-only).
//
// seal() is deterministic authenticated encryption in the SIV style:
//   iv        = HMAC(K, "siv|" + context + "\0" + text), first 16 bytes
//   keystream = HMAC(K, "ks|" + iv + "|0") ‖ HMAC(K, "ks|" + iv + "|1") ‖ …
//   stored    = "e1." + keyId + "." + iv + "." + base64url(utf8(text) XOR keystream)
// The iv doubles as the tag: open() decrypts, recomputes it and compares. Because the iv
// depends on the text, no randomness is needed (Zero has none), and a keystream is never
// reused for different text. The cost of determinism: the same text in the same context
// encrypts the same way, which reveals only "this field didn't change". The context names
// the table, owner, row and field, so a value can't be moved to another row or user.
//
// Every input to HMAC starts with its own label ("siv|", "ks|", "owner|", "email|", "kid|"),
// so one key serves all purposes without one output ever standing in for another.
import type { QueryServerContext } from "@spacefast/zero/server";

type VaultCtx = Pick<QueryServerContext, "crypto">;

const mac = (ctx: VaultCtx, data: string) => ctx.crypto.hmacSha256({ key: "DATA_KEY", data });

/** MySQL TEXT holds 65,535 bytes; stay clear of it. */
const MAX_SEALED = 60_000;
const SEALED = /^e1\.([0-9a-f]{8})\.([0-9a-f]{32})\.([A-Za-z0-9_-]*)$/;

export class VaultError extends Error {}

const keyIds = new WeakMap<object, Promise<string>>();

/** A public fingerprint of DATA_KEY, so data sealed under a different key fails loudly. */
function keyId(ctx: VaultCtx): Promise<string> {
  let id = keyIds.get(ctx.crypto);
  if (!id) {
    id = mac(ctx, "kid|").then((hex) => hex.slice(0, 8));
    keyIds.set(ctx.crypto, id);
    id.catch(() => keyIds.delete(ctx.crypto));
  }
  return id;
}

/** The stored owner ID: a keyed hash of the sign-in account ID, so rows can't be matched to a person without DATA_KEY. */
export async function ownerIdFor(ctx: VaultCtx, userId: string): Promise<string> {
  return `o1_${(await mac(ctx, `owner|${userId}`)).slice(0, 32)}`;
}

export function isPseudonym(ownerId: string): boolean {
  return /^o1_[0-9a-f]{32}$/.test(ownerId);
}

/** Emails are only ever compared (for blocking), so a keyed hash is enough. "" stays "". */
export async function emailHashFor(ctx: VaultCtx, email: string): Promise<string> {
  const clean = email.trim().toLowerCase();
  return clean ? `h1_${(await mac(ctx, `email|${clean}`)).slice(0, 32)}` : "";
}

export async function seal(ctx: VaultCtx, context: string, text: string): Promise<string> {
  if (text === "") return "";
  const bytes = utf8Encode(text);
  // Tag the text exactly as it will decode, so a lone surrogate (stored as U+FFFD) can't break the check.
  const [kid, tag] = await Promise.all([keyId(ctx), mac(ctx, `siv|${context}\u0000${utf8Decode(bytes)}`)]);
  const iv = tag.slice(0, 32);
  const stream = await keystream(ctx, iv, bytes.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= stream[i];
  const sealed = `e1.${kid}.${iv}.${toBase64url(bytes)}`;
  if (sealed.length > MAX_SEALED) throw new VaultError("That text is too long to store.");
  return sealed;
}

export async function open(ctx: VaultCtx, context: string, value: string): Promise<string> {
  if (value === "") return "";
  const match = SEALED.exec(value);
  if (!match) throw new VaultError("A stored value isn't in the encrypted format.");
  const [, storedKid, iv, body] = match;
  const kid = await keyId(ctx);
  if (storedKid !== kid) {
    throw new VaultError(`Stored data was encrypted with a different DATA_KEY (key ${storedKid}; this deployment has ${kid}).`);
  }
  const bytes = fromBase64url(body);
  const stream = await keystream(ctx, iv, bytes.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= stream[i];
  const text = utf8Decode(bytes);
  const check = (await mac(ctx, `siv|${context}\u0000${text}`)).slice(0, 32);
  if (!(await ctx.crypto.timingSafeEqual(check, iv))) throw new VaultError("A stored value failed its integrity check.");
  return text;
}

/** Seals several fields of one row. `scope` names the row, e.g. "jobs|o1_…|acme-em". */
export async function sealFields<K extends string>(ctx: VaultCtx, scope: string, values: Record<K, string>): Promise<Record<K, string>> {
  const keys = Object.keys(values) as K[];
  const sealed = await Promise.all(keys.map((key) => seal(ctx, `${scope}|${key}`, values[key])));
  return Object.fromEntries(keys.map((key, i) => [key, sealed[i]])) as Record<K, string>;
}

export async function openFields<K extends string>(ctx: VaultCtx, scope: string, row: Record<K, string>, keys: readonly K[]): Promise<Record<K, string>> {
  const opened = await Promise.all(keys.map((key) => open(ctx, `${scope}|${key}`, row[key] ?? "")));
  return Object.fromEntries(keys.map((key, i) => [key, opened[i]])) as Record<K, string>;
}

async function keystream(ctx: VaultCtx, iv: string, length: number): Promise<Uint8Array> {
  const blocks = Math.ceil(length / 32);
  const hexes = await Promise.all(Array.from({ length: blocks }, (_, i) => mac(ctx, `ks|${iv}|${i}`)));
  const out = new Uint8Array(blocks * 32);
  let at = 0;
  for (const hex of hexes) for (let i = 0; i < 64; i += 2) out[at++] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

// ---------- Encoding (no TextEncoder or btoa in the sandbox) ----------

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
      } else code = 0xfffd;
    } else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return Uint8Array.from(out);
}

/** Decodes valid UTF-8; anything malformed (only possible after tampering) becomes U+FFFD. */
export function utf8Decode(bytes: Uint8Array): string {
  const units: number[] = [];
  let out = "";
  const flush = () => {
    out += String.fromCharCode(...units);
    units.length = 0;
  };
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    let code = 0xfffd;
    let size = 1;
    const cont = (k: number) => i + k < bytes.length && (bytes[i + k] & 0xc0) === 0x80;
    if (b < 0x80) code = b;
    else if (b >= 0xc2 && b < 0xe0 && cont(1)) {
      code = ((b & 31) << 6) | (bytes[i + 1] & 63);
      size = 2;
    } else if (b >= 0xe0 && b < 0xf0 && cont(1) && cont(2)) {
      const c = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63);
      if (c >= 0x800 && (c < 0xd800 || c > 0xdfff)) code = c;
      size = 3;
    } else if (b >= 0xf0 && b < 0xf5 && cont(1) && cont(2) && cont(3)) {
      const c = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63);
      if (c >= 0x10000 && c <= 0x10ffff) code = c;
      size = 4;
    }
    i += size;
    if (code >= 0x10000) units.push(0xd800 + ((code - 0x10000) >> 10), 0xdc00 + ((code - 0x10000) & 1023));
    else units.push(code);
    if (units.length >= 4096) flush();
  }
  flush();
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function toBase64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}

function fromBase64url(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new VaultError("A stored value is corrupted.");
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const char of text) {
    value = (value << 6) | B64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >> bits) & 255;
    }
  }
  return out;
}
