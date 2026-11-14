import { describe, it, expect } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { WeaveMark, THREAD_A, THREAD_B, WeaveLockup, PRODUCT_NAME, MODULES, TAGLINE, COMPANY_LINE, weaveColors } from "./src/index.ts";

afterEach(cleanup);
describe("WeaveMark path data (BRAND.md)", () => {
  it("uses the exact thread paths", () => {
    expect(THREAD_A).toBe("M8 46 C16 22 23 16 32 32 S48 44 56 18");
    expect(THREAD_B).toBe("M8 18 C16 42 23 48 32 32 S48 20 56 46");
  });
  it("renders both threads and the knot", () => {
    const { container } = render(<WeaveMark />);
    const ds = [...container.querySelectorAll("path")].map((p) => p.getAttribute("d"));
    expect(ds).toContain(THREAD_A); expect(ds).toContain(THREAD_B);
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("TraceIT Weave");
  });
});
describe("animated / live toggles", () => {
  it("adds draw keyframes only when animated", () => {
    expect(render(<WeaveMark animated />).container.querySelector("style")!.textContent).toContain("draw");
    expect(render(<WeaveMark />).container.querySelector("style")!.textContent).not.toContain("draw");
  });
  it("adds a flow overlay path only when live", () => {
    expect(render(<WeaveMark live />).container.querySelectorAll("path").length).toBe(3);
    expect(render(<WeaveMark />).container.querySelectorAll("path").length).toBe(2);
  });
  it("gates all motion behind prefers-reduced-motion:no-preference", () => {
    const css = render(<WeaveMark animated live />).container.querySelector("style")!.textContent!;
    expect(css).toContain("prefers-reduced-motion: no-preference");
  });
});
describe("WeaveLockup theme pick", () => {
  it("renders inline SVG and selects the dark primary variant", () => {
    const { container } = render(<WeaveLockup theme="dark" />);
    const w = container.querySelector("[data-weave-lockup]")!;
    expect(w.getAttribute("data-weave-lockup")).toBe("primary");
    expect(w.getAttribute("data-theme")).toBe("dark");
    expect(w.getAttribute("aria-label")).toBe(PRODUCT_NAME);
    expect(w.querySelector("svg")).toBeTruthy();
  });
  it("selects the light inline variant", () => {
    const { container } = render(<WeaveLockup variant="inline" theme="light" />);
    const w = container.querySelector("[data-weave-lockup]")!;
    expect(w.getAttribute("data-weave-lockup")).toBe("inline");
    expect(w.getAttribute("data-theme")).toBe("light");
  });
});
describe("constants + colors", () => {
  it("exposes product naming", () => {
    expect(PRODUCT_NAME).toBe("TraceIT Weave"); expect(MODULES.gateway).toBe("Weave Gateway"); expect(MODULES.factory).toBe("Weave Factory");
    expect(TAGLINE).toBe("Monitor it. Weave it."); expect(COMPANY_LINE).toContain("Tottempudi Software Solutions");
  });
  it("gives gold/ink per theme", () => {
    expect(weaveColors("light").goldA).toBe("#8A5A08"); expect(weaveColors("dark").ink).toBe("#F2F7FB");
  });
});
