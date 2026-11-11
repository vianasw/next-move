import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { beforeEach, describe, test } from "node:test";
import { canonicalUrl, isHttpUrl, isIsoDate, validateJobs } from "../shared/contract";
import { join, memberOrNull, requireMember, seatsLeft, signedInOwnerIds, viewerOf } from "../server/access";
import {
  agentContext,
  authenticateAgent,
  createHandoff,
  createMcpKey,
  deleteAccount,
  logRun,
  redeemHandoff,
  saveCompanyIcons,
  revokeKey,
  saveJobs,
  saveNotes,
  saveProfile,
  saveTracks,
  setStatus,
  workspace,
} from "../server/data";
import { handleMcp } from "../server/mcp";
import { hashSecret } from "../server/tokens";
import { emailHashFor, open, ownerIdFor, seal, utf8Decode, utf8Encode } from "../server/vault";
import { FakeDb, makeCtx, request, type Identity } from "./fake";

const WILL = { userId: "user_will", email: "will@example.com", displayName: "Will" };
const ANA = { userId: "user_ana", email: "ana@example.com", displayName: "Ana" };
const today = new Date().toISOString().slice(0, 10);

function job(overrides: Record<string, unknown> = {}) {
  return {
    key: "acme-platform-em",
    trackKey: "engineering-manager",
    title: "Engineering Manager, Platform",
    company: { name: "Acme", website: "https://acme.example", summary: "Builds rockets.", industry: "Aerospace", remoteModel: "Fully distributed", remoteSummary: "Remote everywhere." },
    applyUrl: "https://jobs.acme.example/em-platform",
    location: "EMEA · Remote",
    eligibility: "likely",
    workplace: "remote_first",
    salary: "Not published",
    salaryNote: "",
    fit: "strong",
    fitSummary: "Matches distributed management experience.",
    highlights: ["Lead the platform team"],
    caveats: ["Salary not published"],
    tags: ["Platform"],
    source: { name: "Lenny's Jobs", url: "https://www.lennysjobs.com/" },
    lastVerified: today,
    openingStatus: "open",
    ...overrides,
  };
}

const TRACKS = [
  { key: "engineering-manager", title: "Engineering Manager", salaryTarget: 125000, salaryCurrency: "EUR", salaryBasis: "base" },
  { key: "senior-swe", title: "Senior Software Engineer", salaryTarget: 110000, salaryCurrency: "EUR", salaryBasis: "base" },
];

/** The owner ID rows are stored under: a keyed hash of the account ID. */
const ownerOf = (userId: string) => ownerIdFor(makeCtx(new FakeDb(), null).ctx, userId);

async function joined(db: FakeDb, who: NonNullable<Identity> = WILL, env: Record<string, string> = {}) {
  const { ctx } = makeCtx(db, who, env);
  const member = await join(ctx);
  return { ctx, member };
}

async function connect(db: FakeDb, who = WILL) {
  const { ctx, member } = await joined(db, who);
  const { code } = await createHandoff(ctx, member, "onboarding");
  const { ctx: anon } = makeCtx(db, null);
  const { apiKey } = await redeemHandoff(anon, { code, agentName: "Test agent" });
  const key = await authenticateAgent(anon, `Bearer ${apiKey}`, true);
  assert.ok(key, "a freshly issued key authenticates");
  return { apiKey, key: key!, ctx: anon };
}

describe("contract", () => {
  test("canonical URLs ignore tracking params, case, fragments and trailing slashes", () => {
    assert.equal(canonicalUrl("HTTPS://Jobs.Acme.example/em/?utm_source=x&id=7#apply"), "https://jobs.acme.example/em?id=7");
    assert.equal(canonicalUrl("https://a.example/x?b=2&a=1"), canonicalUrl("https://a.example/x/?a=1&b=2&gclid=zzz"));
  });

  test("URLs must be absolute http(s) without credentials", () => {
    assert.ok(isHttpUrl("https://example.com/jobs/1"));
    assert.ok(!isHttpUrl("javascript:alert(1)"));
    assert.ok(!isHttpUrl("https://user:pass@example.com/"));
    assert.ok(!isHttpUrl("/relative"));
  });

  test("a company icon is optional, and must be https because the page loads it", () => {
    const company = job().company;
    assert.equal(validateJobs([job()], today)[0].company.icon, "");
    const icon = "https://cdn.acme.example/apple-touch-icon.png";
    assert.equal(validateJobs([job({ company: { ...company, icon } })], today)[0].company.icon, icon);
    for (const bad of ["http://acme.example/favicon.ico", "data:image/png;base64,AAAA", "/favicon.ico"]) {
      assert.throws(() => validateJobs([job({ company: { ...company, icon: bad } })], today), /company\.icon must be an absolute https URL/);
    }
  });

  test("dates must be real and not in the future", () => {
    assert.ok(isIsoDate("2026-02-28"));
    assert.ok(!isIsoDate("2026-02-30"));
    assert.throws(() => validateJobs([job({ lastVerified: "2999-01-01" })], today), /can't be in the future/);
  });

  test("a bad batch reports every problem at once", () => {
    try {
      validateJobs([job({ fit: "amazing" }), job({ key: "Bad Key", applyUrl: "nope" })], today);
      assert.fail("should throw");
    } catch (error: any) {
      assert.equal(error.problems.length, 3);
    }
  });
});

describe("access", () => {
  const person = (n: number) => ({ userId: `u_${n}`, email: `person${n}@example.com`, displayName: `Person ${n}` });
  const state = async (db: FakeDb, who: Identity, env: Record<string, string> = {}) => (await viewerOf(makeCtx(db, who, env).ctx)).state;

  test("anyone can claim a spot until the cap, then it's invite-only", async () => {
    const db = new FakeDb();
    const env = { MEMBER_CAP: "2", ALLOWED_EMAILS: "invitee@example.com" };
    assert.deepEqual(await viewerOf(makeCtx(db, null, env).ctx), { state: "signed_out", seatsLeft: 2, cap: 2 });

    assert.equal(await state(db, person(1), env), "can_join");
    assert.equal(await state(db, person(1), env), "can_join", "signing in alone doesn't take a seat");
    await joined(db, person(1), env);
    await joined(db, person(1), env);
    assert.equal(db.rows("members").length, 1, "joining twice keeps one seat");
    await joined(db, person(2), env);

    assert.deepEqual(await viewerOf(makeCtx(db, person(3), env).ctx), { state: "no_access", reason: "full", ...{ displayName: "Person 3", email: "person3@example.com", userId: "u_3" } });
    await assert.rejects(join(makeCtx(db, person(3), env).ctx), /invite-only/);
    assert.equal(await seatsLeft(makeCtx(db, null, env).ctx), 0);

    const invitee = { userId: "u_inv", email: "Invitee@Example.com" };
    const ownerOf_inv = await ownerOf("u_inv");
    const view = await viewerOf(makeCtx(db, invitee, env).ctx);
    assert.ok(view.state === "can_join" && view.invited, "invitations skip the cap");
    await joined(db, invitee, env);
    assert.equal(await state(db, invitee, env), "member");
    assert.equal(db.rows("members").find((row) => row.ownerId === ownerOf_inv)!.via, "invite");
  });

  test("an invitation needs a verified email, or an invited user ID", async () => {
    const db = new FakeDb();
    const env = { MEMBER_CAP: "0", ALLOWED_EMAILS: "will@example.com", ALLOWED_USER_IDS: "u_id_only" };
    assert.equal(await state(db, { ...WILL, emailVerified: false }, env), "no_access");
    await assert.rejects(join(makeCtx(db, { ...WILL, emailVerified: false }, env).ctx), /invite-only/);
    assert.equal(await state(db, WILL, env), "can_join");
    assert.equal(await state(db, { userId: "u_id_only" }, env), "can_join");
  });

  test("signed in isn't the same as joined", async () => {
    const db = new FakeDb();
    const { ctx } = makeCtx(db, WILL);
    assert.equal(await memberOrNull(ctx), null);
    await assert.rejects(requireMember(ctx), /Join Next move/);
    await join(ctx);
    assert.equal((await memberOrNull(ctx))?.ownerId, await ownerOf(WILL.userId));
  });

  test("lowering the cap or filling up never evicts existing members", async () => {
    const db = new FakeDb();
    await joined(db, person(1), { MEMBER_CAP: "2" });
    await joined(db, person(2), { MEMBER_CAP: "2" });
    assert.equal(await state(db, person(1), { MEMBER_CAP: "1" }), "member");
    assert.equal(await state(db, person(2), { MEMBER_CAP: "0" }), "member");
  });

  test("blocking locks out the person and their agents, and frees the seat", async () => {
    const db = new FakeDb();
    const { apiKey } = await connect(db, WILL);
    const { code } = await createHandoff(makeCtx(db, WILL).ctx, (await memberOrNull(makeCtx(db, WILL).ctx))!, "update");
    const env = { MEMBER_CAP: "1", BLOCKED_USER_IDS: "user_will" };

    assert.deepEqual(await viewerOf(makeCtx(db, WILL, env).ctx), { state: "no_access", reason: "removed", ...WILL });
    assert.equal(await authenticateAgent(makeCtx(db, null, env).ctx, `Bearer ${apiKey}`, true), null);
    await assert.rejects(redeemHandoff(makeCtx(db, null, env).ctx, { code }), /no longer has access/);
    await assert.rejects(join(makeCtx(db, WILL, env).ctx), /doesn't have access/);

    await joined(db, ANA, env);
    assert.equal(await state(db, ANA, env), "member", "the blocked member's seat went to someone else");
    assert.equal(await state(db, { ...WILL, userId: "user_will_2" }, { BLOCKED_EMAILS: "will@example.com" }), "no_access", "emails block too");
  });
});

describe("handoff codes and keys", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
  });

  test("a code works exactly once and never stores the secret", async () => {
    const { ctx, member } = await joined(db);
    const { code } = await createHandoff(ctx, member, "onboarding");
    assert.match(code, /^nmh_[A-Za-z0-9_-]{43}$/);
    const { ctx: anon } = makeCtx(db, null);
    const first = await redeemHandoff(anon, { code, agentName: "Claude Code" });
    assert.match(first.apiKey, /^nmk_[A-Za-z0-9_-]{43}$/);
    await assert.rejects(redeemHandoff(anon, { code }), /already used/);
    const stored = JSON.stringify([...db.tables.values()]);
    assert.ok(!stored.includes(code) && !stored.includes(first.apiKey), "only hashes are stored");
  });

  test("an expired code is refused", async () => {
    const { ctx, member } = await joined(db);
    const { code } = await createHandoff(ctx, member, "update");
    db.rows("handoffs")[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    await assert.rejects(redeemHandoff(makeCtx(db, null).ctx, { code }), /expired/);
  });

  test("secrets are unique", async () => {
    const { ctx, member } = await joined(db);
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) codes.add((await createHandoff(ctx, member, "update")).code);
    assert.equal(codes.size, 50);
  });

  test("revoked, expired, unknown or blocked keys stop working", async () => {
    const { apiKey, key, ctx } = await connect(db);
    await revokeKey(makeCtx(db, WILL).ctx, key.ownerId, key.id);
    assert.equal(await authenticateAgent(ctx, `Bearer ${apiKey}`, true), null);

    const second = await connect(db);
    db.rows("agentKeys").find((row) => row.id === second.key.id)!.expiresAt = new Date(Date.now() - 1).toISOString();
    assert.equal(await authenticateAgent(ctx, `Bearer ${second.apiKey}`, true), null);

    const third = await connect(db);
    const { ctx: blockedOwner } = makeCtx(db, null, { BLOCKED_EMAILS: "will@example.com" });
    assert.equal(await authenticateAgent(blockedOwner, `Bearer ${third.apiKey}`, true), null);
    assert.ok(await authenticateAgent(ctx, `Bearer ${third.apiKey}`, true), "the same key works while unblocked");

    assert.equal(await authenticateAgent(ctx, `Bearer nmk_${"A".repeat(43)}`, true), null);
    assert.equal(await authenticateAgent(ctx, null, true), null);
  });

  test("a user can't revoke someone else's key", async () => {
    const { key } = await connect(db, WILL);
    await assert.rejects(revokeKey(makeCtx(db, ANA).ctx, await ownerOf(ANA.userId), key.id), /isn't yours/);
  });

  test("MCP keys last 90 days", async () => {
    const { ctx, member } = await joined(db);
    const { key, expiresAt } = await createMcpKey(ctx, member, "Cursor");
    assert.match(key, /^nmk_/);
    const days = (Date.parse(expiresAt) - Date.now()) / 86_400_000;
    assert.ok(days > 89 && days <= 90);
  });
});

describe("agent writes", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
  });

  test("jobs need a saved role, and a bad batch saves nothing", async () => {
    const { key, ctx } = await connect(db);
    await assert.rejects(saveJobs(ctx, key.ownerId, [job()]), /save the roles first/);
    await saveTracks(ctx, key.ownerId, TRACKS);
    await assert.rejects(saveJobs(ctx, key.ownerId, [job(), job({ key: "other", applyUrl: "https://x.example/2", fit: "nope" })]));
    assert.equal(db.rows("jobs").length, 0);
  });

  test("upserts keep status, notes and firstFound; same URL under a new key is refused", async () => {
    const { key, ctx } = await connect(db);
    await saveTracks(ctx, key.ownerId, TRACKS);
    const first = await saveJobs(ctx, key.ownerId, [job({ firstFound: "2026-11-01" })]);
    assert.deepEqual(first, { created: ["acme-platform-em"], updated: [] });

    const userCtx = makeCtx(db, WILL).ctx;
    const row = db.rows("jobs")[0];
    await setStatus(userCtx, key.ownerId, row.id, "not_interested");
    await saveNotes(userCtx, key.ownerId, row.id, "Recruiter: Sam");

    const icon = "https://acme.example/apple-touch-icon.png";
    const again = await saveJobs(ctx, key.ownerId, [job({ salary: "€150k base", firstFound: today, company: { ...job().company, icon } })]);
    assert.deepEqual(again, { created: [], updated: ["acme-platform-em"] });
    const [updated] = (await workspace(userCtx, key.ownerId)).jobs;
    assert.equal(updated.salary, "€150k base");
    assert.equal(updated.company.icon, icon);
    assert.equal(updated.status, "not_interested");
    assert.equal(updated.notes, "Recruiter: Sam");
    assert.equal(updated.firstFound, "2026-11-01");

    await assert.rejects(
      saveJobs(ctx, key.ownerId, [job({ key: "acme-em-dupe", applyUrl: "https://JOBS.acme.example/em-platform/?utm_source=hn" })]),
      /already tracked as "acme-platform-em"/,
    );
  });

  test("icons for tracked jobs change nothing else, and only reach the agent's own jobs", async () => {
    const will = await connect(db, WILL);
    const ana = await connect(db, ANA);
    await saveTracks(will.ctx, will.key.ownerId, TRACKS);
    await saveTracks(ana.ctx, ana.key.ownerId, TRACKS);
    await saveJobs(will.ctx, will.key.ownerId, [job()]);
    await saveJobs(ana.ctx, ana.key.ownerId, [job({ key: "ana-only", applyUrl: "https://ana.example/job" })]);
    const userCtx = makeCtx(db, WILL).ctx;
    const row = db.rows("jobs").find((r) => r.key === "acme-platform-em")!;
    await setStatus(userCtx, will.key.ownerId, row.id, "applied");
    await saveNotes(userCtx, will.key.ownerId, row.id, "Recruiter: Sam");
    const before = (await workspace(userCtx, will.key.ownerId)).jobs[0];

    const icon = "https://acme.example/apple-touch-icon.png";
    assert.deepEqual(await saveCompanyIcons(will.ctx, will.key.ownerId, [{ key: "acme-platform-em", icon }]), { updated: ["acme-platform-em"] });
    const after = (await workspace(userCtx, will.key.ownerId)).jobs[0];
    assert.deepEqual(after, { ...before, company: { ...before.company, icon }, updatedAt: after.updatedAt });
    assert.equal((await agentContext(will.ctx, will.key.ownerId)).jobs[0].companyIcon, icon);

    // A batch with an unknown key (or someone else's) or a non-https URL saves nothing.
    await assert.rejects(
      saveCompanyIcons(will.ctx, will.key.ownerId, [{ key: "acme-platform-em", icon: "" }, { key: "ana-only", icon }]),
      /icons\[1\]\.key "ana-only" isn't a tracked job/,
    );
    await assert.rejects(saveCompanyIcons(will.ctx, will.key.ownerId, [{ key: "acme-platform-em", icon: "http://acme.example/i.png" }]), /must be an absolute https URL/);
    assert.equal((await workspace(userCtx, will.key.ownerId)).jobs[0].company.icon, icon);
    assert.equal((await workspace(makeCtx(db, ANA).ctx, ana.key.ownerId)).jobs[0].company.icon, "");
  });

  test("agents never see notes, and users never see each other's data", async () => {
    const will = await connect(db, WILL);
    const ana = await connect(db, ANA);
    await saveTracks(will.ctx, will.key.ownerId, TRACKS);
    await saveTracks(ana.ctx, ana.key.ownerId, TRACKS);
    await saveJobs(will.ctx, will.key.ownerId, [job()]);
    await saveJobs(ana.ctx, ana.key.ownerId, [job({ key: "ana-only", applyUrl: "https://ana.example/job" })]);
    await saveNotes(makeCtx(db, WILL).ctx, will.key.ownerId, db.rows("jobs")[0].id, "secret note");

    const context = await agentContext(will.ctx, will.key.ownerId);
    assert.deepEqual(context.jobs.map((j) => j.key), ["acme-platform-em"]);
    assert.ok(!JSON.stringify(context).includes("secret note"));

    const anaView = await workspace(makeCtx(db, ANA).ctx, ana.key.ownerId);
    assert.deepEqual(anaView.jobs.map((j) => j.key), ["ana-only"]);

    const willJob = db.rows("jobs")[0];
    await assert.rejects(setStatus(makeCtx(db, ANA).ctx, ana.key.ownerId, willJob.id, "applied"), /isn't in your tracker/);
    await assert.rejects(saveNotes(makeCtx(db, ANA).ctx, ana.key.ownerId, willJob.id, "hi"), /isn't in your tracker/);
  });

  test("profile saves replace the previous one", async () => {
    const { key, ctx } = await connect(db);
    const profile = { headline: "EM", summary: "Five years leading distributed teams.", location: "Spain", strengths: ["Coaching"] };
    await saveProfile(ctx, key.ownerId, profile);
    await saveProfile(ctx, key.ownerId, { ...profile, headline: "Engineering manager" });
    assert.equal(db.rows("profiles").length, 1);
    assert.equal((await agentContext(ctx, key.ownerId)).profile?.headline, "Engineering manager");
  });
});

describe("delete my data", () => {
  test("removes every row the person owns and nothing of anyone else's", async () => {
    const db = new FakeDb();
    const will = await connect(db, WILL);
    const ana = await connect(db, ANA);
    for (const who of [will, ana]) {
      await saveTracks(who.ctx, who.key.ownerId, TRACKS);
      await saveProfile(who.ctx, who.key.ownerId, { headline: "EM", summary: "Leads teams.", location: "Spain" });
    }
    await saveJobs(will.ctx, will.key.ownerId, [job()]);
    await saveJobs(ana.ctx, ana.key.ownerId, [job({ key: "ana-only", applyUrl: "https://ana.example/job" })]);
    const willJob = db.rows("jobs").find((row) => row.ownerId === will.key.ownerId)!;
    await saveNotes(makeCtx(db, WILL).ctx, will.key.ownerId, willJob.id, "secret");
    await logRun(will.ctx, will.key, { summary: "Added Acme.", added: 1 });
    const { ctx } = makeCtx(db, WILL);
    await createHandoff(ctx, (await memberOrNull(ctx))!, "update");

    const deleted = await deleteAccount(ctx, await signedInOwnerIds(ctx));
    assert.deepEqual(deleted, { jobs: 1, tracks: 2, profiles: 1, runs: 1, agentKeys: 1, handoffs: 2, members: 1 });
    for (const [table, rows] of db.tables) {
      assert.ok(rows.every((row) => row.ownerId !== will.key.ownerId), `${table} keeps nothing of Will's`);
    }
    assert.equal(await authenticateAgent(will.ctx, `Bearer ${will.apiKey}`, true), null, "his agents stop working");
    assert.ok(await authenticateAgent(ana.ctx, `Bearer ${ana.apiKey}`, true), "Ana's agent still works");
    assert.equal((await workspace(makeCtx(db, ANA).ctx, ana.key.ownerId)).jobs.length, 1);
    assert.equal((await viewerOf(makeCtx(db, WILL).ctx)).state, "can_join", "his seat is free, and he could start over");
  });

  test("blocked people can still delete; signed-out callers can't", async () => {
    const db = new FakeDb();
    await joined(db, WILL);
    const { ctx } = makeCtx(db, WILL, { BLOCKED_EMAILS: "will@example.com" });
    await deleteAccount(ctx, await signedInOwnerIds(ctx));
    assert.equal(db.rows("members").length, 0);
    await assert.rejects(signedInOwnerIds(makeCtx(db, null).ctx), /Sign in first/);
  });
});

describe("MCP endpoint", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
  });

  async function rpc(apiKey: string | null, body: unknown, headers: Record<string, string> = {}) {
    const { ctx } = makeCtx(db, null);
    const auth: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    const res: any = await handleMcp(ctx, request({ headers: { host: "nextmove.example", ...auth, ...headers }, body }));
    return { status: res.status, headers: res.headers, body: res.body ? JSON.parse(res.body) : null };
  }

  test("handshake, tool list and protocol negotiation", async () => {
    const { apiKey } = await connect(db);
    const init = await rpc(apiKey, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    assert.equal(init.body.result.protocolVersion, "2025-06-18");
    assert.equal(init.body.result.serverInfo.name, "nextmove");
    const future = await rpc(apiKey, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } });
    assert.equal(future.body.result.protocolVersion, "2025-11-25");
    const notification = await rpc(apiKey, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(notification.status, 202);
    const tools = await rpc(apiKey, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    assert.deepEqual(
      tools.body.result.tools.map((t: any) => t.name),
      ["get_instructions", "get_context", "save_profile", "save_tracks", "save_jobs", "save_company_icons", "log_run"],
    );
  });

  test("tools write through the same rules as the REST API", async () => {
    const { apiKey } = await connect(db);
    const call = (name: string, args: unknown) => rpc(apiKey, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } });
    assert.equal((await call("save_tracks", { tracks: TRACKS })).body.result.isError, false);
    const bad = await call("save_jobs", { jobs: [job({ eligibility: "maybe" })] });
    assert.equal(bad.body.result.isError, true);
    assert.match(bad.body.result.content[0].text, /eligibility must be one of/);
    assert.equal(db.rows("jobs").length, 0);
    const good = await call("save_jobs", { jobs: [job()] });
    assert.deepEqual(good.body.result.structuredContent, { created: ["acme-platform-em"], updated: [] });
    const context = await call("get_context", {});
    assert.equal(context.body.result.structuredContent.jobs.length, 1);
    assert.match((await call("get_instructions", {})).body.result.content[0].text, /Research rules/);
    const icons = await call("save_company_icons", { icons: [{ key: "acme-platform-em", icon: "https://acme.example/icon.png" }] });
    assert.deepEqual(icons.body.result.structuredContent, { updated: ["acme-platform-em"] });
    assert.equal((await call("save_company_icons", { icons: [{ key: "nope", icon: "" }] })).body.result.isError, true);
    assert.equal((await call("log_run", { summary: "Added Acme.", added: 1 })).body.result.isError, false);
    assert.equal((await call("delete_everything", {})).body.error.code, -32602);
  });

  test("auth, origin and malformed requests are refused", async () => {
    const { apiKey } = await connect(db);
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    const missing = await rpc(null, ping);
    assert.equal(missing.status, 401);
    assert.match(missing.headers["www-authenticate"], /Bearer/);
    assert.equal((await rpc(apiKey, ping, { origin: "https://evil.example" })).status, 403);
    assert.equal((await rpc(apiKey, ping, { origin: "https://nextmove.example" })).status, 200);
    assert.equal((await rpc(apiKey, [ping])).body.error.code, -32600);
    assert.equal((await rpc(apiKey, { jsonrpc: "2.0", id: 1, method: "resources/list" })).body.error.code, -32601);
    const { ctx } = makeCtx(db, null);
    const garbage: any = await handleMcp(ctx, request({ headers: { host: "nextmove.example", authorization: `Bearer ${apiKey}` }, body: "{not json" }));
    assert.equal(JSON.parse(garbage.body).error.code, -32700);
  });
});

describe("encryption at rest", () => {
  const ctxWith = (secrets: Record<string, string> = {}) => makeCtx(new FakeDb(), null, {}, secrets).ctx;

  test("sealed text round-trips, including emoji, CJK and broken surrogates", async () => {
    const ctx = ctxWith();
    for (const text of ["", "a", "Recruiter: Sam ✓", "日本語のメモ", "team lead 🧑🏽‍💻 ok", "x".repeat(20000)]) {
      assert.equal(await open(ctx, "t|o|f", await seal(ctx, "t|o|f", text)), text);
    }
    assert.equal(await open(ctx, "t", await seal(ctx, "t", "lone \ud800 surrogate")), "lone � surrogate");
    assert.equal(utf8Decode(utf8Encode("€ 🧑🏽‍💻")), "€ 🧑🏽‍💻");
  });

  test("ciphertext is bound to its row and key, and tampering is caught", async () => {
    const ctx = ctxWith();
    const sealed = await seal(ctx, "jobs|o1_a|acme|notes", "call Sam");
    assert.equal(sealed, await seal(ctx, "jobs|o1_a|acme|notes", "call Sam"), "deterministic within one context");
    assert.notEqual(sealed, await seal(ctx, "jobs|o1_b|acme|notes", "call Sam"), "another owner gets different bytes");
    await assert.rejects(open(ctx, "jobs|o1_b|acme|notes", sealed), /integrity/, "can't be moved to another row");
    const flipped = sealed.slice(0, -2) + (sealed.at(-2) === "A" ? "B" : "A") + sealed.at(-1);
    await assert.rejects(open(ctx, "jobs|o1_a|acme|notes", flipped), /integrity/);
    await assert.rejects(open(ctxWith({ DATA_KEY: "another-key" }), "jobs|o1_a|acme|notes", sealed), /different DATA_KEY/);
    await assert.rejects(open(ctx, "x", "plain text"), /encrypted format/);
  });

  test("the database holds no names, emails, account IDs or private text", async () => {
    const db = new FakeDb();
    const will = await connect(db, WILL);
    await saveProfile(will.ctx, will.key.ownerId, {
      headline: "Engineering manager at Globex",
      summary: "Grew the billing team from 3 to 8 reports.",
      location: "Porto, Portugal",
      strengths: ["Coaching managers"],
    });
    await saveTracks(will.ctx, will.key.ownerId, [{ ...TRACKS[0], searchNotes: "Only fully remote" }]);
    await saveJobs(will.ctx, will.key.ownerId, [job({ fitSummary: "Matches the billing leadership.", salaryNote: "Below the €125k target.", caveats: ["Growth gap"] })]);
    const userCtx = makeCtx(db, WILL).ctx;
    const jobId = db.rows("jobs")[0].id;
    await setStatus(userCtx, will.key.ownerId, jobId, "applied");
    await saveNotes(userCtx, will.key.ownerId, jobId, "Recruiter call Tuesday");
    await logRun(will.ctx, will.key, { summary: "Found Acme for the €125k target.", added: 1 });

    const stored = JSON.stringify([...db.tables.entries()]);
    for (const secret of ["user_will", "will@example.com", 'Will"', "Globex", "billing team", "Porto", "Coaching", "Only fully remote", "125000", "125k", "Growth gap", "Recruiter call", "applied", "strong"]) {
      assert.ok(!stored.includes(secret), `"${secret}" isn't stored in the clear`);
    }
    assert.ok(stored.includes("Engineering Manager, Platform"), "job postings stay readable");
    const view = await workspace(userCtx, will.key.ownerId);
    assert.equal(view.profile?.location, "Porto, Portugal");
    assert.equal(view.tracks[0].salaryTarget, 125000);
    assert.equal(view.jobs[0].status, "applied");
    assert.equal(view.jobs[0].notes, "Recruiter call Tuesday");
    assert.deepEqual(view.jobs[0].caveats, ["Growth gap"]);
  });
});

describe("upgrading data from before encryption", () => {
  async function legacyWorld() {
    const db = new FakeDb();
    const plain = (table: string, row: Record<string, unknown>) => db.table(table).insert(row);
    const j = job();
    await plain("members", { ownerId: WILL.userId, email: WILL.email, displayName: "Will", via: "open" });
    await plain("profiles", {
      ownerId: WILL.userId, headline: "EM", summary: "Leads distributed teams.", location: "Spain", workAuthorization: "EU",
      remotePreference: "Remote", strengths: '["Coaching"]', doNotAssume: "[]", dealbreakers: "[]", sources: "CV",
    });
    await plain("tracks", {
      ownerId: WILL.userId, key: "engineering-manager", title: "Engineering Manager", seniority: "", salaryTarget: "125000",
      salaryCurrency: "EUR", salaryBasis: "base", searchNotes: "", active: true,
    });
    await plain("jobs", {
      ownerId: WILL.userId, key: j.key, trackKey: j.trackKey, canonicalUrl: canonicalUrl(j.applyUrl), title: j.title, companyName: "Acme",
      companyWebsite: "", companySummary: "", companyIndustry: "", remoteModel: "", remoteSummary: "", applyUrl: j.applyUrl, location: j.location,
      eligibility: "likely", workplace: "remote_first", salary: "", salaryNote: "Below target.", fit: "strong", fitSummary: "Good match.",
      highlights: "[]", caveats: '["Salary"]', tags: "[]", sourceName: "", sourceUrl: "", firstFound: today, lastVerified: today,
      openingStatus: "open", status: "applied", notes: "Called Sam", statusChangedAt: "",
    });
    await plain("runs", { ownerId: WILL.userId, agentKeyId: "k", agentLabel: "Claude Code", summary: "Imported 1 job.", added: "1", updated: "0", closed: "0" });
    const secret = `nmk_${"L".repeat(43)}`;
    await plain("agentKeys", {
      ownerId: WILL.userId, ownerEmail: WILL.email, label: "Claude Code", kind: "mcp", keyHash: await hashSecret(makeCtx(db, null).ctx, secret),
      keyPrefix: secret.slice(0, 8), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), lastUsedAt: "", revokedAt: "",
    });
    return { db, secret };
  }

  async function assertUpgraded(db: FakeDb) {
    const ownerId = await ownerOf(WILL.userId);
    const stored = JSON.stringify([...db.tables.entries()]);
    for (const secret of [WILL.userId, WILL.email, "Leads distributed", "Called Sam", "Imported 1 job", "applied"]) {
      assert.ok(!stored.includes(secret), `"${secret}" got encrypted or hashed`);
    }
    for (const [table, rows] of db.tables) assert.ok(rows.every((row) => row.ownerId === ownerId), `${table} moved to the hashed owner ID`);
    const view = await workspace(makeCtx(db, WILL).ctx, ownerId);
    assert.equal(view.profile?.summary, "Leads distributed teams.");
    assert.deepEqual(view.profile?.strengths, ["Coaching"]);
    assert.equal(view.tracks[0].salaryTarget, 125000);
    assert.equal(view.jobs[0].status, "applied");
    assert.equal(view.jobs[0].notes, "Called Sam");
    assert.deepEqual(view.jobs[0].caveats, ["Salary"]);
    assert.equal(db.rows("members")[0].emailHash, await emailHashFor(makeCtx(db, null).ctx, WILL.email));
  }

  test("a returning member upgrades by continuing, and keeps their seat", async () => {
    const { db, secret } = await legacyWorld();
    const env = { MEMBER_CAP: "1" };
    const view = await viewerOf(makeCtx(db, WILL, env).ctx);
    assert.ok(view.state === "can_join" && view.returning, "asked to continue, not to claim a seat");
    assert.equal(await authenticateAgent(makeCtx(db, null, env).ctx, `Bearer ${secret}`, false), null, "a read-only request can't upgrade");
    await join(makeCtx(db, WILL, env).ctx);
    await assertUpgraded(db);
    assert.equal((await viewerOf(makeCtx(db, WILL, env).ctx)).state, "member");
    assert.equal(db.rows("members").length, 1);
    assert.ok(await authenticateAgent(makeCtx(db, null, env).ctx, `Bearer ${secret}`, true), "their old MCP key still works");
  });

  test("an agent with an old key upgrades its owner on the spot", async () => {
    const { db, secret } = await legacyWorld();
    const key = await authenticateAgent(makeCtx(db, null).ctx, `Bearer ${secret}`, true);
    assert.equal(key?.ownerId, await ownerOf(WILL.userId));
    await assertUpgraded(db);
    const context = await agentContext(makeCtx(db, null).ctx, key!.ownerId);
    assert.equal(context.jobs[0].applicationStatus, "applied");
    assert.ok(!JSON.stringify(context).includes("Called Sam"), "notes stay out of the agent's context");
  });

  test("blocked legacy members aren't upgraded, but can still delete", async () => {
    const { db, secret } = await legacyWorld();
    const env = { BLOCKED_EMAILS: WILL.email };
    assert.equal(await authenticateAgent(makeCtx(db, null, env).ctx, `Bearer ${secret}`, true), null);
    await assert.rejects(join(makeCtx(db, WILL, env).ctx), /doesn't have access/);
    assert.equal(db.rows("jobs")[0].notes, "Called Sam", "left as it was");
    const { ctx } = makeCtx(db, WILL, env);
    await deleteAccount(ctx, await signedInOwnerIds(ctx));
    assert.equal([...db.tables.values()].flat().length, 0);
  });
});

describe("deployment safety", () => {
  test(".env.server never holds DATA_KEY, since sf publish would overwrite the production key", () => {
    const path = new URL("../.env.server", import.meta.url);
    if (!existsSync(path)) return;
    assert.ok(!/^\s*(export\s+)?DATA_KEY\s*=/m.test(readFileSync(path, "utf8")));
  });
});
