"use client";

import { useState } from "preact/hooks";
import { useMutation, useQuery } from "@spacefast/zero/client";
import { Alert, Badge, Button, CodeBlock, Input, Spinner, TextArea } from "@spacefast/zero/kit";
import { MCP_KEY_DAYS, onboardingPrompt, updatePrompt, type ConnectionMode } from "../shared/prompts";
import type { Activity, AgentKey, Workspace } from "../client/types";
import { PageHeading, copyText, formatDateTime } from "../client/ui";

type Purpose = "onboarding" | "update";

function origin(): string {
  return typeof location === "undefined" ? "" : location.origin;
}

function ModeToggle({ mode, onChange }: { mode: ConnectionMode; onChange: (mode: ConnectionMode) => void }) {
  const option = (value: ConnectionMode, title: string, hint: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === value}
      onClick={() => onChange(value)}
      class={
        mode === value
          ? "flex-1 rounded-lg border-2 border-[#182e2a] bg-surface p-3 text-left dark:border-[#d8efa4]"
          : "flex-1 rounded-lg border-2 border-line bg-surface p-3 text-left hover:border-ink-muted"
      }
    >
      <span class="block text-sm font-semibold text-ink">{title}</span>
      <span class="mt-0.5 block text-xs text-ink-muted">{hint}</span>
    </button>
  );
  return (
    <div role="radiogroup" aria-label="How your agent connects" class="flex flex-col gap-2 sm:flex-row">
      {option("http", "One-time code", "Any agent that can make HTTP requests: Claude Code, Codex, Cursor…")}
      {option("mcp", "MCP connector", "Your agent already has the Next move MCP server connected.")}
    </div>
  );
}

function PromptCard({ purpose, mode, step, title, description }: { purpose: Purpose; mode: ConnectionMode; step: string; title: string; description: string }) {
  const createHandoff = useMutation<[purpose: Purpose], { code: string; expiresAt: string }>("createHandoff");
  const [prompt, setPrompt] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<"" | "yes" | "no">("");
  const [error, setError] = useState("");

  async function generate() {
    setBusy(true);
    setError("");
    setCopied("");
    try {
      const build = purpose === "onboarding" ? onboardingPrompt : updatePrompt;
      if (mode === "mcp") {
        setPrompt(build({ origin: origin(), mode }));
        setExpiresAt("");
      } else {
        const handoff = await createHandoff(purpose);
        const expires = new Date(handoff.expiresAt);
        const label = `${expires.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZoneName: "short" })} (${handoff.expiresAt})`;
        setPrompt(build({ origin: origin(), mode, code: handoff.code, expiresAt: label }));
        setExpiresAt(handoff.expiresAt);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't create the prompt.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    setCopied((await copyText(prompt)) ? "yes" : "no");
  }

  return (
    <div class="flex flex-col rounded-xl border border-line bg-surface p-5">
      <p class="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">{step}</p>
      <h3 class="mt-1 text-lg font-semibold text-ink">{title}</h3>
      <p class="mt-1 text-sm text-ink-muted">{description}</p>
      {prompt ? (
        <>
          <TextArea class="mt-4 font-mono text-xs" rows={9} readOnly value={prompt} aria-label={`${title} prompt`} onFocus={(e) => (e.currentTarget as HTMLTextAreaElement).select()} />
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <Button onClick={() => void copy()}>{copied === "yes" ? "Copied ✓" : "Copy prompt"}</Button>
            <Button variant="ghost" onClick={() => void generate()} loading={busy}>
              New prompt
            </Button>
          </div>
          {copied === "no" ? <p class="mt-2 text-xs text-warning">Your browser blocked copying. Select the text above and copy it yourself.</p> : null}
          {expiresAt ? (
            <p class="mt-2 text-xs text-ink-muted">
              The code inside works once and expires at {formatDateTime(expiresAt)}. It gives your agent a key that lasts 6 hours. Paste the prompt into your agent now.
            </p>
          ) : null}
        </>
      ) : (
        <div class="mt-4">
          <Button onClick={() => void generate()} loading={busy}>
            Create prompt
          </Button>
        </div>
      )}
      {error ? (
        <div class="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
    </div>
  );
}

function McpSetup() {
  const createMcpKey = useMutation<[label: string], { key: string; expiresAt: string }>("createMcpKey");
  const [label, setLabel] = useState("Claude Code");
  const [issued, setIssued] = useState<{ key: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const url = `${origin()}/mcp`;

  async function create() {
    setBusy(true);
    setError("");
    try {
      setIssued(await createMcpKey(label));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't create a key.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="mcp-heading" class="mt-10">
      <h2 id="mcp-heading" class="text-xl font-semibold">Connect over MCP</h2>
      <p class="mt-1 max-w-3xl text-sm text-ink-muted">
        Optional. With the MCP server connected, your agent gets proper Next move tools instead of HTTP calls, and prompts no longer need a code. It works with
        coding agents that let you set a header: Claude Code, Cursor and Codex. ChatGPT and Claude.ai connectors aren't supported yet.
      </p>
      <div class="mt-4 rounded-xl border border-line bg-surface p-5">
        {issued ? (
          <>
            <Alert tone="warning" title="Copy this key now">
              It's shown once and lasts {MCP_KEY_DAYS} days. Anyone with it can update your tracker (never your status or notes). Revoke it below if it leaks.
            </Alert>
            <div class="mt-4 space-y-4">
              <div>
                <p class="mb-1 text-sm font-semibold">Claude Code</p>
                <CodeBlock language="bash" code={`claude mcp add --transport http nextmove ${url} \\\n  --header "Authorization: Bearer ${issued.key}"`} />
              </div>
              <div>
                <p class="mb-1 text-sm font-semibold">Cursor (~/.cursor/mcp.json)</p>
                <CodeBlock
                  language="json"
                  code={JSON.stringify({ mcpServers: { nextmove: { url, headers: { Authorization: `Bearer ${issued.key}` } } } }, null, 2)}
                />
              </div>
              <div>
                <p class="mb-1 text-sm font-semibold">Codex (~/.codex/config.toml, key read from an environment variable)</p>
                <CodeBlock language="toml" code={`[mcp_servers.nextmove]\nurl = "${url}"\nbearer_token_env_var = "NEXTMOVE_KEY"\n\n# in your shell profile:\n# export NEXTMOVE_KEY="${issued.key}"`} />
              </div>
            </div>
            <Button class="mt-4" variant="ghost" onClick={() => setIssued(null)}>
              I've saved it
            </Button>
          </>
        ) : (
          <form
            class="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <label class="flex-1 text-sm">
              <span class="mb-1 block font-medium">Which agent is this for?</span>
              <Input value={label} maxLength={60} onInput={(e) => setLabel((e.currentTarget as HTMLInputElement).value)} />
            </label>
            <Button type="submit" loading={busy}>
              Create MCP key
            </Button>
          </form>
        )}
        {error ? (
          <div class="mt-3">
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function KeyState({ k }: { k: AgentKey }) {
  if (k.state === "active") return <Badge tone="success">Active</Badge>;
  if (k.state === "revoked") return <Badge tone="danger">Revoked</Badge>;
  return <Badge tone="neutral">Expired</Badge>;
}

function Connections({ activity }: { activity: Activity }) {
  const revokeKey = useMutation<[keyId: string], void>("revokeKey");
  const visible = activity.keys.filter((k) => k.state === "active" || k.kind === "mcp").slice(0, 25);
  return (
    <section aria-labelledby="connections-heading" class="mt-10">
      <h2 id="connections-heading" class="text-xl font-semibold">Connected agents</h2>
      <p class="mt-1 text-sm text-ink-muted">Every key an agent holds. Revoking one cuts it off immediately.</p>
      <div class="mt-4 overflow-x-auto rounded-xl border border-line bg-surface">
        {visible.length ? (
          <table class="w-full min-w-[640px] text-left text-sm">
            <thead class="border-b border-line text-xs uppercase tracking-[0.12em] text-ink-muted">
              <tr>
                <th scope="col" class="px-4 py-3 font-semibold">Agent</th>
                <th scope="col" class="px-4 py-3 font-semibold">Type</th>
                <th scope="col" class="px-4 py-3 font-semibold">Last used</th>
                <th scope="col" class="px-4 py-3 font-semibold">Expires</th>
                <th scope="col" class="px-4 py-3 font-semibold">Status</th>
                <th scope="col" class="px-4 py-3"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((k) => (
                <tr key={k.id} class="border-b border-line last:border-b-0">
                  <td class="px-4 py-3">
                    <span class="font-medium">{k.label}</span>
                    <span class="block font-mono text-xs text-ink-muted">{k.keyPrefix}…</span>
                  </td>
                  <td class="px-4 py-3">{k.kind === "mcp" ? "MCP" : "Prompt session"}</td>
                  <td class="px-4 py-3">{formatDateTime(k.lastUsedAt)}</td>
                  <td class="px-4 py-3">{formatDateTime(k.expiresAt)}</td>
                  <td class="px-4 py-3">
                    <KeyState k={k} />
                  </td>
                  <td class="px-4 py-3 text-right">
                    {k.state === "active" ? (
                      <Button size="sm" variant="outline" onClick={() => void revokeKey(k.id)}>
                        Revoke
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p class="p-5 text-sm text-ink-muted">No agents connected right now.</p>
        )}
      </div>
    </section>
  );
}

function Runs({ activity }: { activity: Activity }) {
  return (
    <section aria-labelledby="runs-heading" class="mt-10">
      <h2 id="runs-heading" class="text-xl font-semibold">Recent agent runs</h2>
      {activity.runs.length ? (
        <ol class="mt-4 space-y-3">
          {activity.runs.map((run) => (
            <li key={run.id} class="rounded-xl border border-line bg-surface p-4">
              <p class="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                <span class="font-semibold text-ink">{run.agentLabel}</span>
                <span>{formatDateTime(run.createdAt)}</span>
                <span>
                  · {run.added} added · {run.updated} updated · {run.closed} closed
                </span>
              </p>
              <p class="mt-2 whitespace-pre-line text-sm text-ink">{run.summary}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p class="mt-2 text-sm text-ink-muted">When your agent finishes a run, its summary shows up here.</p>
      )}
    </section>
  );
}

export default function AgentPage() {
  const data = useQuery<Workspace | null>("workspace");
  const activity = useQuery<Activity | null>("agentActivity");
  const [mode, setMode] = useState<ConnectionMode>("http");

  if (data === undefined || activity === undefined) {
    return (
      <div class="flex justify-center py-24">
        <Spinner label="Loading" />
      </div>
    );
  }
  if (!data || !activity) return null;

  return (
    <>
      <PageHeading
        eyebrow="Bring your own AI"
        title="Your agent does the searching."
        intro="Next move never runs an AI itself. Copy a prompt into the agent you already use; it researches openings, explains why each fits, and saves them here."
      />
      <h2 class="sr-only">Create a prompt</h2>
      <ModeToggle mode={mode} onChange={setMode} />
      <div class="mt-4 grid gap-4 lg:grid-cols-2">
        <PromptCard
          purpose="onboarding"
          mode={mode}
          step={data.profile ? "Start over" : "Step 1"}
          title="Set up my search"
          description="Your agent asks for your CV or LinkedIn, the roles you want and your salary targets, saves a summary (never the CV itself), then runs the first search."
        />
        <PromptCard
          purpose="update"
          mode={mode}
          step={data.profile ? "Any time" : "After setup"}
          title="Update my search"
          description="Your agent rechecks listings that are getting stale and looks for new openings for every active role."
        />
      </div>
      {mode === "http" ? (
        <p class="mt-3 text-xs text-ink-muted">
          Each prompt contains a code that works once, for 30 minutes. A prompt left in an old chat can't be reused.
        </p>
      ) : null}
      <McpSetup />
      <Connections activity={activity} />
      <Runs activity={activity} />
    </>
  );
}
