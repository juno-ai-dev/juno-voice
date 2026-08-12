import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import Onboarding from "./Onboarding";

const checkA11y = async (container: HTMLElement) => {
  const result = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
  });
  expect(result.violations).toEqual([]);
};

describe("first-use guidance", () => {
  it("introduces every public journey with progressive disclosure", async () => {
    render(<Onboarding onNavigate={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Start here" })).toBeInTheDocument();
    for (const name of ["Create or fund a bounty", "Register a project", "Settle with contributors", "Set gauge preferences"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }

    await userEvent.click(screen.getByText("Create or fund a bounty"));
    expect(screen.getByText(/Funds attached to a transaction leave your wallet/)).toBeVisible();
    expect(screen.getByText(/deadline uses Juno chain time/)).toBeVisible();
  });

  it("explains wallet and transaction safety without promising reversibility", async () => {
    render(<Onboarding onNavigate={vi.fn()} />);

    expect(screen.getByText(/Browsing is wallet-free/)).toBeInTheDocument();
    expect(screen.getByText(/does not give this app permission to move funds on its own/)).toBeInTheDocument();
    expect(screen.getByText(/A confirmed transaction is final/)).toBeInTheDocument();

    await userEvent.click(screen.getByText("Register a project"));
    expect(screen.getByText(/registration bond is attached to the transaction/)).toBeVisible();
    expect(screen.getByText(/refund only when the contract’s rules allow it/)).toBeVisible();

    await userEvent.click(screen.getByText("Settle with contributors"));
    expect(screen.getByText(/contribution weight is captured for that settlement round/)).toBeVisible();

    await userEvent.click(screen.getByText("Set gauge preferences"));
    expect(screen.getByText(/snapshot power is your recorded voting power/)).toBeVisible();
    expect(screen.getByText(/do-not-distribute/)).toBeVisible();
  });

  it("routes people to public journeys and exposes no privileged actions", async () => {
    const onNavigate = vi.fn();
    render(<Onboarding onNavigate={onNavigate} />);

    await userEvent.click(screen.getByText("Register a project"));
    await userEvent.click(screen.getByRole("button", { name: "Open projects" }));
    expect(onNavigate).toHaveBeenCalledWith("projects");
    expect(screen.queryByRole("button", { name: /curator|governor|agent/i })).not.toBeInTheDocument();
  });

  it("has no WCAG A/AA violations when expanded", async () => {
    const { container } = render(<Onboarding onNavigate={vi.fn()} />);
    for (const summary of screen.getAllByRole("button")) {
      if (summary.tagName === "SUMMARY") await userEvent.click(summary);
    }
    await checkA11y(container);
  });
});
