# Pendulum Simulator

A pendulum physics simulator built with Next.js 14. Drop a weight on a string and drag the anchor up/down along a vertical bar while it swings to change the pendulum's path.

## Features

- Go / Reset controls with a 3-2-1 countdown before release
- Draggable anchor along a vertical bar — before or during the swing
- Rigid-rod physics via Position-Based Dynamics (stable with a moving pivot)
- Subtle green line records the weight's path for one full cycle (right → left → right)
- Live height readout (relative to the release line), running max height, and a marker + label at the left-side peak
- Past-run log of left-peak heights for comparison

## Development

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

## Deployment

Deploys as-is on [Vercel](https://vercel.com) — push to GitHub, import the repo in Vercel, no extra configuration needed.
