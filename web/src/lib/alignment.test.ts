import { describe, it, expect } from "vitest";
import { parseAlignment, type AlignRow } from "./alignment";

const CLUSTAL_FIXTURE = `CLUSTAL W (1.83) multiple sequence alignment

seq1            MKTAYIAKQRQ-SFVKSHFSRQ
seq2            MKT--IAKQRQISFVKSHFSRQ
                ***  *****  *********

seq1            LEERLGLIEV
seq2            LEERLGLIEV
                **********
`;

const STOCKHOLM_FIXTURE = `# STOCKHOLM 1.0
seq1          MKTAYIAKQR
seq2          MKT--IAKQR
//
`;

const PHYLIP_FIXTURE = ` 4 20
seq1      MKTAYIAKQRQISFVKSHFS
seq2      MKTAYIAKQRQISFVKSHFS
seq3      MKTAYIAKQRQISFVKSHFS
seq4      MKTAYIAKQRQISFVKSHFS
`;

const FASTA_ALIGNED_FIXTURE = `>seq1
MKTAYIAKQR
>seq2
MKT--IAKQR
`;

function sameLength(rows: AlignRow[]): boolean {
  return rows.every((r) => r.seq.length === rows[0].seq.length);
}

describe("parseAlignment - Clustal", () => {
  it("parses a Clustal alignment into rows with equal-length sequences", () => {
    const rows = parseAlignment(CLUSTAL_FIXTURE, "aln");
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.id)).toEqual(["seq1", "seq2"]);
    expect(sameLength(rows)).toBe(true);
    expect(rows[0].seq).toBe("MKTAYIAKQRQ-SFVKSHFSRQLEERLGLIEV");
    expect(rows[1].seq).toBe("MKT--IAKQRQISFVKSHFSRQLEERLGLIEV");
  });

  it("skips consensus/conservation symbol lines", () => {
    const rows = parseAlignment(CLUSTAL_FIXTURE, "clustal");
    expect(rows[0].seq).not.toMatch(/\*/);
  });

  it("throws when the CLUSTAL header is missing", () => {
    expect(() => parseAlignment("seq1  ACGT\nseq2  ACGT\n", "aln")).toThrow();
  });
});

describe("parseAlignment - Stockholm", () => {
  it("parses a Stockholm alignment", () => {
    const rows = parseAlignment(STOCKHOLM_FIXTURE, "sto");
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.id)).toEqual(["seq1", "seq2"]);
    expect(sameLength(rows)).toBe(true);
    expect(rows[0].seq).toBe("MKTAYIAKQR");
  });

  it("stops at the '//' terminator", () => {
    const withTrailer = STOCKHOLM_FIXTURE + "garbage that is not alignment data\n";
    const rows = parseAlignment(withTrailer, "sto");
    expect(rows.length).toBe(2);
  });

  it("throws when the STOCKHOLM header is missing", () => {
    expect(() => parseAlignment("seq1 ACGT\nseq2 ACGT\n//\n", "sto")).toThrow();
  });
});

describe("parseAlignment - PHYLIP", () => {
  it("parses the declared count of sequences", () => {
    const rows = parseAlignment(PHYLIP_FIXTURE, "phy");
    expect(rows.length).toBe(4);
    expect(sameLength(rows)).toBe(true);
    expect(rows[0].seq.length).toBe(20);
  });

  it("throws on a malformed header", () => {
    expect(() => parseAlignment("not a header\nseq1 ACGT\n", "phylip")).toThrow();
  });
});

describe("parseAlignment - aligned FASTA fallback", () => {
  it("parses FASTA-formatted content for an unrecognized extension", () => {
    const rows = parseAlignment(FASTA_ALIGNED_FIXTURE, "txt");
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.id)).toEqual(["seq1", "seq2"]);
    expect(sameLength(rows)).toBe(true);
  });
});

describe("parseAlignment - validation", () => {
  it("throws on unequal sequence lengths", () => {
    expect(() => parseAlignment(">seq1\nACGT\n>seq2\nAC\n", "txt")).toThrow();
  });

  it("throws on empty input", () => {
    expect(() => parseAlignment("", "aln")).toThrow();
  });

  it("throws for unrecognized content and extension", () => {
    expect(() => parseAlignment("just some random text\nwith no structure\n", "xyz")).toThrow();
  });
});
