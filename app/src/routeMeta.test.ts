import { describe, expect, it } from "vitest";
import { metaForRoute, routeMetaList, SITE_NAME } from "./routeMeta";

describe("route metadata", () => {
  it("defines unique, non-empty titles and bounded descriptions for every route", () => {
    const titles = routeMetaList.map((route) => route.title);
    expect(new Set(titles).size).toBe(titles.length);
    expect(SITE_NAME).toBe("Juno Voice");
    for (const route of routeMetaList) {
      expect(route.title).toMatch(/Juno Voice/);
      expect(route.description.length).toBeGreaterThan(20);
      expect(route.description.length).toBeLessThanOrEqual(170);
    }
  });
  it("covers exactly the addressable static routes with honest index flags", () => {
    expect([...routeMetaList.map((route) => route.path)].sort()).toEqual(
      ["", "bounties", "bounties/create", "faq", "gauge", "gauge/vote", "projects", "projects/manage"].sort());
    expect(() => metaForRoute("unknown")).toThrow("No route metadata");
    expect(metaForRoute("bounties").index).toBe(true);
    expect(metaForRoute("bounties/create").index).toBe(false);
    expect(routeMetaList.every((route) => route.prerender)).toBe(true);
  });
});
