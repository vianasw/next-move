import { useState } from "preact/hooks";
import { signOut, useMutation } from "@spacefast/zero/client";
import { Alert, Button, Dialog, Field, Input } from "@spacefast/zero/kit";

/** "Delete my data": a confirm-by-typing dialog, then sign out. The server re-checks the word. */
export function DeleteData({ compact }: { compact?: boolean }) {
  const remove = useMutation<[confirmation: string], Record<string, number>>("deleteAccount");
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = typed.trim() === "DELETE";

  function close() {
    if (busy) return;
    setOpen(false);
    setTyped("");
    setError("");
  }

  async function confirm() {
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      await remove("DELETE");
      await signOut();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't delete your data. Try again.");
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant={compact ? "outline" : "danger"} onClick={() => setOpen(true)}>
        Delete my data
      </Button>
      <Dialog
        open={open}
        onClose={close}
        title="Delete everything?"
        description="This can't be undone."
        footer={
          <div class="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void confirm()} disabled={!ready || busy} loading={busy}>
              {busy ? "Deleting…" : "Delete my data"}
            </Button>
          </div>
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void confirm();
          }}
        >
          <p class="text-sm">
            Next move will delete your profile, roles, every saved opening with its status and notes, your agent connections and their run
            history. Connected agents stop working right away, and your spot opens up for someone else.
          </p>
          {compact ? null : <p class="mt-2 text-sm text-ink-muted">Want a copy first? Close this and use “Export everything”.</p>}
          <div class="mt-4">
            <Field label="Type DELETE to confirm" htmlFor="confirm-delete">
              <Input
                id="confirm-delete"
                value={typed}
                autoComplete="off"
                autoCapitalize="characters"
                spellcheck={false}
                onInput={(event) => setTyped((event.currentTarget as HTMLInputElement).value)}
              />
            </Field>
          </div>
          {error ? (
            <div class="mt-4">
              <Alert tone="danger">{error}</Alert>
            </div>
          ) : null}
        </form>
      </Dialog>
    </>
  );
}
