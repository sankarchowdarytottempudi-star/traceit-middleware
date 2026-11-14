import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Markdown } from "../src/migrate/markdown.tsx";

describe("Markdown", () => {
  it("renders headings, lists, tables and code as elements", () => {
    const { container } = render(<Markdown source={"# Title\n\nSome **bold** text with `code`.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nline <script>\n```\n"} />);
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("pre")?.textContent).toContain("line <script>");
  });
  it("never turns document text into markup or links", () => {
    const { container } = render(<Markdown source={"<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1))"} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
