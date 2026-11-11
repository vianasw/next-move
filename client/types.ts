import type { Eligibility, Fit, OpeningStatus, Status, Workplace } from "../shared/contract";

type Person = { displayName: string; email: string; userId: string };

export type Viewer =
  | { state: "signed_out"; seatsLeft: number; cap: number }
  | ({ state: "can_join"; invited: boolean; returning: boolean; seatsLeft: number; cap: number } & Person)
  | ({ state: "no_access"; reason: "full" | "removed" } & Person)
  | ({ state: "member" } & Person);

export type Profile = {
  headline: string;
  summary: string;
  location: string;
  workAuthorization: string;
  remotePreference: string;
  strengths: string[];
  doNotAssume: string[];
  dealbreakers: string[];
  sources: string;
  updatedAt: string;
};

export type Track = {
  id: string;
  key: string;
  title: string;
  seniority: string;
  salaryTarget: number | null;
  salaryCurrency: string;
  salaryBasis: "base" | "total";
  searchNotes: string;
  active: boolean;
};

export type Job = {
  id: string;
  key: string;
  trackKey: string;
  title: string;
  company: { name: string; website: string; icon: string; summary: string; industry: string; remoteModel: string; remoteSummary: string };
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
  status: Status;
  notes: string;
  statusChangedAt: string;
  updatedAt: string;
};

export type Workspace = { today: string; profile: Profile | null; tracks: Track[]; jobs: Job[] };

export type AgentKey = {
  id: string;
  label: string;
  kind: "session" | "mcp";
  keyPrefix: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
  state: "active" | "expired" | "revoked";
};

export type Run = {
  id: string;
  agentLabel: string;
  summary: string;
  added: number;
  updated: number;
  closed: number;
  createdAt: string;
};

export type Activity = { keys: AgentKey[]; runs: Run[] };
