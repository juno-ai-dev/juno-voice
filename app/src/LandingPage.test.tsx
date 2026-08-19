import { render, screen } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { LandingPage } from "./LandingPage";

const renderPage = () => render(<MemoryRouter><LandingPage /></MemoryRouter>);

describe("product landing page", () => {
  it("explains the protocol, authority boundaries, and primary destinations", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: /Fund useful work/ })).toBeInTheDocument();
    expect(screen.getByText(/Contributors—not an operator—decide/)).toBeInTheDocument();
    expect(screen.getByText(/cannot redirect bounty funds or gauge votes/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /visible signal for where funding should flow/ })).toBeInTheDocument();
    expect(screen.getByText(/split their snapshot voting power/)).toBeInTheDocument();
    expect(screen.queryByText("NEW TO JUNO VOICE?")).not.toBeInTheDocument();

    expect(screen.getByRole("link", { name: /View bounty ledger/ })).toHaveAttribute("href", "/bounties");
    expect(screen.getByRole("link", { name: /View projects/ })).toHaveAttribute("href", "/projects");
    expect(screen.getByRole("link", { name: /View gauge epochs/ })).toHaveAttribute("href", "/gauge");
    expect(screen.getByRole("link", { name: /Explore the funding gauge/ })).toHaveAttribute("href", "/gauge");
    expect(screen.getByRole("link", { name: "Browse bounties" })).toHaveAttribute("href", "/bounties");
  });

  it("has no WCAG A/AA violations", async () => {
    const { container } = renderPage();
    const result = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    });
    expect(result.violations).toEqual([]);
  });
});
