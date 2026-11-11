import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { useMutation } from "@spacefast/zero/client";
import { Alert, Badge, Button, TextArea } from "@spacefast/zero/kit";
import { ELIGIBILITY_LABELS, STATUSES, STATUS_LABELS, WORKPLACE_LABELS, type Status } from "../shared/contract";
import type { Job, Track } from "./types";
import { Drawer } from "./Drawer";
import { CompanyMark, FitBadge, Select, formatDate, formatDateTime, needsRecheck } from "./ui";

function Section({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="mt-5">
      <h3 class="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">{title}</h3>
      <div class="mt-2 text-sm leading-relaxed text-ink">{children}</div>
    </section>
  );
}

function Bullets({ items }: { items: string[] }) {
  if (!items.length) return <p class="text-ink-muted">None noted.</p>;
  return (
    <ul class="list-disc space-y-1 pl-5">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

export function JobDetail({ job, track, today, onClose }: { job: Job | null; track: Track | undefined; today: string; onClose: () => void }) {
  const setStatus = useMutation<[jobId: string, status: Status], void>("setStatus");
  const saveNotes = useMutation<[jobId: string, notes: string], void>("saveNotes");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [warnUnsaved, setWarnUnsaved] = useState(false);
  const [error, setError] = useState("");
  // Closing is two steps: the drawer slides out, then onClose unmounts it.
  const [closing, setClosing] = useState(false);

  const jobId = job?.id ?? "";
  useEffect(() => {
    setNotes(job?.notes ?? "");
    setWarnUnsaved(false);
    setError("");
    setClosing(false);
  }, [jobId]);

  if (!job) return null;
  const dirty = notes !== job.notes;

  function requestClose() {
    if (dirty) setWarnUnsaved(true);
    else setClosing(true);
  }

  async function onSave(): Promise<boolean> {
    if (!job) return false;
    setSaving(true);
    setError("");
    try {
      await saveNotes(job.id, notes);
      setWarnUnsaved(false);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save notes.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      open={!closing}
      onClose={requestClose}
      onExited={onClose}
      title={job.title}
      description={`${job.location} · ${WORKPLACE_LABELS[job.workplace] ?? job.workplace}`}
      eyebrow={
        <div class="mb-3 flex items-center gap-3">
          <CompanyMark name={job.company.name} website={job.company.website} icon={job.company.icon} />
          <span class="text-sm font-medium text-ink-muted">{job.company.name}</span>
        </div>
      }
      footer={
        <>
          {warnUnsaved ? (
            <div class="mb-3">
              <Alert tone="warning" title="You have unsaved notes">
                <div class="flex flex-wrap items-center gap-2">
                  <span>Save them, or discard them and close.</span>
                  <Button size="sm" disabled={saving} loading={saving} onClick={async () => (await onSave()) && setClosing(true)}>
                    Save and close
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setClosing(true)}>
                    Discard and close
                  </Button>
                </div>
                {error ? <p class="mt-2 font-medium text-danger">{error}</p> : null}
              </Alert>
            </div>
          ) : null}
          <div class="flex w-full flex-wrap items-center justify-between gap-3">
            <a
              href={job.applyUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1 rounded-lg bg-[#182e2a] px-4 py-2 text-sm font-semibold text-white hover:bg-[#244e3d] dark:bg-[#d8efa4] dark:text-[#182e2a] dark:hover:bg-[#c5e48a]"
            >
              Open employer posting ↗
            </a>
            <Button variant="ghost" onClick={requestClose}>
              Close
            </Button>
          </div>
        </>
      }
    >
      <div class="flex flex-wrap items-center gap-2">
        <FitBadge fit={job.fit} />
        <Badge tone={job.eligibility === "confirmed" ? "success" : job.eligibility === "likely" ? "accent" : "warning"}>
          {ELIGIBILITY_LABELS[job.eligibility] ?? job.eligibility}
        </Badge>
        {job.openingStatus === "closed" ? <Badge tone="danger">Listing closed</Badge> : null}
        {job.openingStatus === "unknown" ? <Badge tone="warning">Availability unclear</Badge> : null}
        {needsRecheck(job, today) ? <Badge tone="warning">Needs recheck</Badge> : null}
      </div>

      <div class="mt-5 grid gap-4 rounded-xl border border-line bg-canvas p-4 sm:grid-cols-2">
        <label class="text-sm">
          <span class="mb-1 block text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">Your progress</span>
          <Select value={job.status} onChange={(event) => void setStatus(job.id, (event.currentTarget as HTMLSelectElement).value as Status)}>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </Select>
        </label>
        <div class="text-sm">
          <span class="mb-1 block text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">Role</span>
          <span>{track ? track.title : job.trackKey}</span>
          {job.statusChangedAt ? <span class="block text-xs text-ink-muted">Status changed {formatDateTime(job.statusChangedAt)}</span> : null}
        </div>
      </div>

      <Section title="Why it fits">{job.fitSummary}</Section>
      <Section title="Compensation">
        <p class="font-medium">{job.salary}</p>
        {job.salaryNote ? <p class="mt-1 text-ink-muted">{job.salaryNote}</p> : null}
      </Section>
      <Section title="Highlights">
        <Bullets items={job.highlights} />
      </Section>
      <Section title="Caveats">
        <Bullets items={job.caveats} />
      </Section>
      <Section title={`About ${job.company.name}`}>
        {job.company.summary ? <p>{job.company.summary}</p> : null}
        {job.company.remoteSummary ? <p class="mt-2 text-ink-muted">{job.company.remoteSummary}</p> : null}
        <p class="mt-2 text-xs text-ink-muted">
          {[job.company.industry, job.company.remoteModel].filter(Boolean).join(" · ")}
          {job.company.website ? (
            <>
              {" · "}
              <a class="underline" href={job.company.website} target="_blank" rel="noopener noreferrer">
                Website
              </a>
            </>
          ) : null}
        </p>
      </Section>
      {job.tags.length ? (
        <div class="mt-4 flex flex-wrap gap-1.5">
          {job.tags.map((tag) => (
            <span key={tag} class="rounded bg-canvas px-2 py-0.5 text-xs text-ink-muted">
              {tag}
            </span>
          ))}
        </div>
      ) : null}

      <Section title="Your notes">
        <TextArea
          rows={5}
          value={notes}
          placeholder="Contacts, interview prep, follow-ups… Only you can see these; agents can't read them."
          aria-label="Your notes"
          onInput={(event) => {
            setNotes((event.currentTarget as HTMLTextAreaElement).value);
            setWarnUnsaved(false);
          }}
        />
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!dirty || saving} loading={saving} onClick={() => void onSave()}>
            Save notes
          </Button>
          {dirty ? (
            <Button size="sm" variant="ghost" onClick={() => setNotes(job.notes)}>
              Discard changes
            </Button>
          ) : null}
        </div>
        {error ? (
          <div class="mt-3">
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : null}
      </Section>

      <p class="mt-6 text-xs text-ink-muted">
        Found {formatDate(job.firstFound)} · Verified {formatDate(job.lastVerified)} · Source{" "}
        <a class="underline" href={job.source.url} target="_blank" rel="noopener noreferrer">
          {job.source.name}
        </a>
      </p>
    </Drawer>
  );
}
