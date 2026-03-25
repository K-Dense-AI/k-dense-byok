"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIcon,
  AtomIcon,
  BarChart3Icon,
  BinaryIcon,
  BookOpenIcon,
  BoxIcon,
  BrainIcon,
  BuildingIcon,
  CalculatorIcon,
  CircleDotIcon,
  ClipboardCheckIcon,
  CloudIcon,
  CogIcon,
  CpuIcon,
  CrosshairIcon,
  DatabaseIcon,
  DnaIcon,
  DollarSignIcon,
  DropletIcon,
  EyeIcon,
  FileCheck2Icon,
  FileSearchIcon,
  FileTextIcon,
  FilterIcon,
  FingerprintIcon,
  FlameIcon,
  FlaskConicalIcon,
  GaugeIcon,
  GemIcon,
  GitBranchIcon,
  GitCompareIcon,
  GlobeIcon,
  GraduationCapIcon,
  HeartIcon,
  HeartPulseIcon,
  HexagonIcon,
  ImageIcon,
  LayersIcon,
  LayoutGridIcon,
  LeafIcon,
  LineChartIcon,
  ListChecksIcon,
  LoaderIcon,
  MapIcon,
  MegaphoneIcon,
  MessageCircleIcon,
  MicroscopeIcon,
  MountainIcon,
  NetworkIcon,
  NewspaperIcon,
  PaletteIcon,
  PaperclipIcon,
  PencilIcon,
  PieChartIcon,
  PlayIcon,
  PresentationIcon,
  RefreshCwIcon,
  ReplyIcon,
  RocketIcon,
  RouteIcon,
  RssIcon,
  SatelliteIcon,
  ScaleIcon,
  ScanIcon,
  SearchIcon,
  SendIcon,
  ShieldIcon,
  SigmaIcon,
  SparklesIcon,
  SproutIcon,
  StarIcon,
  StethoscopeIcon,
  TargetIcon,
  TelescopeIcon,
  ThermometerIcon,
  TimerIcon,
  TreePineIcon,
  TrendingUpIcon,
  UploadIcon,
  UsersIcon,
  WavesIcon,
  WindIcon,
  WrenchIcon,
  ZapIcon,
  CheckCircle2Icon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ModelSelector, type Model, DEFAULT_MODEL } from "@/components/model-selector";
import { ComputeSelector, type ModalInstance } from "@/components/compute-selector";
import workflowsData from "@/data/workflows.json";

export type Workflow = {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  prompt: string;
  suggestedSkills: string[];
  placeholders: { key: string; label: string; required: boolean }[];
  requiresFiles: boolean;
};

const ALL_WORKFLOWS = workflowsData as Workflow[];

const ICON_MAP: Record<string, LucideIcon> = {
  Activity: ActivityIcon,
  Atom: AtomIcon,
  BarChart3: BarChart3Icon,
  Binary: BinaryIcon,
  BookOpen: BookOpenIcon,
  Box: BoxIcon,
  Brain: BrainIcon,
  Building: BuildingIcon,
  Calculator: CalculatorIcon,
  CircleDot: CircleDotIcon,
  ClipboardCheck: ClipboardCheckIcon,
  Cloud: CloudIcon,
  Cog: CogIcon,
  Cpu: CpuIcon,
  Crosshair: CrosshairIcon,
  Database: DatabaseIcon,
  Dna: DnaIcon,
  DollarSign: DollarSignIcon,
  Droplet: DropletIcon,
  Eye: EyeIcon,
  FileCheck: FileCheck2Icon,
  FileSearch: FileSearchIcon,
  FileText: FileTextIcon,
  Filter: FilterIcon,
  Fingerprint: FingerprintIcon,
  Flame: FlameIcon,
  FlaskConical: FlaskConicalIcon,
  Gauge: GaugeIcon,
  Gem: GemIcon,
  GitBranch: GitBranchIcon,
  GitCompare: GitCompareIcon,
  Globe: GlobeIcon,
  GraduationCap: GraduationCapIcon,
  Heart: HeartIcon,
  HeartPulse: HeartPulseIcon,
  Hexagon: HexagonIcon,
  Image: ImageIcon,
  Layers: LayersIcon,
  LayoutGrid: LayoutGridIcon,
  Leaf: LeafIcon,
  LineChart: LineChartIcon,
  ListChecks: ListChecksIcon,
  Map: MapIcon,
  Megaphone: MegaphoneIcon,
  MessageCircle: MessageCircleIcon,
  Microscope: MicroscopeIcon,
  Mountain: MountainIcon,
  Network: NetworkIcon,
  Newspaper: NewspaperIcon,
  Palette: PaletteIcon,
  Pencil: PencilIcon,
  PieChart: PieChartIcon,
  Presentation: PresentationIcon,
  RefreshCw: RefreshCwIcon,
  Reply: ReplyIcon,
  Rocket: RocketIcon,
  Route: RouteIcon,
  Rss: RssIcon,
  Satellite: SatelliteIcon,
  Scale: ScaleIcon,
  Scan: ScanIcon,
  Search: SearchIcon,
  Send: SendIcon,
  Shield: ShieldIcon,
  Sigma: SigmaIcon,
  Sparkles: SparklesIcon,
  Sprout: SproutIcon,
  Star: StarIcon,
  Stethoscope: StethoscopeIcon,
  Target: TargetIcon,
  Telescope: TelescopeIcon,
  Thermometer: ThermometerIcon,
  Timer: TimerIcon,
  TreePine: TreePineIcon,
  TrendingUp: TrendingUpIcon,
  Users: UsersIcon,
  Waves: WavesIcon,
  Wind: WindIcon,
  Wrench: WrenchIcon,
  Zap: ZapIcon,
};

const CATEGORIES: { id: string; label: string; color: string }[] = [
  { id: "paper", label: "Paper & Manuscript", color: "text-blue-500" },
  { id: "visual", label: "Visual & Presentation", color: "text-rose-500" },
  { id: "data", label: "Data & Analysis", color: "text-emerald-500" },
  { id: "literature", label: "Literature & Research", color: "text-violet-500" },
  { id: "grants", label: "Grants & Planning", color: "text-amber-500" },
  { id: "scicomm", label: "Science Communication", color: "text-cyan-500" },
  { id: "genomics", label: "Genomics & Transcriptomics", color: "text-teal-500" },
  { id: "proteomics", label: "Proteomics & Structural Biology", color: "text-indigo-500" },
  { id: "cellbio", label: "Cell Biology & Single-Cell", color: "text-fuchsia-500" },
  { id: "chemistry", label: "Chemistry & Computational Chemistry", color: "text-orange-500" },
  { id: "drugdiscovery", label: "Drug Discovery & Pharmacology", color: "text-red-500" },
  { id: "physics", label: "Physics & Quantum Computing", color: "text-yellow-600" },
  { id: "materials", label: "Materials Science", color: "text-slate-500" },
  { id: "clinical", label: "Clinical & Health Sciences", color: "text-green-500" },
  { id: "neuro", label: "Neuroscience", color: "text-purple-500" },
  { id: "ecology", label: "Ecology & Environmental Science", color: "text-lime-600" },
  { id: "finance", label: "Finance & Economics", color: "text-sky-500" },
  { id: "social", label: "Social Sciences", color: "text-pink-500" },
  { id: "math", label: "Mathematics & Modeling", color: "text-stone-500" },
  { id: "ml", label: "Machine Learning & AI", color: "text-blue-600" },
  { id: "engineering", label: "Engineering & Simulation", color: "text-zinc-500" },
  { id: "astro", label: "Astronomy & Space Science", color: "text-violet-600" },
];

const CATEGORY_BG: Record<string, string> = {
  paper: "bg-blue-500/10 hover:bg-blue-500/15 border-blue-500/20",
  visual: "bg-rose-500/10 hover:bg-rose-500/15 border-rose-500/20",
  data: "bg-emerald-500/10 hover:bg-emerald-500/15 border-emerald-500/20",
  literature: "bg-violet-500/10 hover:bg-violet-500/15 border-violet-500/20",
  grants: "bg-amber-500/10 hover:bg-amber-500/15 border-amber-500/20",
  scicomm: "bg-cyan-500/10 hover:bg-cyan-500/15 border-cyan-500/20",
  genomics: "bg-teal-500/10 hover:bg-teal-500/15 border-teal-500/20",
  proteomics: "bg-indigo-500/10 hover:bg-indigo-500/15 border-indigo-500/20",
  cellbio: "bg-fuchsia-500/10 hover:bg-fuchsia-500/15 border-fuchsia-500/20",
  chemistry: "bg-orange-500/10 hover:bg-orange-500/15 border-orange-500/20",
  drugdiscovery: "bg-red-500/10 hover:bg-red-500/15 border-red-500/20",
  physics: "bg-yellow-500/10 hover:bg-yellow-500/15 border-yellow-500/20",
  materials: "bg-slate-500/10 hover:bg-slate-500/15 border-slate-500/20",
  clinical: "bg-green-500/10 hover:bg-green-500/15 border-green-500/20",
  neuro: "bg-purple-500/10 hover:bg-purple-500/15 border-purple-500/20",
  ecology: "bg-lime-500/10 hover:bg-lime-500/15 border-lime-500/20",
  finance: "bg-sky-500/10 hover:bg-sky-500/15 border-sky-500/20",
  social: "bg-pink-500/10 hover:bg-pink-500/15 border-pink-500/20",
  math: "bg-stone-500/10 hover:bg-stone-500/15 border-stone-500/20",
  ml: "bg-blue-600/10 hover:bg-blue-600/15 border-blue-600/20",
  engineering: "bg-zinc-500/10 hover:bg-zinc-500/15 border-zinc-500/20",
  astro: "bg-violet-600/10 hover:bg-violet-600/15 border-violet-600/20",
};

const CATEGORY_ICON_COLOR: Record<string, string> = {
  paper: "text-blue-500",
  visual: "text-rose-500",
  data: "text-emerald-500",
  literature: "text-violet-500",
  grants: "text-amber-500",
  scicomm: "text-cyan-500",
  genomics: "text-teal-500",
  proteomics: "text-indigo-500",
  cellbio: "text-fuchsia-500",
  chemistry: "text-orange-500",
  drugdiscovery: "text-red-500",
  physics: "text-yellow-600",
  materials: "text-slate-500",
  clinical: "text-green-500",
  neuro: "text-purple-500",
  ecology: "text-lime-600",
  finance: "text-sky-500",
  social: "text-pink-500",
  math: "text-stone-500",
  ml: "text-blue-600",
  engineering: "text-zinc-500",
  astro: "text-violet-600",
};

function WorkflowIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICON_MAP[name] ?? FileTextIcon;
  return <Icon className={className} />;
}

function LaunchDialog({
  workflow,
  open,
  onOpenChange,
  onLaunch,
  onUploadFiles,
  modalConfigured,
}: {
  workflow: Workflow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLaunch: (prompt: string, model: Model, compute: ModalInstance | null, suggestedSkills: string[]) => void;
  onUploadFiles?: (files: FileList | File[]) => Promise<string[]>;
  modalConfigured: boolean;
}) {
  const [model, setModel] = useState<Model>(DEFAULT_MODEL);
  const [compute, setCompute] = useState<ModalInstance | null>(null);
  const [placeholderValues, setPlaceholderValues] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const updatePlaceholder = useCallback((key: string, value: string) => {
    setPlaceholderValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length || !onUploadFiles) return;
    setUploading(true);
    try {
      const paths = await onUploadFiles(files);
      setUploadedFiles((prev) => [...prev, ...paths]);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [onUploadFiles]);

  const assembledPrompt = useMemo(() => {
    let prompt = workflow.prompt;
    for (const ph of workflow.placeholders) {
      const val = placeholderValues[ph.key]?.trim() || `[${ph.label}]`;
      prompt = prompt.replaceAll(`{${ph.key}}`, val);
    }
    return prompt;
  }, [workflow, placeholderValues]);

  const canLaunch = workflow.placeholders
    .filter((ph) => ph.required)
    .every((ph) => placeholderValues[ph.key]?.trim());

  const handleLaunch = useCallback(() => {
    onLaunch(assembledPrompt, model, compute, workflow.suggestedSkills);
    onOpenChange(false);
    setPlaceholderValues({});
    setUploadedFiles([]);
  }, [assembledPrompt, model, compute, workflow.suggestedSkills, onLaunch, onOpenChange]);

  const iconColor = CATEGORY_ICON_COLOR[workflow.category] ?? "text-muted-foreground";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <WorkflowIcon name={workflow.icon} className={cn("size-5", iconColor)} />
            {workflow.name}
          </DialogTitle>
          <DialogDescription>{workflow.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {workflow.requiresFiles && onUploadFiles && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-foreground">
                Upload files to sandbox
                <span className="ml-1 text-[10px] font-normal text-amber-600 dark:text-amber-400">(this workflow uses uploaded data)</span>
              </label>
              <div className="rounded-lg border border-dashed border-amber-500/30 bg-amber-500/5 p-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleFileUpload}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="flex w-full items-center justify-center gap-2 rounded-md border border-amber-500/20 bg-background px-3 py-2 text-xs font-medium transition-colors hover:bg-amber-500/10 disabled:opacity-50"
                >
                  {uploading ? (
                    <>
                      <LoaderIcon className="size-3.5 animate-spin text-amber-500" />
                      <span className="text-muted-foreground">Uploading...</span>
                    </>
                  ) : (
                    <>
                      <UploadIcon className="size-3.5 text-amber-500" />
                      <span className="text-muted-foreground">Choose files to upload</span>
                    </>
                  )}
                </button>
                {uploadedFiles.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {uploadedFiles.map((path) => (
                      <div key={path} className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2Icon className="size-3 shrink-0" />
                        <span className="truncate">{path.split("/").pop()}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {workflow.placeholders.length > 0 && (
            <div className="space-y-3">
              {workflow.placeholders.map((ph) => (
                <div key={ph.key}>
                  <label className="mb-1.5 block text-xs font-medium text-foreground">
                    {ph.label}
                    {ph.required && <span className="ml-0.5 text-destructive">*</span>}
                  </label>
                  <input
                    type="text"
                    value={placeholderValues[ph.key] ?? ""}
                    onChange={(e) => updatePlaceholder(ph.key, e.target.value)}
                    placeholder={ph.label}
                    className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary/30 placeholder:text-muted-foreground/50"
                  />
                </div>
              ))}
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Prompt preview</label>
            <div className="max-h-32 overflow-y-auto rounded-lg border bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              {assembledPrompt}
            </div>
          </div>

          {workflow.suggestedSkills.length > 0 && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Suggested skills</label>
              <div className="flex flex-wrap gap-1.5">
                {workflow.suggestedSkills.map((skill) => (
                  <span
                    key={skill}
                    className="rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-400"
                  >
                    {skill}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <ModelSelector selected={model} onChange={setModel} />
            <ComputeSelector selected={compute} onChange={setCompute} modalConfigured={modalConfigured} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleLaunch} disabled={!canLaunch} className="gap-1.5">
            <PlayIcon className="size-3.5" />
            Run workflow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function WorkflowsPanel({
  onLaunch,
  onUploadFiles,
  modalConfigured,
}: {
  onLaunch: (prompt: string, model: Model, compute: ModalInstance | null, suggestedSkills: string[]) => void;
  onUploadFiles?: (files: FileList | File[]) => Promise<string[]>;
  modalConfigured: boolean;
}) {
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(null);
  const [search, setSearch] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return ALL_WORKFLOWS;
    return ALL_WORKFLOWS.filter(
      (w) =>
        w.name.toLowerCase().includes(q) ||
        w.description.toLowerCase().includes(q) ||
        w.category.toLowerCase().includes(q) ||
        w.suggestedSkills.some((s) => s.toLowerCase().includes(q))
    );
  }, [search]);

  const grouped = useMemo(() => {
    const map = new Map<string, Workflow[]>();
    for (const cat of CATEGORIES) map.set(cat.id, []);
    for (const w of filtered) {
      const list = map.get(w.category);
      if (list) list.push(w);
    }
    return map;
  }, [filtered]);

  const visibleCategories = useMemo(
    () => CATEGORIES.filter((cat) => (grouped.get(cat.id)?.length ?? 0) > 0),
    [grouped]
  );

  const scrollToCategory = useCallback((catId: string) => {
    const container = scrollRef.current;
    if (!container) return;
    const section = container.querySelector(`[data-category="${catId}"]`);
    if (section) {
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Search + category pills */}
      <div className="shrink-0 border-b px-4 py-3 space-y-2.5">
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search workflows..."
            className="w-full rounded-lg border bg-background py-2 pl-9 pr-3 text-sm outline-none transition-colors focus:border-primary placeholder:text-muted-foreground/50"
          />
        </div>

        <div className="flex gap-1.5 overflow-x-auto pb-0.5 scrollbar-none">
          {visibleCategories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => scrollToCategory(cat.id)}
              className={cn(
                "shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                CATEGORY_BG[cat.id]
              )}
            >
              <span className={CATEGORY_ICON_COLOR[cat.id]}>{cat.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Scrollable workflow grid */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        <div className="space-y-6">
          {CATEGORIES.map((cat) => {
            const workflows = grouped.get(cat.id);
            if (!workflows || workflows.length === 0) return null;
            return (
              <section key={cat.id} data-category={cat.id}>
                <h3 className={cn("mb-2.5 text-xs font-semibold uppercase tracking-wider", cat.color)}>
                  {cat.label}
                  <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                    ({workflows.length})
                  </span>
                </h3>
                <div className="grid grid-cols-1 gap-2">
                  {workflows.map((w) => {
                    const bgClass = CATEGORY_BG[w.category] ?? "";
                    const iconColor = CATEGORY_ICON_COLOR[w.category] ?? "text-muted-foreground";
                    return (
                      <button
                        key={w.id}
                        onClick={() => setSelectedWorkflow(w)}
                        className={cn(
                          "flex items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-all",
                          bgClass
                        )}
                      >
                        <WorkflowIcon name={w.icon} className={cn("mt-0.5 size-4 shrink-0", iconColor)} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-medium text-foreground">{w.name}</span>
                            {w.requiresFiles && (
                              <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/10 px-1.5 py-px text-[9px] font-medium text-amber-600 dark:text-amber-400 border border-amber-500/20">
                                <PaperclipIcon className="size-2.5" />
                                Files
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed line-clamp-2">
                            {w.description}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </div>

      {selectedWorkflow && (
        <LaunchDialog
          workflow={selectedWorkflow}
          open={!!selectedWorkflow}
          onOpenChange={(open) => {
            if (!open) setSelectedWorkflow(null);
          }}
          onLaunch={onLaunch}
          onUploadFiles={onUploadFiles}
          modalConfigured={modalConfigured}
        />
      )}
    </div>
  );
}
