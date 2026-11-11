import type { ComponentChildren } from "preact";
import { useMemo, useState } from "preact/hooks";
import { Badge, Icon, Select as KitSelect, type SelectProps } from "@spacefast/zero/kit";
import { addDays } from "../shared/contract";
import type { Job, Track } from "./types";

export function formatDate(iso: string): string {
  if (!iso) return "Not recorded";
  const date = iso.length === 10 ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateTime(iso: string): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function formatMoney(amount: number | null, currency: string): string {
  if (amount === null) return "No target";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "EUR", maximumFractionDigits: 0, notation: amount >= 1000 ? "compact" : "standard" }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

export function trackSalary(track: Track): string {
  if (track.salaryTarget === null) return "No salary target";
  return `${formatMoney(track.salaryTarget, track.salaryCurrency)} ${track.salaryBasis === "base" ? "base" : "total"}`;
}

export function isNew(job: Job, today: string): boolean {
  return job.status === "shortlisted" && job.openingStatus === "open" && !!job.firstFound && job.firstFound >= addDays(today, -7);
}

export function needsRecheck(job: Job, today: string): boolean {
  return job.openingStatus === "open" && !!job.lastVerified && job.lastVerified < addDays(today, -14);
}

/**
 * The kit's Select with a chevron we place ourselves. The browser's own arrow sits
 * wherever the browser likes, a few pixels from the border, and padding doesn't reliably
 * move it. So `appearance-none` drops it and an icon goes in the padding we reserve.
 */
export function Select({ class: className, ...props }: SelectProps) {
  return (
    <span class="relative block min-w-0">
      <KitSelect {...props} class={`cursor-pointer appearance-none pr-10 ${typeof className === "string" ? className : ""}`} />
      <span aria-hidden="true" class="pointer-events-none absolute inset-y-0 right-3 flex items-center text-ink-muted">
        <Icon name="chevron-down" size="sm" />
      </span>
    </span>
  );
}

export function FitBadge({ fit }: { fit: Job["fit"] }) {
  if (fit === "strong") return <Badge tone="success">Strong match</Badge>;
  if (fit === "good") return <Badge tone="accent">Good match</Badge>;
  return <Badge tone="warning">Stretch</Badge>;
}

export function NewBadge() {
  return <span class="rounded bg-[#d8efa4] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#294c28]">New</span>;
}

/** Each icon URL's natural width once known, 0 if it failed, so remounts skip straight to the answer. */
const iconWidths = new Map<string, number>();

/** Best first: the icon the agent read off the company's homepage, then the conventional /favicon.ico. */
function iconSources(icon: string, website: string): string[] {
  const sources = icon ? [icon] : [];
  try {
    const { protocol, hostname } = new URL(website);
    if (protocol === "https:" || protocol === "http:") sources.push(`https://${hostname}/favicon.ico`);
  } catch {
    // No website, or not a URL: the initial will do.
  }
  return sources;
}

/**
 * The company's icon on a white tile, since most are drawn for light browser tabs, with its
 * initial until one loads or if none does. The browser fetches the icon straight from the
 * company's site (Zero handlers can't fetch, so there's no proxy); no-referrer keeps Next
 * move's address out of the request.
 */
export function CompanyMark({ name, website = "", icon = "" }: { name: string; website?: string; icon?: string }) {
  const [, recheck] = useState(0);
  const sources = useMemo(() => iconSources(icon, website), [icon, website]);
  const src = sources.find((candidate) => iconWidths.get(candidate) !== 0);
  const width = src === undefined ? undefined : iconWidths.get(src);
  const shown = width !== undefined && width > 0;
  const settle = (url: string, naturalWidth: number) => {
    iconWidths.set(url, naturalWidth);
    recheck((n) => n + 1);
  };
  // Sized by what actually arrived. Touch icons (usually 180px) are drawn as full tiles; a
  // 16px favicon gets drawn small, because stretching it to fill a retina tile turns it to mush.
  const imageClass = !shown
    ? "absolute h-7 w-7 opacity-0"
    : width >= 96
      ? "h-full w-full object-contain"
      : width >= 32
        ? "h-7 w-7 rounded-md object-contain"
        : "h-5 w-5 object-contain";
  return (
    <span
      aria-hidden="true"
      class={
        shown
          ? "relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-white"
          : "relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-surface text-base font-semibold text-ink"
      }
    >
      {shown ? null : (name.trim()[0] ?? "?").toUpperCase()}
      {src ? (
        <img
          key={src}
          src={src}
          alt=""
          width={28}
          height={28}
          loading="lazy"
          decoding="async"
          referrerpolicy="no-referrer"
          class={imageClass}
          // Anything under 16px (a 1×1 placeholder, a tracking pixel) isn't an icon. A loaded
          // image reporting 0 is an SVG with no fixed size: it scales, so draw it mid-size.
          onLoad={(event) => {
            const natural = (event.currentTarget as HTMLImageElement).naturalWidth;
            settle(src, natural === 0 ? 64 : natural >= 16 ? natural : 0);
          }}
          onError={() => settle(src, 0)}
        />
      ) : null}
    </span>
  );
}

export function PageHeading({ eyebrow, title, intro, actions }: { eyebrow: string; title: string; intro?: string; actions?: ComponentChildren }) {
  return (
    <div class="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p class="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">{eyebrow}</p>
        <h1 class="mt-1 text-3xl font-semibold tracking-tight text-ink sm:text-4xl">{title}</h1>
        {intro ? <p class="mt-2 max-w-2xl text-ink-muted">{intro}</p> : null}
      </div>
      {actions ? <div class="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Chip({ children }: { children: ComponentChildren }) {
  return <span class="rounded-md border border-line bg-surface px-2.5 py-1 text-xs text-ink-muted">{children}</span>;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
