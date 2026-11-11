// The data contract shared by the agent API, the MCP tools and the UI.
// Pure TypeScript: no imports, no platform globals (the Zero server has no URL,
// URLSearchParams or TextEncoder), so everything here is hand-rolled on purpose.

export const STATUSES = [
  "shortlisted",
  "applied",
  "interviewing",
  "rejected",
  "offer",
  "withdrawn",
  "not_interested",
] as const;
export const FITS = ["strong", "good", "stretch"] as const;
export const ELIGIBILITY = ["confirmed", "likely", "confirm"] as const;
export const WORKPLACES = ["remote_first", "remote_role", "hybrid", "onsite"] as const;
export const OPENING_STATUSES = ["open", "closed", "unknown"] as const;
export const SALARY_BASES = ["base", "total"] as const;

export type Status = (typeof STATUSES)[number];
export type Fit = (typeof FITS)[number];
export type Eligibility = (typeof ELIGIBILITY)[number];
export type Workplace = (typeof WORKPLACES)[number];
export type OpeningStatus = (typeof OPENING_STATUSES)[number];
export type SalaryBasis = (typeof SALARY_BASES)[number];

export const LIMITS = {
  jobsPerSave: 25,
  jobsPerUser: 1000,
  tracksPerUser: 12,
  notes: 20000,
  listItems: 12,
};

export type ProfileInput = {
  headline: string;
  summary: string;
  location: string;
  workAuthorization: string;
  remotePreference: string;
  strengths: string[];
  doNotAssume: string[];
  dealbreakers: string[];
  sources: string;
};

export type TrackInput = {
  key: string;
  title: string;
  seniority: string;
  salaryTarget: number | null;
  salaryCurrency: string;
  salaryBasis: SalaryBasis;
  searchNotes: string;
  active: boolean;
};

export type JobInput = {
  key: string;
  trackKey: string;
  title: string;
  company: {
    name: string;
    website: string;
    /** The icon the company's homepage declares, shown beside its jobs. Optional. */
    icon: string;
    summary: string;
    industry: string;
    remoteModel: string;
    remoteSummary: string;
  };
  applyUrl: string;
  location: string;
  eligibility: Eligibility;
  workplace: Workplace;
  salary: string;
  salaryNote: string;
  fit: Fit;
  fitSummary: string;
  highlights: string[];
  caveats: string[];
  tags: string[];
  source: { name: string; url: string };
  firstFound: string;
  lastVerified: string;
  openingStatus: OpeningStatus;
};

export type RunInput = { summary: string; added: number; updated: number; closed: number };

/** Every problem found in a payload, so an agent can fix them all in one pass. */
export class ContractError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(problems.length === 1 ? problems[0] : `${problems.length} problems: ${problems.slice(0, 3).join("; ")}`);
    this.problems = problems;
  }
}

const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Absolute http(s) URL without credentials or whitespace. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:[/?#][^\s]*)?$/i.test(value) && !/^https?:\/\/[^/]*@/i.test(value);
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Same opening, same URL: lowercase scheme/host, no fragment, no trailing slash, no tracking params. */
export function canonicalUrl(value: string): string {
  const match = /^(https?):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i.exec(value.trim());
  if (!match) return value.trim();
  const [, scheme, host, rawPath, rawQuery] = match;
  const path = rawPath.replace(/\/+$/, "");
  const params = (rawQuery ?? "")
    .slice(1)
    .split("&")
    .filter((pair) => {
      if (!pair) return false;
      const name = pair.split("=")[0].toLowerCase();
      return !name.startsWith("utm_") && !["ref", "gclid", "fbclid", "source", "src"].includes(name);
    })
    .sort();
  return `${scheme.toLowerCase()}://${host.toLowerCase()}${path}${params.length ? "?" + params.join("&") : ""}`;
}

class Reader {
  problems: string[] = [];

  text(obj: Record<string, unknown>, field: string, label: string, opts: { max: number; required?: boolean; fallback?: string }): string {
    const value = obj[field];
    if (value === undefined || value === null) {
      if (opts.required) this.problems.push(`${label} is required`);
      return opts.fallback ?? "";
    }
    if (typeof value !== "string") {
      this.problems.push(`${label} must be a string`);
      return opts.fallback ?? "";
    }
    const trimmed = value.trim();
    if (opts.required && !trimmed) this.problems.push(`${label} must not be empty`);
    if (trimmed.length > opts.max) this.problems.push(`${label} must be at most ${opts.max} characters`);
    return trimmed;
  }

  list(obj: Record<string, unknown>, field: string, label: string, opts: { maxItems: number; maxLength: number }): string[] {
    const value = obj[field];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      this.problems.push(`${label} must be an array of strings`);
      return [];
    }
    if (value.length > opts.maxItems) this.problems.push(`${label} may have at most ${opts.maxItems} items`);
    const out: string[] = [];
    value.forEach((item, index) => {
      if (typeof item !== "string" || !item.trim()) {
        this.problems.push(`${label}[${index}] must be a non-empty string`);
      } else if (item.length > opts.maxLength) {
        this.problems.push(`${label}[${index}] must be at most ${opts.maxLength} characters`);
      } else {
        out.push(item.trim());
      }
    });
    return out;
  }

  oneOf<T extends string>(obj: Record<string, unknown>, field: string, label: string, allowed: readonly T[], fallback?: T): T {
    const value = obj[field];
    if ((value === undefined || value === null) && fallback !== undefined) return fallback;
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
      this.problems.push(`${label} must be one of: ${allowed.join(", ")}`);
      return allowed[0];
    }
    return value as T;
  }

  url(obj: Record<string, unknown>, field: string, label: string, required: boolean): string {
    const value = this.text(obj, field, label, { max: 2048, required });
    if (value && !isHttpUrl(value)) this.problems.push(`${label} must be an absolute http(s) URL`);
    return value;
  }

  /** Optional https URL. The page loads it as an image, so plain http would be mixed content. */
  https(obj: Record<string, unknown>, field: string, label: string): string {
    const value = this.text(obj, field, label, { max: 2048 });
    if (value && !(isHttpUrl(value) && /^https:/i.test(value))) this.problems.push(`${label} must be an absolute https URL`);
    return value;
  }

  date(obj: Record<string, unknown>, field: string, label: string, today: string, required: boolean): string {
    const value = this.text(obj, field, label, { max: 10, required });
    if (!value) return "";
    if (!isIsoDate(value)) this.problems.push(`${label} must be a real date formatted YYYY-MM-DD`);
    else if (value > addDays(today, 1)) this.problems.push(`${label} can't be in the future`);
    return value;
  }

  count(obj: Record<string, unknown>, field: string, label: string): number {
    const value = obj[field];
    if (value === undefined || value === null) return 0;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100000) {
      this.problems.push(`${label} must be a whole number`);
      return 0;
    }
    return value;
  }
}

export function validateProfile(raw: unknown): ProfileInput {
  if (!isObject(raw)) throw new ContractError(["profile must be an object"]);
  const r = new Reader();
  const profile: ProfileInput = {
    headline: r.text(raw, "headline", "profile.headline", { max: 200, required: true }),
    summary: r.text(raw, "summary", "profile.summary", { max: 4000, required: true }),
    location: r.text(raw, "location", "profile.location", { max: 200, required: true }),
    workAuthorization: r.text(raw, "workAuthorization", "profile.workAuthorization", { max: 500 }),
    remotePreference: r.text(raw, "remotePreference", "profile.remotePreference", { max: 300 }),
    strengths: r.list(raw, "strengths", "profile.strengths", { maxItems: 20, maxLength: 300 }),
    doNotAssume: r.list(raw, "doNotAssume", "profile.doNotAssume", { maxItems: 20, maxLength: 300 }),
    dealbreakers: r.list(raw, "dealbreakers", "profile.dealbreakers", { maxItems: 20, maxLength: 300 }),
    sources: r.text(raw, "sources", "profile.sources", { max: 300 }),
  };
  if (r.problems.length) throw new ContractError(r.problems);
  return profile;
}

export function validateTracks(raw: unknown): TrackInput[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ContractError(["tracks must be a non-empty array"]);
  if (raw.length > LIMITS.tracksPerUser) throw new ContractError([`tracks may have at most ${LIMITS.tracksPerUser} roles`]);
  const r = new Reader();
  const seen = new Set<string>();
  const tracks = raw.map((item, index): TrackInput => {
    const label = `tracks[${index}]`;
    if (!isObject(item)) {
      r.problems.push(`${label} must be an object`);
      return null as unknown as TrackInput;
    }
    const key = r.text(item, "key", `${label}.key`, { max: 60, required: true });
    if (key && !KEY_PATTERN.test(key)) r.problems.push(`${label}.key must be lowercase words joined by dashes`);
    if (seen.has(key)) r.problems.push(`${label}.key "${key}" is repeated`);
    seen.add(key);
    let salaryTarget: number | null = null;
    const target = item.salaryTarget;
    if (typeof target === "number" && Number.isFinite(target) && target >= 0 && target < 100000000) salaryTarget = Math.round(target);
    else if (target !== undefined && target !== null) r.problems.push(`${label}.salaryTarget must be a number or null`);
    const currency = r.text(item, "salaryCurrency", `${label}.salaryCurrency`, { max: 3 }).toUpperCase();
    if (currency && !/^[A-Z]{3}$/.test(currency)) r.problems.push(`${label}.salaryCurrency must be a 3-letter code like EUR`);
    if (salaryTarget !== null && !currency) r.problems.push(`${label}.salaryCurrency is required when salaryTarget is set`);
    const active = item.active;
    if (active !== undefined && typeof active !== "boolean") r.problems.push(`${label}.active must be true or false`);
    return {
      key,
      title: r.text(item, "title", `${label}.title`, { max: 120, required: true }),
      seniority: r.text(item, "seniority", `${label}.seniority`, { max: 80 }),
      salaryTarget,
      salaryCurrency: currency,
      salaryBasis: r.oneOf(item, "salaryBasis", `${label}.salaryBasis`, SALARY_BASES, "base"),
      searchNotes: r.text(item, "searchNotes", `${label}.searchNotes`, { max: 1000 }),
      active: active === undefined ? true : Boolean(active),
    };
  });
  if (r.problems.length) throw new ContractError(r.problems);
  return tracks;
}

export function validateJobs(raw: unknown, today: string): JobInput[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ContractError(["jobs must be a non-empty array"]);
  if (raw.length > LIMITS.jobsPerSave) {
    throw new ContractError([`Send at most ${LIMITS.jobsPerSave} jobs per call (got ${raw.length}); split the batch`]);
  }
  const r = new Reader();
  const jobs = raw.map((item, index): JobInput => {
    const label = `jobs[${index}]`;
    if (!isObject(item)) {
      r.problems.push(`${label} must be an object`);
      return null as unknown as JobInput;
    }
    const key = r.text(item, "key", `${label}.key`, { max: 100, required: true });
    if (key && !KEY_PATTERN.test(key)) r.problems.push(`${label}.key must be lowercase words joined by dashes`);
    const company = isObject(item.company) ? item.company : {};
    if (!isObject(item.company)) r.problems.push(`${label}.company must be an object`);
    const source = isObject(item.source) ? item.source : {};
    if (!isObject(item.source)) r.problems.push(`${label}.source must be an object with name and url`);
    const list = { maxItems: LIMITS.listItems, maxLength: 300 };
    return {
      key,
      trackKey: r.text(item, "trackKey", `${label}.trackKey`, { max: 60, required: true }),
      title: r.text(item, "title", `${label}.title`, { max: 200, required: true }),
      company: {
        name: r.text(company, "name", `${label}.company.name`, { max: 120, required: true }),
        website: r.url(company, "website", `${label}.company.website`, false),
        icon: r.https(company, "icon", `${label}.company.icon`),
        summary: r.text(company, "summary", `${label}.company.summary`, { max: 1000 }),
        industry: r.text(company, "industry", `${label}.company.industry`, { max: 120 }),
        remoteModel: r.text(company, "remoteModel", `${label}.company.remoteModel`, { max: 120 }),
        remoteSummary: r.text(company, "remoteSummary", `${label}.company.remoteSummary`, { max: 600 }),
      },
      applyUrl: r.url(item, "applyUrl", `${label}.applyUrl`, true),
      location: r.text(item, "location", `${label}.location`, { max: 200, required: true }),
      eligibility: r.oneOf(item, "eligibility", `${label}.eligibility`, ELIGIBILITY),
      workplace: r.oneOf(item, "workplace", `${label}.workplace`, WORKPLACES),
      salary: r.text(item, "salary", `${label}.salary`, { max: 200, fallback: "Not published" }) || "Not published",
      salaryNote: r.text(item, "salaryNote", `${label}.salaryNote`, { max: 800 }),
      fit: r.oneOf(item, "fit", `${label}.fit`, FITS),
      fitSummary: r.text(item, "fitSummary", `${label}.fitSummary`, { max: 1200, required: true }),
      highlights: r.list(item, "highlights", `${label}.highlights`, list),
      caveats: r.list(item, "caveats", `${label}.caveats`, list),
      tags: r.list(item, "tags", `${label}.tags`, { maxItems: 12, maxLength: 40 }),
      source: {
        name: r.text(source, "name", `${label}.source.name`, { max: 120, required: true }),
        url: r.url(source, "url", `${label}.source.url`, true),
      },
      firstFound: r.date(item, "firstFound", `${label}.firstFound`, today, false),
      lastVerified: r.date(item, "lastVerified", `${label}.lastVerified`, today, true),
      openingStatus: r.oneOf(item, "openingStatus", `${label}.openingStatus`, OPENING_STATUSES),
    };
  });
  const keys = new Map<string, number>();
  const urls = new Map<string, number>();
  jobs.forEach((job, index) => {
    if (!job) return;
    if (job.key && keys.has(job.key)) r.problems.push(`jobs[${index}].key "${job.key}" repeats jobs[${keys.get(job.key)}]`);
    keys.set(job.key, index);
    const url = canonicalUrl(job.applyUrl);
    if (job.applyUrl && urls.has(url)) r.problems.push(`jobs[${index}].applyUrl repeats jobs[${urls.get(url)}]; one record per opening`);
    urls.set(url, index);
  });
  if (r.problems.length) throw new ContractError(r.problems);
  return jobs;
}

export type IconInput = { key: string; icon: string };

/** Icons for jobs that are already tracked, by key. "" clears one. */
export function validateIcons(raw: unknown): IconInput[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ContractError(["icons must be a non-empty array of {key, icon}"]);
  if (raw.length > LIMITS.jobsPerUser) throw new ContractError([`icons may have at most ${LIMITS.jobsPerUser} items`]);
  const r = new Reader();
  const icons = raw.map((item, index) => {
    const label = `icons[${index}]`;
    if (!isObject(item)) {
      r.problems.push(`${label} must be an object with key and icon`);
      return { key: "", icon: "" };
    }
    return { key: r.text(item, "key", `${label}.key`, { max: 80, required: true }), icon: r.https(item, "icon", `${label}.icon`) };
  });
  if (r.problems.length) throw new ContractError(r.problems);
  return icons;
}

export function validateRun(raw: unknown): RunInput {
  if (!isObject(raw)) throw new ContractError(["run must be an object with a summary"]);
  const r = new Reader();
  const run = {
    summary: r.text(raw, "summary", "summary", { max: 4000, required: true }),
    added: r.count(raw, "added", "added"),
    updated: r.count(raw, "updated", "updated"),
    closed: r.count(raw, "closed", "closed"),
  };
  if (r.problems.length) throw new ContractError(r.problems);
  return run;
}

export const STATUS_LABELS: Record<Status, string> = {
  shortlisted: "Shortlisted",
  applied: "Applied",
  interviewing: "Interviewing",
  rejected: "Rejected",
  offer: "Offer",
  withdrawn: "Withdrawn",
  not_interested: "Not interested",
};

export const WORKPLACE_LABELS: Record<Workplace, string> = {
  remote_first: "Remote-first company",
  remote_role: "Remote role",
  hybrid: "Hybrid",
  onsite: "On-site",
};

export const ELIGIBILITY_LABELS: Record<Eligibility, string> = {
  confirmed: "Hires where you live",
  likely: "Likely eligible",
  confirm: "Confirm eligibility",
};
