/** Generate favicon/PWA icons from the brand app icon. Run: pnpm exec tsx scripts/gen-icons.ts */
import sharp from "sharp";
import { mkdirSync } from "node:fs";
const SRC = "public/brand/weave-app-icon-1024.png";
const OUT = "public/icons";
const SIZES = [16, 32, 180, 192, 512];
mkdirSync(OUT, { recursive: true });
await Promise.all(SIZES.map((s) => sharp(SRC).resize(s, s, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(`${OUT}/icon-${s}.png`)));
console.log("icons written to", OUT);
