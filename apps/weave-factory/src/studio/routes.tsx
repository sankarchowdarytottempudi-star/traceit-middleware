// Studio (flow canvas, connections, connectors, executions). Owned by the studio work stream.
import { Route } from "react-router-dom";
import { Workflow } from "lucide-react";
import type { NavGroup } from "../nav.ts";
import { Canvas } from "../screens/Canvas.tsx";

export const studioNav: NavGroup[] = [
  { title: "BUILD", items: [{ to: "/studio", label: "Flows", icon: Workflow }] },
];

/** Called (not rendered) inside <Routes> so the <Route> elements stay direct children. */
export function studioRoutes() {
  return (
    <>
      <Route path="studio" element={<Canvas />} />
      <Route path="canvas" element={<Canvas />} />
    </>
  );
}
