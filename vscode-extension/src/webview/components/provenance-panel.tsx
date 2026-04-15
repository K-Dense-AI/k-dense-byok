import type { SidebarProvenanceChip, SidebarProvenanceEvent } from "../../shared/sidebar-scaffold";

function renderChipLabel(chip: SidebarProvenanceChip) {
  return (
    <span className="chip" key={`${chip.label}:${chip.value}`}>
      <span className="chip__label">{chip.label}:</span>
      <span>{chip.value}</span>
    </span>
  );
}

function ProvenanceItem({ event }: { event: SidebarProvenanceEvent }) {
  return (
    <article className="provenance-item">
      <span className={`provenance__dot provenance__dot--${event.type}`} aria-hidden="true" />
      <div>
        <div className="provenance__row">
          <span className="provenance__label">{event.label}</span>
          <span className="provenance__time">{event.relativeTime}</span>
        </div>
        <p className="provenance__detail">{event.detail}</p>
        {event.chips && event.chips.length > 0 ? (
          <div className="provenance__chips">{event.chips.map(renderChipLabel)}</div>
        ) : null}
      </div>
    </article>
  );
}

export function ProvenancePanel({ events }: { events: SidebarProvenanceEvent[] }) {
  if (events.length === 0) {
    return null;
  }

  return (
    <details className="sidebar-drawer" aria-label="Session provenance">
      <summary>
        <span>Session provenance</span>
        <span className="chip">{`${events.length} event${events.length === 1 ? "" : "s"}`}</span>
      </summary>
      <div className="sidebar-drawer__body">
        <div className="provenance-list provenance-list--scroll">
          {events.map((event) => (
            <ProvenanceItem event={event} key={event.id} />
          ))}
        </div>
      </div>
    </details>
  );
}
