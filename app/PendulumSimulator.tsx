"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 560;
const PX_PER_METER = 150;
const GRAVITY = 9.81 * PX_PER_METER;
const STRING_LENGTH = 200;
const BAR_X = 350;
const BAR_TOP = 60;
const BAR_BOTTOM = CANVAS_HEIGHT - 60;
const ANCHOR_MIN_Y = BAR_TOP + 8;
const ANCHOR_MAX_Y = BAR_BOTTOM - 8;
const ANCHOR_INIT_Y = CANVAS_HEIGHT / 2;
const ANCHOR_RADIUS = 12;
const WEIGHT_RADIUS = 16;
const MAX_ANCHOR_SPEED = 1800;
const VX_THRESHOLD = 80;
const DAMPING_PER_STEP = 0.9998;

type Phase = "idle" | "countdown" | "swinging" | "done";

interface Vec2 {
  x: number;
  y: number;
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
  dragging: boolean;
  pointerOffsetY: number;
  movedLeft: boolean;
  movedRight: boolean;
  leftmostX: number;
  leftmostPos: Vec2 | null;
  leftPeakCommitted: boolean;
  leftPeakHeightM: number | null;
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
    dragging: false,
    pointerOffsetY: 0,
    movedLeft: false,
    movedRight: false,
    leftmostX: Infinity,
    leftmostPos: null,
    leftPeakCommitted: false,
    leftPeakHeightM: null,
  };
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

  const clearTimers = () => {
    timersRef.current.forEach((id) => window.clearTimeout(id));
    timersRef.current = [];
  };

  const reset = useCallback(() => {
    clearTimers();
    const prevAnchor = simRef.current.anchor;
    const fresh = makeInitialSim();
    // Keep anchor where the user last placed it, per the spec:
    // "the red weight resets to being directly to the right of the black anchor point".
    fresh.anchor = { x: BAR_X, y: prevAnchor.y };
    fresh.anchorTargetY = prevAnchor.y;
    fresh.weight = { x: BAR_X + STRING_LENGTH, y: prevAnchor.y };
    fresh.referenceY = prevAnchor.y;
    simRef.current = fresh;
    setPhase("idle");
    setCountdown(0);
    setCurrentHeight(0);
    setMaxHeight(0);
    setLeftPeakHeight(null);
  }, []);

  const go = useCallback(() => {
    reset();
    setPhase("countdown");
    simRef.current.phase = "countdown";
    setCountdown(3);
    timersRef.current.push(window.setTimeout(() => setCountdown(2), 1000));
    timersRef.current.push(window.setTimeout(() => setCountdown(1), 2000));
    timersRef.current.push(
      window.setTimeout(() => {
        setCountdown(0);
        const s = simRef.current;
        s.phase = "swinging";
        s.referenceY = s.weight.y;
        setPhase("swinging");
      }, 3000)
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

    if (s.phase === "swinging") {
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

      // Height tracking
      const heightPx = s.referenceY - s.weight.y;
      s.currentHeightM = heightPx / PX_PER_METER;
      if (s.currentHeightM > s.maxHeightM) s.maxHeightM = s.currentHeightM;

      // Leftmost-x tracking (for peak marker)
      if (s.weight.x < s.leftmostX) {
        s.leftmostX = s.weight.x;
        s.leftmostPos = { x: s.weight.x, y: s.weight.y };
      }

      // Phase detection via x-velocity
      const vx = s.weightVel.x;
      if (!s.leftPeakCommitted) {
        if (vx < -VX_THRESHOLD) s.movedLeft = true;
        if (s.movedLeft && vx > 0) {
          s.leftPeakCommitted = true;
          if (s.leftmostPos) {
            s.leftPeakHeightM = (s.referenceY - s.leftmostPos.y) / PX_PER_METER;
          }
        }
      } else {
        if (vx > VX_THRESHOLD) s.movedRight = true;
        if (s.movedRight && vx <= 0) {
          s.phase = "done";
        }
      }

      // Record path
      s.frameCount++;
      if (s.frameCount % 2 === 0) {
        s.path.push({ x: s.weight.x, y: s.weight.y });
        if (s.path.length > 6000) s.path.shift();
      }
    } else {
      // Keep weight pinned to the right of anchor while idle / countdown / done
      if (s.phase !== "done") {
        s.weight.x = s.anchor.x + STRING_LENGTH;
        s.weight.y = s.anchor.y;
        s.weightVel.x = 0;
        s.weightVel.y = 0;
        s.referenceY = s.anchor.y;
      }
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

    // Blue vertical bar
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 10;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(BAR_X, BAR_TOP);
    ctx.lineTo(BAR_X, BAR_BOTTOM);
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
    if (s.leftPeakCommitted && s.leftmostPos) {
      ctx.fillStyle = "#10b981";
      ctx.strokeStyle = "#047857";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s.leftmostPos.x, s.leftmostPos.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      const label = `${(s.leftPeakHeightM ?? 0).toFixed(2)} m`;
      ctx.font = "600 13px ui-sans-serif, system-ui, sans-serif";
      const tx = s.leftmostPos.x;
      const ty = s.leftmostPos.y - 14;
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
    if (s.dragging) {
      ctx.strokeStyle = "#60a5fa";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

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

  const localCoords = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * CANVAS_WIDTH,
      y: ((e.clientY - rect.top) / rect.height) * CANVAS_HEIGHT,
    };
  };

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = localCoords(e);
    const s = simRef.current;
    const onAnchor = Math.hypot(x - s.anchor.x, y - s.anchor.y) < ANCHOR_RADIUS * 2.5;
    const onBar = Math.abs(x - BAR_X) < 18 && y >= BAR_TOP && y <= BAR_BOTTOM;
    if (onAnchor || onBar) {
      s.dragging = true;
      s.pointerOffsetY = onAnchor ? s.anchor.y - y : 0;
      if (!onAnchor && onBar) {
        s.anchorTargetY = clamp(y, ANCHOR_MIN_Y, ANCHOR_MAX_Y);
      }
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = simRef.current;
    if (!s.dragging) return;
    const { y } = localCoords(e);
    s.anchorTargetY = clamp(y + s.pointerOffsetY, ANCHOR_MIN_Y, ANCHOR_MAX_Y);
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = simRef.current;
    s.dragging = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
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
          Tip: drag the black anchor along the blue bar while swinging.
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

      <div
        className="relative border border-neutral-300 rounded-lg overflow-hidden bg-white touch-none select-none"
        style={{ aspectRatio: `${CANVAS_WIDTH} / ${CANVAS_HEIGHT}` }}
      >
        <canvas
          ref={canvasRef}
          className="w-full h-full block cursor-grab active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
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
