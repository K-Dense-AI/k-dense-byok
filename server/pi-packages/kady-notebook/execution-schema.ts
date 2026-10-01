import { Type } from "typebox";

export const NotebookExecutionSchema = Type.Object({
  status: Type.Union([Type.Literal("planned"), Type.Literal("attempted"), Type.Literal("completed"), Type.Literal("unverified")]),
  evidence: Type.Optional(Type.String({ minLength: 1, maxLength: 4000,
    description: "Concrete command/run identifier, observed exit/output and exact log/result paths supporting the status. Required for completed; a plan, approval or filename alone is insufficient. This is your report, not independent verification." })),
}, { description: "Execution state of this procedure, separate from its scientific outcome. Use planned before running, attempted for partial/failed/cancelled execution, completed only with execution evidence, unverified when records are insufficient." });
