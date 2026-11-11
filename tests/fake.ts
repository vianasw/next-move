// A small in-memory stand-in for the Zero handler context, so the agent API, the
// MCP server and the access rules can be tested without the platform. It mirrors
// only what the app uses: withIndex(eq)/collect/first, get/insert/update, crypto,
// jwt.sign (with a random jti, like the runtime) and invalidate.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

type Row = Record<string, unknown> & { id: string; createdAt: string; updatedAt: string };

const SECRETS: Record<string, string> = {
  TOKEN_SEED: "test-seed-not-a-real-key-000000000000000000",
  TOKEN_PEPPER: "test-pepper",
  DATA_KEY: "test-data-key-not-a-real-key",
};

let counter = 0;

export class FakeDb {
  tables = new Map<string, Row[]>();

  rows(name: string): Row[] {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name)!;
  }

  table(name: string) {
    const rows = () => this.rows(name);
    const builder = (list: Row[]) => {
      let items = [...list];
      const api = {
        order(direction: "asc" | "desc") {
          items.sort((a, b) => (direction === "asc" ? 1 : -1) * a.createdAt.localeCompare(b.createdAt));
          return api;
        },
        async collect() {
          return items.map((row) => ({ ...row }));
        },
        async first() {
          return items[0] ? { ...items[0] } : null;
        },
        async take(count: number) {
          return items.slice(0, count).map((row) => ({ ...row }));
        },
      };
      return api;
    };
    return {
      withIndex(_index: string, range?: (r: unknown) => unknown) {
        const predicates: [string, unknown][] = [];
        const r = {
          eq(field: string, value: unknown) {
            predicates.push([field, value]);
            return r;
          },
        };
        range?.(r);
        return builder(rows().filter((row) => predicates.every(([field, value]) => row[field] === value)));
      },
      async get(id: string) {
        const row = rows().find((item) => item.id === id);
        return row ? { ...row } : null;
      },
      async insert(value: Record<string, unknown>) {
        const now = new Date(Date.now() + counter).toISOString();
        const row = { ...value, id: `${name}_${++counter}`, createdAt: now, updatedAt: now } as Row;
        rows().push(row);
        return { ...row };
      },
      async update(id: string, patch: Record<string, unknown>) {
        const row = rows().find((item) => item.id === id);
        if (!row) return null;
        Object.assign(row, patch, { updatedAt: new Date().toISOString() });
        return { ...row };
      },
      async delete(id: string) {
        const list = rows();
        const index = list.findIndex((item) => item.id === id);
        if (index >= 0) list.splice(index, 1);
        return index >= 0;
      },
    };
  }

  proxy() {
    return new Proxy({}, { get: (_target, name: string) => this.table(name) });
  }
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

export type Identity = { userId: string; email?: string; displayName?: string; emailVerified?: boolean } | null;

/** `secrets` overrides the fake platform secrets, e.g. a different DATA_KEY. */
export function makeCtx(db: FakeDb, identity: Identity, env: Record<string, string> = {}, secrets: Record<string, string> = {}) {
  const invalidated: string[][] = [];
  const auth = identity
    ? {
        userId: identity.userId,
        displayName: identity.displayName ?? identity.userId,
        email: identity.email,
        emailVerified: identity.emailVerified ?? true,
        provider: "google",
        isAuthenticated: true,
        isGuest: false,
        isSignedIn: true,
      }
    : { userId: "guest:anon", displayName: "Guest", provider: "guest", isAuthenticated: false, isGuest: true, isSignedIn: false };
  const keyOf = (key: string | { value: string }) => (typeof key === "string" ? (secrets[key] ?? SECRETS[key]) : key.value);
  const ctx = {
    auth,
    env,
    db: db.proxy(),
    invalidate: (...names: string[]) => invalidated.push(names),
    log: { info() {}, warn() {}, error() {} },
    crypto: {
      async sha256(data: string) {
        return createHash("sha256").update(data).digest("hex");
      },
      async hmacSha256({ key, data }: { key: string | { value: string }; data: string }) {
        const secret = keyOf(key);
        if (!secret) throw new Error(`unknown secret ${String(key)}`);
        return createHmac("sha256", secret).update(data).digest("hex");
      },
      async timingSafeEqual(a: string, b: string) {
        return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
      },
    },
    jwt: {
      async sign({ key, kid, claims, ttlSeconds = 300 }: { key: string; kid: string; claims: Record<string, unknown>; ttlSeconds?: number }) {
        const iat = Math.floor(Date.now() / 1000);
        const head = b64url(JSON.stringify({ alg: "EdDSA", typ: "at+jwt", kid }));
        const body = b64url(JSON.stringify({ ...claims, iat, exp: iat + ttlSeconds, jti: randomBytes(16).toString("base64url") }));
        const sig = createHmac("sha256", SECRETS[key]).update(`${head}.${body}`).digest("base64url");
        return `${head}.${body}.${sig}`;
      },
    },
  };
  return { ctx: ctx as any, invalidated };
}

export function request(init: { method?: string; url?: string; headers?: Record<string, string>; body?: unknown }) {
  const headers = new Map(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const raw = init.body === undefined ? "" : typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  return {
    method: init.method ?? "POST",
    path: "/mcp",
    url: init.url ?? "https://nextmove.example/mcp",
    params: {},
    query: {},
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) ?? null,
      has: (name: string) => headers.has(name.toLowerCase()),
      entries: () => headers.entries(),
    },
    async text() {
      return raw;
    },
    async json() {
      return JSON.parse(raw);
    },
  } as any;
}
