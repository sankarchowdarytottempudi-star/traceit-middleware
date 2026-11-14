// Placeholder replaced by the real interpreter in the next increment.
import type { CompileInstructionRequest, CompiledInstruction } from "@traceit/weave-flow";
import type { HttpClient } from "../clients/http.js";
export interface CompileOutcome { ok: boolean; compiled: CompiledInstruction | null; understood: string[]; reason?: string; suggestions: string[]; fields: string[]; }
export interface ModelHook { modelUrl: string; http: HttpClient; }
export const INSTRUCTION_EXAMPLES: string[] = [];
export async function compileInstruction(_req: CompileInstructionRequest, _hook?: ModelHook): Promise<CompileOutcome> {
  return { ok: false, compiled: null, understood: [], reason: "The plain-words interpreter is being installed.", suggestions: [], fields: [] };
}
