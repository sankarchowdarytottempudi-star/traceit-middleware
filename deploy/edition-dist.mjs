#!/usr/bin/env node
// Server-side branding of a Weave image per edition, run in the Docker build stage after the build.
//
//   node deploy/edition-dist.mjs <edition> <appDir> [--package <package.json>] [--node-modules <dir>] [--scan <dir>]...
//
// TraceIT edition (default): does nothing; the image ships exactly as it is built.
// Cruise Saudi edition (shipped to the customer: no TraceIT / Tottempudi name may be in a file of it):
//   1. vendors the shared @traceit/weave-flow package into <appDir>/dist/vendor/weave-flow and points
//      the imports at it (relative paths), so no shipped file names the internal package scope;
//   2. reprints every .js file of <appDir>/dist without comments (TypeScript printer: code unchanged);
//   3. string literals: "TraceIT Weave" -> "Cruise Saudi Weave" (product name fallback),
//      "traceit" -> "cruise-saudi" (the edition id: the image is locked to its edition),
//      "weave.traceit/..." -> "weave.cruise-saudi/..." (Kubernetes annotation keys the Factory writes);
//   4. --package: drops the @traceit/* dependency entries of a shipped package.json (now vendored);
//   5. --node-modules: removes the (now unused) @traceit/* packages and pnpm's bookkeeping files
//      (.modules.yaml, .pnpm/lock.yaml; not read at run time) from the shipped node_modules;
//   6. guard: fails the build if any text file of <appDir>/dist, the --package file, the --node-modules
//      directory or a --scan directory still matches /traceit|tottempudi|traceit-tottech/i (the go-live check B6).
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";

const FORBIDDEN = /traceit-tottech|traceit|tottempudi/i;
const TEXT = /\.(js|mjs|cjs|json|html|css|svg|webmanifest|txt|md|xml|yaml|yml|map|ts)$/i;
const SCOPE = "@traceit/weave-flow";

const [edition, appArg, ...rest] = process.argv.slice(2);
if (!edition || !appArg) { console.error("usage: edition-dist.mjs <edition> <appDir> [--package <file>] [--scan <dir>]..."); process.exit(2); }
if (edition !== "cruise-saudi") { console.log(`edition-dist: edition "${edition}": nothing to change`); process.exit(0); }

const appDir = resolve(appArg);
const dist = join(appDir, "dist");
const scans = []; let pkgFile = ""; let nmDir = "";
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--scan") scans.push(resolve(rest[++i]));
  else if (rest[i] === "--package") pkgFile = resolve(rest[++i]);
  else if (rest[i] === "--node-modules") nmDir = resolve(rest[++i]);
  else { console.error(`edition-dist: unknown argument ${rest[i]}`); process.exit(2); }
}
const req = createRequire(join(appDir, "package.json"));
const ts = req("typescript");

function* walk(dir, intoNodeModules = false) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue; // pnpm links point into the same tree: each file is reached once
    if (st.isDirectory()) { if (intoNodeModules || n !== "node_modules") yield* walk(p, intoNodeModules); }
    else yield p;
  }
}
const jsFiles = (dir) => [...walk(dir)].filter((f) => /\.(js|mjs|cjs)$/.test(f));

// 1. vendor the shared package
const importers = jsFiles(dist).filter((f) => readFileSync(f, "utf8").includes(`"${SCOPE}"`));
if (importers.length) {
  const entry = req.resolve(SCOPE);                 // .../weave-flow/dist/index.js
  const vendor = join(dist, "vendor", "weave-flow");
  rmSync(vendor, { recursive: true, force: true });
  cpSync(dirname(entry), vendor, { recursive: true, filter: (s) => statSync(s).isDirectory() || /\.js$/.test(s) });
  const target = join(vendor, "index.js");
  for (const f of importers) {
    let rel = relative(dirname(f), target).split(sep).join("/");
    if (!rel.startsWith(".")) rel = "./" + rel;
    writeFileSync(f, readFileSync(f, "utf8").split(`"${SCOPE}"`).join(JSON.stringify(rel)));
  }
}

// 2 + 3. reprint without comments; rebrand string literals
const rebrand = (s) => s === "traceit" ? "cruise-saudi"
  : s.replace(/TraceIT Weave/g, "Cruise Saudi Weave").replace(/\bweave\.traceit\//g, "weave.cruise-saudi/");
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
const literals = (ctx) => (root) => {
  const visit = (node) => {
    if (ts.isStringLiteral(node)) {
      const t = rebrand(node.text);
      return t === node.text ? node : ts.factory.createStringLiteral(t);
    }
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      const t = rebrand(node.text);
      return t === node.text ? node : ts.factory.createNoSubstitutionTemplateLiteral(t);
    }
    return ts.visitEachChild(node, visit, ctx);
  };
  return ts.visitNode(root, visit);
};
let files = 0;
for (const f of jsFiles(dist)) {
  const src = readFileSync(f, "utf8");
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const out = ts.transform(sf, [literals]);
  writeFileSync(f, printer.printFile(out.transformed[0]));
  out.dispose();
  files++;
}

// 4. shipped package.json
if (pkgFile) {
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const d of Object.keys(pkg[k] ?? {})) if (FORBIDDEN.test(d) || FORBIDDEN.test(String(pkg[k][d]))) delete pkg[k][d];
  }
  delete pkg.devDependencies; delete pkg.scripts;
  writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
}

// 5. shipped node_modules
if (nmDir && existsSync(nmDir)) {
  rmSync(join(nmDir, "@traceit"), { recursive: true, force: true });
  rmSync(join(nmDir, ".modules.yaml"), { force: true });
  const store = join(nmDir, ".pnpm");
  if (existsSync(store)) {
    rmSync(join(store, "lock.yaml"), { force: true });
    for (const n of readdirSync(store)) if (FORBIDDEN.test(n)) rmSync(join(store, n), { recursive: true, force: true });
    rmSync(join(store, "node_modules", "@traceit"), { recursive: true, force: true }); // pnpm's hoisted links
  }
}

// 6. guard
const left = [];
for (const dir of [dist, ...scans, ...(nmDir ? [nmDir] : [])]) {
  if (!existsSync(dir)) { left.push(`${dir}: missing`); continue; }
  for (const f of walk(dir, dir === nmDir)) {
    if (FORBIDDEN.test(relative(dir, f))) { left.push(`${f}: file name`); continue; }
    if (!TEXT.test(f)) continue;
    const t = readFileSync(f, "utf8"); const m = FORBIDDEN.exec(t);
    if (m) left.push(`${f}: ...${t.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, " ")}...`);
  }
}
if (pkgFile && FORBIDDEN.test(readFileSync(pkgFile, "utf8"))) left.push(`${pkgFile}: still names the package scope`);
if (left.length) {
  console.error(`edition-dist: the Cruise Saudi image would still name TraceIT/Tottempudi in ${left.length} file(s):\n  ${left.slice(0, 30).join("\n  ")}`);
  process.exit(1);
}
console.log(`edition-dist: cruise-saudi: ${files} server files rebranded${importers.length ? `, shared package vendored for ${importers.length} files` : ""}; no TraceIT/Tottempudi left`);
