// One background action (install, release, deploy, promote, rollback) followed until it ends.
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { sapi, type Job } from "./api.ts";
import { Notice } from "../migrate/ui.tsx";
import { StepList } from "./StepList.tsx";

export function JobLine({ job, what, onEnd }: { job: Job; what: string; onEnd?: (j: Job) => void }) {
  const q = useQuery({ queryKey: ["job", job.id], queryFn: () => sapi.job(job.id), initialData: job,
    refetchInterval: (s) => (s.state.data?.state === "running" ? 3000 : false) });
  const j = q.data ?? job;
  useEffect(() => { if (j.state !== "running") onEnd?.(j); }, [j.state]); // eslint-disable-line react-hooks/exhaustive-deps
  if (j.state === "running") return <Notice><span className="mf-mg-row" style={{ gap: 8 }} data-testid="job-running"><Loader2 size={14} className="mf-spin" aria-hidden="true" />{what} is running. This updates by itself.</span></Notice>;
  const r = j.result ?? {};
  return (
    <div className="mf-mg-stack" style={{ gap: 8 }} data-testid="job-result" data-state={j.state}>
      <Notice tone={j.state === "done" ? "ok" : "bad"}>
        <strong>{what} {j.state === "done" ? "finished." : "did not finish."}</strong>
        {r.message ? <span style={{ display: "block" }}>{r.message}</span> : null}
        {r.error ? <span style={{ display: "block" }} className="mf-mg-wrap">{r.error}</span> : null}
        {(r.refused ?? []).length > 0 && <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{(r.refused ?? []).map((x, i) => <li key={i}>{x}</li>)}</ul>}
      </Notice>
      {(r.steps ?? []).length > 0 && <StepList steps={r.steps ?? []} />}
    </div>
  );
}
