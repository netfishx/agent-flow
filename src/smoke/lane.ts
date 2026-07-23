// Builds the shell command lines dispatched into panes. Herdr re-parses a pane
// command through the pane's shell, so every command produced here is ONE
// already-quoted line. Values are passed as bash positional arguments rather
// than interpolated into the script body, so the script text is fixed and only
// the (centrally quoted) argument list varies.

import { shellSingleQuote } from "../herdr/argv.ts";
import type { LaneCommandInput } from "../runtime/types.ts";

// A self-contained simulated lane: streams progress to a durable log, prints a
// run+lane-specific sentinel on exit, and turns SIGINT into exit 130. It reads
// paths/steps/delay from "$1".."$7"; the sentinel token is built
// from those, matching laneSentinelToken(runId, laneId).
const LANE_SCRIPT = [
  "set -u",
  'runId="$1"; laneId="$2"; logFile="$3"; steps="$4"; delay="$5"; checkpointFile="$6"; resultFile="$7"',
  'token="FLOW_${runId}_LANE_${laneId}_EXIT"',
  "run_lane() {",
  'mkdir -p -- "$(dirname -- "$logFile")" "$(dirname -- "$checkpointFile")" "$(dirname -- "$resultFile")"',
  'emit() { printf "%s\\n" "$1"; }',
  'records() { { printf "STATUS: %s\\n" "$1"; printf "PHASE: simulated\\nCOMPLETED:\\n- steps ${i:-0}/${steps}\\nNEXT:\\n- none\\nBLOCKERS:\\n- none\\nARTIFACTS:\\n- %s\\nVERIFICATION_CLAIMS:\\n- completion sentinel\\nGAPS:\\n- none\\n" "$resultFile"; } >| "$checkpointFile"; printf "RESULT: %s steps=%s\\n" "$2" "${i:-0}" >| "$resultFile"; }',
  'finish() { records "$3" "$4"; emit "STEP=${i:-0} EVENT=$2"; emit "${token}=$1"; exit "$1"; }',
  "trap 'finish 130 interrupted-SIGINT partial interrupted' INT",
  'emit "START run=${runId} lane=${laneId} pid=$$"',
  "i=0",
  'while [ "$i" -lt "$steps" ]; do',
  "  i=$((i+1))",
  '  emit "STEP=${i}/${steps} lane=${laneId}"',
  '  sleep "$delay"',
  "done",
  "finish 0 done complete ok",
  "}",
  'run_lane 2>&1 | tee -a "$logFile"',
  'laneStatus="${PIPESTATUS[0]}"',
  'exit "$laneStatus"',
].join("\n");

export function buildLaneCommand(input: LaneCommandInput): string {
  return [
    "bash",
    "-c",
    shellSingleQuote(LANE_SCRIPT),
    "flow-lane",
    shellSingleQuote(input.runId),
    shellSingleQuote(input.laneId),
    shellSingleQuote(input.logFile),
    shellSingleQuote(String(input.steps)),
    shellSingleQuote(String(input.stepDelaySeconds)),
    shellSingleQuote(input.checkpointFile),
    shellSingleQuote(input.resultFile),
  ].join(" ");
}
