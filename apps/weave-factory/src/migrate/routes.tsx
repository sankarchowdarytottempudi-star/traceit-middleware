// Migrate (migrations lifecycle, deployed-API estate, workspaces, playground, knowledge).
// Owned by the migrate work stream.
import { Route } from "react-router-dom";
import { Boxes, Layers, FlaskConical, BookOpen, Network, Activity } from "lucide-react";
import type { NavGroup } from "../nav.ts";
import "./migrate.css";
import { Migrations } from "../screens/Migrations.tsx";
import { Workspaces } from "../screens/Workspaces.tsx";
import { Playground } from "../screens/Playground.tsx";
import { Knowledge } from "../screens/Knowledge.tsx";
import { ToolHealthPage } from "../screens/ToolHealth.tsx";
import { EstateList } from "./EstateList.tsx";
import { EstateDetail } from "./EstateDetail.tsx";
import { MigrationNew } from "./MigrationNew.tsx";
import { MigrationFromGit } from "./MigrationFromGit.tsx";
import { MigrationFromRequirements } from "./MigrationFromRequirements.tsx";
import { MigrationDetail } from "./MigrationDetail.tsx";
import { ServersPage } from "../servers/Servers.tsx";
import { ReleasesPage } from "../servers/Releases.tsx";

export const migrateNav: NavGroup[] = [
  { title: "RUN", items: [{ to: "/estate", label: "Running APIs", icon: Network }] },
  { title: "MIGRATE", items: [
    { to: "/migrations", label: "Migrations", icon: Boxes },
    { to: "/workspaces", label: "Workspaces", icon: Layers },
  ] },
  { title: "TEST", items: [{ to: "/playground", label: "Playground", icon: FlaskConical }] },
  { title: "KNOWLEDGE", items: [{ to: "/knowledge", label: "Knowledge base", icon: BookOpen }, { to: "/tool-health", label: "Tool health", icon: Activity }] },
];

/** Called (not rendered) inside <Routes> so the <Route> elements stay direct children. */
export function migrateRoutes() {
  return (
    <>
      <Route path="estate" element={<EstateList />} />
      <Route path="estate/:api" element={<EstateDetail />} />
      <Route path="migrations" element={<Migrations />} />
      <Route path="migrations/new" element={<MigrationNew key="upload" />} />
      <Route path="migrations/paste" element={<MigrationNew key="paste" mode="paste" />} />
      <Route path="migrations/from-git" element={<MigrationFromGit />} />
      <Route path="migrations/from-requirements" element={<MigrationFromRequirements />} />
      <Route path="migrations/:id" element={<MigrationDetail />} />
      <Route path="workspaces" element={<Workspaces />} />
      <Route path="workspaces/:id/servers" element={<ServersPage />} />
      <Route path="workspaces/:id/releases" element={<ReleasesPage />} />
      <Route path="playground" element={<Playground />} />
      <Route path="knowledge" element={<Knowledge />} />
      <Route path="tool-health" element={<ToolHealthPage />} />
    </>
  );
}
