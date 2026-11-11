// Everything that reads or writes user data. The REST endpoints, the MCP tools and
// the UI all go through these functions, so the rules live in exactly one place.
//
// Private fields are stored encrypted (see sealed.ts for which ones, vault.ts for how).
// Rows go in sealed and come out through openRow(); nothing else should read them raw.
import type { QueryServerContext, ServerContext } from "@spacefast/zero/server";
import {
  ContractError,
  LIMITS,
  canonicalUrl,
  validateIcons,
  validateJobs,
  validateProfile,
  validateRun,
  validateTracks,
  type JobInput,
  type ProfileInput,
  type Status,
  type TrackInput,
} from "../shared/contract";
import { HANDOFF_MINUTES, MCP_KEY_DAYS, SESSION_HOURS } from "../shared/prompts";
import { isLegacyMember, isMember, type Member } from "./access";
import { openRow, scopeFor, upgradeLegacyOwner } from "./sealed";
import { hashSecret, isoIn, mintSecret, nowIso, todayIso } from "./tokens";
import { isPseudonym, open, seal, sealFields } from "./vault";

type ReadCtx = QueryServerContext;
type WriteCtx = ServerContext;

type Row = { id: string; createdAt: string; updatedAt: string };

export type ProfileRow = Row & {
  ownerId: string;
  headline: string;
  summary: string;
  location: string;
  workAuthorization: string;
  remotePreference: string;
  strengths: string;
  doNotAssume: string;
  dealbreakers: string;
  sources: string;
};

export type TrackRow = Row & {
  ownerId: string;
  key: string;
  title: string;
  seniority: string;
  salaryTarget: string;
  salaryCurrency: string;
  salaryBasis: string;
  searchNotes: string;
  active: boolean;
};

export type JobRow = Row & {
  ownerId: string;
  key: string;
  trackKey: string;
  canonicalUrl: string;
  title: string;
  companyName: string;
  companyWebsite: string;
  companyIcon?: string;
  companySummary: string;
  companyIndustry: string;
  remoteModel: string;
  remoteSummary: string;
  applyUrl: string;
  location: string;
  eligibility: string;
  workplace: string;
  salary: string;
  salaryNote: string;
  fit: string;
  fitSummary: string;
  highlights: string;
  caveats: string;
  tags: string;
  sourceName: string;
  sourceUrl: string;
  firstFound: string;
  lastVerified: string;
  openingStatus: string;
  status: string;
  notes: string;
  statusChangedAt: string;
};

export type KeyRow = Row & {
  ownerId: string;
  ownerEmailHash: string;
  label: string;
  kind: string;
  keyHash: string;
  keyPrefix: string;
  expiresAt: string;
  lastUsedAt: string;
  revokedAt: string;
};

type HandoffRow = Row & {
  ownerId: string;
  ownerEmailHash: string;
  codeHash: string;
  purpose: string;
  expiresAt: string;
  usedAt: string;
  agentKeyId: string;
};

type RunRow = Row & {
  ownerId: string;
  agentKeyId: string;
  agentLabel: string;
  summary: string;
  added: string;
  updated: string;
  closed: string;
};

/** A request problem the caller can fix; never thrown after a write has started. */
export class RequestError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function ownerRows<T>(ctx: ReadCtx | WriteCtx, table: string, ownerId: string): Promise<T[]> {
  return (await ctx.db[table].withIndex("by_owner", (range) => range.eq("ownerId", ownerId)).collect()) as T[];
}

// ---------- Views (take decrypted rows) ----------

export function profileView(row: ProfileRow | null) {
  if (!row) return null;
  return {
    headline: row.headline,
    summary: row.summary,
    location: row.location,
    workAuthorization: row.workAuthorization,
    remotePreference: row.remotePreference,
    strengths: parseList(row.strengths),
    doNotAssume: parseList(row.doNotAssume),
    dealbreakers: parseList(row.dealbreakers),
    sources: row.sources,
    updatedAt: row.updatedAt,
  };
}

export function trackView(row: TrackRow) {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    seniority: row.seniority,
    salaryTarget: row.salaryTarget === "" ? null : Number(row.salaryTarget),
    salaryCurrency: row.salaryCurrency,
    salaryBasis: row.salaryBasis,
    searchNotes: row.searchNotes,
    active: row.active,
  };
}

export function jobView(row: JobRow) {
  return {
    id: row.id,
    key: row.key,
    trackKey: row.trackKey,
    title: row.title,
    company: {
      name: row.companyName,
      website: row.companyWebsite,
      icon: row.companyIcon ?? "",
      summary: row.companySummary,
      industry: row.companyIndustry,
      remoteModel: row.remoteModel,
      remoteSummary: row.remoteSummary,
    },
    applyUrl: row.applyUrl,
    location: row.location,
    eligibility: row.eligibility,
    workplace: row.workplace,
    salary: row.salary,
    salaryNote: row.salaryNote,
    fit: row.fit,
    fitSummary: row.fitSummary,
    highlights: parseList(row.highlights),
    caveats: parseList(row.caveats),
    tags: parseList(row.tags),
    source: { name: row.sourceName, url: row.sourceUrl },
    firstFound: row.firstFound,
    lastVerified: row.lastVerified,
    openingStatus: row.openingStatus,
    status: row.status,
    notes: row.notes,
    statusChangedAt: row.statusChangedAt,
    updatedAt: row.updatedAt,
  };
}

async function openProfile(ctx: ReadCtx, ownerId: string) {
  const [row] = await ownerRows<ProfileRow>(ctx, "profiles", ownerId);
  return row ? profileView(await openRow(ctx, "profiles", row)) : null;
}

async function openTracks(ctx: ReadCtx, ownerId: string) {
  const rows = await ownerRows<TrackRow>(ctx, "tracks", ownerId);
  return Promise.all(rows.map(async (row) => trackView(await openRow(ctx, "tracks", row))));
}

export async function workspace(ctx: ReadCtx, ownerId: string) {
  const jobRows = await ownerRows<JobRow>(ctx, "jobs", ownerId);
  const [profile, tracks, jobs] = await Promise.all([
    openProfile(ctx, ownerId),
    openTracks(ctx, ownerId),
    Promise.all(jobRows.map(async (row) => jobView(await openRow(ctx, "jobs", row)))),
  ]);
  return { today: todayIso(), profile, tracks, jobs };
}

// ---------- Agent operations ----------

/** What an agent sees: everything it needs to dedupe and judge, minus private notes. */
export async function agentContext(ctx: ReadCtx, ownerId: string) {
  const jobRows = await ownerRows<JobRow>(ctx, "jobs", ownerId);
  const [profile, tracks, jobs] = await Promise.all([
    openProfile(ctx, ownerId),
    openTracks(ctx, ownerId),
    // Decrypt only what the agent gets; notes stay sealed.
    Promise.all(jobRows.map((row) => openRow(ctx, "jobs", row, ["fit", "status"]))),
  ]);
  return {
    today: todayIso(),
    profile,
    tracks: tracks.map(({ id: _id, ...track }) => track),
    jobs: jobs.map((job) => ({
      key: job.key,
      trackKey: job.trackKey,
      title: job.title,
      company: job.companyName,
      companyWebsite: job.companyWebsite,
      companyIcon: job.companyIcon ?? "",
      applyUrl: job.applyUrl,
      location: job.location,
      salary: job.salary,
      fit: job.fit,
      openingStatus: job.openingStatus,
      firstFound: job.firstFound,
      lastVerified: job.lastVerified,
      applicationStatus: job.status,
    })),
    limits: { jobsPerSave: LIMITS.jobsPerSave, jobsPerUser: LIMITS.jobsPerUser },
  };
}

function profileFields(profile: ProfileInput) {
  return {
    headline: profile.headline,
    summary: profile.summary,
    location: profile.location,
    workAuthorization: profile.workAuthorization,
    remotePreference: profile.remotePreference,
    strengths: JSON.stringify(profile.strengths),
    doNotAssume: JSON.stringify(profile.doNotAssume),
    dealbreakers: JSON.stringify(profile.dealbreakers),
    sources: profile.sources,
  };
}

export async function saveProfile(ctx: WriteCtx, ownerId: string, raw: unknown) {
  const profile = validateProfile(raw);
  const sealed = await sealFields(ctx, scopeFor("profiles", ownerId), profileFields(profile));
  const [existing] = await ownerRows<ProfileRow>(ctx, "profiles", ownerId);
  if (existing) await ctx.db.profiles.update(existing.id, sealed);
  else await ctx.db.profiles.insert({ ownerId, ...sealed });
  ctx.invalidate();
  return { saved: true };
}

async function sealedTrack(ctx: WriteCtx, ownerId: string, track: TrackInput) {
  const text = {
    title: track.title,
    seniority: track.seniority,
    salaryTarget: track.salaryTarget === null ? "" : String(track.salaryTarget),
    salaryCurrency: track.salaryCurrency,
    salaryBasis: track.salaryBasis,
    searchNotes: track.searchNotes,
  };
  return { ...(await sealFields(ctx, scopeFor("tracks", ownerId, track.key), text)), active: track.active };
}

export async function saveTracks(ctx: WriteCtx, ownerId: string, raw: unknown) {
  const tracks = validateTracks(raw);
  const existing = await ownerRows<TrackRow>(ctx, "tracks", ownerId);
  const byKey = new Map(existing.map((row) => [row.key, row]));
  const newCount = tracks.filter((track) => !byKey.has(track.key)).length;
  if (existing.length + newCount > LIMITS.tracksPerUser) {
    throw new ContractError([`A user can have at most ${LIMITS.tracksPerUser} roles; reuse existing keys`]);
  }
  const sealed = await Promise.all(tracks.map((track) => sealedTrack(ctx, ownerId, track)));
  const created: string[] = [];
  const updated: string[] = [];
  for (const [index, track] of tracks.entries()) {
    const row = byKey.get(track.key);
    if (row) {
      await ctx.db.tracks.update(row.id, sealed[index]);
      updated.push(track.key);
    } else {
      await ctx.db.tracks.insert({ ownerId, key: track.key, ...sealed[index] });
      created.push(track.key);
    }
  }
  ctx.invalidate();
  return { created, updated };
}

/** Research fields: the posting stays plain; the agent's judgment of the user is sealed. */
async function sealedResearch(ctx: WriteCtx, ownerId: string, job: JobInput) {
  const judgment = await sealFields(ctx, scopeFor("jobs", ownerId, job.key), {
    fit: job.fit,
    eligibility: job.eligibility,
    fitSummary: job.fitSummary,
    caveats: JSON.stringify(job.caveats),
    salaryNote: job.salaryNote,
  });
  return {
    trackKey: job.trackKey,
    canonicalUrl: canonicalUrl(job.applyUrl),
    title: job.title,
    companyName: job.company.name,
    companyWebsite: job.company.website,
    companyIcon: job.company.icon,
    companySummary: job.company.summary,
    companyIndustry: job.company.industry,
    remoteModel: job.company.remoteModel,
    remoteSummary: job.company.remoteSummary,
    applyUrl: job.applyUrl,
    location: job.location,
    workplace: job.workplace,
    salary: job.salary,
    highlights: JSON.stringify(job.highlights),
    tags: JSON.stringify(job.tags),
    sourceName: job.source.name,
    sourceUrl: job.source.url,
    lastVerified: job.lastVerified,
    openingStatus: job.openingStatus,
    ...judgment,
  };
}

/**
 * Upserts research by stable key. Validation and encryption happen before the first
 * write, so a bad batch saves nothing. Application status, notes and firstFound are
 * never touched by an agent.
 */
export async function saveJobs(ctx: WriteCtx, ownerId: string, raw: unknown) {
  const today = todayIso();
  const jobs = validateJobs(raw, today);
  const [tracks, existing] = await Promise.all([
    ownerRows<TrackRow>(ctx, "tracks", ownerId),
    ownerRows<JobRow>(ctx, "jobs", ownerId),
  ]);
  const trackKeys = tracks.map((track) => track.key);
  const byKey = new Map(existing.map((row) => [row.key, row]));
  const byUrl = new Map(existing.map((row) => [row.canonicalUrl, row]));
  const problems: string[] = [];
  jobs.forEach((job, index) => {
    if (!trackKeys.includes(job.trackKey)) {
      const known = trackKeys.length ? `one of: ${trackKeys.join(", ")}` : "none saved yet; save the roles first";
      problems.push(`jobs[${index}].trackKey "${job.trackKey}" isn't one of the user's roles (${known})`);
    }
    const owner = byUrl.get(canonicalUrl(job.applyUrl));
    if (owner && owner.key !== job.key) {
      problems.push(`jobs[${index}].applyUrl is already tracked as "${owner.key}"; reuse that key`);
    }
  });
  const newCount = jobs.filter((job) => !byKey.has(job.key)).length;
  if (existing.length + newCount > LIMITS.jobsPerUser) {
    problems.push(`This would exceed ${LIMITS.jobsPerUser} tracked jobs`);
  }
  if (problems.length) throw new ContractError(problems);

  const research = await Promise.all(jobs.map((job) => sealedResearch(ctx, ownerId, job)));
  const shortlisted = await Promise.all(
    jobs.map((job) => (byKey.has(job.key) ? null : sealFields(ctx, scopeFor("jobs", ownerId, job.key), { status: "shortlisted" }))),
  );
  const created: string[] = [];
  const updated: string[] = [];
  for (const [index, job] of jobs.entries()) {
    const row = byKey.get(job.key);
    if (row) {
      await ctx.db.jobs.update(row.id, { ...research[index], firstFound: row.firstFound || job.firstFound || today });
      updated.push(job.key);
    } else {
      await ctx.db.jobs.insert({
        ownerId,
        key: job.key,
        ...research[index],
        firstFound: job.firstFound || today,
        status: shortlisted[index]!.status,
        notes: "",
        statusChangedAt: "",
      });
      created.push(job.key);
    }
  }
  ctx.invalidate();
  return { created, updated };
}

/**
 * Sets the company icon on jobs that are already tracked, matched by key, and touches
 * nothing else. save_jobs replaces a whole job, and agents can't read back the research
 * they'd have to resend, so adding icons to older jobs needs its own narrow write.
 */
export async function saveCompanyIcons(ctx: WriteCtx, ownerId: string, raw: unknown) {
  const icons = validateIcons(raw);
  const byKey = new Map((await ownerRows<JobRow>(ctx, "jobs", ownerId)).map((row) => [row.key, row]));
  const problems = icons.flatMap((item, index) => (byKey.has(item.key) ? [] : [`icons[${index}].key "${item.key}" isn't a tracked job`]));
  if (problems.length) throw new ContractError(problems);
  for (const item of icons) await ctx.db.jobs.update(byKey.get(item.key)!.id, { companyIcon: item.icon });
  ctx.invalidate();
  return { updated: [...new Set(icons.map((item) => item.key))] };
}

export async function logRun(ctx: WriteCtx, key: KeyRow, raw: unknown) {
  const run = validateRun(raw);
  await ctx.db.runs.insert({
    ownerId: key.ownerId,
    agentKeyId: key.id,
    agentLabel: key.label,
    summary: await seal(ctx, `${scopeFor("runs", key.ownerId)}|summary`, run.summary),
    added: String(run.added),
    updated: String(run.updated),
    closed: String(run.closed),
  });
  ctx.invalidate();
  return { logged: true };
}

// ---------- User-only operations ----------

async function ownedJob(ctx: WriteCtx, ownerId: string, jobId: string): Promise<JobRow> {
  const row = (await ctx.db.jobs.get(jobId)) as JobRow | null;
  if (!row || row.ownerId !== ownerId) throw new Error("That job isn't in your tracker.");
  return row;
}

export async function setStatus(ctx: WriteCtx, ownerId: string, jobId: string, status: Status) {
  const row = await ownedJob(ctx, ownerId, jobId);
  const context = `${scopeFor("jobs", ownerId, row.key)}|status`;
  if ((await open(ctx, context, row.status)) !== status) {
    await ctx.db.jobs.update(row.id, { status: await seal(ctx, context, status), statusChangedAt: nowIso() });
  }
  ctx.invalidate("workspace");
}

export async function saveNotes(ctx: WriteCtx, ownerId: string, jobId: string, notes: string) {
  if (typeof notes !== "string" || notes.length > LIMITS.notes) throw new Error(`Notes are limited to ${LIMITS.notes} characters.`);
  const row = await ownedJob(ctx, ownerId, jobId);
  await ctx.db.jobs.update(row.id, { notes: await seal(ctx, `${scopeFor("jobs", ownerId, row.key)}|notes`, notes) });
  ctx.invalidate("workspace");
}

export async function setTrackActive(ctx: WriteCtx, ownerId: string, trackId: string, active: boolean) {
  const row = (await ctx.db.tracks.get(trackId)) as TrackRow | null;
  if (!row || row.ownerId !== ownerId) throw new Error("That role isn't yours.");
  await ctx.db.tracks.update(row.id, { active: Boolean(active) });
  ctx.invalidate("workspace");
}

/** Every table with rows that belong to one person. Membership goes last. */
const OWNED_TABLES = ["jobs", "tracks", "profiles", "runs", "agentKeys", "handoffs", "members"] as const;

/**
 * "Delete my data". Removes every row stored under any of the owner's IDs (see
 * signedInOwnerIds), including agent keys (their agents stop working) and membership
 * (their seat frees up). It runs in the mutation's transaction: everything or nothing.
 */
export async function deleteAccount(ctx: WriteCtx, ownerIds: string[]) {
  const deleted: Record<string, number> = {};
  for (const table of OWNED_TABLES) {
    deleted[table] = 0;
    for (const ownerId of ownerIds) {
      const rows = await ownerRows<Row>(ctx, table, ownerId);
      for (const row of rows) await ctx.db[table].delete(row.id);
      deleted[table] += rows.length;
    }
  }
  ctx.invalidate();
  return deleted;
}

// ---------- Credentials ----------

function keyView(row: KeyRow) {
  const now = nowIso();
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    keyPrefix: row.keyPrefix,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    state: row.revokedAt ? "revoked" : row.expiresAt <= now ? "expired" : "active",
  };
}

export async function agentActivity(ctx: ReadCtx, ownerId: string) {
  const [keys, runs] = await Promise.all([
    ownerRows<KeyRow>(ctx, "agentKeys", ownerId),
    ownerRows<RunRow>(ctx, "runs", ownerId),
  ]);
  const recent = runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
  return {
    keys: keys.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(keyView),
    runs: await Promise.all(
      recent.map(async (row) => {
        const run = await openRow(ctx, "runs", row);
        return {
          id: run.id,
          agentLabel: run.agentLabel,
          summary: run.summary,
          added: Number(run.added),
          updated: Number(run.updated),
          closed: Number(run.closed),
          createdAt: run.createdAt,
        };
      }),
    ),
  };
}

async function issueKey(ctx: WriteCtx, owner: Member, label: string, kind: "session" | "mcp", ttlMs: number) {
  const secret = await mintSecret(ctx, "nmk");
  const expiresAt = isoIn(ttlMs);
  const row = (await ctx.db.agentKeys.insert({
    ownerId: owner.ownerId,
    ownerEmail: "",
    ownerEmailHash: owner.emailHash,
    label,
    kind,
    keyHash: await hashSecret(ctx, secret),
    keyPrefix: secret.slice(0, 8),
    expiresAt,
    lastUsedAt: "",
    revokedAt: "",
  })) as KeyRow;
  return { secret, expiresAt, row };
}

function cleanLabel(value: unknown, fallback: string): string {
  const label = typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 60) : "";
  return label || fallback;
}

export async function createHandoff(ctx: WriteCtx, member: Member, purpose: "onboarding" | "update") {
  if (purpose !== "onboarding" && purpose !== "update") throw new Error("Unknown prompt type.");
  const code = await mintSecret(ctx, "nmh");
  const expiresAt = isoIn(HANDOFF_MINUTES * 60_000);
  await ctx.db.handoffs.insert({
    ownerId: member.ownerId,
    ownerEmail: "",
    ownerEmailHash: member.emailHash,
    codeHash: await hashSecret(ctx, code),
    purpose,
    expiresAt,
    usedAt: "",
    agentKeyId: "",
  });
  return { code, expiresAt };
}

/** One-time code in, short-lived API key out. A used or expired code is refused. */
export async function redeemHandoff(ctx: WriteCtx, raw: unknown) {
  const body = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!/^nmh_[A-Za-z0-9_-]{43}$/.test(code)) {
    throw new RequestError(400, "invalid_code", "Send the one-time code from the prompt as {\"code\": \"nmh_...\"}.");
  }
  const codeHash = await hashSecret(ctx, code);
  const handoff = (await ctx.db.handoffs.withIndex("by_hash", (range) => range.eq("codeHash", codeHash)).first()) as HandoffRow | null;
  if (!handoff || handoff.usedAt || handoff.expiresAt <= nowIso()) {
    throw new RequestError(400, "code_unavailable", "This code is unknown, already used, or expired. Ask the user to copy a fresh prompt from Next move.");
  }
  if (!(await isMember(ctx, handoff.ownerId, handoff.ownerEmailHash))) {
    throw new RequestError(403, "no_access", "This account no longer has access to Next move.");
  }
  const label = cleanLabel(body.agentName, "Agent");
  const issued = await issueKey(ctx, { ownerId: handoff.ownerId, emailHash: handoff.ownerEmailHash }, label, "session", SESSION_HOURS * 3_600_000);
  await ctx.db.handoffs.update(handoff.id, { usedAt: nowIso(), agentKeyId: issued.row.id });
  ctx.invalidate("agentActivity");
  return { apiKey: issued.secret, expiresAt: issued.expiresAt, purpose: handoff.purpose };
}

export async function createMcpKey(ctx: WriteCtx, member: Member, label: unknown) {
  const issued = await issueKey(ctx, member, cleanLabel(label, "MCP connection"), "mcp", MCP_KEY_DAYS * 86_400_000);
  ctx.invalidate("agentActivity");
  return { key: issued.secret, expiresAt: issued.expiresAt };
}

export async function revokeKey(ctx: WriteCtx, ownerId: string, keyId: string) {
  const row = (await ctx.db.agentKeys.get(keyId)) as KeyRow | null;
  if (!row || row.ownerId !== ownerId) throw new Error("That key isn't yours.");
  if (!row.revokedAt) await ctx.db.agentKeys.update(row.id, { revokedAt: nowIso() });
  ctx.invalidate("agentActivity");
}

/**
 * Resolves `Authorization: Bearer nmk_...` to a live key, or null. Lookup is by
 * HMAC, so the stored value can't be replayed even if the database leaks.
 *
 * A key issued before encryption still carries its owner's raw account ID. When the
 * request can write, its owner's rows are upgraded on the spot and the key carries on.
 */
export async function authenticateAgent(ctx: ReadCtx | WriteCtx, header: string | null, canWrite: boolean): Promise<KeyRow | null> {
  const match = /^Bearer\s+(nmk_[A-Za-z0-9_-]{43})\s*$/.exec(header ?? "");
  if (!match) return null;
  const keyHash = await hashSecret(ctx, match[1]);
  let row = (await ctx.db.agentKeys.withIndex("by_hash", (range) => range.eq("keyHash", keyHash)).first()) as KeyRow | null;
  if (!row || row.revokedAt || row.expiresAt <= nowIso()) return null;
  if (!isPseudonym(row.ownerId)) {
    const legacyEmail = String((row as KeyRow & { ownerEmail?: string }).ownerEmail ?? "");
    if (!canWrite || !(await isLegacyMember(ctx, row.ownerId, legacyEmail))) return null;
    await upgradeLegacyOwner(ctx as WriteCtx, row.ownerId);
    (ctx as WriteCtx).invalidate();
    row = (await ctx.db.agentKeys.get(row.id)) as KeyRow;
  }
  if (!(await isMember(ctx, row.ownerId, row.ownerEmailHash))) return null;
  const staleAfter = new Date(Date.now() - 60_000).toISOString();
  if (canWrite && (!row.lastUsedAt || row.lastUsedAt < staleAfter)) {
    await (ctx as WriteCtx).db.agentKeys.update(row.id, { lastUsedAt: nowIso() });
  }
  return row;
}
