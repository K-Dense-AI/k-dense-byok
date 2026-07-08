import { describe, it, expect } from "vitest";
import { buildTimeline } from "./notebook-timeline";
import type { NotebookEntry } from "./notebook";

// Local-time timestamps so day boundaries hold in any TZ the test runs in.
const day = (d: number, h = 9) => new Date(2026, 5, d, h).getTime();

const e = (id: string, over: Partial<NotebookEntry> = {}): NotebookEntry => ({
  id,
  type: "note",
  title: id,
  timestamp: day(1),
  ...over,
});

const kinds = (items: ReturnType<typeof buildTimeline>) => items.map((i) => i.kind);

describe("buildTimeline", () => {
  it("returns an empty list for no entries", () => {
    expect(buildTimeline([])).toEqual([]);
  });

  it("emits no day dividers when all entries share one local day", () => {
    const items = buildTimeline([e("a", { timestamp: day(1, 9) }), e("b", { timestamp: day(1, 17) })]);
    expect(kinds(items)).toEqual(["entry", "entry"]);
  });

  it("emits a day divider per day when entries span more than one local day", () => {
    const items = buildTimeline([
      e("a", { timestamp: day(1) }),
      e("b", { timestamp: day(1, 15) }),
      e("c", { timestamp: day(2) }),
    ]);
    expect(kinds(items)).toEqual(["day", "entry", "entry", "day", "entry"]);
  });

  it("emits a run divider only when the runId changes between stamped entries", () => {
    const items = buildTimeline([
      e("a", { runId: "r1" }),
      e("b", { runId: "r1" }),
      e("c", { runId: "r2" }),
    ]);
    expect(kinds(items)).toEqual(["entry", "entry", "run", "entry"]);
    const run = items[2];
    expect(run).toMatchObject({ kind: "run", runId: "r2" });
  });

  it("emits no divider before the first stamped run", () => {
    const items = buildTimeline([e("a"), e("b", { runId: "r1" })]);
    expect(kinds(items)).toEqual(["entry", "entry"]);
  });

  it("does not let unstamped entries reset run tracking", () => {
    const same = buildTimeline([e("a", { runId: "r1" }), e("b"), e("c", { runId: "r1" })]);
    expect(kinds(same)).toEqual(["entry", "entry", "entry"]);
    const changed = buildTimeline([e("a", { runId: "r1" }), e("b"), e("c", { runId: "r2" })]);
    expect(kinds(changed)).toEqual(["entry", "entry", "run", "entry"]);
  });

  it("emits session dividers only when withSessionDividers is set", () => {
    const entries = [e("a", { sessionId: "s1" }), e("b", { sessionId: "s2" })];
    expect(kinds(buildTimeline(entries))).toEqual(["entry", "entry"]);
    const items = buildTimeline(entries, { withSessionDividers: true });
    expect(kinds(items)).toEqual(["session", "entry", "session", "entry"]);
  });

  it("uses sessionNames for divider labels, falling back to the sessionId", () => {
    const items = buildTimeline(
      [e("a", { sessionId: "s1" }), e("b", { sessionId: "s2" })],
      { withSessionDividers: true, sessionNames: new Map([["s1", "Alpha chat"]]) },
    );
    expect(items[0]).toMatchObject({ kind: "session", sessionId: "s1", name: "Alpha chat" });
    expect(items[2]).toMatchObject({ kind: "session", sessionId: "s2", name: "s2" });
  });

  it("resets run tracking at a session divider", () => {
    const items = buildTimeline(
      [
        e("a", { sessionId: "s1", runId: "r1" }),
        // Different runId, but the first stamped entry of a new session must
        // not get a run divider…
        e("b", { sessionId: "s2", runId: "r2" }),
        // …while a change within the session still does.
        e("c", { sessionId: "s2", runId: "r3" }),
      ],
      { withSessionDividers: true },
    );
    expect(kinds(items)).toEqual(["session", "entry", "session", "entry", "run", "entry"]);
  });

  it("resets day tracking at a session divider", () => {
    const items = buildTimeline(
      [
        e("a", { sessionId: "s1", timestamp: day(1) }),
        e("b", { sessionId: "s2", timestamp: day(1, 12) }),
        e("c", { sessionId: "s2", timestamp: day(2) }),
      ],
      { withSessionDividers: true },
    );
    // multiDay overall, so each session restarts its day dividers.
    expect(kinds(items)).toEqual([
      "session", "day", "entry",
      "session", "day", "entry", "day", "entry",
    ]);
  });
});
