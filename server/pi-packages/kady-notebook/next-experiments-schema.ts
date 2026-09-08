import { Type } from "typebox";
const text = (maxLength = 1600) => Type.String({ minLength: 1, maxLength });
const source = Type.Object({ kind: Type.Optional(Type.Union([Type.Literal("notebook"), Type.Literal("user-note"), Type.Literal("plan-event")])), sessionId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$" })), entryId: text(500), eventId: Type.Optional(text(100)) });
const sources = Type.Array(source, { minItems: 1, maxItems: 6 });
const strings = (minItems = 1) => Type.Array(text(1000), { minItems, maxItems: 8 });
const effort = Type.Object({ level: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("unknown")]), rationale: text(1000) });
export const NextExperimentsSchema = Type.Object({
  target: Type.Object({ sessionId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$" })), entryId: text(500) }),
  question: text(), decision: text(), existingDataAssessment: text(2400),
  explanations: Type.Array(Type.Object({ id: text(40), label: text(200), description: text(), sources }), { minItems: 2, maxItems: 4 }),
  experiments: Type.Array(Type.Object({
    id: text(40), title: text(200), kind: Type.Union([Type.Literal("existing-data"), Type.Literal("new-data"), Type.Literal("literature-check")]),
    priority: Type.Union([Type.Literal("first"), Type.Literal("next"), Type.Literal("later")]), rationale: text(), sources,
    dependsOn: Type.Optional(strings(0)), method: text(), measurement: text(), controls: strings(),
    predictions: Type.Array(Type.Object({ explanationId: text(40), expectedOutcome: text() }), { minItems: 2, maxItems: 4 }),
    decisionBranches: Type.Array(Type.Object({ outcome: text(), decisionChange: text() }), { minItems: 2, maxItems: 4 }),
    inconclusiveAction: text(), requiredInputs: strings(), resources: text(), time: effort, cost: effort, limitations: strings(), whyNewData: Type.Optional(text()),
  }), { minItems: 1, maxItems: 6 }),
}, { description: "PROPOSAL ONLY on a note entry, targeting an already saved hypothesis. Link exact notebook_search sources (sessionId omitted = this note's session). Compare 2–4 competing explanations; every candidate predicts outcomes under all of them and says how observed/inconclusive outcomes change a decision. Prefer existing-data checks; justify new collection. Qualitative priority/time/cost only: no numeric confidence, probability, information-gain or price claims. This never approves or executes work." });
