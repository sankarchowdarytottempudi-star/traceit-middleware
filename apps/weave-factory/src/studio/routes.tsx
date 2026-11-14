// Studio (flow canvas, connections, connectors, executions). Owned by the studio work stream.
import { Navigate, Route } from "react-router-dom";
import { History, Plug, Puzzle, Workflow } from "lucide-react";
import type { NavGroup } from "../nav.ts";
import { ConnectionsPage } from "./pages/Connections.tsx";
import { ConnectorsPage } from "./pages/Connectors.tsx";
import { EstateFlowPage } from "./pages/EstateFlow.tsx";
import { ExecutionsPage } from "./pages/Executions.tsx";
import { FlowEditorPage } from "./pages/FlowEditor.tsx";
import { FlowsListPage } from "./pages/FlowsList.tsx";

export const studioNav: NavGroup[] = [
  {
    title: "BUILD",
    items: [
      { to: "/studio", label: "Flows", icon: Workflow, match: (p) => p === "/studio" || p === "/studio/" || p.startsWith("/studio/flows") || p.startsWith("/studio/estate") },
      { to: "/studio/connections", label: "Connections", icon: Plug },
      { to: "/studio/connectors", label: "Connectors", icon: Puzzle },
      { to: "/studio/executions", label: "Executions", icon: History },
    ],
  },
];

/** Called (not rendered) inside <Routes> so the <Route> elements stay direct children. */
export function studioRoutes() {
  return (
    <>
      <Route path="studio" element={<FlowsListPage />} />
      <Route path="studio/flows/:id" element={<FlowEditorPage />} />
      <Route path="studio/connections" element={<ConnectionsPage />} />
      <Route path="studio/connectors" element={<ConnectorsPage />} />
      <Route path="studio/executions" element={<ExecutionsPage />} />
      <Route path="studio/estate/:api" element={<EstateFlowPage />} />
      <Route path="studio/*" element={<Navigate to="/studio" replace />} />
      <Route path="canvas" element={<Navigate to="/studio" replace />} />
    </>
  );
}
