import type { Edge, Node } from "@xyflow/svelte";
import dagre from "dagre";

import type { AgentNodeData, GraphDescriptor } from "./types";

const NODE_WIDTH = 240;
const NODE_HEIGHT = 144;
const DEFAULT_DIRECTION: "LR" | "TB" = "LR";

export function layoutNodes(
  nodes: Node<AgentNodeData>[],
  edges: Edge[],
  direction: "LR" | "TB" = DEFAULT_DIRECTION,
): Node<AgentNodeData>[] {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: direction, nodesep: 48, ranksep: 104, marginx: 24, marginy: 24 });

  for (const node of nodes) {
    graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    graph.setEdge(edge.source, edge.target);
  }

  dagre.layout(graph);

  return nodes.map((node) => {
    const positioned = graph.node(node.id);
    const x = typeof positioned?.x === "number" ? positioned.x : 0;
    const y = typeof positioned?.y === "number" ? positioned.y : 0;
    return {
      ...node,
      position: { x: x - NODE_WIDTH / 2, y: y - NODE_HEIGHT / 2 },
    };
  });
}

export function buildFlow(descriptor: GraphDescriptor): {
  nodes: Node<AgentNodeData>[];
  edges: Edge[];
} {
  const nodes: Node<AgentNodeData>[] = descriptor.nodes.map((n) => ({
    id: n.key,
    type: "agent",
    position: { x: 0, y: 0 },
    data: {
      key: n.key,
      label: n.label,
      role: n.role,
      modelBearing: n.modelBearing,
      modelDisplayName: n.modelDisplayName ?? null,
      vendor: n.vendor ?? null,
      gateway: n.gateway ?? null,
      byok: n.byok === true,
      weight: n.weight ?? null,
    },
    draggable: false,
    connectable: false,
  }));

  const edges: Edge[] = descriptor.edges.map((edge, index) => ({
    id: `e-${edge.from}-${edge.to}-${index}`,
    source: edge.from,
    target: edge.to,
    type: "smoothstep",
    animated: edge.conditional === true,
    style: "stroke: var(--cc-flow-edge);",
  }));

  return { nodes: layoutNodes(nodes, edges), edges };
}
