/** Versioned wire model for typed scientific-result tool cards. */
export const SCIENTIFIC_RESULT_VERSION = 1 as const;

export type ScientificScalar = string | number | boolean | null;
export type ScientificStatus = "pass" | "warn" | "fail";

export interface ScientificArtifact {
  path: string;
  label?: string;
  description?: string;
  role?:
    | "input"
    | "output"
    | "figure"
    | "table"
    | "script"
    | "report"
    | "data"
    | "log"
    | "other";
}

interface ScientificResultBase {
  schemaVersion: typeof SCIENTIFIC_RESULT_VERSION;
  title: string;
  summary?: string;
  artifacts?: ScientificArtifact[];
}

export interface TableResult extends ScientificResultBase {
  kind: "table";
  columns: {
    key: string;
    label: string;
    unit?: string;
    description?: string;
  }[];
  rows: ScientificScalar[][];
  totalRows?: number;
  truncated?: boolean;
}

export interface StatisticalTestResult extends ScientificResultBase {
  kind: "statistical-test";
  tests: {
    name: string;
    method?: string;
    estimate?: number;
    estimateLabel?: string;
    statistic?: number;
    statisticLabel?: string;
    degreesOfFreedom?: number | string;
    pValue?: number;
    adjustedPValue?: number;
    effectSize?: number;
    effectSizeLabel?: string;
    confidenceInterval?: [number, number];
    confidenceLevel?: number;
    sampleSize?: number;
    interpretation?: string;
  }[];
}

export interface PlotResult extends ScientificResultBase {
  kind: "plot";
  images: { path: string; alt: string; caption?: string }[];
}

export interface ArtifactListResult extends ScientificResultBase {
  kind: "artifact-list";
  items: ScientificArtifact[];
}

export interface QcReportResult extends ScientificResultBase {
  kind: "qc-report";
  overall: ScientificStatus;
  checks: {
    name: string;
    status: ScientificStatus;
    value?: ScientificScalar;
    expected?: string;
    message?: string;
    artifact?: string;
  }[];
}

export interface DatasetSchemaResult extends ScientificResultBase {
  kind: "dataset-schema";
  path?: string;
  format?: string;
  shape?: number[];
  dimensions?: { name: string; size: number }[];
  fields?: {
    name: string;
    dtype: string;
    unit?: string;
    missing?: number;
    unique?: number;
    description?: string;
  }[];
  rowCount?: number;
  columnCount?: number;
}

export interface CitationListResult extends ScientificResultBase {
  kind: "citation-list";
  entries: {
    kind: "doi" | "arxiv" | "pubmed" | "url" | "other";
    identifier: string;
    title?: string;
    url?: string;
    authors?: string[];
    year?: number;
    note?: string;
  }[];
}

export interface MoleculeResult extends ScientificResultBase {
  kind: "molecule";
  path?: string;
  index?: number;
  name?: string;
  formula?: string;
  smiles?: string;
  inchi?: string;
  molecularWeight?: number;
  atomCount?: number;
  bondCount?: number;
  properties?: {
    name: string;
    value: ScientificScalar;
    unit?: string;
  }[];
}

export type ScientificResultCard =
  | TableResult
  | StatisticalTestResult
  | PlotResult
  | ArtifactListResult
  | QcReportResult
  | DatasetSchemaResult
  | CitationListResult
  | MoleculeResult;

export interface ToolResultImage {
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

const STATUSES = new Set<ScientificStatus>(["pass", "warn", "fail"]);
const CITATION_KINDS = new Set(["doi", "arxiv", "pubmed", "url", "other"]);
const IMAGE_MIME = new Set<ToolResultImage["mimeType"]>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isScalar(value: unknown): value is ScientificScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    isFiniteNumber(value)
  );
}

function isArtifact(value: unknown): value is ScientificArtifact {
  return (
    isRecord(value) &&
    isString(value.path) &&
    (value.label === undefined || typeof value.label === "string") &&
    (value.description === undefined || typeof value.description === "string") &&
    (value.role === undefined || typeof value.role === "string")
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function hasCommonFields(value: Record<string, unknown>): boolean {
  return (
    value.schemaVersion === SCIENTIFIC_RESULT_VERSION &&
    isString(value.title) &&
    (value.summary === undefined || typeof value.summary === "string") &&
    (value.artifacts === undefined ||
      (Array.isArray(value.artifacts) && value.artifacts.every(isArtifact)))
  );
}

/**
 * Defensively validate a server/history payload before rendering it. The
 * backend owns the full schema; this parser prevents malformed old/forged
 * session rows from crashing a discriminated renderer.
 */
export function parseScientificResult(value: unknown): ScientificResultCard | null {
  if (!isRecord(value) || !hasCommonFields(value) || typeof value.kind !== "string") {
    return null;
  }

  switch (value.kind) {
    case "table": {
      const columns = value.columns;
      if (
        !Array.isArray(columns) ||
        !columns.every(
          (column) =>
            isRecord(column) &&
            isString(column.key) &&
            isString(column.label) &&
            isOptionalString(column.unit) &&
            isOptionalString(column.description),
        ) ||
        !Array.isArray(value.rows) ||
        !value.rows.every(
          (row) =>
            Array.isArray(row) &&
            row.length === columns.length &&
            row.every(isScalar),
        )
      ) {
        return null;
      }
      break;
    }
    case "statistical-test":
      if (
        !Array.isArray(value.tests) ||
        !value.tests.every(
          (test) =>
            isRecord(test) &&
            isString(test.name) &&
            isOptionalString(test.method) &&
            isOptionalNumber(test.estimate) &&
            isOptionalString(test.estimateLabel) &&
            isOptionalNumber(test.statistic) &&
            isOptionalString(test.statisticLabel) &&
            (test.degreesOfFreedom === undefined ||
              isFiniteNumber(test.degreesOfFreedom) ||
              isString(test.degreesOfFreedom)) &&
            isOptionalNumber(test.pValue) &&
            isOptionalNumber(test.adjustedPValue) &&
            isOptionalNumber(test.effectSize) &&
            isOptionalString(test.effectSizeLabel) &&
            (test.confidenceInterval === undefined ||
              (Array.isArray(test.confidenceInterval) &&
                test.confidenceInterval.length === 2 &&
                test.confidenceInterval.every(isFiniteNumber))) &&
            isOptionalNumber(test.confidenceLevel) &&
            isOptionalNumber(test.sampleSize) &&
            isOptionalString(test.interpretation),
        )
      ) {
        return null;
      }
      break;
    case "plot":
      if (
        !Array.isArray(value.images) ||
        !value.images.every(
          (image) =>
            isRecord(image) &&
            isString(image.path) &&
            isString(image.alt) &&
            isOptionalString(image.caption),
        )
      ) {
        return null;
      }
      break;
    case "artifact-list":
      if (!Array.isArray(value.items) || !value.items.every(isArtifact)) return null;
      break;
    case "qc-report":
      if (
        !STATUSES.has(value.overall as ScientificStatus) ||
        !Array.isArray(value.checks) ||
        !value.checks.every(
          (check) =>
            isRecord(check) &&
            isString(check.name) &&
            STATUSES.has(check.status as ScientificStatus) &&
            (check.value === undefined || isScalar(check.value)) &&
            isOptionalString(check.expected) &&
            isOptionalString(check.message) &&
            isOptionalString(check.artifact),
        )
      ) {
        return null;
      }
      break;
    case "dataset-schema":
      if (
        value.path === undefined &&
        !Array.isArray(value.shape) &&
        !Array.isArray(value.dimensions) &&
        !Array.isArray(value.fields)
      ) {
        return null;
      }
      if (
        value.path !== undefined &&
        !isString(value.path)
      ) {
        return null;
      }
      if (
        !isOptionalString(value.format) ||
        (value.shape !== undefined &&
          (!Array.isArray(value.shape) || !value.shape.every(isFiniteNumber))) ||
        (value.dimensions !== undefined &&
          (!Array.isArray(value.dimensions) ||
            !value.dimensions.every(
              (dimension) =>
                isRecord(dimension) &&
                isString(dimension.name) &&
                isFiniteNumber(dimension.size),
            ))) ||
        (value.fields !== undefined &&
          (!Array.isArray(value.fields) ||
            !value.fields.every(
              (field) =>
                isRecord(field) &&
                isString(field.name) &&
                isString(field.dtype) &&
                isOptionalString(field.unit) &&
                isOptionalNumber(field.missing) &&
                isOptionalNumber(field.unique) &&
                isOptionalString(field.description),
            ))) ||
        !isOptionalNumber(value.rowCount) ||
        !isOptionalNumber(value.columnCount)
      ) {
        return null;
      }
      break;
    case "citation-list":
      if (
        !Array.isArray(value.entries) ||
        !value.entries.every(
          (entry) =>
            isRecord(entry) &&
            CITATION_KINDS.has(String(entry.kind)) &&
            isString(entry.identifier) &&
            isOptionalString(entry.title) &&
            isOptionalString(entry.url) &&
            (entry.authors === undefined ||
              (Array.isArray(entry.authors) && entry.authors.every(isString))) &&
            isOptionalNumber(entry.year) &&
            isOptionalString(entry.note),
        )
      ) {
        return null;
      }
      break;
    case "molecule":
      if (
        !isString(value.path) &&
        !isString(value.smiles) &&
        !isString(value.inchi)
      ) {
        return null;
      }
      if (
        !isOptionalString(value.path) ||
        !isOptionalString(value.smiles) ||
        !isOptionalString(value.inchi) ||
        !isOptionalNumber(value.index) ||
        !isOptionalString(value.name) ||
        !isOptionalString(value.formula) ||
        !isOptionalNumber(value.molecularWeight) ||
        !isOptionalNumber(value.atomCount) ||
        !isOptionalNumber(value.bondCount) ||
        (value.properties !== undefined &&
          (!Array.isArray(value.properties) ||
            !value.properties.every(
              (property) =>
                isRecord(property) &&
                isString(property.name) &&
                isScalar(property.value) &&
                isOptionalString(property.unit),
            )))
      ) {
        return null;
      }
      break;
    default:
      return null;
  }

  return value as unknown as ScientificResultCard;
}

export function parseToolResultImages(value: unknown): ToolResultImage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      !isRecord(item) ||
      !isString(item.data) ||
      !IMAGE_MIME.has(item.mimeType as ToolResultImage["mimeType"])
    ) {
      return [];
    }
    return [
      {
        data: item.data,
        mimeType: item.mimeType as ToolResultImage["mimeType"],
      },
    ];
  });
}
