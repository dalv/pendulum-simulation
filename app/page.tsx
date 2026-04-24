import PendulumSimulator from "./PendulumSimulator";

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center py-6 px-4">
      <div className="w-full max-w-4xl">
        <header className="mb-4">
          <h1 className="text-2xl font-semibold">Pendulum Simulator</h1>
          <p className="text-sm text-neutral-600 mt-1">
            Press <span className="font-medium">Go</span> to drop the weight after a 3-2-1 countdown. Shape the
            anchor&apos;s motion on the timeline below to change how the pendulum swings.
          </p>
        </header>
        <PendulumSimulator />
      </div>
    </main>
  );
}
