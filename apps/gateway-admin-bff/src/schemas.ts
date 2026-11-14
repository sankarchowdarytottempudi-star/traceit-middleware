import { z } from "zod";

export const Problem = z.object({ type: z.string(), title: z.string(), status: z.number(), detail: z.string().optional() });

export const QuotaType = z.enum(["requestCount", "bandwidth", "eventCount", "aiApiQuota"]);
export const SubPolicy = z.object({
  policyId: z.string(), name: z.string(), displayName: z.string().optional(),
  quotaType: QuotaType, limit: z.number(), unit: z.string(), timeUnit: z.string(),
  stopOnQuotaReach: z.boolean().default(true),
});
export const AdvPolicy = z.object({ policyId: z.string(), name: z.string(), limit: z.number(), timeUnit: z.string() });
export const DenyPolicy = z.object({ policyId: z.string(), conditionType: z.string(), value: z.string(), enabled: z.boolean() });

export const Environment = z.object({
  id: z.string(), name: z.string(), type: z.string(), gatewayType: z.string(),
  visibility: z.string().optional(), vhosts: z.array(z.object({ host: z.string(), httpContext: z.string().optional() })),
  reachable: z.boolean(),
});
export const KeyManager = z.object({ id: z.string(), name: z.string(), type: z.string(), enabled: z.boolean() });

export const RuleViolation = z.object({ ruleName: z.string(), severity: z.enum(["ERROR", "WARN", "INFO"]), message: z.string(), path: z.string().optional() });
export const ApiCompliance = z.object({
  apiId: z.string(), name: z.string(), version: z.string(),
  errors: z.number(), warnings: z.number(), info: z.number(), policy: z.string(),
  violations: z.array(RuleViolation).optional(),
});
export const ComplianceSummary = z.object({
  governed: z.number(), compliant: z.number(), total: z.number(),
  errors: z.number(), warnings: z.number(), info: z.number(),
  policyAdherencePct: z.number(), apiCompliancePct: z.number(),
  apis: z.array(ApiCompliance),
});

export const WorkflowType = z.object({ type: z.string(), label: z.string(), pending: z.number() });
export const WorkflowRequest = z.object({ referenceId: z.string(), type: z.string(), requester: z.string(), description: z.string(), createdTime: z.string() });

export const MigratedApi = z.object({
  id: z.string(), name: z.string(), context: z.string(), version: z.string(),
  lifeCycleStatus: z.string(), securityScheme: z.array(z.string()),
  throttlingPolicy: z.string().optional(),
  operations: z.array(z.object({ verb: z.string(), target: z.string(), authType: z.string() })),
  backend: z.string().optional(),
});

export type TComplianceSummary = z.infer<typeof ComplianceSummary>;
export type TMigratedApi = z.infer<typeof MigratedApi>;
