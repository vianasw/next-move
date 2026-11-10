import type { ComponentChildren } from "preact";
import { Link, SignInWithGoogle, signOut, useAuth } from "@spacefast/zero/client";
import { Button, Spinner } from "@spacefast/zero/kit";

function AuthControls() {
  const auth = useAuth();
  if (auth.isLoading) return <Spinner size="sm" />;
  if (auth.isGuest) return <SignInWithGoogle />;
  return (
    <div class="flex items-center gap-2">
      <span class="text-sm text-ink-muted">{auth.displayName}</span>
      <Button variant="ghost" size="sm" onClick={() => signOut()}>
        Sign out
      </Button>
    </div>
  );
}

export function Layout({ children }: { children: ComponentChildren }) {
  return (
    <main class="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-4 p-6">
      <header class="flex items-center justify-between gap-4">
        <nav class="flex gap-4 text-sm font-medium">
          <Link to="/" class="text-ink hover:text-accent">Todos</Link>
          <Link to="/status" class="text-ink hover:text-accent">Status</Link>
        </nav>
        <AuthControls />
      </header>
      {children}
    </main>
  );
}
