// Which stored fields are encrypted, what each one is bound to, and the one-time upgrade
// of rows written before encryption existed.
//
// Encrypted: everything people say about themselves, plus the agent's judgment of them
// (fit, eligibility, fitSummary, caveats, salaryNote) because that's written from their
// profile. Plain: job postings, which are public anyway, and the keys and IDs the app
// looks rows up by. Owner IDs and emails are keyed hashes (see vault.ts).
import type { ServerContext } from "@spacefast/zero/server";
import { emailHashFor, openFields, ownerIdFor, sealFields } from "./vault";

type WriteCtx = Pick<ServerContext, "crypto" | "db">;
type Row = { id: string; ownerId: string; key?: string } & Record<string, unknown>;

export const SEALED = {
  profiles: ["headline", "summary", "location", "workAuthorization", "remotePreference", "strengths", "doNotAssume", "dealbreakers", "sources"],
  tracks: ["title", "seniority", "salaryTarget", "salaryCurrency", "salaryBasis", "searchNotes"],
  jobs: ["fit", "eligibility", "fitSummary", "caveats", "salaryNote", "status", "notes"],
  runs: ["summary"],
} as const;

export type SealedTable = keyof typeof SEALED;

/** What a value is bound to: table, owner and, for tables with stable keys, the row. */
export function scopeFor(table: SealedTable, ownerId: string, key?: string): string {
  return key === undefined ? `${table}|${ownerId}` : `${table}|${ownerId}|${key}`;
}

function rowScope(table: SealedTable, row: Row): string {
  return scopeFor(table, row.ownerId, table === "tracks" || table === "jobs" ? String(row.key) : undefined);
}

/** A copy of the row with the given encrypted fields (all of them by default) decrypted. */
export async function openRow<T extends Row>(
  ctx: Pick<ServerContext, "crypto">,
  table: SealedTable,
  row: T,
  fields: readonly string[] = SEALED[table],
): Promise<T> {
  const opened = await openFields(ctx, rowScope(table, row), row as Record<string, string>, fields);
  return { ...row, ...opened };
}

function pick(row: Row, fields: readonly string[]): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field, String(row[field] ?? "")]));
}

const OWNED = ["profiles", "tracks", "jobs", "runs", "agentKeys", "handoffs", "members"] as const;

/**
 * Upgrades everything a pre-encryption owner has: the raw account ID becomes its keyed
 * hash, private fields get encrypted, and stored emails and names become a hash or "".
 * It runs inside the caller's transaction, so it's all or nothing. Running it twice
 * concurrently is harmless: encryption is deterministic, so both write the same values.
 */
export async function upgradeLegacyOwner(ctx: WriteCtx, legacyId: string): Promise<Record<string, number>> {
  const ownerId = await ownerIdFor(ctx, legacyId);
  const counts: Record<string, number> = {};
  for (const table of OWNED) {
    const rows = (await ctx.db[table].withIndex("by_owner", (range) => range.eq("ownerId", legacyId)).collect()) as unknown as Row[];
    for (const row of rows) {
      let patch: Record<string, unknown>;
      if (table === "agentKeys" || table === "handoffs") {
        patch = { ownerEmail: "", ownerEmailHash: await emailHashFor(ctx, String(row.ownerEmail ?? "")) };
      } else if (table === "members") {
        patch = { email: "", displayName: "", emailHash: await emailHashFor(ctx, String(row.email ?? "")) };
      } else {
        patch = await sealFields(ctx, rowScope(table, { ...row, ownerId }), pick(row, SEALED[table]));
      }
      await ctx.db[table].update(row.id, { ...patch, ownerId });
    }
    counts[table] = rows.length;
  }
  return counts;
}
