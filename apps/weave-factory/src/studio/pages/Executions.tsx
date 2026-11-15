// /studio/executions: every run of every flow built here, and every call of the migrated services.
import { useSearchParams } from "react-router-dom";
import { StudioHeader, Tabs, type TabDef } from "../ui.tsx";
import { ExecutionsList } from "../editor/Executions.tsx";
import { MigratedExecutionsList } from "../editor/MigratedExecutions.tsx";

type Source = "flows" | "migrated";
const SOURCES: TabDef<Source>[] = [{ id: "flows", label: "Flows built here" }, { id: "migrated", label: "Migrated APIs" }];

export function ExecutionsPage() {
  const [params, setParams] = useSearchParams();
  const source: Source = params.get("source") === "migrated" ? "migrated" : "flows";
  const patch = (changes: Record<string, string | null>) => setParams((p) => {
    const n = new URLSearchParams(p);
    for (const [k, v] of Object.entries(changes)) { if (v) n.set(k, v); else n.delete(k); }
    return n;
  }, { replace: true });
  return (
    <div className="mf-stack ws-page" style={{ gap: 20 }}>
      <StudioHeader area="Build" title="Executions"
        subtitle={source === "migrated"
          ? "Every call that went through the migrated APIs, and every job they ran. Open one to follow it from service to service."
          : "Every test run and every live call, across all flows. Open one to see what each step received and produced."} />
      <Tabs tabs={SOURCES} value={source} label="Where the executions come from" onChange={(s) => patch({ source: s === "migrated" ? s : null, execution: null, api: null })} />
      {source === "migrated"
        ? <MigratedExecutionsList pickedApi={params.get("api") ?? ""} onPickApi={(a) => patch({ api: a || null })} openId={params.get("execution")} onOpen={(id) => patch({ execution: id })} />
        : <ExecutionsList showFlow openId={params.get("execution")} onOpen={(id) => patch({ execution: id })} />}
    </div>
  );
}
