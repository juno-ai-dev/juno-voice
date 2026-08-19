import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UriDigestFields } from "./UriDigestFields";

const baseProps = { uriLabel: "Content URI", uriHint: "HTTPS or IPFS", digestLabel: "Content SHA-256 digest",
  digestHint: "Paste or calculate.", fileLabel: "Calculate content digest from file" };

describe("UriDigestFields", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("hashes a selected file locally into the digest input", async () => {
    vi.stubGlobal("crypto", { subtle: { digest: vi.fn(async () => new Uint8Array(32).fill(0xcd).buffer) } });
    render(<UriDigestFields {...baseProps} />);
    const file = new File(["body"], "meta.json", { type: "application/json" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode("body").buffer });
    await userEvent.upload(screen.getByLabelText("Calculate content digest from file"), file);
    expect(await screen.findByRole("status")).toHaveTextContent(/calculated locally.*not uploaded/i);
    expect(screen.getByLabelText(/^Content SHA-256 digest/)).toHaveValue(`sha256:${"cd".repeat(32)}`);
  });
  it("supports controlled values and forwards changes", async () => {
    const onUriChange = vi.fn(); const onDigestChange = vi.fn();
    render(<UriDigestFields {...baseProps} uriValue="" onUriChange={onUriChange} digestValue="" onDigestChange={onDigestChange} />);
    await userEvent.type(screen.getByLabelText(/^Content URI/), "i");
    expect(onUriChange).toHaveBeenCalledWith("i");
    await userEvent.type(screen.getByLabelText(/^Content SHA-256 digest/), "s");
    expect(onDigestChange).toHaveBeenCalledWith("s");
  });
  it("reports the size-cap error without reading the file and toggles the busy callback", async () => {
    const onHashingChange = vi.fn();
    render(<UriDigestFields {...baseProps} onHashingChange={onHashingChange} />);
    const file = new File([""], "big.bin");
    Object.defineProperty(file, "size", { value: 20 * 1024 * 1024 + 1 });
    await userEvent.upload(screen.getByLabelText("Calculate content digest from file"), file);
    expect(await screen.findByRole("status")).toHaveTextContent(/no larger than 20 MB/);
    expect(onHashingChange).toHaveBeenNthCalledWith(1, true);
    expect(onHashingChange).toHaveBeenLastCalledWith(false);
  });
  it("disables inputs when the caller disables the pair", () => {
    render(<UriDigestFields {...baseProps} disabled />);
    expect(screen.getByLabelText(/^Content URI/)).toBeDisabled();
    expect(screen.getByLabelText(/^Content SHA-256 digest/)).toBeDisabled();
    expect(screen.getByLabelText("Calculate content digest from file")).toBeDisabled();
  });
});
