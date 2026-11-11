import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { Link, SignInWithGoogle, SignInWithGravatar, signOut, useAuth, useLocation, useMutation, useQuery } from "@spacefast/zero/client";
import { Alert, Button, Spinner } from "@spacefast/zero/kit";
import { DeleteData } from "./DeleteData";
import type { Viewer } from "./types";

const NAV = [
  { to: "/", label: "Opportunities", glyph: "▦" },
  { to: "/agent", label: "Your agent", glyph: "⌘" },
  { to: "/profile", label: "Profile & roles", glyph: "◉" },
];

function Brand({ inverted }: { inverted?: boolean }) {
  return (
    <span class="flex items-center gap-3">
      <span class="flex h-9 w-9 items-center justify-center rounded-lg bg-[#d8efa4] text-lg font-bold text-[#182e2a]">
        n<span class="text-xs">↗</span>
      </span>
      <span class={inverted ? "text-lg font-semibold tracking-tight text-white" : "text-lg font-semibold tracking-tight text-ink"}>next move</span>
    </span>
  );
}

function Centered({ children }: { children: ComponentChildren }) {
  return <div class="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10 text-ink">{children}</div>;
}

function seatLine(seatsLeft: number, cap: number) {
  if (seatsLeft <= 0) return "Next move is full, so it's invite-only now. If someone invited you, sign in with the email they used.";
  const spots = seatsLeft === 1 ? "1 spot left" : `${seatsLeft} spots left`;
  return `Open to the first ${cap} people, then invite-only. ${spots}.`;
}

function Landing({ viewer }: { viewer: Extract<Viewer, { state: "signed_out" }> }) {
  return (
    <Centered>
      <div class="w-full max-w-md rounded-2xl border border-line bg-surface p-8 shadow-sm">
        <Brand />
        <h1 class="mt-8 text-3xl font-semibold tracking-tight">A good place to land.</h1>
        <p class="mt-3 text-ink-muted">
          Track openings across every role you're considering. Your own AI agent does the searching and explains why each role fits;
          Next move keeps it organized.
        </p>
        <div class="mt-8 flex flex-col gap-3">
          <SignInWithGoogle
            requestPii
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#182e2a] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#244e3d] dark:bg-[#d8efa4] dark:text-[#182e2a] dark:hover:bg-[#c5e48a]"
          />
          <SignInWithGravatar
            requestPii
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface px-4 py-2.5 text-sm font-semibold text-ink hover:bg-canvas"
          >
            Sign in with WordPress.com
          </SignInWithGravatar>
        </div>
        <p class="mt-6 text-xs text-ink-muted">{seatLine(viewer.seatsLeft, viewer.cap)} Your notes and application progress are visible only to you.</p>
      </div>
    </Centered>
  );
}

function SignedInAs({ viewer }: { viewer: { displayName: string; email: string } }) {
  return (
    <>
      <strong class="text-ink">{viewer.displayName}</strong>
      {viewer.email ? ` (${viewer.email})` : ""}
    </>
  );
}

function Join({ viewer }: { viewer: Extract<Viewer, { state: "can_join" }> }) {
  const join = useMutation<[], void>("join");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function claim() {
    setBusy(true);
    setError("");
    try {
      await join();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't join. Try again.");
      setBusy(false);
    }
  }

  return (
    <Centered>
      <div class="w-full max-w-md rounded-2xl border border-line bg-surface p-8 shadow-sm">
        <Brand />
        <h1 class="mt-8 text-2xl font-semibold tracking-tight">
          {viewer.returning ? "Welcome back." : viewer.invited ? "You're invited." : "There's room for you."}
        </h1>
        <p class="mt-3 text-ink-muted">
          You're signed in as <SignedInAs viewer={viewer} />.{" "}
          {viewer.returning
            ? "Next move now encrypts what you store in it. Continue to encrypt your existing data; it takes a moment, and your agents reconnect on their own."
            : viewer.invited
              ? "Your invitation holds your place."
              : `Next move is open to the first ${viewer.cap} people, and ${viewer.seatsLeft === 1 ? "1 spot is" : `${viewer.seatsLeft} spots are`} left.`}
        </p>
        {error ? (
          <div class="mt-4">
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : null}
        <div class="mt-6 flex flex-wrap gap-3">
          <Button onClick={() => void claim()} disabled={busy}>
            {busy ? (viewer.returning ? "Encrypting…" : "Joining…") : viewer.returning ? "Continue" : viewer.invited ? "Join Next move" : "Claim my spot"}
          </Button>
          <Button variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </div>
    </Centered>
  );
}

function NoAccess({ viewer }: { viewer: Extract<Viewer, { state: "no_access" }> }) {
  const full = viewer.reason === "full";
  return (
    <Centered>
      <div class="w-full max-w-md rounded-2xl border border-line bg-surface p-8 shadow-sm">
        <Brand />
        <h1 class="mt-8 text-2xl font-semibold tracking-tight">{full ? "Next move is full." : "No access."}</h1>
        <p class="mt-3 text-ink-muted">
          You're signed in as <SignedInAs viewer={viewer} />.{" "}
          {full
            ? `Every open spot is taken, so it's invite-only now. Ask whoever runs Next move to invite ${viewer.email ? "that email" : "this account ID"}.`
            : "This account doesn't have access to Next move."}
        </p>
        {full && !viewer.email ? <p class="mt-3 break-all rounded-md bg-canvas p-2 font-mono text-xs text-ink-muted">{viewer.userId}</p> : null}
        {full ? null : <p class="mt-3 text-sm text-ink-muted">You can still delete anything you saved here.</p>}
        <div class="mt-6 flex flex-wrap gap-3">
          <Button variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
          {full ? null : <DeleteData compact />}
        </div>
      </div>
    </Centered>
  );
}

function Shell({ viewer, children }: { viewer: Extract<Viewer, { state: "member" }>; children: ComponentChildren }) {
  const { pathname } = useLocation();
  const active = (to: string) => (to === "/" ? pathname === "/" : pathname.startsWith(to));
  return (
    <div class="min-h-dvh bg-canvas text-ink">
      <a href="#main" class="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside class="bg-[#182e2a] text-[#dce4db] md:fixed md:inset-y-0 md:left-0 md:flex md:w-60 md:flex-col md:px-5 md:py-8">
        <div class="flex items-center justify-between px-4 py-3 md:block md:p-0">
          <Link to="/" aria-label="Next move home">
            <Brand inverted />
          </Link>
          <button type="button" class="text-xs text-[#9fb3a6] underline-offset-2 hover:underline md:hidden" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
        <nav aria-label="Main" class="flex gap-1 overflow-x-auto px-3 pb-3 md:mt-10 md:flex-col md:px-0 md:pb-0">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              aria-current={active(item.to) ? "page" : undefined}
              class={
                active(item.to)
                  ? "flex shrink-0 items-center gap-3 rounded-lg bg-[#d8efa4] px-3 py-2 text-sm font-semibold text-[#182e2a]"
                  : "flex shrink-0 items-center gap-3 rounded-lg px-3 py-2 text-sm text-[#dce4db] hover:bg-white/10"
              }
            >
              <span aria-hidden="true" class="w-4 text-center">{item.glyph}</span>
              {item.label}
            </Link>
          ))}
        </nav>
        <div class="mt-auto hidden border-t border-white/10 pt-5 md:block">
          <p class="truncate text-sm font-medium text-white">{viewer.displayName}</p>
          {viewer.email ? <p class="truncate text-xs text-[#9fb3a6]">{viewer.email}</p> : null}
          <button type="button" class="mt-3 text-xs text-[#9fb3a6] underline-offset-2 hover:text-white hover:underline" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </aside>
      <div class="min-w-0 md:ml-60">
        <main id="main" class="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 md:px-10 md:py-10">
          {children}
        </main>
      </div>
    </div>
  );
}

export function Layout({ children }: { children: ComponentChildren }) {
  const auth = useAuth();
  const viewer = useQuery<Viewer>("viewer");
  if (auth.isLoading || viewer === undefined) {
    return (
      <Centered>
        <Spinner label="Getting your workspace ready" />
      </Centered>
    );
  }
  if (viewer.state === "signed_out") return <Landing viewer={viewer} />;
  if (viewer.state === "can_join") return <Join viewer={viewer} />;
  if (viewer.state === "no_access") return <NoAccess viewer={viewer} />;
  return <Shell viewer={viewer}>{children}</Shell>;
}
