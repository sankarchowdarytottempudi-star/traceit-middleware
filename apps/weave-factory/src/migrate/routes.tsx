// Migrate (migrations lifecycle, deployed-API estate, workspaces, playground, knowledge).
// Owned by the migrate work stream.
import { Route } from "react-router-dom";
import { Boxes, Layers, FlaskConical, BookOpen } from "lucide-react";
import type { NavGroup } from "../nav.ts";
import { Migrations } from "../screens/Migrations.tsx";
import { Workspaces } from "../screens/Workspaces.tsx";
import { Playground } from "../screens/Playground.tsx";
import { Knowledge } from "../screens/Knowledge.tsx";

export const migrateNav: NavGroup[] = [
  { title: "MIGRATE", items: [
    { to: "/migrations", label: "Migrations", icon: Boxes },
    { to: "/workspaces", label: "Workspaces", icon: Layers },
  ] },
  { title: "TEST", items: [{ to: "/playground", label: "Playground", icon: FlaskConical }] },
  { title: "KNOWLEDGE", items: [{ to: "/knowledge", label: "Knowledge base", icon: BookOpen }] },
];

/** Called (not rendered) inside <Routes> so the <Route> elements stay direct children. */
export function migrateRoutes() {
  return (
    <>
      <Route path="migrations" element={<Migrations />} />
      <Route path="workspaces" element={<Workspaces />} />
      <Route path="playground" element={<Playground />} />
      <Route path="knowledge" element={<Knowledge />} />
    </>
  );
}
