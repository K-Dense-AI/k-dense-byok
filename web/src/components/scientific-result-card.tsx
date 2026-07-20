"use client";

import {
  AtomIcon,
  BarChart3Icon,
  BookOpenIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  FileIcon,
  FlaskConicalIcon,
  TableIcon,
  TriangleAlertIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { KadyFileIcon } from "@/components/file-icon";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { rawFileUrl, sciRenderUrl } from "@/lib/use-sandbox";
import type {
  CitationListResult,
  DatasetSchemaResult,
  MoleculeResult,
  PlotResult,
  QcReportResult,
  ScientificArtifact,
  ScientificResultCard as ScientificResult,
  ScientificScalar,
  ScientificStatus,
  StatisticalTestResult,
  TableResult,
  ToolResultImage,
} from "@/lib/scientific-results";
import type { ActivityItem } from "@/lib/use-agent";
import { cn } from "@/lib/utils";

const KIND_META: Record<
  ScientificResult["kind"],
  { label: string; Icon: LucideIcon }
> = {
  table: { label: "Table", Icon: TableIcon },
  "statistical-test": { label: "Statistical test", Icon: FlaskConicalIcon },
  plot: { label: "Plot", Icon: BarChart3Icon },
  "artifact-list": { label: "Artifacts", Icon: FileIcon },
  "qc-report": { label: "QC report", Icon: CheckCircle2Icon },
  "dataset-schema": { label: "Dataset schema", Icon: DatabaseIcon },
  "citation-list": { label: "Citations", Icon: BookOpenIcon },
  molecule: { label: "Molecule", Icon: AtomIcon },
};

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 0.001 || abs >= 1_000_000)) {
    return value.toExponential(3);
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function formatScalar(value: ScientificScalar | undefined): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return value;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function FileButton({
  artifact,
  onOpenFile,
}: {
  artifact: ScientificArtifact;
  onOpenFile?: (path: string) => void;
}) {
  const label = artifact.label || basename(artifact.path);
  return (
    <button
      type="button"
      onClick={() => onOpenFile?.(artifact.path)}
      disabled={!onOpenFile}
      className="flex min-w-0 items-center gap-2 rounded-md border bg-background px-2.5 py-2 text-left transition-colors enabled:hover:bg-muted/40 disabled:cursor-default"
      title={artifact.path}
    >
      <KadyFileIcon name={artifact.path} className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{label}</span>
        {(artifact.description || artifact.role) && (
          <span className="block truncate text-[11px] text-muted-foreground">
            {[artifact.role, artifact.description].filter(Boolean).join(" · ")}
          </span>
        )}
      </span>
      {onOpenFile && <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />}
    </button>
  );
}

function ArtifactGrid({
  artifacts,
  onOpenFile,
}: {
  artifacts: ScientificArtifact[];
  onOpenFile?: (path: string) => void;
}) {
  if (artifacts.length === 0) return null;
  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      {artifacts.map((artifact, index) => (
        <FileButton
          key={`${artifact.path}:${index}`}
          artifact={artifact}
          onOpenFile={onOpenFile}
        />
      ))}
    </div>
  );
}

function TableBody({ card }: { card: TableResult }) {
  const shown = card.rows.length;
  const total = card.totalRows ?? shown;
  return (
    <div className="space-y-1.5">
      <div className="max-h-80 overflow-auto rounded-md border">
        <table className="w-full min-w-max text-xs">
          <thead className="sticky top-0 z-10 bg-muted/90 backdrop-blur">
            <tr className="border-b">
              {card.columns.map((column) => (
                <th
                  key={column.key}
                  title={column.description}
                  className="px-2.5 py-2 text-left font-semibold"
                >
                  {column.label}
                  {column.unit && (
                    <span className="ml-1 font-normal text-muted-foreground">
                      ({column.unit})
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {card.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-b last:border-0 odd:bg-muted/15">
                {row.map((cell, columnIndex) => (
                  <td
                    key={card.columns[columnIndex]?.key ?? columnIndex}
                    className="max-w-64 px-2.5 py-1.5 font-mono text-[11px]"
                  >
                    {formatScalar(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(card.truncated || total > shown) && (
        <p className="text-[11px] text-muted-foreground">
          Showing {shown.toLocaleString()} of {total.toLocaleString()} rows.
        </p>
      )}
    </div>
  );
}

function StatValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-muted/35 px-2 py-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-xs">{value}</div>
    </div>
  );
}

function StatisticalBody({ card }: { card: StatisticalTestResult }) {
  return (
    <div className="space-y-2">
      {card.tests.map((test, index) => {
        const values: { label: string; value: string }[] = [];
        if (test.estimate !== undefined) {
          values.push({
            label: test.estimateLabel ?? "Estimate",
            value: formatNumber(test.estimate),
          });
        }
        if (test.statistic !== undefined) {
          values.push({
            label: test.statisticLabel ?? "Statistic",
            value: formatNumber(test.statistic),
          });
        }
        if (test.degreesOfFreedom !== undefined) {
          values.push({ label: "df", value: String(test.degreesOfFreedom) });
        }
        if (test.pValue !== undefined) {
          values.push({ label: "p-value", value: formatNumber(test.pValue) });
        }
        if (test.adjustedPValue !== undefined) {
          values.push({
            label: "Adjusted p",
            value: formatNumber(test.adjustedPValue),
          });
        }
        if (test.effectSize !== undefined) {
          values.push({
            label: test.effectSizeLabel ?? "Effect size",
            value: formatNumber(test.effectSize),
          });
        }
        if (test.confidenceInterval) {
          values.push({
            label: `${Math.round((test.confidenceLevel ?? 0.95) * 100)}% CI`,
            value: `${formatNumber(test.confidenceInterval[0])} – ${formatNumber(test.confidenceInterval[1])}`,
          });
        }
        if (test.sampleSize !== undefined) {
          values.push({ label: "n", value: test.sampleSize.toLocaleString() });
        }
        return (
          <section key={`${test.name}:${index}`} className="rounded-md border p-2.5">
            <div className="font-medium text-xs">{test.name}</div>
            {test.method && (
              <div className="mt-0.5 text-[11px] text-muted-foreground">{test.method}</div>
            )}
            {values.length > 0 && (
              <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {values.map((entry) => (
                  <StatValue key={entry.label} {...entry} />
                ))}
              </div>
            )}
            {test.interpretation && (
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {test.interpretation}
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}

function PlotBody({
  card,
  projectId,
  onOpenFile,
}: {
  card: PlotResult;
  projectId: string;
  onOpenFile?: (path: string) => void;
}) {
  return (
    <div className="grid gap-2">
      {card.images.map((image, index) => (
        <figure key={`${image.path}:${index}`} className="overflow-hidden rounded-md border">
          <button
            type="button"
            onClick={() => onOpenFile?.(image.path)}
            disabled={!onOpenFile}
            className="block w-full bg-white disabled:cursor-default"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={rawFileUrl(image.path, projectId)}
              alt={image.alt}
              className="max-h-96 w-full object-contain"
            />
          </button>
          <figcaption className="flex items-start gap-2 border-t bg-background px-2.5 py-2">
            <KadyFileIcon name={image.path} className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium">{basename(image.path)}</span>
              {image.caption && (
                <span className="block text-[11px] text-muted-foreground">
                  {image.caption}
                </span>
              )}
            </span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

const STATUS_META: Record<
  ScientificStatus,
  { label: string; Icon: LucideIcon; className: string }
> = {
  pass: {
    label: "Pass",
    Icon: CheckCircle2Icon,
    className: "text-emerald-600 dark:text-emerald-400",
  },
  warn: {
    label: "Warning",
    Icon: TriangleAlertIcon,
    className: "text-amber-600 dark:text-amber-400",
  },
  fail: {
    label: "Fail",
    Icon: XCircleIcon,
    className: "text-destructive",
  },
};

function StatusLabel({ status }: { status: ScientificStatus }) {
  const { label, Icon, className } = STATUS_META[status];
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] font-medium", className)}>
      <Icon className="size-3.5" />
      {label}
    </span>
  );
}

function QcBody({
  card,
  onOpenFile,
}: {
  card: QcReportResult;
  onOpenFile?: (path: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      {card.checks.map((check, index) => (
        <div
          key={`${check.name}:${index}`}
          className="flex items-start gap-2.5 rounded-md border px-2.5 py-2"
        >
          <div className="w-16 shrink-0 pt-0.5">
            <StatusLabel status={check.status} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium">{check.name}</div>
            {(check.value !== undefined || check.expected) && (
              <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                {check.value !== undefined ? formatScalar(check.value) : ""}
                {check.expected ? ` · expected ${check.expected}` : ""}
              </div>
            )}
            {check.message && (
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                {check.message}
              </p>
            )}
          </div>
          {check.artifact && (
            <button
              type="button"
              onClick={() => onOpenFile?.(check.artifact!)}
              disabled={!onOpenFile}
              className="shrink-0 rounded p-1 text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground"
              title={`Open ${check.artifact}`}
            >
              <FileIcon className="size-3.5" />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function DatasetBody({
  card,
  onOpenFile,
}: {
  card: DatasetSchemaResult;
  onOpenFile?: (path: string) => void;
}) {
  const dimensions =
    card.dimensions?.map((dimension) => `${dimension.name}: ${dimension.size.toLocaleString()}`) ??
    card.shape?.map((size, index) => `dim${index + 1}: ${size.toLocaleString()}`) ??
    [];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {card.format && (
          <span className="rounded-full border bg-muted/30 px-2 py-0.5 text-[11px]">
            {card.format}
          </span>
        )}
        {dimensions.map((dimension) => (
          <span
            key={dimension}
            className="rounded-full border bg-muted/30 px-2 py-0.5 font-mono text-[11px]"
          >
            {dimension}
          </span>
        ))}
        {card.rowCount !== undefined && (
          <span className="rounded-full border bg-muted/30 px-2 py-0.5 text-[11px]">
            {card.rowCount.toLocaleString()} rows
          </span>
        )}
        {card.columnCount !== undefined && (
          <span className="rounded-full border bg-muted/30 px-2 py-0.5 text-[11px]">
            {card.columnCount.toLocaleString()} columns
          </span>
        )}
      </div>
      {card.path && (
        <ArtifactGrid
          artifacts={[{ path: card.path, label: basename(card.path), role: "data" }]}
          onOpenFile={onOpenFile}
        />
      )}
      {card.fields && card.fields.length > 0 && (
        <div className="max-h-72 overflow-auto rounded-md border">
          <table className="w-full min-w-max text-xs">
            <thead className="sticky top-0 bg-muted/90">
              <tr className="border-b">
                {["Field", "Type", "Unit", "Missing", "Unique"].map((heading) => (
                  <th key={heading} className="px-2.5 py-2 text-left font-semibold">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {card.fields.map((field) => (
                <tr key={field.name} className="border-b last:border-0">
                  <td title={field.description} className="px-2.5 py-1.5 font-medium">
                    {field.name}
                  </td>
                  <td className="px-2.5 py-1.5 font-mono text-[11px]">{field.dtype}</td>
                  <td className="px-2.5 py-1.5">{field.unit ?? "—"}</td>
                  <td className="px-2.5 py-1.5">
                    {field.missing?.toLocaleString() ?? "—"}
                  </td>
                  <td className="px-2.5 py-1.5">
                    {field.unique?.toLocaleString() ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CitationBody({ card }: { card: CitationListResult }) {
  return (
    <ol className="space-y-1.5">
      {card.entries.map((entry, index) => (
        <li key={`${entry.kind}:${entry.identifier}:${index}`} className="rounded-md border p-2.5">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 rounded border bg-muted/30 px-1.5 py-0.5 font-mono text-[9px] uppercase text-muted-foreground">
              {entry.kind}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium">
                {entry.title || entry.identifier}
              </div>
              {entry.title && (
                <div className="mt-0.5 break-all font-mono text-[10px] text-muted-foreground">
                  {entry.identifier}
                </div>
              )}
              {(entry.authors?.length || entry.year) && (
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {[entry.authors?.join(", "), entry.year].filter(Boolean).join(" · ")}
                </div>
              )}
              {entry.note && (
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {entry.note}
                </p>
              )}
            </div>
            {entry.url && (
              <a
                href={entry.url}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open citation ${entry.identifier}`}
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <ExternalLinkIcon className="size-3.5" />
              </a>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function MoleculeBody({
  card,
  projectId,
  onOpenFile,
}: {
  card: MoleculeResult;
  projectId: string;
  onOpenFile?: (path: string) => void;
}) {
  const facts = [
    card.formula && ["Formula", card.formula],
    card.molecularWeight !== undefined && ["Molecular weight", formatNumber(card.molecularWeight)],
    card.atomCount !== undefined && ["Atoms", card.atomCount.toLocaleString()],
    card.bondCount !== undefined && ["Bonds", card.bondCount.toLocaleString()],
  ].filter(Boolean) as [string, string][];
  return (
    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      {card.path ? (
        <button
          type="button"
          onClick={() => onOpenFile?.(card.path!)}
          disabled={!onOpenFile}
          className="overflow-hidden rounded-md border bg-white disabled:cursor-default"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={sciRenderUrl(card.path, "chem", card.index ?? 0, undefined, projectId)}
            alt={card.name || card.smiles || "Molecule structure"}
            className="max-h-72 w-full object-contain"
          />
        </button>
      ) : (
        <div className="flex min-h-32 items-center justify-center rounded-md border bg-muted/20">
          <AtomIcon className="size-10 text-muted-foreground/40" />
        </div>
      )}
      <div className="space-y-2">
        {facts.length > 0 && (
          <dl className="grid grid-cols-2 gap-1.5">
            {facts.map(([label, value]) => (
              <div key={label} className="rounded bg-muted/35 px-2 py-1.5">
                <dt className="text-[10px] text-muted-foreground">{label}</dt>
                <dd className="mt-0.5 font-mono text-xs">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {(card.smiles || card.inchi) && (
          <div className="space-y-1">
            {card.smiles && (
              <div className="rounded border bg-muted/20 p-2">
                <div className="text-[9px] font-semibold uppercase text-muted-foreground">
                  SMILES
                </div>
                <div className="mt-0.5 break-all font-mono text-[10px]">{card.smiles}</div>
              </div>
            )}
            {card.inchi && (
              <div className="rounded border bg-muted/20 p-2">
                <div className="text-[9px] font-semibold uppercase text-muted-foreground">
                  InChI
                </div>
                <div className="mt-0.5 break-all font-mono text-[10px]">{card.inchi}</div>
              </div>
            )}
          </div>
        )}
        {card.properties && card.properties.length > 0 && (
          <dl className="space-y-1 text-xs">
            {card.properties.map((property, index) => (
              <div key={`${property.name}:${index}`} className="flex gap-2">
                <dt className="min-w-0 flex-1 text-muted-foreground">{property.name}</dt>
                <dd className="font-mono">
                  {formatScalar(property.value)}
                  {property.unit ? ` ${property.unit}` : ""}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}

export function ToolResultImages({
  images,
  truncated = 0,
}: {
  images: ToolResultImage[];
  truncated?: number;
}) {
  if (images.length === 0 && truncated === 0) return null;
  return (
    <div className="space-y-1.5">
      {images.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {images.map((image, index) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={`${image.mimeType}:${index}`}
              src={`data:${image.mimeType};base64,${image.data}`}
              alt={`Tool result image ${index + 1}`}
              className="max-h-80 w-full rounded-md border bg-white object-contain"
            />
          ))}
        </div>
      )}
      {truncated > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {truncated} image{truncated === 1 ? "" : "s"} omitted by display limits.
        </p>
      )}
    </div>
  );
}

function RawToolDetails({ item }: { item: ActivityItem }) {
  const [open, setOpen] = useState(false);
  const input = useMemo(() => {
    try {
      return JSON.stringify(item.args ?? {}, null, 2);
    } catch {
      return String(item.args ?? "");
    }
  }, [item.args]);
  if (!input && !item.result) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
        <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
        Raw tool details
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 grid gap-1.5">
          {input && (
            <pre className="max-h-48 overflow-auto rounded bg-muted/40 p-2 font-mono text-[10px] whitespace-pre-wrap break-words">
              {input}
            </pre>
          )}
          {item.result && (
            <pre className="max-h-48 overflow-auto rounded bg-muted/40 p-2 font-mono text-[10px] whitespace-pre-wrap break-words">
              {item.result}
            </pre>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function CardBody({
  card,
  projectId,
  onOpenFile,
}: {
  card: ScientificResult;
  projectId: string;
  onOpenFile?: (path: string) => void;
}) {
  switch (card.kind) {
    case "table":
      return <TableBody card={card} />;
    case "statistical-test":
      return <StatisticalBody card={card} />;
    case "plot":
      return <PlotBody card={card} projectId={projectId} onOpenFile={onOpenFile} />;
    case "artifact-list":
      return <ArtifactGrid artifacts={card.items} onOpenFile={onOpenFile} />;
    case "qc-report":
      return <QcBody card={card} onOpenFile={onOpenFile} />;
    case "dataset-schema":
      return <DatasetBody card={card} onOpenFile={onOpenFile} />;
    case "citation-list":
      return <CitationBody card={card} />;
    case "molecule":
      return <MoleculeBody card={card} projectId={projectId} onOpenFile={onOpenFile} />;
  }
}

export function ScientificResultCard({
  item,
  projectId,
  onOpenFile,
}: {
  item: ActivityItem;
  projectId: string;
  onOpenFile?: (path: string) => void;
}) {
  const card = item.scientificResult;
  if (!card) return null;
  const { label, Icon } = KIND_META[card.kind];
  const commonArtifacts = card.artifacts ?? [];
  const qcOverall = card.kind === "qc-report" ? card.overall : undefined;

  return (
    <article
      data-tool-call-id={item.id}
      className={cn(
        "my-1 overflow-hidden rounded-lg border bg-background shadow-sm",
        item.status === "error" && "border-destructive/40",
      )}
    >
      <header className="flex items-start gap-2.5 border-b bg-muted/20 px-3 py-2.5">
        <span className="mt-0.5 rounded-md border bg-background p-1.5">
          <Icon className="size-4 text-primary" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold leading-tight">{card.title}</h3>
            <span className="rounded-full border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {label}
            </span>
            {qcOverall && <StatusLabel status={qcOverall} />}
          </div>
          {card.summary && (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {card.summary}
            </p>
          )}
        </div>
      </header>
      <div className="space-y-3 p-3">
        <CardBody card={card} projectId={projectId} onOpenFile={onOpenFile} />
        {commonArtifacts.length > 0 && (
          <section className="space-y-1.5">
            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Related files
            </h4>
            <ArtifactGrid artifacts={commonArtifacts} onOpenFile={onOpenFile} />
          </section>
        )}
        <ToolResultImages
          images={item.resultImages ?? []}
          truncated={item.resultImagesTruncated}
        />
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2">
          <span className="text-[10px] text-muted-foreground">
            Structured agent output · not independently verified
          </span>
          <RawToolDetails item={item} />
        </div>
      </div>
    </article>
  );
}
