/** Shared Office preview wire types. Full document editing runs in the WASM workspace. */
export interface TextRun { id: string; text: string; bold: boolean; italic: boolean }
export interface TextGroup { label: string; paragraphs: { label: string; runs: TextRun[] }[] }
export type CellType = "text" | "number" | "boolean" | "formula" | "clear";
export interface OfficeCell { ref: string; value: string; display: string; type: CellType; readOnly: boolean; style?: { bold?: boolean; italic?: boolean; color?: string; background?: string } }
interface Base { revision: string; readOnly: boolean }
export interface OfficeText extends Base { kind: "docx" | "pptx"; groups: TextGroup[]; data: string }
export interface OfficeSheet extends Base {
  kind: "xlsx"; sheet: string; sheets: { name: string; hidden: boolean }[];
  row: number; col: number; rows: number; cols: number; cells: OfficeCell[]; merges: string[];
}
export type OfficeModel = OfficeText | OfficeSheet;
