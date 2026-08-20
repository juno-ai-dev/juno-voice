import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { describe, expect, it } from "vitest";
import { useCloseModal } from "./useCloseModal";

function Parent() {
  const navigate = useNavigate();
  return <><h1>Projects</h1><Link to="/projects/1">Open detail</Link><button onClick={() => void navigate(-1)}>Browser back</button></>;
}

function Detail() {
  const close = useCloseModal("/projects");
  return <><h1>Project detail</h1><button onClick={close}>Close</button></>;
}

describe("useCloseModal", () => {
  it("preserves the preceding history entry for an ordinarily pushed modal", async () => {
    render(<MemoryRouter initialEntries={["/", "/projects"]} initialIndex={1}>
      <Routes>
        <Route path="/" element={<h1>Previous page</h1>} />
        <Route path="/projects" element={<Parent />} />
        <Route path="/projects/1" element={<Detail />} />
      </Routes>
    </MemoryRouter>);

    await userEvent.click(screen.getByRole("link", { name: "Open detail" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("heading", { name: "Projects" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Browser back" }));
    expect(screen.getByRole("heading", { name: "Previous page" })).toBeVisible();
  });
});
