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

function getCollapsedSummary(events: SidebarProvenanceEvent[]) {
  const latestEvent = events[events.length - 1];
  if (!latestEvent) {
    return "Session events appear here after the first chat activity.";
  }

  return `${latestEvent.label} · ${latestEvent.relativeTime} · ${latestEvent.detail}`;
}

export function ProvenancePanel({ events }: { events: SidebarProvenanceEvent[] }) {
  if (events.length === 0) {
    return null;
  }

  const eventCountLabel = `${events.length} event${events.length === 1 ? "" : "s"}`;
  const collapsedSummary = getCollapsedSummary(events);

  return (
    <details
      className="sidebar-drawer provenance-dock"
      data-chat-region="provenance"
      aria-label="Session provenance"
    >
      <summary>
        <span className="provenance-dock__summary">
          <span className="provenance-dock__title-row">
            <span>Session provenance</span>
            <span className="chip">{eventCountLabel}</span>
          </span>
          <span className="provenance-dock__preview">{collapsedSummary}</span>
        </span>
      </summary>
      <div className="sidebar-drawer__body provenance-dock__body">
        <div className="provenance-list provenance-list--scroll">
          {events.map((event) => (
            <ProvenanceItem event={event} key={event.id} />
          ))}
        </div>
      </div>
    </details>
  );
}
