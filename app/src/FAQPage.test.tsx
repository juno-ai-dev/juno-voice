import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { FAQPage } from "./FAQPage";

const renderPage = () => render(<MemoryRouter><FAQPage /></MemoryRouter>);

describe("FAQ page", () => {
  it("organizes protocol guidance by topic with progressive disclosure", async () => {
    renderPage();

    expect(screen.getByRole("heading", { name: /Questions, answered plainly/ })).toBeInTheDocument();
    for (const topic of ["The basics", "Bounties", "The funding gauge", "Projects", "Wallet and safety"]) {
      expect(screen.getAllByRole("heading", { name: topic })).not.toHaveLength(0);
    }

    await userEvent.click(screen.getByText("What is a project candidate?"));
    expect(screen.getByText(/does not register, endorse, approve, or automatically graduate/)).toBeVisible();
    await userEvent.click(screen.getByText("How do weighted preferences work?"));
    expect(screen.getByText(/split their snapshot voting power/)).toBeVisible();
  });

  it("routes people back into each public protocol view", () => {
    renderPage();

    expect(screen.getByRole("link", { name: /Explore bounties/ })).toHaveAttribute("href", "/bounties");
    expect(screen.getByRole("link", { name: /View the gauge/ })).toHaveAttribute("href", "/gauge");
    expect(screen.getByRole("link", { name: /Browse projects/ })).toHaveAttribute("href", "/projects");
  });

  it("has no WCAG A/AA violations when all answers are expanded", async () => {
    const { container } = renderPage();
    for (const details of container.querySelectorAll("details:not([open])")) {
      await userEvent.click(details.querySelector("summary")!);
    }
    const result = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    });
    expect(result.violations).toEqual([]);
  });
});
