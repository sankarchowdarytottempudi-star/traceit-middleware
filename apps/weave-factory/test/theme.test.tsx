import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { resolve, ThemeProvider } from "../src/theme";

afterEach(cleanup);
describe("resolve", () => {
  it("auto follows system", () => { expect(resolve("auto", true)).toBe("dark"); expect(resolve("auto", false)).toBe("light"); });
  it("explicit wins", () => { expect(resolve("light", true)).toBe("light"); expect(resolve("dark", false)).toBe("dark"); });
});
describe("ThemeProvider", () => {
  it("sets data-theme on the document element", () => {
    render(<ThemeProvider><span>x</span></ThemeProvider>);
    expect(["light", "dark"]).toContain(document.documentElement.dataset.theme);
  });
});
