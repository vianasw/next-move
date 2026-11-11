import type { QueryServerContext, ServerContext } from "@spacefast/zero/server";
import { upgradeLegacyOwner } from "./sealed";
import { emailHashFor, isPseudonym, ownerIdFor } from "./vault";

type ReadCtx = Pick<QueryServerContext, "auth" | "env" | "db" | "crypto">;
type WriteCtx = Pick<ServerContext, "auth" | "env" | "db" | "invalidate" | "crypto">;
type Env = QueryServerContext["env"];

export const DEFAULT_MEMBER_CAP = 50;

/** What the server stores and checks: a keyed hash of the account ID, and of the verified email. */
export type Member = { ownerId: string; emailHash: string };

type MemberRow = { id: string; ownerId: string; email: string; emailHash: string; via: string; createdAt: string };

/** The signed-in person as the sign-in provider reports them. Shown in the UI, never stored. */
type Person = { displayName: string; email: string; userId: string };

type Identity = Person & Member;

export type Viewer =
  | { state: "signed_out"; seatsLeft: number; cap: number }
  | ({ state: "can_join"; invited: boolean; returning: boolean; seatsLeft: number; cap: number } & Person)
  | ({ state: "no_access"; reason: "full" | "removed" } & Person)
  | ({ state: "member" } & Person);

/** Emails compare case-insensitively. User IDs compare exactly, because they're hashed as-is. */
function csv(value: string | undefined, lower: boolean): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => (lower ? item.trim().toLowerCase() : item.trim()))
    .filter(Boolean);
}

function listed(emails: string | undefined, userIds: string | undefined, email: string, userId: string): boolean {
  if (email && csv(emails, true).includes(email.toLowerCase())) return true;
  return Boolean(userId) && csv(userIds, false).includes(userId);
}

/** MEMBER_CAP overrides the default of 50. "0" makes Next move invite-only from the start. */
export function memberCap(env: Env): number {
  const raw = (env.MEMBER_CAP ?? "").trim();
  const value = /^\d+$/.test(raw) ? Number(raw) : DEFAULT_MEMBER_CAP;
  return Number.isSafeInteger(value) ? value : DEFAULT_MEMBER_CAP;
}

/** Invitations skip the cap: ALLOWED_EMAILS (verified emails) or ALLOWED_USER_IDS. */
export function invited(env: Env, email: string, userId: string): boolean {
  return listed(env.ALLOWED_EMAILS, env.ALLOWED_USER_IDS, email, userId);
}

/** The off switch, checked against the raw identity of whoever is signed in. */
function blockedPerson(env: Env, email: string, userId: string): boolean {
  return listed(env.BLOCKED_EMAILS, env.BLOCKED_USER_IDS, email, userId);
}

const blockLists = new WeakMap<object, Promise<{ owners: Set<string>; emails: Set<string> }>>();

/** BLOCKED_* hashed the way rows store identities, so agent requests and seat counts can check them. */
function hashedBlockLists(ctx: Pick<ReadCtx, "env" | "crypto">) {
  let lists = blockLists.get(ctx);
  if (!lists) {
    lists = (async () => ({
      owners: new Set(await Promise.all(csv(ctx.env.BLOCKED_USER_IDS, false).map((id) => ownerIdFor(ctx, id)))),
      emails: new Set(await Promise.all(csv(ctx.env.BLOCKED_EMAILS, true).map((email) => emailHashFor(ctx, email)))),
    }))();
    blockLists.set(ctx, lists);
  }
  return lists;
}

/** The off switch for stored identities: blocks the person and their agents, and frees their seat. */
export async function blocked(ctx: Pick<ReadCtx, "env" | "crypto">, ownerId: string, emailHash: string): Promise<boolean> {
  const lists = await hashedBlockLists(ctx);
  return lists.owners.has(ownerId) || (Boolean(emailHash) && lists.emails.has(emailHash));
}

function verifiedEmail(ctx: ReadCtx): string {
  if (!ctx.auth.isAuthenticated || ctx.auth.emailVerified === false) return "";
  return (ctx.auth.email ?? "").toLowerCase();
}

async function identity(ctx: ReadCtx): Promise<Identity | null> {
  if (!ctx.auth.isAuthenticated || !ctx.auth.userId) return null;
  const email = verifiedEmail(ctx);
  const [ownerId, emailHash] = await Promise.all([ownerIdFor(ctx, ctx.auth.userId), emailHashFor(ctx, email)]);
  return { displayName: ctx.auth.displayName, email, userId: ctx.auth.userId, ownerId, emailHash };
}

function personOf(who: Identity): Person {
  return { displayName: who.displayName, email: who.email, userId: who.userId };
}

async function memberRow(ctx: Pick<ReadCtx, "db">, ownerId: string): Promise<MemberRow | null> {
  return (await ctx.db.members.withIndex("by_owner", (range) => range.eq("ownerId", ownerId)).first()) as MemberRow | null;
}

/**
 * Open seats left. Blocked members don't hold a seat. Reads every member row, which is
 * fine at this size (the cap plus invitations) and avoids a counter that could drift.
 */
export async function seatsLeft(ctx: Pick<ReadCtx, "env" | "db" | "crypto">): Promise<number> {
  const rows = (await ctx.db.members.withIndex("by_creation").collect()) as unknown as MemberRow[];
  let taken = 0;
  for (const row of rows) {
    // A row from before encryption still has the raw account ID and email.
    const isBlocked = isPseudonym(row.ownerId) ? await blocked(ctx, row.ownerId, row.emailHash) : blockedPerson(ctx.env, row.email, row.ownerId);
    if (!isBlocked) taken++;
  }
  return Math.max(0, memberCap(ctx.env) - taken);
}

/**
 * A member has joined and isn't blocked. Joining is checked against the cap once, so
 * lowering MEMBER_CAP or filling up never evicts anyone who is already in.
 */
export async function isMember(ctx: Pick<ReadCtx, "env" | "db" | "crypto">, ownerId: string, emailHash: string): Promise<boolean> {
  if (!isPseudonym(ownerId) || (await blocked(ctx, ownerId, emailHash))) return false;
  return (await memberRow(ctx, ownerId)) !== null;
}

/** A member from before encryption, identified by their raw account ID and email. */
export async function isLegacyMember(ctx: Pick<ReadCtx, "env" | "db">, userId: string, email: string): Promise<boolean> {
  if (isPseudonym(userId) || blockedPerson(ctx.env, email, userId)) return false;
  return (await memberRow(ctx, userId)) !== null;
}

export async function memberOrNull(ctx: ReadCtx): Promise<Member | null> {
  const who = await identity(ctx);
  if (!who || !(await isMember(ctx, who.ownerId, who.emailHash))) return null;
  return { ownerId: who.ownerId, emailHash: who.emailHash };
}

export async function requireMember(ctx: ReadCtx): Promise<Member> {
  const member = await memberOrNull(ctx);
  if (!member) throw new Error("Join Next move with your account first.");
  return member;
}

/**
 * Every owner ID the signed-in person's rows could be stored under, member or not: the
 * keyed hash and, until they've been upgraded, the raw account ID. Deleting your data only
 * needs this, so a blocked person can still erase what they left behind.
 */
export async function signedInOwnerIds(ctx: ReadCtx): Promise<string[]> {
  const who = await identity(ctx);
  if (!who) throw new Error("Sign in first.");
  return [who.ownerId, who.userId];
}

export async function viewerOf(ctx: ReadCtx): Promise<Viewer> {
  const cap = memberCap(ctx.env);
  const who = await identity(ctx);
  if (!who) return { state: "signed_out", seatsLeft: await seatsLeft(ctx), cap };
  const person = personOf(who);
  if (blockedPerson(ctx.env, who.email, who.userId)) return { state: "no_access", reason: "removed", ...person };
  if (await memberRow(ctx, who.ownerId)) return { state: "member", ...person };
  const left = await seatsLeft(ctx);
  // Joined before encryption: their seat is theirs, and joining again upgrades their data.
  if (await memberRow(ctx, who.userId)) return { state: "can_join", invited: false, returning: true, seatsLeft: left, cap, ...person };
  const isInvited = invited(ctx.env, who.email, who.userId);
  if (isInvited || left > 0) return { state: "can_join", invited: isInvited, returning: false, seatsLeft: left, cap, ...person };
  return { state: "no_access", reason: "full", ...person };
}

/**
 * Claims a seat, uses an invitation once the seats are gone, or upgrades a member who
 * joined before encryption. Idempotent.
 *
 * The count and the insert aren't atomic: Zero has no unique constraints and doesn't
 * document its isolation level. Two people claiming the very last seat at the same
 * moment could both get in, so the worst case is a member or two over the cap.
 */
export async function join(ctx: WriteCtx): Promise<Member> {
  const who = await identity(ctx);
  if (!who) throw new Error("Sign in first.");
  if (blockedPerson(ctx.env, who.email, who.userId)) throw new Error("This account doesn't have access to Next move.");
  const member = { ownerId: who.ownerId, emailHash: who.emailHash };
  if (await memberRow(ctx, who.ownerId)) return member;
  if (await memberRow(ctx, who.userId)) {
    await upgradeLegacyOwner(ctx, who.userId);
    ctx.invalidate();
    return member;
  }
  const isInvited = invited(ctx.env, who.email, who.userId);
  if (!isInvited && (await seatsLeft(ctx)) <= 0) {
    throw new Error("Next move just filled up and is invite-only now.");
  }
  await ctx.db.members.insert({ ownerId: who.ownerId, emailHash: who.emailHash, email: "", displayName: "", via: isInvited ? "invite" : "open" });
  ctx.invalidate("viewer", "workspace", "agentActivity");
  return member;
}
