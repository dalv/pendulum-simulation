import PendulumSimulator from "./PendulumSimulator";

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center py-3 sm:py-6 px-3 sm:px-4">
      <div className="w-full max-w-4xl">
        <header className="mb-2 sm:mb-3">
          <h1 className="text-xl sm:text-2xl font-semibold">Pendulum Simulator</h1>
        </header>
        <PendulumSimulator />
      </div>
    </main>
  );
}
