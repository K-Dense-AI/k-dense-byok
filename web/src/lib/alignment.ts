/**
 * Minimal, dependency-free multiple-sequence-alignment parser (client-side;
 * used by the alignment viewer to render .aln/.clustal/.sto/.stk/.phy/.phylip
 * files with no backend round-trip). Supports Clustal, Stockholm, relaxed
 * PHYLIP, and an aligned-FASTA fallback. Dispatch is primarily driven by the
 * file extension, with light content sniffing as a fallback for
 * unrecognized/generic extensions.
 */

export interface AlignRow {
  id: string;
  seq: string;
}

/** Ensures every row has a non-empty, equal-length gapped sequence. */
function validateRows(rows: AlignRow[]): AlignRow[] {
  if (rows.length === 0) {
    throw new Error("Malformed alignment: no sequences found");
  }
  const len = rows[0].seq.length;
  if (len === 0) {
    throw new Error("Malformed alignment: sequences are empty");
  }
  for (const row of rows) {
    if (row.seq.length !== len) {
      throw new Error(
        `Malformed alignment: sequences have unequal lengths ("${row.id}" has ${row.seq.length}, expected ${len})`,
      );
    }
  }
  return rows;
}

/** Clustal: an optional blank line, a header containing "CLUSTAL", then
 *  blocks of `id  seq_chunk` lines interleaved with blank lines and
 *  consensus/conservation symbol lines (e.g. `   ***  *.:  `, no letters). */
function parseClustal(text: string): AlignRow[] {
  const lines = text.split(/\r?\n/);
  const order: string[] = [];
  const seqs = new Map<string, string>();
  let sawHeader = false;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!sawHeader) {
      if (/^CLUSTAL/i.test(trimmed)) sawHeader = true;
      continue;
    }
    if (trimmed === "") continue;
    const tokens = trimmed.split(/\s+/);
    if (tokens.length < 2) continue;
    const id = tokens[0];
    const seqChunk = tokens[1];
    if (!/[A-Za-z]/.test(seqChunk)) continue; // consensus/conservation symbol line
    if (!seqs.has(id)) order.push(id);
    seqs.set(id, (seqs.get(id) ?? "") + seqChunk);
  }

  if (!sawHeader) {
    throw new Error('Malformed Clustal alignment: missing a "CLUSTAL" header line');
  }
  if (order.length === 0) {
    throw new Error("Malformed Clustal alignment: no sequence data found");
  }
  return order.map((id) => ({ id, seq: seqs.get(id) ?? "" }));
}

/** Stockholm: `# STOCKHOLM` header, `id  seq_chunk` lines, `#=GF/GC/GS/GR`
 *  annotation lines (skipped), terminated by `//`. */
function parseStockholm(text: string): AlignRow[] {
  const lines = text.split(/\r?\n/);
  const order: string[] = [];
  const seqs = new Map<string, string>();
  let sawHeader = false;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    if (!sawHeader) {
      if (/^#\s*STOCKHOLM/i.test(trimmed)) sawHeader = true;
      continue;
    }
    if (trimmed === "//") break;
    if (trimmed.startsWith("#")) continue; // annotation line
    const m = trimmed.match(/^(\S+)\s+(\S+)$/);
    if (!m) continue;
    const [, id, seqChunk] = m;
    if (!seqs.has(id)) order.push(id);
    seqs.set(id, (seqs.get(id) ?? "") + seqChunk);
  }

  if (!sawHeader) {
    throw new Error('Malformed Stockholm alignment: missing a "# STOCKHOLM" header line');
  }
  if (order.length === 0) {
    throw new Error("Malformed Stockholm alignment: no sequence data found");
  }
  return order.map((id) => ({ id, seq: seqs.get(id) ?? "" }));
}

/** Relaxed PHYLIP: first non-blank line is "<count> <length>", followed by
 *  `count` sequential `id seq` lines. Any additional lines are treated as
 *  interleaved continuation blocks (sequence-only chunks, cycling through
 *  the declared order) and appended to the matching row. */
function parsePhylip(text: string): AlignRow[] {
  const lines = text.split(/\r?\n/);
  let idx = 0;
  while (idx < lines.length && lines[idx].trim() === "") idx++;
  if (idx >= lines.length) {
    throw new Error("Malformed PHYLIP alignment: empty input");
  }

  const header = lines[idx].trim();
  const headerMatch = header.match(/^(\d+)\s+(\d+)/);
  if (!headerMatch) {
    throw new Error('Malformed PHYLIP alignment: expected a "<count> <length>" header line');
  }
  const count = parseInt(headerMatch[1], 10);
  idx++;

  const rest = lines.slice(idx).filter((l) => l.trim() !== "");
  if (rest.length < count) {
    throw new Error(
      `Malformed PHYLIP alignment: declared ${count} sequences but found ${rest.length}`,
    );
  }

  const order: string[] = [];
  const seqs: string[] = [];
  for (let i = 0; i < count; i++) {
    const m = rest[i].match(/^(\S+)\s+(.*)$/);
    if (!m) {
      throw new Error(`Malformed PHYLIP alignment: bad data line "${rest[i]}"`);
    }
    order.push(m[1]);
    seqs.push(m[2].replace(/\s+/g, ""));
  }

  // Optional interleaved continuation blocks: sequence-only chunks that
  // cycle back through the same `count` rows, in order.
  for (let i = count; i < rest.length; i++) {
    const chunk = rest[i].replace(/\s+/g, "");
    seqs[(i - count) % count] += chunk;
  }

  return order.map((id, i) => ({ id, seq: seqs[i] }));
}

/** Aligned FASTA fallback: standard `>id description` headers followed by
 *  (possibly multi-line) sequence, used for unrecognized extensions whose
 *  content looks like FASTA. */
function parseFastaAligned(text: string): AlignRow[] {
  const rows: AlignRow[] = [];
  let curId: string | null = null;
  let curSeq = "";

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith(">")) {
      if (curId !== null) rows.push({ id: curId, seq: curSeq });
      const header = line.slice(1).trim();
      const sp = header.search(/\s/);
      curId = sp === -1 ? header : header.slice(0, sp);
      curSeq = "";
    } else if (curId !== null) {
      curSeq += line.trim();
    }
  }
  if (curId !== null) rows.push({ id: curId, seq: curSeq });

  if (rows.length === 0) {
    throw new Error("Malformed FASTA alignment: no sequences found");
  }
  return rows;
}

export function parseAlignment(text: string, ext: string): AlignRow[] {
  if (typeof text !== "string") {
    throw new Error("Malformed alignment: input must be a string");
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("Malformed alignment: input is empty");
  }

  const e = ext.toLowerCase().replace(/^\./, "");

  if (e === "sto" || e === "stk") return validateRows(parseStockholm(text));
  if (e === "aln" || e === "clustal") return validateRows(parseClustal(text));
  if (e === "phy" || e === "phylip") return validateRows(parsePhylip(text));

  // Unrecognized/generic extension — sniff the content instead.
  if (/^#\s*STOCKHOLM/im.test(trimmed)) return validateRows(parseStockholm(text));
  if (/^CLUSTAL/im.test(trimmed)) return validateRows(parseClustal(text));
  if (trimmed.startsWith(">")) return validateRows(parseFastaAligned(text));

  throw new Error(`Unrecognized alignment format for extension ".${e || "?"}"`);
}
