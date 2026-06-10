/**
 * Map uploaded scientific data files to the skills most likely to help.
 *
 * When a researcher drops an `.h5ad` or a `.fastq`, the agent shouldn't make
 * them hunt through 140+ skills — we surface the obvious matches. Matching is
 * conservative: an extension maps to a few keyword tokens, and a skill is only
 * suggested when its name or description actually contains one of them.
 */
import type { Skill } from "@/lib/use-skills";

/** Extension (lowercase, no dot) → candidate skill keyword tokens. */
const EXT_KEYWORDS: Record<string, string[]> = {
  // Single-cell / genomics matrices
  h5ad: ["anndata", "scanpy", "scvi", "single-cell", "scverse", "muon"],
  loom: ["anndata", "scanpy", "loom"],
  mtx: ["scanpy", "anndata", "single-cell"],
  // Sequence / alignment / variants
  fastq: ["biopython", "pysam", "sequence", "bioinformatics"],
  fq: ["biopython", "pysam", "sequence", "bioinformatics"],
  fasta: ["biopython", "sequence", "bioinformatics"],
  fa: ["biopython", "sequence", "bioinformatics"],
  fna: ["biopython", "sequence", "bioinformatics"],
  sam: ["pysam", "samtools", "alignment"],
  bam: ["pysam", "samtools", "alignment"],
  vcf: ["pysam", "variant", "cyvcf"],
  gff: ["biopython", "annotation", "gffutils"],
  gtf: ["annotation", "gffutils"],
  bed: ["pybedtools", "bedtools", "genomic interval"],
  // Structures
  pdb: ["biopython", "biotite", "structure", "protein", "pymol"],
  cif: ["biotite", "structure", "protein"],
  // Neuroimaging
  nii: ["nibabel", "nilearn", "neuroimaging"],
  dcm: ["nibabel", "pydicom", "imaging"],
  nwb: ["pynwb", "neurodata", "neuro"],
  // Microscopy / imaging
  tif: ["scikit-image", "aicsimageio", "imaging"],
  tiff: ["scikit-image", "aicsimageio", "imaging"],
  // Time series
  edf: ["mne", "time series", "signal"],
};

/** Lowercased extension of a path, handling common double extensions. */
function extOf(path: string): string {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  if (name.endsWith(".nii.gz")) return "nii";
  if (name.endsWith(".fastq.gz")) return "fastq";
  if (name.endsWith(".vcf.gz")) return "vcf";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1);
}

/**
 * Return skills (from the catalogue) relevant to the just-uploaded files.
 * Deduped, capped, and ordered by how many files reference them.
 */
export function suggestSkillsForFiles(
  paths: string[],
  skills: Skill[],
  max = 3,
): Skill[] {
  const keywords = new Set<string>();
  for (const p of paths) {
    for (const kw of EXT_KEYWORDS[extOf(p)] ?? []) keywords.add(kw);
  }
  if (keywords.size === 0) return [];

  const scored: { skill: Skill; score: number }[] = [];
  for (const skill of skills) {
    const name = skill.name.toLowerCase();
    const desc = skill.description.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (name === kw) score += 3;
      else if (name.includes(kw)) score += 2;
      else if (desc.includes(kw)) score += 1;
    }
    if (score > 0) scored.push({ skill, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((s) => s.skill);
}
