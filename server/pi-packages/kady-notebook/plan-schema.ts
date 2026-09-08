/** Self-contained shared schemas: the vendored child package must load standalone. */
import { Type } from "typebox";
const detail = () => Type.String({ minLength: 1, maxLength: 4000 });
export const AnalysisPlanSchema = Type.Object({
  hypothesis: detail(),
  primaryOutcome: detail(),
  exclusions: detail(),
  model: detail(),
  multiplicity: detail(),
  qc: detail(),
  stopping: detail(),
  exposureNotes: detail(),
  datasets: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 8 }),
  intent: Type.Union([Type.Literal("exploratory"), Type.Literal("confirmatory")]),
  priorExposure: Type.Union([Type.Literal("none"), Type.Literal("metadata-only"), Type.Literal("outcomes-inspected"), Type.Literal("unknown")]),
}, { description: "DRAFT analysis plan for a hypothesis entry. State unknown/not-applicable fields explicitly. Only the user can review and freeze it in the notebook UI; this tool cannot approve or preregister anything." });
export const NotebookResultsSchema = Type.Array(Type.Object({
  toolCallId: Type.String({ minLength: 1, maxLength: 500 }),
  sessionId: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$" })),
}), { maxItems: 12, description: "References to successful persisted scientific_result calls. Use ids returned by that tool; omit sessionId for this session. Never copy or invent result measurements here." });
