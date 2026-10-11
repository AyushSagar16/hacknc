import type { SiteStage } from "@/lib/types";

const STATUS: Record<SiteStage["status"], string> = { open: "Open", in_progress: "In progress", decided: "Decided" };

/** Location → dates → travel → stay → food & activities, each open, in progress or decided. */
export function StageBar({ stages }: { stages: SiteStage[] }) {
  if (!stages.length) return null;
  const done = stages.filter((s) => s.status === "decided").length;
  const next = stages.find((s) => s.status !== "decided");
  return (
    <section className="stages" aria-label="Planning progress">
      <p className="stages-head small">
        <strong>
          {done} of {stages.length} decided
        </strong>
        {next ? <span className="muted"> · up next: {next.label.toLowerCase()}</span> : <span className="muted"> · all set</span>}
      </p>
      <ol>
        {stages.map((s) => (
          <li key={s.key} className={`stage ${s.status}`} aria-current={s === next ? "step" : undefined}>
            <span className="stage-bar" aria-hidden="true" />
            <span className="stage-label">{s.label}</span>
            <span className="stage-detail">{s.status === "decided" && s.detail ? s.detail : STATUS[s.status]}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
