import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { Button } from "@spacefast/zero/kit";

type DrawerProps = {
  open: boolean;
  /** Every dismissal (Esc, backdrop, close button) asks this; the drawer stays open until `open` turns false. */
  onClose: () => void;
  /** Called once the drawer has finished sliding out after `open` turned false. Unmount it then, not before. */
  onExited?: () => void;
  title: string;
  description?: string;
  /** Sits above the title, e.g. a company mark. */
  eyebrow?: ComponentChildren;
  children?: ComponentChildren;
  /** Pinned to the bottom, outside the scrolling body. */
  footer?: ComponentChildren;
};

/**
 * A full-height panel over the right edge of the page. It's the same native `<dialog>` and
 * `showModal()` as the kit's Dialog, which supplies the top layer, inert page, focus trap
 * and backdrop. Two things differ besides the shape:
 *
 * - Esc *asks* to close instead of closing, so the caller can refuse (unsaved notes). The
 *   kit's Dialog lets the browser close first and reports afterwards, which leaves a
 *   closed dialog the app still thinks is open.
 * - Browsers may still force-close: a second Esc with no click or keypress in between
 *   skips the cancel event, so a page can't trap people. Then the drawer reopens itself
 *   if the caller still wants it open.
 *
 * Opening slides in with CSS alone (`@starting-style`). Closing can't: once the dialog is
 * closed or unmounted there's nothing left to animate. So when `open` turns false the
 * drawer stays open in a "leaving" state, slides out, then closes itself and calls
 * `onExited`, which is when the caller should unmount it.
 */
export function Drawer({ open, onClose, onExited, title, description, eyebrow, children, footer }: DrawerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [, rerender] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const pressedBackdrop = useRef(false);
  // True until the drawer has been shown, so mounting with `open` false doesn't count as an exit.
  const exited = useRef(true);

  // After every render, not only when `open` changes, so a force-closed drawer comes back.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      if (leaving) setLeaving(false);
      if (!dialog.open) dialog.showModal();
      exited.current = false;
    } else if (dialog.open) {
      if (!leaving) setLeaving(true);
    } else if (!exited.current) {
      exited.current = true;
      onExited?.();
    }
  });

  // Slide out, then close for real. The timer covers a transition that never ends:
  // reduced motion, a hidden tab, or a browser that skips it.
  useEffect(() => {
    const dialog = ref.current;
    if (!leaving || !dialog) return;
    const finish = () => {
      dialog.close();
      setLeaving(false);
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finish();
      return;
    }
    const onEnd = (event: TransitionEvent) => {
      if (event.target === dialog && event.propertyName === "translate" && !event.pseudoElement) finish();
    };
    dialog.addEventListener("transitionend", onEnd);
    const timer = window.setTimeout(finish, 400);
    return () => {
      dialog.removeEventListener("transitionend", onEnd);
      window.clearTimeout(timer);
    };
  }, [leaving]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (!open) return;
        onClose();
        rerender((n) => n + 1);
      }}
      // Clicks on ::backdrop land on the dialog itself; the panel covers the rest of it.
      // Requiring the press to start there too means selecting text in the notes and
      // releasing over the backdrop doesn't throw the drawer away.
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === ref.current;
      }}
      onClick={(event) => {
        if (pressedBackdrop.current && event.target === ref.current) onClose();
      }}
      class={
        "fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-[min(44rem,100vw)] max-w-none overflow-hidden " +
        "border-0 border-l border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-[2px] " +
        "transition-[translate] duration-200 starting:translate-x-full motion-reduce:transition-none " +
        "backdrop:transition-opacity backdrop:duration-200 starting:backdrop:opacity-0 motion-reduce:backdrop:transition-none " +
        // Whole literals per state, so Tailwind sees both and only one easing ever applies.
        (leaving ? "translate-x-full ease-in backdrop:opacity-0" : "ease-out")
      }
    >
      <div class="flex h-full flex-col">
        <header class="flex items-start justify-between gap-4 border-b border-line px-5 py-4 sm:px-7 sm:py-5">
          <div class="min-w-0">
            {eyebrow}
            <h2 id={`${id}-title`} class="text-xl font-semibold leading-snug tracking-tight text-ink sm:text-2xl">
              {title}
            </h2>
            {description ? (
              <p id={`${id}-description`} class="mt-1 text-sm text-ink-muted">
                {description}
              </p>
            ) : null}
          </div>
          <Button aria-label="Close" icon="x" size="icon" variant="ghost" onClick={onClose} />
        </header>
        {/* Focus starts here rather than on Close: no stray focus ring when a job opens, and
            arrow keys and Page Down scroll the job right away. Tab still reaches everything. */}
        <div autofocus tabIndex={-1} class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 outline-none sm:px-7">
          {children}
        </div>
        {footer ? <footer class="border-t border-line bg-surface px-5 py-4 sm:px-7">{footer}</footer> : null}
      </div>
    </dialog>
  );
}
