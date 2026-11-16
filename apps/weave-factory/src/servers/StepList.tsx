// The steps a server reported, in plain words, with what to do when one failed.
import { Check, CircleDashed, Loader2, X, SkipForward } from "lucide-react";
import { STEP_WORDS, type Step } from "./api.ts";
import { Pill } from "../migrate/ui.tsx";

const TONE: Record<string, "ok" | "bad" | "warn" | "accent" | undefined> = { ok: "ok", fail: "bad", run: "accent", skip: undefined };
const WORD: Record<string, string> = { ok: "done", fail: "failed", run: "running", skip: "already there" };

export function StepList({ steps }: { steps: Step[] }) {
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }} data-testid="steps">
      {steps.map((s, i) => {
        const Icon = s.state === "ok" ? Check : s.state === "fail" ? X : s.state === "run" ? Loader2 : s.state === "skip" ? SkipForward : CircleDashed;
        return (
          <li key={i} className="mf-mg-item" style={{ padding: "8px 10px", display: "grid", gap: 4 }} data-testid="step" data-state={s.state}>
            <span className="mf-mg-row" style={{ gap: 8, flexWrap: "wrap" }}>
              <Icon size={14} aria-hidden="true" className={s.state === "run" ? "mf-spin" : undefined} />
              <strong style={{ fontSize: 13.5 }}>{STEP_WORDS[s.step] ?? s.step}</strong>
              <Pill tone={TONE[s.state]}>{WORD[s.state] ?? s.state}</Pill>
            </span>
            {s.message ? <span className="mf-mg-small mf-mg-muted mf-mg-wrap">{s.message}</span> : null}
            {s.state === "fail" && s.help ? <span className="mf-mg-small mf-mg-wrap"><strong>What to do: </strong>{s.help}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
