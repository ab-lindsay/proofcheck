"use client";
import { useDevMode } from "@/hooks/use-dev-mode";
import { useDevEscalation, setDevEscalation } from "@/hooks/use-dev-escalation";

/**
 * Dev-mode-only switch for the escalation ladder (off by default, matching the server).
 *
 * Deliberately named for what it DOES rather than what it is: "escalation ladder" is internal
 * vocabulary, meaningless to anyone reading the header. Styled as a bordered pill group like the
 * tier switcher beside it so it reads as a control rather than stray text, and labelled Off/On so
 * the current state is legible without decoding a colour.
 *
 * This is a demo/debugging affordance, not a user feature — it makes verification slower for no
 * measured accuracy gain, which is exactly why the default is off. It lives here so the agentic loop
 * can be watched working on the deployed URL (the verdict card then shows its attempt trail) without
 * a redeploy.
 */
export function EscalationToggle() {
  const devMode = useDevMode();
  const enabled = useDevEscalation();
  if (!devMode) return null;

  const title = enabled
    ? "ON — re-reads fields the extractor read badly (crop or contrast-boost, then re-extract). Slower, and measured no accuracy gain."
    : "OFF (default) — one extraction per label. Turn on to watch the self-correcting re-read loop work.";

  return (
    <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1" title={title}>
      <span className="px-1.5 text-xs font-semibold whitespace-nowrap text-foreground">Re-read weak fields</span>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Re-read weak fields"
        onClick={() => setDevEscalation(!enabled)}
        className={`rounded-md px-2.5 py-1.5 text-xs font-bold uppercase tracking-wide transition-colors ${
          enabled ? "bg-primary text-primary-foreground" : "bg-muted text-foreground hover:bg-muted/80"
        }`}
      >
        {enabled ? "On" : "Off"}
      </button>
    </div>
  );
}
