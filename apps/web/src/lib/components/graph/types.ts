export type AgentRole = "orchestrator" | "reviewer" | "summarizer" | "fixed";

export type GraphGateway = "openrouter" | "saia";

export type GraphType = "pr_review";

export interface GraphNode {
  key: string;
  label: string;
  role: AgentRole;
  modelBearing: boolean;
  modelId?: string | null;
  modelDisplayName?: string | null;
  vendor?: string | null;
  gateway?: GraphGateway | null;
  byok?: boolean;
  weight?: number | string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string | null;
  conditional?: boolean;
}

export interface GraphDescriptor {
  graphType: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface AgentNodeData extends Record<string, unknown> {
  key: string;
  label: string;
  role: AgentRole;
  modelBearing: boolean;
  modelDisplayName?: string | null;
  vendor?: string | null;
  gateway?: GraphGateway | null;
  byok?: boolean;
  weight?: number | string | null;
}

export function roleLabel(role: string): string {
  if (role === "orchestrator") return "Orchestrator";
  if (role === "reviewer") return "Reviewer";
  if (role === "summarizer") return "Summarizer";
  if (role === "fixed") return "Pipeline";
  return role;
}

export function gatewayLabel(gateway?: string | null): string | null {
  if (gateway === "saia") return "via SAIA";
  if (gateway === "openrouter") return "OpenRouter";
  return null;
}
