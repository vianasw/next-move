"use client";

import { Link, useMutation, useQuery } from "@spacefast/zero/client";
import { Button, EmptyState, Spinner, Switch } from "@spacefast/zero/kit";
import { DeleteData } from "../client/DeleteData";
import type { Workspace } from "../client/types";
import { PageHeading, downloadJson, formatDate, trackSalary } from "../client/ui";

function List({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div>
      <h3 class="text-xs font-semibold uppercase tracking-[0.14em] text-ink-muted">{title}</h3>
      {items.length ? (
        <ul class="mt-2 list-disc space-y-1 pl-5 text-sm">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p class="mt-2 text-sm text-ink-muted">{empty}</p>
      )}
    </div>
  );
}

export default function ProfilePage() {
  const data = useQuery<Workspace | null>("workspace");
  const setTrackActive = useMutation<[trackId: string, active: boolean], void>("setTrackActive");

  if (data === undefined) {
    return (
      <div class="flex justify-center py-24">
        <Spinner label="Loading your profile" />
      </div>
    );
  }
  if (!data) return null;
  const { profile, tracks } = data;

  return (
    <>
      <PageHeading
        eyebrow="What your agent knows"
        title="Profile & roles"
        intro="Your agent writes this from your CV or LinkedIn. To change it, run the setup prompt again and tell your agent what's different."
        actions={
          <Button variant="outline" onClick={() => downloadJson(`nextmove-export-${data.today}.json`, data)}>
            ↓ Export everything
          </Button>
        }
      />

      {!profile ? (
        <div class="rounded-xl border border-line bg-surface p-8">
          <EmptyState
            icon="inbox"
            title="No profile yet"
            description="Give your agent the setup prompt. It asks for your CV and the roles you want, then saves a summary here."
            action={
              <Link to="/agent" class="inline-flex rounded-lg bg-[#182e2a] px-4 py-2 text-sm font-semibold text-white hover:bg-[#244e3d] dark:bg-[#d8efa4] dark:text-[#182e2a] dark:hover:bg-[#c5e48a]">
                Get the setup prompt
              </Link>
            }
          />
        </div>
      ) : (
        <div class="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <section aria-labelledby="profile-heading" class="rounded-xl border border-line bg-surface p-6">
            <h2 id="profile-heading" class="text-xl font-semibold">{profile.headline}</h2>
            <p class="mt-1 text-sm text-ink-muted">
              {profile.location}
              {profile.remotePreference ? ` · ${profile.remotePreference}` : ""}
            </p>
            <p class="mt-4 whitespace-pre-line text-sm leading-relaxed">{profile.summary}</p>
            {profile.workAuthorization ? (
              <p class="mt-4 text-sm">
                <span class="font-semibold">Can work in:</span> {profile.workAuthorization}
              </p>
            ) : null}
            <div class="mt-6 grid gap-6 sm:grid-cols-2">
              <List title="Strengths" items={profile.strengths} empty="None listed." />
              <List title="Agents must not assume" items={profile.doNotAssume} empty="Nothing listed." />
              <List title="Dealbreakers" items={profile.dealbreakers} empty="None listed." />
            </div>
            <p class="mt-6 text-xs text-ink-muted">
              Based on {profile.sources || "what you shared"} · Updated {formatDate(profile.updatedAt)}
            </p>
          </section>

          <section aria-labelledby="roles-heading">
            <h2 id="roles-heading" class="text-xl font-semibold">Roles you're tracking</h2>
            <p class="mt-1 text-sm text-ink-muted">Paused roles keep their openings, and agents stop searching for them.</p>
            <ul class="mt-4 space-y-3">
              {tracks.map((track) => (
                <li key={track.id} class={track.active ? "rounded-xl border border-line bg-surface p-4" : "rounded-xl border border-line bg-canvas p-4 opacity-75"}>
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <p class="font-semibold">{track.title}</p>
                      <p class="text-sm text-ink-muted">
                        {[track.seniority, trackSalary(track)].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <label class="flex items-center gap-2 text-xs text-ink-muted">
                      {track.active ? "Active" : "Paused"}
                      <Switch checked={track.active} aria-label={`Search for ${track.title}`} onChange={() => void setTrackActive(track.id, !track.active)} />
                    </label>
                  </div>
                  {track.searchNotes ? <p class="mt-2 text-sm">{track.searchNotes}</p> : null}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      <section aria-labelledby="your-data-heading" class="mt-10 rounded-xl border border-line bg-surface p-6">
        <h2 id="your-data-heading" class="text-xl font-semibold">Your data</h2>
        <p class="mt-1 max-w-2xl text-sm text-ink-muted">
          “Export everything” downloads all of it as JSON. Deleting removes everything Next move stores for you, disconnects your agents and frees
          your spot. Signing in again later starts from scratch.
        </p>
        <div class="mt-4">
          <DeleteData />
        </div>
      </section>
    </>
  );
}
