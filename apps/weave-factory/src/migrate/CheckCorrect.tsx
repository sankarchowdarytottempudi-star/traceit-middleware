// "Check and correct what the agent produced": on the Progress tab, the ways to change the agent's work
// in one place: edit the mapping (or any document), correct the analysis with the workbook (download,
// change, upload), give test data (requests and the answers expected), and answer the decisions the
// agent could not take alone. Each opens the
// Documents and corrections tab at the right place.
import { FileSpreadsheet, FlaskConical, ListChecks, Pencil, FileText } from "lucide-react";
import type { Migration } from "../api.ts";
import { num, txt } from "../lib/text.ts";
import { correctable } from "./Corrections.tsx";
import { Btn, Panel } from "./ui.tsx";

export type CorrectWhere = "mapping" | "workbook" | "testdata" | "decisions" | "documents";

/** Shown once the documents exist (the document phase is done) for a migration a person can correct. */
export function canCheck(m: Migration): boolean {
  return correctable(m) && txt((m.phases ?? []).find((p) => p.key === "document")?.status) === "done";
}

const BTN = { minWidth: 0, maxWidth: "100%", whiteSpace: "normal" as const, height: "auto", minHeight: 38, padding: "8px 14px", textAlign: "left" as const };

export function CheckCorrect({ m, open }: { m: Migration; open: (where: CorrectWhere) => void }) {
  if (!canCheck(m)) return null;
  const decisions = num(m.decisionsCounts?.open);
  const edited = (m.docEdits ?? []).length;
  const corrected = (m.corrections ?? []).length;
  return (
    <Panel title="Check and correct what the agent produced">
      <div className="mf-mg-stack" style={{ gap: 10 }} data-testid="check-correct">
        <span className="mf-mg-hint mf-mg-wrap">Something wrong in the mapping or another document? Change it here. Every change is kept and used each time the project is generated again{edited || corrected ? ` (so far: ${edited} document${edited === 1 ? "" : "s"} edited, ${corrected} workbook upload${corrected === 1 ? "" : "s"})` : ""}.</span>
        <div className="mf-mg-row" style={{ alignItems: "flex-start" }}>
          <Btn icon={<Pencil size={14} aria-hidden="true" />} onClick={() => open("mapping")} style={BTN} data-testid="cc-mapping">Edit the mapping (MAPPING.md)</Btn>
          <span className="mf-mg-hint mf-mg-grow" style={{ flexBasis: 220, paddingTop: 9 }}>Change the mapping text or its table rows directly. Rows you change in the table are applied to the generated code.</span>
        </div>
        <div className="mf-mg-row" style={{ alignItems: "flex-start" }}>
          <Btn icon={<FileSpreadsheet size={14} aria-hidden="true" />} onClick={() => open("workbook")} style={BTN} data-testid="cc-workbook">Correct with the workbook (.xlsx): download or upload</Btn>
          <span className="mf-mg-hint mf-mg-grow" style={{ flexBasis: 220, paddingTop: 9 }}>Download the analysis as Excel, fix the rows (fields, operations, backends, flows), upload it again. The documents and the project are regenerated.</span>
        </div>
        <div className="mf-mg-row" style={{ alignItems: "flex-start" }}>
          <Btn icon={<FlaskConical size={14} aria-hidden="true" />} onClick={() => open("testdata")} style={BTN} data-testid="cc-testdata">Give test data (requests and the answers you expect)</Btn>
          <span className="mf-mg-hint mf-mg-grow" style={{ flexBasis: 220, paddingTop: 9 }}>Examples of each operation become tests, and can suggest answers for the steps still on the TODO list. Nothing is used until you accept it.</span>
        </div>
        {decisions > 0 && (
          <div className="mf-mg-row" style={{ alignItems: "flex-start" }}>
            <Btn icon={<ListChecks size={14} aria-hidden="true" />} onClick={() => open("decisions")} style={BTN} data-testid="cc-decisions">Answer the open decisions ({decisions})</Btn>
            <span className="mf-mg-hint mf-mg-grow" style={{ flexBasis: 220, paddingTop: 9 }}>Steps the agent could not convert alone: choose the connector, expression or code.</span>
          </div>
        )}
        <div className="mf-mg-row" style={{ alignItems: "flex-start" }}>
          <Btn icon={<FileText size={14} aria-hidden="true" />} onClick={() => open("documents")} style={BTN} data-testid="cc-documents">Edit another document</Btn>
          <span className="mf-mg-hint mf-mg-grow" style={{ flexBasis: 220, paddingTop: 9 }}>Technical, functional and estimate documents: each has an Edit button.</span>
        </div>
      </div>
    </Panel>
  );
}
