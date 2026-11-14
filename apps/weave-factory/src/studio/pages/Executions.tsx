// /studio/executions: every run of every flow.
import { useSearchParams } from "react-router-dom";
import { StudioHeader } from "../ui.tsx";
import { ExecutionsList } from "../editor/Executions.tsx";

export function ExecutionsPage() {
  const [params, setParams] = useSearchParams();
  return (
    <div className="mf-stack ws-page" style={{ gap: 20 }}>
      <StudioHeader area="Build" title="Executions" subtitle="Every test run and every live call, across all flows. Open one to see what each step received and produced." />
      <ExecutionsList showFlow openId={params.get("execution")} onOpen={(id) => setParams((p) => { const n = new URLSearchParams(p); if (id) n.set("execution", id); else n.delete("execution"); return n; }, { replace: true })} />
    </div>
  );
}
