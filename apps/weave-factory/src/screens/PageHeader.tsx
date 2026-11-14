import type { ReactNode } from "react";
import { Head, useTitle } from "../migrate/ui.tsx";
import "../migrate/migrate.css";

/** Page heading shared by the Factory screens. Wraps on small screens. */
export function PageHeader({ area, title, subtitle, actions }: { area: string; title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  useTitle(area);
  return <Head area={area} title={title} subtitle={subtitle} actions={actions} />;
}
