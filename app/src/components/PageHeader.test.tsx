import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageHeader } from "./PageHeader";

describe("PageHeader", () => {
  it("renders eyebrow, title, lede, top-right actions, and a labelled stat strip", () => {
    render(<PageHeader eyebrow="JUNO VOICE · TEST" title="Test page" titleId="test-title"
      lede="A short explanation." actions={<a className="button" href="/create">Create a thing</a>}
      stats={[{ label: "Bounties", value: "3" }, { label: "Solvency", value: "Fully backed" }]}
      statsLabel="Protocol summary" />);
    expect(screen.getByRole("heading", { name: "Test page", level: 1 })).toHaveAttribute("id", "test-title");
    expect(screen.getByText("JUNO VOICE · TEST")).toBeInTheDocument();
    expect(screen.getByText("A short explanation.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create a thing" })).toBeInTheDocument();
    const stats = screen.getByRole("group", { name: "Protocol summary" });
    expect(stats).toHaveTextContent("Bounties");
    expect(stats).toHaveTextContent("Fully backed");
  });
  it("omits the action and stat slots when not provided", () => {
    render(<PageHeader eyebrow="E" title="T" titleId="t" lede="L" />);
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
