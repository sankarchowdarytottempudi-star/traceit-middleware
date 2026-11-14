// A small, safe renderer for the documents the migration tool writes (headings, paragraphs,
// lists, tables, code blocks, bold and inline code). It builds React elements only: no HTML from
// the document is ever injected into the page.
import { Fragment, type ReactNode } from "react";

function inline(text: string, key: string): ReactNode {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0; let m: RegExpExecArray | null; let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) out.push(<code key={`${key}-${n++}`}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**")) out.push(<strong key={`${key}-${n++}`}>{tok.slice(2, -2)}</strong>);
    else out.push(tok.replace(/^\[([^\]]+)\]\(([^)]+)\)$/, "$1"));
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <Fragment key={key}>{out}</Fragment>;
}
const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0; let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*```/.test(line);
    if (fence) {
      const buf: string[] = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(<pre key={k++} className="mf-mono"><code>{buf.join("\n")}</code></pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(4, h[1].length);
      const body = inline(h[2].replace(/\s+#+\s*$/, ""), `h${k}`);
      out.push(level === 1 ? <h1 key={k++}>{body}</h1> : level === 2 ? <h2 key={k++}>{body}</h2> : level === 3 ? <h3 key={k++}>{body}</h3> : <h4 key={k++}>{body}</h4>);
      i++; continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push(<hr key={k++} />); i++; continue; }
    if (line.includes("|") && i + 1 < lines.length && isRule(lines[i + 1])) {
      const head = cells(line); i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        <div key={k++} className="mf-mg-doc-table"><table>
          <thead><tr>{head.map((c, x) => <th key={x}>{inline(c, `th${x}`)}</th>)}</tr></thead>
          <tbody>{rows.map((r, y) => <tr key={y}>{head.map((_c, x) => <td key={x}>{inline(r[x] ?? "", `td${y}-${x}`)}</td>)}</tr>)}</tbody>
        </table></div>,
      );
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m) { items.push(m[2]); i++; continue; }
        if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += " " + lines[i].trim(); i++; continue; }
        break;
      }
      const body = items.map((t, x) => <li key={x}>{inline(t.replace(/^\[( |x)\]\s*/i, ""), `li${x}`)}</li>);
      out.push(ordered ? <ol key={k++}>{body}</ol> : <ul key={k++}>{body}</ul>);
      continue;
    }
    const para: string[] = [line.trim()]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*([-*+]|\d+[.)])\s)/.test(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && isRule(lines[i + 1]))) para.push(lines[i++].trim());
    out.push(<p key={k++}>{inline(para.join(" ").replace(/^>\s?/, ""), `p${k}`)}</p>);
  }
  return <div className="mf-mg-doc">{out}</div>;
}
