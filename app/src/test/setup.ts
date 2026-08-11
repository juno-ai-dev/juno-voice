import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
  () =>
    ({
      measureText: (text: string) => ({ width: text.length * 8 }),
    }) as unknown as CanvasRenderingContext2D,
);

afterEach(cleanup);
