import looperRef from "../assets/looper-landing-ref.png";

export default function LooperLandingPage() {
  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-[#0E1710] text-white">
      {/* Background image */}
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat"
        style={{ backgroundImage: `url(${looperRef})` }}
      />

      {/* Slight dark overlay */}
      <div className="absolute inset-0 bg-black/10" />

      {/* Bottom panels */}
      <div className="relative z-10 flex min-h-screen items-end justify-center pb-10 px-6">
        <div className="grid w-full max-w-[1200px] grid-cols-2 gap-6">

          {/* LEFT: New Session */}
          <div className="rounded-xl border border-[#314233] bg-[#142118]/70 p-6">
            <h2 className="text-lg font-semibold text-[#F2E7C7]">
              New Session
            </h2>

            <div className="mt-4 space-y-4">
              {/* Choose Club */}
              <button className="w-full h-[60px] rounded-lg border border-[#314233] bg-[#172419] flex items-center justify-between px-4">
                <span>Choose Club</span>
                <span className="text-[#D4B15A]">›</span>
              </button>

              {/* Start (gold emphasis) */}
              <button className="w-full h-[60px] rounded-lg border border-[#D4B15A] bg-[#D4B15A] text-black flex items-center justify-between px-4">
                <span className="font-semibold">Start</span>
                <span>›</span>
              </button>
            </div>
          </div>

          {/* RIGHT: Manage Data */}
          <div className="rounded-xl border border-[#314233] bg-[#142118]/70 p-6">
            <h2 className="text-lg font-semibold text-[#F2E7C7]">
              Manage Data
            </h2>

            <div className="mt-4">
              <button className="w-full h-[60px] rounded-lg border border-[#314233] bg-[#172419] flex items-center justify-between px-4">
                <span>Open Data</span>
                <span className="text-[#D4B15A]">›</span>
              </button>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}