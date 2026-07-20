/**
 * Typed scientific-result tool and wire protocol.
 *
 * The model calls `scientific_result` after it has produced a concrete result.
 * Pi persists the returned details alongside the tool-result message; events.ts
 * and session-history.ts extract only this versioned envelope for the web UI.
 */
import fs from "node:fs";
import path from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { resolvePaths } from "../projects.ts";
import {
  apiRelative,
  guessMime,
  isUserVisible,
  isWithin,
} from "../sandbox-fs.ts";

export const SCIENTIFIC_RESULT_VERSION = 1 as const;
export const MAX_SCIENTIFIC_RESULT_BYTES = 64 * 1024;

const ShortString = Type.String({ minLength: 1, maxLength: 200 });
const MediumString = Type.String({ minLength: 1, maxLength: 500 });
const LongString = Type.String({ minLength: 1, maxLength: 2_000 });
const PathString = Type.String({ minLength: 1, maxLength: 1_000 });
const Scalar = Type.Union([
  Type.String({ maxLength: 500 }),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
]);

const ArtifactRole = Type.Union([
  Type.Literal("input"),
  Type.Literal("output"),
  Type.Literal("figure"),
  Type.Literal("table"),
  Type.Literal("script"),
  Type.Literal("report"),
  Type.Literal("data"),
  Type.Literal("log"),
  Type.Literal("other"),
]);

export const ScientificArtifactSchema = Type.Object(
  {
    path: PathString,
    label: Type.Optional(ShortString),
    description: Type.Optional(MediumString),
    role: Type.Optional(ArtifactRole),
  },
  { additionalProperties: false },
);

const commonProperties = {
  schemaVersion: Type.Literal(SCIENTIFIC_RESULT_VERSION),
  title: ShortString,
  summary: Type.Optional(LongString),
  artifacts: Type.Optional(Type.Array(ScientificArtifactSchema, { maxItems: 25 })),
};

const TableColumnSchema = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 100 }),
    label: ShortString,
    unit: Type.Optional(Type.String({ maxLength: 50 })),
    description: Type.Optional(MediumString),
  },
  { additionalProperties: false },
);

const TableCardSchema = Type.Object(
  {
    ...commonProperties,
    kind: Type.Literal("table"),
    columns: Type.Array(TableColumnSchema, { minItems: 1, maxItems: 25 }),
    rows: Type.Array(Type.Array(Scalar, { maxItems: 25 }), { maxItems: 100 }),
    totalRows: Type.Optional(Type.Integer({ minimum: 0 })),
    truncated: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const StatisticalTestSchema = Type.Object(
  {
    name: ShortString,
    method: Type.Optional(MediumString),
    estimate: Type.Optional(Type.Number()),
    estimateLabel: Type.Optional(ShortString),
    statistic: Type.Optional(Type.Number()),
    statisticLabel: Type.Optional(ShortString),
    degreesOfFreedom: Type.Optional(Type.Union([Type.Number(), ShortString])),
    pValue: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    adjustedPValue: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    effectSize: Type.Optional(Type.Number()),
    effectSizeLabel: Type.Optional(ShortString),
    confidenceInterval: Type.Optional(
      Type.Tuple([Type.Number(), Type.Number()]),
    ),
    confidenceLevel: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    sampleSize: Type.Optional(Type.Integer({ minimum: 0 })),
    interpretation: Type.Optional(LongString),
  },
  { additionalProperties: false },
);

const StatisticalTestCardSchema = Type.Object(
  {
    ...commonProperties,
    kind: Type.Literal("statistical-test"),
    tests: Type.Array(StatisticalTestSchema, { minItems: 1, maxItems: 20 }),
  },
  { additionalProperties: false },
);

const PlotImageSchema = Type.Object(
  {
    path: PathString,
    alt: MediumString,
    caption: Type.Optional(LongString),
  },
  { additionalProperties: false },
);

const PlotCardSchema = Type.Object(
  {
    ...commonProperties,
    kind: Type.Literal("plot"),
    images: Type.Array(PlotImageSchema, { minItems: 1, maxItems: 8 }),
  },
  { additionalProperties: false },
);

const ArtifactListCardSchema = Type.Object(
  {
    ...commonProperties,
    kind: Type.Literal("artifact-list"),
    items: Type.Array(ScientificArtifactSchema, { minItems: 1, maxItems: 25 }),
  },
  { additionalProperties: false },
);

const QcCheckSchema = Type.Object(
  {
    name: ShortString,
    status: Type.Union([
      Type.Literal("pass"),
      Type.Literal("warn"),
      Type.Literal("fail"),
    ]),
    value: Type.Optional(Scalar),
    expected: Type.Optional(MediumString),
    message: Type.Optional(LongString),
    artifact: Type.Optional(PathString),
  },
  { additionalProperties: false },
);

const QcReportCardSchema = Type.Object(
  {
    ...commonProperties,
    kind: Type.Literal("qc-report"),
    overall: Type.Union([
      Type.Literal("pass"),
      Type.Literal("warn"),
      Type.Literal("fail"),
    ]),
    checks: Type.Array(QcCheckSchema, { minItems: 1, maxItems: 100 }),
  },
  { additionalProperties: false },
);

const DatasetDimensionSchema = Type.Object(
  {
    name: ShortString,
    size: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const DatasetFieldSchema = Type.Object(
  {
    name: ShortString,
    dtype: ShortString,
    unit: Type.Optional(Type.String({ maxLength: 50 })),
    missing: Type.Optional(Type.Integer({ minimum: 0 })),
    unique: Type.Optional(Type.Integer({ minimum: 0 })),
    description: Type.Optional(MediumString),
  },
  { additionalProperties: false },
);

const DatasetSchemaCardSchema = Type.Object(
  {
    ...commonProperties,
    kind: Type.Literal("dataset-schema"),
    path: Type.Optional(PathString),
    format: Type.Optional(ShortString),
    shape: Type.Optional(
      Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1, maxItems: 8 }),
    ),
    dimensions: Type.Optional(
      Type.Array(DatasetDimensionSchema, { maxItems: 20 }),
    ),
    fields: Type.Optional(Type.Array(DatasetFieldSchema, { maxItems: 100 })),
    rowCount: Type.Optional(Type.Integer({ minimum: 0 })),
    columnCount: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const CitationSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("doi"),
      Type.Literal("arxiv"),
      Type.Literal("pubmed"),
      Type.Literal("url"),
      Type.Literal("other"),
    ]),
    identifier: MediumString,
    title: Type.Optional(MediumString),
    url: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
    authors: Type.Optional(Type.Array(ShortString, { maxItems: 20 })),
    year: Type.Optional(Type.Integer({ minimum: 0, maximum: 9999 })),
    note: Type.Optional(LongString),
  },
  { additionalProperties: false },
);

const CitationListCardSchema = Type.Object(
  {
    ...commonProperties,
    kind: Type.Literal("citation-list"),
    entries: Type.Array(CitationSchema, { minItems: 1, maxItems: 100 }),
  },
  { additionalProperties: false },
);

const MoleculePropertySchema = Type.Object(
  {
    name: ShortString,
    value: Scalar,
    unit: Type.Optional(Type.String({ maxLength: 50 })),
  },
  { additionalProperties: false },
);

const MoleculeCardSchema = Type.Object(
  {
    ...commonProperties,
    kind: Type.Literal("molecule"),
    path: Type.Optional(PathString),
    index: Type.Optional(Type.Integer({ minimum: 0 })),
    name: Type.Optional(ShortString),
    formula: Type.Optional(ShortString),
    smiles: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
    inchi: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
    molecularWeight: Type.Optional(Type.Number({ minimum: 0 })),
    atomCount: Type.Optional(Type.Integer({ minimum: 0 })),
    bondCount: Type.Optional(Type.Integer({ minimum: 0 })),
    properties: Type.Optional(
      Type.Array(MoleculePropertySchema, { maxItems: 30 }),
    ),
  },
  { additionalProperties: false },
);

export const ScientificResultParams = Type.Union(
  [
    TableCardSchema,
    StatisticalTestCardSchema,
    PlotCardSchema,
    ArtifactListCardSchema,
    QcReportCardSchema,
    DatasetSchemaCardSchema,
    CitationListCardSchema,
    MoleculeCardSchema,
  ],
  {
    description:
      "A compact, typed scientific result card. Put large/full data in sandbox artifacts and show only a bounded preview here.",
  },
);

export type ScientificResultCard = Static<typeof ScientificResultParams>;
export interface ScientificResultDetails {
  scientificResult: ScientificResultCard;
}

function normalizedFile(projectId: string, rawPath: string): string {
  const sandbox = resolvePaths(projectId).sandbox;
  const target = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(sandbox, rawPath);
  if (!isWithin(sandbox, target)) throw new Error(`Artifact path leaves sandbox: ${rawPath}`);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    throw new Error(`Artifact file does not exist: ${rawPath}`);
  }
  const realSandbox = fs.realpathSync(sandbox);
  const realTarget = fs.realpathSync(target);
  if (!isWithin(realSandbox, realTarget)) {
    throw new Error(`Artifact path leaves sandbox through a symlink: ${rawPath}`);
  }
  if (!isUserVisible(target, sandbox)) {
    throw new Error(`Artifact is not user-visible: ${rawPath}`);
  }
  return apiRelative(sandbox, target);
}

function normalizedArtifact(
  projectId: string,
  artifact: Static<typeof ScientificArtifactSchema>,
): Static<typeof ScientificArtifactSchema> {
  return { ...artifact, path: normalizedFile(projectId, artifact.path) };
}

function normalizedUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Citation URL is invalid: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Citation URL must use http or https: ${raw}`);
  }
  return parsed.toString();
}

function normalizeCard(
  projectId: string,
  params: ScientificResultCard,
): ScientificResultCard {
  const card = {
    ...params,
    ...(params.artifacts
      ? { artifacts: params.artifacts.map((item) => normalizedArtifact(projectId, item)) }
      : {}),
  } as ScientificResultCard;

  switch (card.kind) {
    case "table":
      if (card.rows.some((row) => row.length !== card.columns.length)) {
        throw new Error("Every table row must have exactly one value per column");
      }
      break;
    case "plot":
      card.images = card.images.map((image) => ({
        ...image,
        path: normalizedFile(projectId, image.path),
      }));
      for (const image of card.images) {
        if (!guessMime(image.path).startsWith("image/")) {
          throw new Error(`Plot preview must reference an image file: ${image.path}`);
        }
      }
      break;
    case "artifact-list":
      card.items = card.items.map((item) => normalizedArtifact(projectId, item));
      break;
    case "qc-report":
      card.checks = card.checks.map((check) => ({
        ...check,
        ...(check.artifact
          ? { artifact: normalizedFile(projectId, check.artifact) }
          : {}),
      }));
      break;
    case "dataset-schema":
      if (
        !card.path &&
        !card.shape?.length &&
        !card.dimensions?.length &&
        !card.fields?.length
      ) {
        throw new Error("Dataset schema needs a path, shape, dimensions, or fields");
      }
      if (card.path) card.path = normalizedFile(projectId, card.path);
      break;
    case "citation-list":
      card.entries = card.entries.map((entry) => ({
        ...entry,
        ...(entry.url ? { url: normalizedUrl(entry.url) } : {}),
      }));
      break;
    case "molecule":
      if (!card.path && !card.smiles && !card.inchi) {
        throw new Error("Molecule card needs a sandbox file, SMILES, or InChI");
      }
      if (card.path) card.path = normalizedFile(projectId, card.path);
      break;
    case "statistical-test":
      break;
  }

  if (Buffer.byteLength(JSON.stringify(card), "utf-8") > MAX_SCIENTIFIC_RESULT_BYTES) {
    throw new Error(
      `Scientific result exceeds ${MAX_SCIENTIFIC_RESULT_BYTES / 1024}KB; save the full result as an artifact and provide a smaller preview`,
    );
  }
  return card;
}

/** Strictly extract the only tool-result details shape Kady sends to the UI. */
export function scientificResultFromDetails(
  details: unknown,
): ScientificResultCard | undefined {
  if (!details || typeof details !== "object") return undefined;
  const result = (details as { scientificResult?: unknown }).scientificResult;
  try {
    if (!Value.Check(ScientificResultParams, result)) return undefined;
    if (
      Buffer.byteLength(JSON.stringify(result), "utf-8") >
      MAX_SCIENTIFIC_RESULT_BYTES
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return result;
}

export function makeScientificResultTool(
  projectId: string,
) {
  return defineTool<typeof ScientificResultParams, ScientificResultDetails>({
    name: "scientific_result",
    label: "Scientific result",
    description: [
      "Present a concrete scientific result as a typed card in the user's chat.",
      "Use only values you actually observed or computed; this tool presents evidence but does not independently verify it.",
      "Keep previews compact and save complete tables, plots, scripts, and reports as sandbox artifacts.",
      "Use the notebook tool separately for hypotheses, methods, observations, and decisions.",
    ].join("\n"),
    promptSnippet:
      "scientific_result: present observed tables, statistics, plots, QC, schemas, citations, molecules, and artifacts as typed cards",
    promptGuidelines: [
      "After obtaining a meaningful scientific result, call `scientific_result` with a compact typed preview and links to the underlying sandbox artifacts.",
      "Never invent values for a result card. Cards are presentation, not independent verification.",
      "Do not paste large datasets into a card; save them to files and include the files as artifacts.",
    ],
    parameters: ScientificResultParams,
    async execute(_toolCallId, params) {
      const card = normalizeCard(projectId, params);
      return {
        content: [
          {
            type: "text",
            text: `Presented ${card.kind} result: ${card.title}`,
          },
        ],
        details: { scientificResult: card },
      };
    },
  });
}
