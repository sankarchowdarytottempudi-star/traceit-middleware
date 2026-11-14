// The step palette: every node type in the catalog, grouped and searchable. Items can be
// dragged onto the canvas (mouse) or clicked/tapped to add after the selected step.
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { NodeTypeDef } from "@traceit/weave-flow";
import { accentOf, CATEGORY_LABEL, CATEGORY_ORDER, type Catalog } from "../catalog.ts";
import { iconFor } from "../icons.ts";
import { txt } from "../../lib/text.ts";

export const DND_NODE = "application/x-weave-node";

export function Palette({ catalog, onAdd, autoFocus }: { catalog: Catalog; onAdd: (type: string) => void; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hit = (d: NodeTypeDef) => !needle || `${d.label} ${d.description} ${d.type}`.toLowerCase().includes(needle);
    const cats = Array.from(new Set([...CATEGORY_ORDER, ...catalog.nodeTypes.map((d) => d.category)]));
    return cats.map((c) => ({ id: c, label: CATEGORY_LABEL[c] ?? c, items: catalog.nodeTypes.filter((d) => d.category === c && hit(d)) })).filter((g) => g.items.length);
  }, [catalog.nodeTypes, q]);

  return (
    <div className="ws-palette">
      <div className="ws-palette-search mf-search">
        <Search size={15} aria-hidden />
        <input className="mf-control mf-control-sm" type="search" placeholder="Search steps" aria-label="Search steps" value={q} onChange={(e) => setQ(e.target.value)} autoFocus={autoFocus} />
      </div>
      <div className="ws-palette-list">
        {groups.length === 0 && <p className="mf-help" style={{ padding: "8px 12px" }}>No step matches "{q}".</p>}
        {groups.map((g) => (
          <section key={g.id} aria-label={g.label}>
            <h3 className="ws-palette-group">{g.label}</h3>
            {g.items.map((d) => {
              const Icon = iconFor(d.icon);
              return (
                <button
                  key={d.type} type="button" className="ws-palette-item" data-node-type={d.type} title={txt(d.description)} draggable
                  onDragStart={(e) => { e.dataTransfer.setData(DND_NODE, d.type); e.dataTransfer.setData("text/plain", d.label); e.dataTransfer.effectAllowed = "copy"; }}
                  onClick={() => onAdd(d.type)}
                >
                  <span className="mf-iconchip ws-palette-chip" style={{ ["--chip" as string]: accentOf(d) }}><Icon size={16} aria-hidden /></span>
                  <span className="ws-palette-text">
                    <span className="ws-palette-name">{txt(d.label)}</span>
                    <span className="ws-palette-desc">{txt(d.description)}</span>
                  </span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
