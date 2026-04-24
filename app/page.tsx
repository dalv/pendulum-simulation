import PendulumSimulator from "./PendulumSimulator";

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center py-6 px-4">
      <div className="w-full max-w-4xl">
        <header className="mb-4">
          <h1 className="text-2xl font-semibold">Pendulum Simulator</h1>
          <p className="text-sm text-neutral-600 mt-1">
            Press <span className="font-medium">Go</span> to drop the weight after a 3-2-1 countdown. Drag the black
            anchor up and down along the blue bar while the pendulum swings to change its path.
          </p>
        </header>
        <PendulumSimulator />
      </div>
    </main>
  );
}
