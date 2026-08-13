import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { LandingPage } from "./LandingPage";

describe("product landing page", () => {
  it("explains the protocol, authority boundaries, and primary destinations", async () => {
    const onNavigate = vi.fn();
    render(<LandingPage onNavigate={onNavigate} />);

    expect(screen.getByRole("heading", { name: /Fund useful work/ })).toBeInTheDocument();
    expect(screen.getByText(/Contributors—not an operator—decide/)).toBeInTheDocument();
    expect(screen.getByText(/cannot redirect bounty funds or gauge votes/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /visible signal for where funding should flow/ })).toBeInTheDocument();
    expect(screen.getByText(/split their snapshot voting power/)).toBeInTheDocument();
    expect(screen.queryByText("NEW TO JUNO VOICE?")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /View bounty ledger/ }));
    await userEvent.click(screen.getByRole("button", { name: /View projects/ }));
    await userEvent.click(screen.getByRole("button", { name: /View gauge epochs/ }));
    expect(onNavigate.mock.calls).toEqual([["bounties"], ["projects"], ["gauge"]]);
  });

  it("has no WCAG A/AA violations", async () => {
    const { container } = render(<LandingPage onNavigate={vi.fn()} />);
    const result = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    });
    expect(result.violations).toEqual([]);
  });
});
