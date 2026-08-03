// Visibility is the runtime's purpose, so the arrangement is asserted, not
// assumed. A geometry simulator replays the placements against the same rule
// Herdr applies — a split divides only the cell it targets, and the ratio is
// the share the original pane keeps — so the tests can measure what an operator
// would actually see.

import { describe, expect, test } from "bun:test";
import { laneColumns, planLanePanes } from "../src/runtime/pane-layout.ts";

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Replay placements over a tab of the given size; index 0 is the controller. */
function simulate(
  laneCount: number,
  tab: Rect = { x: 0, y: 0, width: 180, height: 45 },
): { controller: Rect; lanes: Rect[] } {
  const placements = planLanePanes(laneCount);
  let controller = tab;
  const lanes: Rect[] = [];
  const cellOf = (from: { kind: string; index?: number }): Rect =>
    from.kind === "controller" ? controller : lanes[from.index!]!;
  const setCell = (
    from: { kind: string; index?: number },
    rect: Rect,
  ): void => {
    if (from.kind === "controller") controller = rect;
    else lanes[from.index!] = rect;
  };

  for (const placement of placements) {
    const cell = cellOf(placement.from);
    const keep = placement.ratio ?? 0.5;
    if (placement.direction === "down") {
      const keptHeight = Math.round(cell.height * keep);
      setCell(placement.from, { ...cell, height: keptHeight });
      lanes.push({
        x: cell.x,
        y: cell.y + keptHeight,
        width: cell.width,
        height: cell.height - keptHeight,
      });
    } else {
      const keptWidth = Math.round(cell.width * keep);
      setCell(placement.from, { ...cell, width: keptWidth });
      lanes.push({
        x: cell.x + keptWidth,
        y: cell.y,
        width: cell.width - keptWidth,
        height: cell.height,
      });
    }
  }
  return { controller, lanes };
}

describe("laneColumns", () => {
  test.each([
    [1, 1],
    [2, 2],
    [3, 2],
    [4, 2],
    [6, 3],
    [9, 3],
  ])("puts %i lanes in %i columns", (lanes, columns) => {
    expect(laneColumns(lanes)).toBe(columns);
  });
});

describe("planLanePanes", () => {
  test("produces exactly one placement per lane", () => {
    for (const count of [1, 2, 3, 4, 6, 9]) {
      expect(planLanePanes(count)).toHaveLength(count);
    }
  });

  test("only ever splits a pane that already exists", () => {
    const placements = planLanePanes(6);
    placements.forEach((placement, index) => {
      if (placement.from.kind === "lane") {
        expect(placement.from.index).toBeLessThan(index);
      }
    });
    expect(placements[0]!.from.kind).toBe("controller");
  });

  // The defect this module exists for: six lanes stacked in one strip left each
  // lane about five rows of a 45-row terminal, which is not readable output.
  test("six lanes are a grid, not a strip", () => {
    const { controller, lanes } = simulate(6);
    expect(lanes).toHaveLength(6);
    // Two distinct rows and three distinct columns.
    expect(new Set(lanes.map((lane) => lane.y)).size).toBe(2);
    expect(new Set(lanes.map((lane) => lane.x)).size).toBe(3);
    // Every lane keeps usable height and width.
    for (const lane of lanes) {
      expect(lane.height).toBeGreaterThanOrEqual(15);
      expect(lane.width).toBeGreaterThanOrEqual(55);
    }
    // The controller stays visible without taking the tab.
    expect(controller.height).toBeGreaterThanOrEqual(6);
    expect(controller.height).toBeLessThanOrEqual(12);
  });

  test("the six lane cells are even and do not overlap", () => {
    const { lanes } = simulate(6);
    const heights = new Set(lanes.map((lane) => lane.height));
    const widths = new Set(lanes.map((lane) => lane.width));
    // Rounding may differ by one column; nothing may differ by more.
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    for (const [i, a] of lanes.entries()) {
      for (const b of lanes.slice(i + 1)) {
        const disjoint =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        expect(disjoint).toBeTrue();
      }
    }
  });

  test("a single lane keeps today's simple split", () => {
    const placements = planLanePanes(1, "down");
    expect(placements).toEqual([
      { from: { kind: "controller" }, direction: "down", ratio: 0.2 },
    ]);
  });

  test("a partial last row still leaves every lane usable", () => {
    const { lanes } = simulate(5);
    expect(lanes).toHaveLength(5);
    for (const lane of lanes) {
      expect(lane.height).toBeGreaterThanOrEqual(15);
      expect(lane.width).toBeGreaterThanOrEqual(55);
    }
  });
});
