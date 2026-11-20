// GENERATED from the migration factory's writer registry (factory/writers/__init__.py):
//   cd migration-factory && python3 -m factory targets --ts > <this file>
// Do not edit by hand: the generator is the single source of truth for targets and their maturity.
export type TargetMaturity = "complete" | "complete-unverified" | "partial" | "skeleton";
export interface GeneratedTarget { id: string; label: string; maturity: TargetMaturity; depth: "full" | "partial" | "skeleton"; hint: string; }

export const GENERATED_TARGETS: GeneratedTarget[] = [
  { id: "wso2", label: "WSO2 (Ballerina service)", maturity: "complete", depth: "full", hint: "Complete generator: documents, service, tests and deployment." },
  { id: "mule", label: "MuleSoft", maturity: "complete", depth: "full", hint: "Complete Mule 4 project: flows, DataWeave, connections, MUnit, lessons." },
  { id: "springboot", label: "Spring Boot", maturity: "complete", depth: "full", hint: "Complete generator: Java 21 / Spring Boot 3 project, every flow step, tests, Docker and Helm." },
  { id: "dotnet", label: ".NET", maturity: "complete", depth: "full", hint: "Complete generator: ASP.NET Core solution, flows, mappings, tests, Docker and Helm." },
  { id: "webmethods", label: "webMethods", maturity: "complete-unverified", depth: "partial", hint: "complete-unverified: an Integration Server package zip (flow services, document types, REST resource, JDBC adapter placeholders), tests, parity and lessons reports." },
  { id: "boomi", label: "Boomi", maturity: "complete-unverified", depth: "partial", hint: "complete-unverified: importable component XML (processes, connections, operations, profiles, maps), Platform API import script, tests, parity and lessons reports." },
  { id: "workato", label: "Workato", maturity: "complete-unverified", depth: "partial", hint: "Importable Workato package: API endpoint recipes, recipe functions, connections; format-verified, not run (no Workato account)." },
  { id: "nodejs", label: "Node.js", maturity: "skeleton", depth: "skeleton", hint: "Project skeleton, step model and documents." },
  { id: "openapi", label: "OpenAPI description only", maturity: "skeleton", depth: "skeleton", hint: "The API contract and documents, no service." },
];
