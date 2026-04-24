"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 560;
const PX_PER_METER = 150;
const GRAVITY = 9.81 * PX_PER_METER;
const STRING_LENGTH = 200;
const BAR_X = 350;

// Anchor movement bounds — apply to BOTH manual drag and trajectory playback.
const ANCHOR_UP_M = 0.2;
const ANCHOR_DOWN_M = 0.5;
const ANCHOR_UP_PX = ANCHOR_UP_M * PX_PER_METER;
const ANCHOR_DOWN_PX = ANCHOR_DOWN_M * PX_PER_METER;
const ANCHOR_HOME_Y = 200;
const ANCHOR_MIN_Y = ANCHOR_HOME_Y - ANCHOR_UP_PX;
const ANCHOR_MAX_Y = ANCHOR_HOME_Y + ANCHOR_DOWN_PX;
// Bar spans most of the canvas as a visual fixture; the dark-blue segment
// inside marks the anchor's actual movable range.
const BAR_TOP = 60;
const BAR_BOTTOM = CANVAS_HEIGHT - 60;
const ACTIVE_BAR_TOP = ANCHOR_MIN_Y;
const ACTIVE_BAR_BOTTOM = ANCHOR_MAX_Y;
const ANCHOR_INIT_Y = ANCHOR_HOME_Y;

const ANCHOR_RADIUS = 12;
const WEIGHT_RADIUS = 16;
const MAX_ANCHOR_SPEED = 1800;
const DAMPING_PER_STEP = 0.9998;
const COUNTDOWN_DURATION_S = 3;
const CHARGE_HEIGHT_M = 0.3;
const CHARGE_PX = CHARGE_HEIGHT_M * PX_PER_METER;

// Anchor-trajectory timeline.
const TRAJECTORY_DURATION_S = 2.0;
const TIMELINE_W = 800;
const TIMELINE_H = 110;
const TIMELINE_PAD = 14;
const TIMELINE_BOTTOM_LABEL_H = 14;
const TIMELINE_INNER_W = TIMELINE_W - 2 * TIMELINE_PAD;
const TIMELINE_INNER_H = TIMELINE_H - 2 * TIMELINE_PAD - TIMELINE_BOTTOM_LABEL_H;
const TIMELINE_INNER_TOP = TIMELINE_PAD;
const TIMELINE_HOME_Y =
  TIMELINE_INNER_TOP +
  (ANCHOR_UP_PX / (ANCHOR_UP_PX + ANCHOR_DOWN_PX)) * TIMELINE_INNER_H;

type Phase = "idle" | "countdown" | "swinging" | "done";

interface Vec2 {
  x: number;
  y: number;
}

interface TrajPoint {
  id: number;
  t: number; // 0..1 along TRAJECTORY_DURATION_S
  offset: number; // pixels from ANCHOR_HOME_Y, negative = up, positive = down
}

interface SimState {
  anchor: Vec2;
  anchorTargetY: number;
  weight: Vec2;
  weightVel: Vec2;
  phase: Phase;
  referenceY: number;
  currentHeightM: number;
  maxHeightM: number;
  path: Vec2[];
  frameCount: number;
  hasBeenLeft: boolean;
  hasReturnedRight: boolean;
  rightmostXAfterReturn: number;
  leftTopPos: Vec2 | null;
  leftPeakHeightM: number | null;
  countdownElapsedS: number;
  swingElapsedS: number;
  minWeightX: number;
  reachedLeftPeak: boolean;
}

function makeInitialSim(): SimState {
  return {
    anchor: { x: BAR_X, y: ANCHOR_INIT_Y },
    anchorTargetY: ANCHOR_INIT_Y,
    weight: { x: BAR_X + STRING_LENGTH, y: ANCHOR_INIT_Y },
    weightVel: { x: 0, y: 0 },
    phase: "idle",
    referenceY: ANCHOR_INIT_Y,
    currentHeightM: 0,
    maxHeightM: 0,
    path: [],
    frameCount: 0,
    hasBeenLeft: false,
    hasReturnedRight: false,
    rightmostXAfterReturn: -Infinity,
    leftTopPos: null,
    leftPeakHeightM: null,
    countdownElapsedS: 0,
    swingElapsedS: 0,
    minWeightX: Infinity,
    reachedLeftPeak: false,
  };
}

function defaultTrajectory(): TrajPoint[] {
  return [
    { id: 1, t: 0, offset: 0 },
    { id: 2, t: 1, offset: 0 },
  ];
}

// Preset shapes. Each preset's "-0.3" in the user spec = 0.3 m below home,
// which maps to +0.3 * PX_PER_METER in our internal offset (positive = down).
const PRESET_DROP_PX = 0.3 * PX_PER_METER;

const TRAJECTORY_PRESETS: Array<{
  label: string;
  build: () => TrajPoint[];
}> = [
  {
    label: "Down & wait",
    build: () => [
      { id: 1, t: 0, offset: 0 },
      { id: 2, t: 0.5, offset: PRESET_DROP_PX },
      { id: 3, t: 1, offset: PRESET_DROP_PX },
    ],
  },
  {
    label: "Linear pump",
    build: () => [
      { id: 1, t: 0, offset: 0 },
      { id: 2, t: 0.5, offset: PRESET_DROP_PX },
      { id: 3, t: 1, offset: 0 },
    ],
  },
  {
    label: "Early start",
    build: () => [
      { id: 1, t: 0, offset: 0 },
      { id: 2, t: 0.3, offset: PRESET_DROP_PX },
      { id: 3, t: 0.6, offset: 0 },
      { id: 4, t: 1, offset: 0 },
    ],
  },
  {
    label: "Late start",
    build: () => [
      { id: 1, t: 0, offset: 0 },
      { id: 2, t: 0.4, offset: PRESET_DROP_PX },
      { id: 3, t: 0.75, offset: 0 },
      { id: 4, t: 1, offset: 0 },
    ],
  },
];

// Monotone cubic Hermite (Fritsch-Carlson) tangents. Produces a smooth curve
// that passes through every control point without overshooting between them.
function monotoneCubicTangents(pts: TrajPoint[]): number[] {
  const n = pts.length;
  if (n === 0) return [];
  if (n === 1) return [0];

  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dt = pts[i + 1].t - pts[i].t;
    d.push(dt === 0 ? 0 : (pts[i + 1].offset - pts[i].offset) / dt);
  }

  const m: number[] = [];
  m.push(d[0]);
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m.push(0);
    else m.push((d[i - 1] + d[i]) / 2);
  }
  m.push(d[n - 2]);

  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = a * a + b * b;
    if (h > 9) {
      const s = 3 / Math.sqrt(h);
      m[i] = s * a * d[i];
      m[i + 1] = s * b * d[i];
    }
  }

  return m;
}

function sampleTrajectory(points: TrajPoint[], t: number): number {
  const n = points.length;
  if (n === 0) return 0;
  const ct = t < 0 ? 0 : t > 1 ? 1 : t;
  if (ct <= points[0].t) return points[0].offset;
  const last = points[n - 1];
  if (ct >= last.t) return last.offset;
  if (n === 1) return points[0].offset;

  const tan = monotoneCubicTangents(points);
  for (let i = 0; i < n - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a.t <= ct && ct <= b.t) {
      const h = b.t - a.t;
      if (h <= 0) return b.offset;
      const u = (ct - a.t) / h;
      const u2 = u * u;
      const u3 = u2 * u;
      const h00 = 2 * u3 - 3 * u2 + 1;
      const h10 = u3 - 2 * u2 + u;
      const h01 = -2 * u3 + 3 * u2;
      const h11 = u3 - u2;
      return (
        h00 * a.offset +
        h10 * h * tan[i] +
        h01 * b.offset +
        h11 * h * tan[i + 1]
      );
    }
  }
  return last.offset;
}

function smootherstep(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * x * (x * (x * 6 - 15) + 10);
}

export default function PendulumSimulator() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<SimState>(makeInitialSim());
  const lastTimeRef = useRef<number>(0);
  const timersRef = useRef<number[]>([]);

  const [phase, setPhase] = useState<Phase>("idle");
  const [countdown, setCountdown] = useState<number>(0);
  const [currentHeight, setCurrentHeight] = useState<number>(0);
  const [maxHeight, setMaxHeight] = useState<number>(0);
  const [leftPeakHeight, setLeftPeakHeight] = useState<number | null>(null);
  const [pastRuns, setPastRuns] = useState<number[]>([]);
  const [trajectory, setTrajectory] = useState<TrajPoint[]>(defaultTrajectory);
  const [playheadT, setPlayheadT] = useState<number | null>(null);
  const trajectoryRef = useRef<TrajPoint[]>(trajectory);
  useEffect(() => {
    trajectoryRef.current = trajectory;
  }, [trajectory]);

  const clearTimers = () => {
    timersRef.current.forEach((id) => window.clearTimeout(id));
    timersRef.current = [];
  };

  const reset = useCallback(() => {
    clearTimers();
    // Reset the anchor back to its home position on every Reset, so the
    // trajectory plays from a known starting point on the next run.
    const fresh = makeInitialSim();
    simRef.current = fresh;
    setPhase("idle");
    setCountdown(0);
    setCurrentHeight(0);
    setMaxHeight(0);
    setLeftPeakHeight(null);
    setPlayheadT(null);
  }, []);

  const go = useCallback(() => {
    reset();
    setPhase("countdown");
    simRef.current.phase = "countdown";
    simRef.current.countdownElapsedS = 0;
    setCountdown(3);
    timersRef.current.push(window.setTimeout(() => setCountdown(2), 1000));
    timersRef.current.push(window.setTimeout(() => setCountdown(1), 2000));
    timersRef.current.push(
      window.setTimeout(() => {
        setCountdown(0);
        const s = simRef.current;
        // Reference line = horizontal release position (anchor's y). The charge
        // raises the weight above that line, so initial height is CHARGE_HEIGHT_M.
        s.referenceY = s.anchor.y;
        s.phase = "swinging";
        setPhase("swinging");
      }, COUNTDOWN_DURATION_S * 1000)
    );
  }, [reset]);

  useEffect(() => {
    let running = true;
    let uiAccum = 0;
    let lastSyncedPhase: Phase = simRef.current.phase;

    const tick = (t: number) => {
      if (!running) return;
      if (lastTimeRef.current === 0) lastTimeRef.current = t;
      const dt = Math.min(0.033, Math.max(0.001, (t - lastTimeRef.current) / 1000));
      lastTimeRef.current = t;

      step(dt);
      render();

      uiAccum += dt;
      if (uiAccum >= 1 / 30) {
        uiAccum = 0;
        const s = simRef.current;
        setCurrentHeight(s.currentHeightM);
        setMaxHeight(s.maxHeightM);
        if (s.leftPeakHeightM !== null) setLeftPeakHeight(s.leftPeakHeightM);
        if (s.phase === "idle" || s.phase === "countdown") {
          setPlayheadT(null);
        } else if (
          s.phase === "swinging" &&
          !s.reachedLeftPeak
        ) {
          setPlayheadT(Math.min(s.swingElapsedS / TRAJECTORY_DURATION_S, 1));
        }
        // Past-peak and "done" phases leave the playhead where it was —
        // the UI holds its last position.
        if (s.phase !== lastSyncedPhase) {
          if (s.phase === "done" && lastSyncedPhase === "swinging") {
            setPhase("done");
            if (s.leftPeakHeightM !== null) {
              const peak = s.leftPeakHeightM;
              setPastRuns((prev) => [...prev, peak]);
            }
          }
          lastSyncedPhase = s.phase;
        }
      }

      requestAnimationFrame(tick);
    };

    const id = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(id);
    };
  }, []);

  function step(dt: number) {
    const s = simRef.current;

    // Anchor glide toward target (clamped speed)
    {
      const dy = s.anchorTargetY - s.anchor.y;
      const maxDy = MAX_ANCHOR_SPEED * dt;
      s.anchor.y += Math.abs(dy) > maxDy ? Math.sign(dy) * maxDy : dy;
      s.anchor.y = clamp(s.anchor.y, ANCHOR_MIN_Y, ANCHOR_MAX_Y);
    }

    if (s.phase === "idle") {
      // At rest — weight pinned horizontally to the right of the anchor.
      s.weight.x = s.anchor.x + STRING_LENGTH;
      s.weight.y = s.anchor.y;
      s.weightVel.x = 0;
      s.weightVel.y = 0;
      s.referenceY = s.anchor.y;
    } else if (s.phase === "countdown") {
      // "Charge up": raise the weight along the string arc by CHARGE_PX over
      // the countdown, using an ease-in-out (smootherstep) S-curve.
      s.countdownElapsedS = Math.min(
        s.countdownElapsedS + dt,
        COUNTDOWN_DURATION_S
      );
      const t = s.countdownElapsedS / COUNTDOWN_DURATION_S;
      const h = CHARGE_PX * smootherstep(t);
      const horiz = Math.sqrt(Math.max(0, STRING_LENGTH * STRING_LENGTH - h * h));
      s.weight.x = s.anchor.x + horiz;
      s.weight.y = s.anchor.y - h;
      s.weightVel.x = 0;
      s.weightVel.y = 0;
      s.referenceY = s.anchor.y;
    } else if (s.phase === "swinging") {
      // Drive anchor from the pre-defined trajectory while we're on the
      // right→left leg of the swing. Once the weight passes the left peak,
      // trajectory playback stops — the anchor holds at its last target.
      s.swingElapsedS += dt;
      if (!s.reachedLeftPeak) {
        const tNorm = Math.min(s.swingElapsedS / TRAJECTORY_DURATION_S, 1);
        const offset = sampleTrajectory(trajectoryRef.current, tNorm);
        s.anchorTargetY = clamp(
          ANCHOR_HOME_Y + offset,
          ANCHOR_MIN_Y,
          ANCHOR_MAX_Y
        );
      }

      // Integrate gravity
      s.weightVel.y += GRAVITY * dt;
      let px = s.weight.x + s.weightVel.x * dt;
      let py = s.weight.y + s.weightVel.y * dt;

      // Rigid rod constraint around current anchor position
      const dx = px - s.anchor.x;
      const dy = py - s.anchor.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1e-6) {
        const k = STRING_LENGTH / dist;
        px = s.anchor.x + dx * k;
        py = s.anchor.y + dy * k;
      }

      // Velocity from actual motion (captures constraint + anchor movement)
      s.weightVel.x = (px - s.weight.x) / dt;
      s.weightVel.y = (py - s.weight.y) / dt;
      s.weight.x = px;
      s.weight.y = py;

      // Mild damping to avoid numerical energy drift
      s.weightVel.x *= DAMPING_PER_STEP;
      s.weightVel.y *= DAMPING_PER_STEP;

      // Left-side peak = highest point (min y) reached while the weight is on
      // the left of the anchor. Tracking leftmost-x alone misses peaks
      // created by pumping the anchor upward.
      if (s.weight.x < s.anchor.x) {
        s.hasBeenLeft = true;
        if (s.leftTopPos === null || s.weight.y < s.leftTopPos.y) {
          s.leftTopPos = { x: s.weight.x, y: s.weight.y };
          s.leftPeakHeightM = (s.referenceY - s.weight.y) / PX_PER_METER;
        }
      }

      // Detect the "left peak" moment (weight.x has stopped decreasing
      // after the weight has been on the left). This is when trajectory
      // playback must stop — the anchor no longer follows the pre-set
      // shape on the return leg.
      if (s.hasBeenLeft) {
        if (s.weight.x < s.minWeightX) s.minWeightX = s.weight.x;
        if (!s.reachedLeftPeak && s.weight.x > s.minWeightX + 3) {
          s.reachedLeftPeak = true;
        }
      }

      // Phase detection: one full right→left→right cycle, position-based.
      // A velocity-sign criterion breaks when pumping sends the weight high
      // enough on the left that its horizontal velocity flips positive while
      // still rising — we'd then hit "vx <= 0" at the peak and stop the
      // simulation on the upper-left. Using position instead works even if
      // the swing loops all the way over the top of the anchor.
      if (s.hasBeenLeft && s.weight.x > s.anchor.x) {
        s.hasReturnedRight = true;
      }
      if (s.hasReturnedRight) {
        if (s.weight.x > s.rightmostXAfterReturn) {
          s.rightmostXAfterReturn = s.weight.x;
        } else if (s.weight.x < s.rightmostXAfterReturn - 3) {
          // x has started decreasing after reaching a right-side max → done.
          s.phase = "done";
        }
      }

      // Record path
      s.frameCount++;
      if (s.frameCount % 2 === 0) {
        s.path.push({ x: s.weight.x, y: s.weight.y });
        if (s.path.length > 6000) s.path.shift();
      }
    }
    // phase === "done": leave weight and velocity untouched — frozen where it ended.

    // Height is meaningful in every phase (including the charge-up animation).
    s.currentHeightM = (s.referenceY - s.weight.y) / PX_PER_METER;
    if (
      (s.phase === "countdown" || s.phase === "swinging") &&
      s.currentHeightM > s.maxHeightM
    ) {
      s.maxHeightM = s.currentHeightM;
    }
  }

  function render() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const s = simRef.current;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Reference (release-height) line
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, s.referenceY);
    ctx.lineTo(CANVAS_WIDTH, s.referenceY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Vertical bar — light blue outside the anchor's movable window, dark
    // blue inside it so the active range is visually obvious.
    ctx.lineWidth = 10;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#bfdbfe";
    ctx.beginPath();
    ctx.moveTo(BAR_X, BAR_TOP);
    ctx.lineTo(BAR_X, ACTIVE_BAR_TOP);
    ctx.moveTo(BAR_X, ACTIVE_BAR_BOTTOM);
    ctx.lineTo(BAR_X, BAR_BOTTOM);
    ctx.stroke();
    ctx.lineCap = "butt";
    ctx.strokeStyle = "#2563eb";
    ctx.beginPath();
    ctx.moveTo(BAR_X, ACTIVE_BAR_TOP);
    ctx.lineTo(BAR_X, ACTIVE_BAR_BOTTOM);
    ctx.stroke();

    // Recorded path
    if (s.path.length > 1) {
      ctx.strokeStyle = "rgba(22, 163, 74, 0.55)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s.path[0].x, s.path[0].y);
      for (let i = 1; i < s.path.length; i++) {
        ctx.lineTo(s.path[i].x, s.path[i].y);
      }
      ctx.stroke();
    }

    // String (orange)
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(s.anchor.x, s.anchor.y);
    ctx.lineTo(s.weight.x, s.weight.y);
    ctx.stroke();

    // Left-peak marker (rendered before anchor/weight so they sit on top when close)
    if (s.leftTopPos && s.leftPeakHeightM !== null) {
      ctx.fillStyle = "#10b981";
      ctx.strokeStyle = "#047857";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s.leftTopPos.x, s.leftTopPos.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      const label = `${s.leftPeakHeightM.toFixed(2)} m`;
      ctx.font = "600 13px ui-sans-serif, system-ui, sans-serif";
      const tx = s.leftTopPos.x;
      const ty = s.leftTopPos.y - 14;
      const metrics = ctx.measureText(label);
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.fillRect(tx - metrics.width / 2 - 4, ty - 14, metrics.width + 8, 18);
      ctx.fillStyle = "#065f46";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, tx, ty - 5);
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    }

    // Anchor (black)
    ctx.fillStyle = "#0f172a";
    ctx.beginPath();
    ctx.arc(s.anchor.x, s.anchor.y, ANCHOR_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    // Weight (red)
    ctx.fillStyle = "#ef4444";
    ctx.strokeStyle = "#991b1b";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(s.weight.x, s.weight.y, WEIGHT_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Inline current-height readout near the weight
    if (s.phase === "swinging" || s.phase === "done") {
      const label = `${s.currentHeightM.toFixed(2)} m`;
      ctx.font = "600 12px ui-sans-serif, system-ui, sans-serif";
      const metrics = ctx.measureText(label);
      const lx = s.weight.x + WEIGHT_RADIUS + 6;
      const ly = s.weight.y - 2;
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillRect(lx - 3, ly - 12, metrics.width + 6, 16);
      ctx.fillStyle = "#111827";
      ctx.fillText(label, lx, ly);
    }
  }

  // Canvas sizing with DPR
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = CANVAS_WIDTH * dpr;
    canvas.height = CANVAS_HEIGHT * dpr;
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={go}
          className="px-4 py-2 rounded-md bg-black text-white text-sm font-medium hover:bg-neutral-800 transition-colors"
        >
          Go
        </button>
        <button
          onClick={reset}
          className="px-4 py-2 rounded-md bg-neutral-200 text-black text-sm font-medium hover:bg-neutral-300 transition-colors"
        >
          Reset
        </button>
        {countdown > 0 && (
          <span className="text-4xl font-bold tabular-nums text-neutral-800 ml-2">{countdown}</span>
        )}
        <span className="ml-auto text-xs text-neutral-500">
          Tip: shape the anchor&apos;s path on the timeline below before pressing Go.
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Current height" value={`${currentHeight.toFixed(2)} m`} />
        <Stat label="Max height" value={`${maxHeight.toFixed(2)} m`} />
        <Stat
          label="Left-peak height"
          value={leftPeakHeight === null ? "—" : `${leftPeakHeight.toFixed(2)} m`}
        />
        <Stat label="Status" value={prettyPhase(phase)} />
      </div>

      <AnchorTimeline
        traj={trajectory}
        onChange={setTrajectory}
        playT={playheadT}
        disabled={phase === "swinging" || phase === "countdown"}
      />

      <div
        className="relative border border-neutral-300 rounded-lg overflow-hidden bg-white touch-none select-none"
        style={{ aspectRatio: `${CANVAS_WIDTH} / ${CANVAS_HEIGHT}` }}
      >
        <canvas ref={canvasRef} className="w-full h-full block" />
      </div>

      {pastRuns.length > 0 && (
        <div className="text-sm bg-white border border-neutral-200 rounded-md px-3 py-2">
          <div className="font-medium mb-1">Past runs — left-peak height</div>
          <ul className="list-disc pl-5 space-y-0.5 text-neutral-700">
            {pastRuns.map((h, i) => (
              <li key={i}>
                Run {i + 1}: <span className="tabular-nums">{h.toFixed(2)} m</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="text-xs text-neutral-500">
        Reference (dashed line) = the weight&apos;s height at the moment of release. Heights above that line are
        positive; below are negative.
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border border-neutral-200 rounded-md px-3 py-2">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="text-base font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function prettyPhase(p: Phase): string {
  switch (p) {
    case "idle":
      return "Ready";
    case "countdown":
      return "Counting down";
    case "swinging":
      return "Swinging";
    case "done":
      return "Done";
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function AnchorTimeline({
  traj,
  onChange,
  playT,
  disabled,
}: {
  traj: TrajPoint[];
  onChange: (next: TrajPoint[]) => void;
  playT: number | null;
  disabled: boolean;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ id: number; isEndpoint: boolean } | null>(null);
  const nextIdRef = useRef<number>(
    Math.max(0, ...traj.map((p) => p.id)) + 1
  );

  const totalRangePx = ANCHOR_UP_PX + ANCHOR_DOWN_PX;

  const tToX = (t: number) =>
    TIMELINE_PAD + clamp(t, 0, 1) * TIMELINE_INNER_W;
  const offsetToY = (o: number) =>
    TIMELINE_INNER_TOP +
    ((clamp(o, -ANCHOR_UP_PX, ANCHOR_DOWN_PX) + ANCHOR_UP_PX) / totalRangePx) *
      TIMELINE_INNER_H;
  const xToT = (x: number) =>
    clamp((x - TIMELINE_PAD) / TIMELINE_INNER_W, 0, 1);
  const yToOffset = (y: number) =>
    clamp(
      ((y - TIMELINE_INNER_TOP) / TIMELINE_INNER_H) * totalRangePx -
        ANCHOR_UP_PX,
      -ANCHOR_UP_PX,
      ANCHOR_DOWN_PX
    );

  const localCoords = (e: React.PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * TIMELINE_W,
      y: ((e.clientY - rect.top) / rect.height) * TIMELINE_H,
    };
  };

  const onBgPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    const { x, y } = localCoords(e);
    const t = xToT(x);
    const offset = yToOffset(y);
    const id = nextIdRef.current++;
    const next = [...traj, { id, t, offset }].sort((a, b) => a.t - b.t);
    onChange(next);
    dragRef.current = { id, isEndpoint: false };
    try {
      svgRef.current!.setPointerCapture(e.pointerId);
    } catch {}
  };

  const onPointPointerDown = (p: TrajPoint, isEndpoint: boolean) => (
    e: React.PointerEvent
  ) => {
    if (disabled) return;
    e.stopPropagation();
    dragRef.current = { id: p.id, isEndpoint };
    try {
      svgRef.current!.setPointerCapture(e.pointerId);
    } catch {}
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { x, y } = localCoords(e);
    const next = traj
      .map((p) => {
        if (p.id !== drag.id) return p;
        return {
          ...p,
          t: drag.isEndpoint ? p.t : xToT(x),
          offset: yToOffset(y),
        };
      })
      .sort((a, b) => a.t - b.t);
    onChange(next);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      svgRef.current!.releasePointerCapture(e.pointerId);
    } catch {}
  };

  const onPointDoubleClick = (p: TrajPoint, isEndpoint: boolean) => (
    e: React.MouseEvent
  ) => {
    if (disabled || isEndpoint) return;
    e.stopPropagation();
    onChange(traj.filter((pt) => pt.id !== p.id));
  };

  // Trace the smoothed curve by sampling sampleTrajectory — keeps the rendered
  // line identical to what actually drives the anchor at playback.
  const SMOOTH_SAMPLES = 160;
  const t0 = traj[0]?.t ?? 0;
  const t1 = traj[traj.length - 1]?.t ?? 1;
  const polyPoints =
    traj.length < 2
      ? traj
          .map(
            (p) => `${tToX(p.t).toFixed(2)},${offsetToY(p.offset).toFixed(2)}`
          )
          .join(" ")
      : Array.from({ length: SMOOTH_SAMPLES + 1 }, (_, i) => {
          const tt = t0 + (i / SMOOTH_SAMPLES) * (t1 - t0);
          return `${tToX(tt).toFixed(2)},${offsetToY(
            sampleTrajectory(traj, tt)
          ).toFixed(2)}`;
        }).join(" ");

  const homeY = TIMELINE_HOME_Y;
  const innerLeft = TIMELINE_PAD;
  const innerRight = TIMELINE_PAD + TIMELINE_INNER_W;
  const innerBottom = TIMELINE_INNER_TOP + TIMELINE_INNER_H;

  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="font-medium text-neutral-700">
          Anchor trajectory — x: time (0–{TRAJECTORY_DURATION_S.toFixed(1)}s of the right→left leg). y: anchor
          offset from home.
        </span>
        <button
          className="text-xs text-neutral-600 underline disabled:opacity-40"
          onClick={() => {
            nextIdRef.current = 3;
            onChange(defaultTrajectory());
          }}
          disabled={disabled}
        >
          Reset shape
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs mb-2">
        <span className="text-neutral-500">Presets:</span>
        {TRAJECTORY_PRESETS.map((preset) => (
          <button
            key={preset.label}
            className="px-2 py-0.5 rounded border border-neutral-300 bg-white hover:bg-neutral-100 disabled:opacity-40 disabled:hover:bg-white"
            onClick={() => {
              const pts = preset.build();
              nextIdRef.current = Math.max(0, ...pts.map((p) => p.id)) + 1;
              onChange(pts);
            }}
            disabled={disabled}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${TIMELINE_W} ${TIMELINE_H}`}
        className={`w-full block bg-white border border-neutral-300 rounded-md ${
          disabled ? "opacity-60 cursor-not-allowed" : "cursor-crosshair"
        } touch-none select-none`}
        style={{ aspectRatio: `${TIMELINE_W} / ${TIMELINE_H}` }}
        onPointerDown={onBgPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <rect
          x={innerLeft}
          y={TIMELINE_INNER_TOP}
          width={TIMELINE_INNER_W}
          height={TIMELINE_INNER_H}
          fill="#f9fafb"
          stroke="#e5e7eb"
        />
        {/* Home line (dashed) */}
        <line
          x1={innerLeft}
          x2={innerRight}
          y1={homeY}
          y2={homeY}
          stroke="#9ca3af"
          strokeDasharray="4 4"
        />
        {/* Axis labels */}
        <text x={innerLeft + 4} y={TIMELINE_INNER_TOP + 11} fontSize="10" fill="#6b7280">
          ↑ {ANCHOR_UP_M.toFixed(1)} m
        </text>
        <text x={innerLeft + 4} y={innerBottom - 3} fontSize="10" fill="#6b7280">
          ↓ {ANCHOR_DOWN_M.toFixed(1)} m
        </text>
        <text x={innerRight - 38} y={homeY - 4} fontSize="10" fill="#9ca3af">
          home
        </text>
        <text x={innerLeft} y={TIMELINE_H - 3} fontSize="10" fill="#6b7280">
          0s
        </text>
        <text x={innerRight - 28} y={TIMELINE_H - 3} fontSize="10" fill="#6b7280">
          {TRAJECTORY_DURATION_S.toFixed(1)}s
        </text>
        {/* Playhead */}
        {playT !== null && (
          <line
            x1={tToX(playT)}
            x2={tToX(playT)}
            y1={TIMELINE_INNER_TOP}
            y2={innerBottom}
            stroke="#10b981"
            strokeWidth="1.5"
          />
        )}
        {/* Trajectory polyline */}
        <polyline
          points={polyPoints}
          fill="none"
          stroke="#2563eb"
          strokeWidth="2"
        />
        {/* Control points */}
        {traj.map((p, i) => {
          const isEndpoint = i === 0 || i === traj.length - 1;
          return (
            <circle
              key={p.id}
              cx={tToX(p.t)}
              cy={offsetToY(p.offset)}
              r={isEndpoint ? 6 : 7}
              fill={isEndpoint ? "#60a5fa" : "#2563eb"}
              stroke="#1e40af"
              strokeWidth="1.5"
              style={{ cursor: disabled ? "not-allowed" : "grab" }}
              onPointerDown={onPointPointerDown(p, isEndpoint)}
              onDoubleClick={onPointDoubleClick(p, isEndpoint)}
            />
          );
        })}
      </svg>
      <div className="text-[11px] text-neutral-500 mt-1">
        Click inside to add a control point, drag to shape, double-click an interior point to remove it. The
        trajectory only drives the anchor during the first half of the swing (right → left peak); after that, the
        anchor holds at its last position.
      </div>
    </div>
  );
}
