// Where each lane's pane goes. Visibility is this runtime's purpose, not a
// side effect, so the arrangement is a first-class decision rather than a
// consequence of a loop.
//
// Splitting every new pane off the previous one in one direction produces a
// single strip: seven panes stacked in a 45-row terminal leave each lane about
// five rows, which satisfies "simultaneously visible" on paper and nothing at
// all in practice. The owner reported exactly that. These placements build an
// even grid instead.
//
// Herdr's split ratio is the fraction the ORIGINAL pane keeps (measured, not
// assumed: a 0.25 down-split of a 45-row pane left 11 rows above and 34 below).
// Carving k equal parts out of one cell therefore means splitting the newest
// pane each time with ratio 1/(k-j), which is what `evenChain` below computes.

export interface LanePanePlacement {
  /** The pane to split: the controller, or an earlier lane's pane. */
  readonly from: { readonly kind: "controller" } | { readonly kind: "lane"; readonly index: number };
  readonly direction: "right" | "down";
  /** The fraction the split pane keeps; omitted means Herdr's default. */
  readonly ratio?: number;
}

/** The share of the tab the controller keeps above the lane grid. */
const CONTROLLER_SHARE = 0.2;

/**
 * The column count that keeps panes closest to square. Two lanes or fewer stay
 * on one axis, where a grid would only add a fold.
 */
export function laneColumns(laneCount: number): number {
  if (laneCount <= 2) return Math.max(laneCount, 1);
  return Math.ceil(Math.sqrt(laneCount));
}

/**
 * Placements for `laneCount` lanes, in the order the runtime creates them.
 *
 * Creation order is not reading order: a rectangle split can only divide the
 * cell it targets, so every row must exist before any row is cut into columns.
 * Lanes are therefore assigned to cells as the cells appear. Each pane carries
 * its own lane's output, so identity comes from the pane's content rather than
 * from its position.
 */
export function planLanePanes(
  laneCount: number,
  openDirection: "right" | "down" = "down",
): readonly LanePanePlacement[] {
  if (laneCount <= 0) return [];
  const columns = laneColumns(laneCount);
  const rows = Math.ceil(laneCount / columns);
  const placements: LanePanePlacement[] = [
    // The lane area, carved off the controller.
    {
      from: { kind: "controller" },
      direction: openDirection,
      ratio: CONTROLLER_SHARE,
    },
  ];
  if (laneCount === 1) return placements;

  // Row heads first: index 0 already holds the whole lane area, and each split
  // takes an equal band off what remains.
  const rowHead: number[] = [0];
  for (let row = 1; row < rows; row += 1) {
    placements.push({
      from: { kind: "lane", index: rowHead[row - 1]! },
      direction: "down",
      ratio: 1 / (rows - row + 1),
    });
    rowHead.push(placements.length - 1);
  }

  // Then each row is cut into its columns, left to right.
  for (let row = 0; row < rows; row += 1) {
    const inThisRow = Math.min(columns, laneCount - row * columns);
    let previous = rowHead[row]!;
    for (let column = 1; column < inThisRow; column += 1) {
      placements.push({
        from: { kind: "lane", index: previous },
        direction: "right",
        ratio: 1 / (inThisRow - column + 1),
      });
      previous = placements.length - 1;
    }
  }
  return placements;
}
