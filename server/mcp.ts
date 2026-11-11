// A stateless MCP server over Streamable HTTP (JSON responses, no SSE stream),
// authenticated with the same bearer keys as the REST API. Hand-written because
// Zero server code can't import npm packages; the protocol surface is small.
import { empty, json, type EndpointRequest, type ServerContext } from "@spacefast/zero/server";
import {
  ContractError,
  ELIGIBILITY,
  FITS,
  LIMITS,
  OPENING_STATUSES,
  SALARY_BASES,
  WORKPLACES,
} from "../shared/contract";
import { agentGuide } from "../shared/prompts";
import { agentContext, authenticateAgent, logRun, saveCompanyIcons, saveJobs, saveProfile, saveTracks, type KeyRow } from "./data";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const strList = (description: string) => ({ type: "array", items: { type: "string" }, description });
const noArgs = { type: "object", properties: {}, additionalProperties: false };

const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    headline: str("One-line professional headline"),
    summary: str("The user's experience in a few short paragraphs, distilled from their CV/LinkedIn"),
    location: str("Where the user lives"),
    workAuthorization: str("Where the user can legally work"),
    remotePreference: str("Remote, hybrid or on-site preference"),
    strengths: strList("Evidence-backed strengths"),
    doNotAssume: strList("Things a recruiter might assume that the CV doesn't support"),
    dealbreakers: strList("Industries, travel, company size, etc. to avoid"),
    sources: str("What you read, e.g. 'CV, LinkedIn PDF'"),
  },
  required: ["headline", "summary", "location"],
};

const TRACK_SCHEMA = {
  type: "object",
  properties: {
    key: str("Stable lowercase-dashed key, e.g. engineering-manager"),
    title: str("Role title, e.g. Engineering Manager"),
    seniority: str("e.g. Senior, Staff"),
    salaryTarget: { type: ["number", "null"], description: "Annual target, or null" },
    salaryCurrency: str("3-letter currency code, e.g. EUR"),
    salaryBasis: { type: "string", enum: SALARY_BASES, description: "base salary or total compensation" },
    searchNotes: str("Titles and scope to look for"),
    active: { type: "boolean" },
  },
  required: ["key", "title"],
};

const JOB_SCHEMA = {
  type: "object",
  properties: {
    key: str("Stable lowercase-dashed key; reuse the existing key for a known opening"),
    trackKey: str("Key of the user's role this opening belongs to"),
    title: str("Actual role title"),
    company: {
      type: "object",
      properties: {
        name: str("Company name"),
        website: str("Absolute URL"),
        icon: str("Absolute https URL of the icon the company's homepage declares: its apple-touch-icon, else its largest <link rel=\"icon\">. Omit if there isn't one."),
        summary: str("Concise factual summary"),
        industry: str("Industry"),
        remoteModel: str("e.g. Fully distributed"),
        remoteSummary: str("How remote work applies to this opening"),
      },
      required: ["name"],
    },
    applyUrl: str("The employer's own posting (absolute https URL)"),
    location: str("Advertised geography"),
    eligibility: { type: "string", enum: ELIGIBILITY, description: "Against where the user lives and can work" },
    workplace: { type: "string", enum: WORKPLACES },
    salary: str("Published pay, or 'Not published'"),
    salaryNote: str("Currency, basis, geography, equity, and comparison with the target"),
    fit: { type: "string", enum: FITS },
    fitSummary: str("Why it's relevant, from profile evidence only"),
    highlights: strList("Short scope/requirement highlights"),
    caveats: strList("Screening gates, gaps, restrictions, uncertainty"),
    tags: strList("Short searchable labels"),
    source: {
      type: "object",
      properties: { name: str("Where you discovered it"), url: str("Absolute URL") },
      required: ["name", "url"],
    },
    firstFound: str("YYYY-MM-DD, only from evidence; omit otherwise"),
    lastVerified: str("YYYY-MM-DD you actually loaded the employer posting"),
    openingStatus: { type: "string", enum: OPENING_STATUSES },
  },
  required: [
    "key", "trackKey", "title", "company", "applyUrl", "location", "eligibility",
    "workplace", "fit", "fitSummary", "source", "lastVerified", "openingStatus",
  ],
};

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };
const UPSERT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: "get_instructions",
    title: "Research guide",
    description: "How to onboard the user and how to research and save openings. Read this before your first save.",
    inputSchema: noArgs,
    annotations: READ_ONLY,
  },
  {
    name: "get_context",
    title: "Get profile, roles and tracked jobs",
    description: "The user's profile, their roles (tracks) with salary targets, and every tracked job with its application status. Call first; reuse existing keys.",
    inputSchema: noArgs,
    annotations: READ_ONLY,
  },
  {
    name: "save_profile",
    title: "Save profile",
    description: "Create or replace the user's distilled profile. Show it to the user and get confirmation first. Never send the raw CV.",
    inputSchema: { type: "object", properties: { profile: PROFILE_SCHEMA }, required: ["profile"] },
    annotations: UPSERT,
  },
  {
    name: "save_tracks",
    title: "Save roles",
    description: "Create or update the roles the user is searching for, matched by key. Roles you leave out are unchanged.",
    inputSchema: {
      type: "object",
      properties: { tracks: { type: "array", items: TRACK_SCHEMA, minItems: 1, maxItems: LIMITS.tracksPerUser } },
      required: ["tracks"],
    },
    annotations: UPSERT,
  },
  {
    name: "save_jobs",
    title: "Save openings",
    description: `Create or update researched openings, matched by key, up to ${LIMITS.jobsPerSave} per call. A batch with any problem saves nothing and lists every problem. Never changes application status or notes.`,
    inputSchema: {
      type: "object",
      properties: { jobs: { type: "array", items: JOB_SCHEMA, minItems: 1, maxItems: LIMITS.jobsPerSave } },
      required: ["jobs"],
    },
    annotations: UPSERT,
  },
  {
    name: "save_company_icons",
    title: "Save company icons",
    description:
      "Set the company icon on jobs already tracked, matched by key. Nothing else about the job changes. " +
      "Use it for tracked jobs whose companyIcon is empty. A batch with any problem saves nothing.",
    inputSchema: {
      type: "object",
      properties: {
        icons: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: str("Key of a tracked job"),
              icon: str("Absolute https URL of the icon the company's homepage declares, or \"\" to clear it"),
            },
            required: ["key", "icon"],
          },
          minItems: 1,
          maxItems: LIMITS.jobsPerUser,
        },
      },
      required: ["icons"],
    },
    annotations: UPSERT,
  },
  {
    name: "log_run",
    title: "Log research run",
    description: "Record what this run did, shown to the user in Next move.",
    inputSchema: {
      type: "object",
      properties: {
        summary: str("New roles, closures, important salary or qualification changes"),
        added: { type: "integer", minimum: 0 },
        updated: { type: "integer", minimum: 0 },
        closed: { type: "integer", minimum: 0 },
      },
      required: ["summary"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

const INSTRUCTIONS =
  "Next move is the user's job-search tracker. You research openings; these tools store them. " +
  "Call get_instructions before your first save, and get_context before researching.";

type RpcId = string | number | null;

function rpcResult(id: RpcId, result: unknown) {
  return json({ jsonrpc: "2.0", id, result }, { headers: { "cache-control": "no-store" } });
}

function rpcError(id: RpcId, code: number, message: string, status = 200, headers: Record<string, string> = {}) {
  return json({ jsonrpc: "2.0", id, error: { code, message } }, { status, headers: { "cache-control": "no-store", ...headers } });
}

function toolResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
    ...(typeof data === "object" && data !== null ? { structuredContent: data } : {}),
    isError,
  };
}

async function callTool(ctx: ServerContext, key: KeyRow, name: string, args: Record<string, unknown>) {
  switch (name) {
    case "get_instructions":
      return toolResult(agentGuide());
    case "get_context":
      return toolResult(await agentContext(ctx, key.ownerId));
    case "save_profile":
      return toolResult(await saveProfile(ctx, key.ownerId, args.profile));
    case "save_tracks":
      return toolResult(await saveTracks(ctx, key.ownerId, args.tracks));
    case "save_jobs":
      return toolResult(await saveJobs(ctx, key.ownerId, args.jobs));
    case "save_company_icons":
      return toolResult(await saveCompanyIcons(ctx, key.ownerId, args.icons));
    case "log_run":
      return toolResult(await logRun(ctx, key, args));
    default:
      return null;
  }
}

function hostOf(origin: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i.exec(origin);
  return match ? match[1].toLowerCase() : "";
}

export async function handleMcp(ctx: ServerContext, req: EndpointRequest) {
  // Browsers send Origin; agents don't. A foreign Origin means a web page is trying
  // to drive this server with someone's credentials (DNS rebinding and friends).
  const origin = req.headers.get("origin");
  if (origin && hostOf(origin) !== (req.headers.get("host") ?? "").toLowerCase()) {
    return json({ error: "forbidden_origin" }, { status: 403 });
  }

  const key = await authenticateAgent(ctx, req.headers.get("authorization"), true);
  if (!key) {
    return rpcError(null, -32001, "Missing, expired or revoked Next move key. Create a new MCP key in Next move → Agent.", 401, {
      "www-authenticate": 'Bearer realm="nextmove", error="invalid_token"',
    });
  }

  let message: unknown;
  try {
    message = await req.json();
  } catch {
    return rpcError(null, -32700, "Parse error: the body must be JSON.");
  }
  if (Array.isArray(message)) return rpcError(null, -32600, "Batch requests aren't supported.");
  if (typeof message !== "object" || message === null) return rpcError(null, -32600, "Invalid request.");
  const msg = message as Record<string, unknown>;
  const id = (typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null) as RpcId;

  // Notifications and responses get an empty 202, per the Streamable HTTP transport.
  if (typeof msg.method !== "string" || msg.id === undefined) return empty({ status: 202 });
  if (msg.jsonrpc !== "2.0") return rpcError(id, -32600, "Invalid request: jsonrpc must be \"2.0\".");
  const params = (typeof msg.params === "object" && msg.params !== null ? msg.params : {}) as Record<string, unknown>;

  switch (msg.method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "nextmove", title: "Next move", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (typeof params.arguments === "object" && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      try {
        const result = await callTool(ctx, key, name, args);
        if (!result) return rpcError(id, -32602, `Unknown tool: ${name}`);
        return rpcResult(id, result);
      } catch (error) {
        // Validation runs before any write, so reporting it can't commit half a batch.
        if (error instanceof ContractError) {
          return rpcResult(id, toolResult({ error: "validation_error", problems: error.problems }, true));
        }
        throw error;
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}
