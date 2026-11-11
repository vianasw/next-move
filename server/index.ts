import {
  boolean,
  capsule,
  endpoint,
  json,
  mutation,
  query,
  string,
  table,
  text,
  type EndpointRequest,
  type ServerContext,
} from "@spacefast/zero/server";
import { ContractError, STATUSES, type Status } from "../shared/contract";
import { agentGuide } from "../shared/prompts";
import { join, memberOrNull, requireMember, signedInOwnerIds, viewerOf } from "./access";
import {
  RequestError,
  agentActivity,
  agentContext,
  authenticateAgent,
  createHandoff,
  createMcpKey,
  deleteAccount,
  logRun,
  redeemHandoff,
  revokeKey,
  saveCompanyIcons,
  saveJobs,
  saveNotes,
  saveProfile,
  saveTracks,
  setStatus,
  setTrackActive,
  workspace,
  type KeyRow,
} from "./data";
import { handleMcp } from "./mcp";

const NO_STORE = { "cache-control": "no-store" };

function problem(status: number, error: string, message: string, extra: Record<string, unknown> = {}) {
  const headers: Record<string, string> = { ...NO_STORE };
  if (status === 401) headers["www-authenticate"] = 'Bearer realm="nextmove", error="invalid_token"';
  return json({ error, message, ...extra }, { status, headers });
}

async function readBody(req: EndpointRequest): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new RequestError(400, "invalid_json", "The request body must be JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new RequestError(400, "invalid_json", "The request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

/** Maps caller mistakes to 4xx. Anything else rethrows so the transaction rolls back. */
function asProblem(error: unknown) {
  if (error instanceof ContractError) return problem(400, "validation_error", error.message, { problems: error.problems });
  if (error instanceof RequestError) return problem(error.status, error.code, error.message);
  throw error;
}

async function asAgent(ctx: ServerContext, req: EndpointRequest, run: (key: KeyRow) => Promise<unknown>) {
  const key = await authenticateAgent(ctx, req.headers.get("authorization"), true);
  if (!key) return problem(401, "invalid_token", "Missing, expired or revoked API key. Ask the user to copy a fresh prompt from Next move.");
  try {
    return json(await run(key), { headers: NO_STORE });
  } catch (error) {
    return asProblem(error);
  }
}

const notAllowed = () => problem(405, "method_not_allowed", "The MCP endpoint only accepts POST.");

export default capsule({
  name: "Next move",
  schema: {
    profiles: table({
      ownerId: string(),
      headline: string(),
      summary: string(),
      location: string(),
      workAuthorization: string(),
      remotePreference: string(),
      strengths: string(),
      doNotAssume: string(),
      dealbreakers: string(),
      sources: string(),
    }).index("by_owner", ["ownerId"]),
    tracks: table({
      ownerId: string(),
      key: string(),
      title: string(),
      seniority: string(),
      salaryTarget: string(),
      salaryCurrency: string(),
      salaryBasis: string(),
      searchNotes: string(),
      active: boolean().default(true),
    }).index("by_owner", ["ownerId"]),
    jobs: table({
      ownerId: string(),
      key: string(),
      trackKey: string(),
      canonicalUrl: string(),
      title: string(),
      companyName: string(),
      companyWebsite: string(),
      companyIcon: string().default(""),
      companySummary: string(),
      companyIndustry: string(),
      remoteModel: string(),
      remoteSummary: string(),
      applyUrl: string(),
      location: string(),
      eligibility: string(),
      workplace: string(),
      salary: string(),
      salaryNote: string(),
      fit: string(),
      fitSummary: string(),
      highlights: string(),
      caveats: string(),
      tags: string(),
      sourceName: string(),
      sourceUrl: string(),
      firstFound: string(),
      lastVerified: string(),
      openingStatus: string(),
      status: string().default("shortlisted"),
      notes: string().default(""),
      statusChangedAt: string().default(""),
    }).index("by_owner", ["ownerId"]),
    // ownerId is a keyed hash of the account ID, and emails are stored only as keyed hashes
    // (see server/vault.ts). The old plaintext columns stay, always "", because dropping a
    // column needs a manual migration.
    agentKeys: table({
      ownerId: string(),
      ownerEmail: string(),
      ownerEmailHash: string().default(""),
      label: string(),
      kind: string(),
      keyHash: string(),
      keyPrefix: string(),
      expiresAt: string(),
      lastUsedAt: string().default(""),
      revokedAt: string().default(""),
    })
      .index("by_owner", ["ownerId"])
      .index("by_hash", ["keyHash"]),
    handoffs: table({
      ownerId: string(),
      ownerEmail: string(),
      ownerEmailHash: string().default(""),
      codeHash: string(),
      purpose: string(),
      expiresAt: string(),
      usedAt: string().default(""),
      agentKeyId: string().default(""),
    })
      .index("by_owner", ["ownerId"])
      .index("by_hash", ["codeHash"]),
    members: table({
      ownerId: string(),
      email: string(),
      emailHash: string().default(""),
      displayName: string(),
      via: string(),
    }).index("by_owner", ["ownerId"]),
    runs: table({
      ownerId: string(),
      agentKeyId: string(),
      agentLabel: string(),
      summary: string(),
      added: string(),
      updated: string(),
      closed: string(),
    }).index("by_owner", ["ownerId"]),
  },

  queries: {
    viewer: query(async (ctx) => viewerOf(ctx)),
    workspace: query(async (ctx) => {
      const member = await memberOrNull(ctx);
      return member ? workspace(ctx, member.ownerId) : null;
    }),
    agentActivity: query(async (ctx) => {
      const member = await memberOrNull(ctx);
      return member ? agentActivity(ctx, member.ownerId) : null;
    }),
  },

  mutations: {
    join: mutation(async (ctx) => {
      await join(ctx);
    }),
    setStatus: mutation(async (ctx, jobId: string, status: Status) => {
      if (!STATUSES.includes(status)) throw new Error("Unknown status.");
      await setStatus(ctx, (await requireMember(ctx)).ownerId, jobId, status);
    }),
    saveNotes: mutation(async (ctx, jobId: string, notes: string) => {
      await saveNotes(ctx, (await requireMember(ctx)).ownerId, jobId, notes);
    }),
    setTrackActive: mutation(async (ctx, trackId: string, active: boolean) => {
      await setTrackActive(ctx, (await requireMember(ctx)).ownerId, trackId, active);
    }),
    createHandoff: mutation(async (ctx, purpose: "onboarding" | "update") => createHandoff(ctx, await requireMember(ctx), purpose)),
    createMcpKey: mutation(async (ctx, label: string) => createMcpKey(ctx, await requireMember(ctx), label)),
    revokeKey: mutation(async (ctx, keyId: string) => {
      await revokeKey(ctx, (await requireMember(ctx)).ownerId, keyId);
    }),
    // The client asks the user to type DELETE; checking it here too means a stray call can't wipe anything.
    deleteAccount: mutation(async (ctx, confirmation: string) => {
      if (confirmation !== "DELETE") throw new Error("Type DELETE to confirm.");
      return deleteAccount(ctx, await signedInOwnerIds(ctx));
    }),
  },

  endpoints: {
    // One-time code → short-lived API key. The only agent route without a bearer key.
    session: endpoint({ method: "POST", path: "/api/agent/session" }, async (ctx, req) => {
      try {
        return json(await redeemHandoff(ctx, await readBody(req)), { headers: NO_STORE });
      } catch (error) {
        return asProblem(error);
      }
    }),
    guide: endpoint({ method: "GET", path: "/api/agent/guide" }, () =>
      // "Content-Type" must match the helper's casing to replace it; production rejects duplicate headers.
      text(agentGuide(), { headers: { "Content-Type": "text/markdown; charset=utf-8" } }),
    ),
    // readOnly: false so the key's "last used" time can be recorded.
    context: endpoint({ method: "GET", path: "/api/agent/context", readOnly: false }, (ctx, req) =>
      asAgent(ctx, req, (key) => agentContext(ctx, key.ownerId)),
    ),
    profile: endpoint({ method: "PUT", path: "/api/agent/profile" }, (ctx, req) =>
      asAgent(ctx, req, async (key) => saveProfile(ctx, key.ownerId, (await readBody(req)).profile)),
    ),
    tracks: endpoint({ method: "POST", path: "/api/agent/tracks" }, (ctx, req) =>
      asAgent(ctx, req, async (key) => saveTracks(ctx, key.ownerId, (await readBody(req)).tracks)),
    ),
    jobs: endpoint({ method: "POST", path: "/api/agent/jobs" }, (ctx, req) =>
      asAgent(ctx, req, async (key) => saveJobs(ctx, key.ownerId, (await readBody(req)).jobs)),
    ),
    icons: endpoint({ method: "POST", path: "/api/agent/icons" }, (ctx, req) =>
      asAgent(ctx, req, async (key) => saveCompanyIcons(ctx, key.ownerId, (await readBody(req)).icons)),
    ),
    runs: endpoint({ method: "POST", path: "/api/agent/runs" }, (ctx, req) =>
      asAgent(ctx, req, async (key) => logRun(ctx, key, await readBody(req))),
    ),
    mcp: endpoint({ method: "POST", path: "/mcp" }, (ctx, req) => handleMcp(ctx, req)),
    mcpGet: endpoint({ method: "GET", path: "/mcp" }, notAllowed),
    mcpDelete: endpoint({ method: "DELETE", path: "/mcp" }, notAllowed),
  },
});
