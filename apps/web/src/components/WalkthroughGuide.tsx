"use client";

export type WalkthroughStep = 1 | 2 | 3 | 4 | 5 | 6;

const TIER1: { n: WalkthroughStep; title: string; hint: string }[] = [
  {
    n: 1,
    title: "Start patient episode",
    hint: "Create or select an interaction in the sidebar.",
  },
  {
    n: 2,
    title: "AI drafts follow-up SMS",
    hint: "Run AI care coordinator — review the proposal and trace.",
  },
  {
    n: 3,
    title: "You approve the send",
    hint: "Approve the proposal — one outbound SMS via the idempotent path.",
  },
  {
    n: 4,
    title: "Prove no duplicate sends",
    hint: "Fire 50 identical triggers — metrics should show one outbound row.",
  },
];

const TIER2: { n: WalkthroughStep; title: string; hint: string }[] = [
  {
    n: 5,
    title: "Patient confirms YES",
    hint: "Simulate inbound SMS — care ops supervisor routes to confirm; status badges flip.",
  },
  {
    n: 6,
    title: "Patient asks to reschedule",
    hint: "Inbound router classifies RESCHEDULE → outbound coordinator proposes SMS for your approval.",
  },
];

type WalkthroughGuideProps = {
  current: WalkthroughStep;
  completed: Set<number>;
  tier2Unlocked: boolean;
};

function StepChip({
  step,
  isCurrent,
  isDone,
  dimmed,
}: {
  step: (typeof TIER1)[number];
  isCurrent: boolean;
  isDone: boolean;
  dimmed?: boolean;
}) {
  return (
    <li
      className={`rounded-md border px-3 py-2 text-sm transition-opacity ${
        dimmed ? "opacity-50" : ""
      } ${
        isCurrent
          ? "border-primary bg-white shadow-sm"
          : isDone
            ? "border-emerald-200 bg-emerald-50/80"
            : "border-border bg-white/60"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
            isDone
              ? "bg-emerald-600 text-white"
              : isCurrent
                ? "bg-primary text-white"
                : "bg-slate-200 text-slate-600"
          }`}
        >
          {isDone ? "✓" : step.n}
        </span>
        <span className="font-medium leading-tight">{step.title}</span>
      </div>
    </li>
  );
}

export function WalkthroughGuide({ current, completed, tier2Unlocked }: WalkthroughGuideProps) {
  const allSteps = [...TIER1, ...TIER2];
  const active = allSteps.find((s) => s.n === current)!;

  return (
    <section className="card border-primary/20 bg-blue-50/40">
      <p className="text-xs font-medium uppercase tracking-wide text-primary">
        Guided invariant walkthrough · you are the care coordinator
      </p>
      <p className="mt-1 text-sm text-slate-700">
        A patient finished a voice visit. An AI care coordinator drafts a follow-up SMS — you
        approve it, prove duplicate sends cannot happen, then optionally continue into
        bidirectional orchestration.
      </p>

      <p className="mt-3 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        Tier 1 · 5-min pitch
      </p>
      <ol className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {TIER1.map((step) => (
          <StepChip
            key={step.n}
            step={step}
            isCurrent={step.n === current}
            isDone={completed.has(step.n)}
          />
        ))}
      </ol>

      {tier2Unlocked ? (
        <>
          <p className="mt-4 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Tier 2 · continue if time
          </p>
          <ol className="mt-2 grid gap-2 sm:grid-cols-2">
            {TIER2.map((step) => (
              <StepChip
                key={step.n}
                step={step}
                isCurrent={step.n === current}
                isDone={completed.has(step.n)}
              />
            ))}
          </ol>
        </>
      ) : (
        <p className="mt-4 rounded-md border border-dashed border-slate-300 bg-white/50 px-3 py-2 text-xs text-slate-500">
          Complete step 4 to unlock Tier 2 — patient YES confirmation and inbound reschedule
          routing via the care ops supervisor.
        </p>
      )}

      <p className="mt-3 text-xs text-slate-600">
        <span className="font-semibold">Step {current}:</span> {active.hint}
      </p>
    </section>
  );
}

export function deriveWalkthroughState(input: {
  hasThread: boolean;
  coordinatorStarted: boolean;
  coordinatorApproved: boolean;
  stormCompleted: boolean;
  patientConfirmed: boolean;
  inboundProposalReady: boolean;
}): { current: WalkthroughStep; completed: Set<number>; tier2Unlocked: boolean } {
  const completed = new Set<number>();
  if (input.hasThread) completed.add(1);
  if (input.coordinatorStarted) completed.add(2);
  if (input.coordinatorApproved) completed.add(3);
  if (input.stormCompleted) completed.add(4);
  if (input.patientConfirmed) completed.add(5);
  if (input.inboundProposalReady) completed.add(6);

  const tier2Unlocked = input.stormCompleted;

  if (!input.hasThread) return { current: 1, completed, tier2Unlocked };
  if (!input.coordinatorStarted) return { current: 2, completed, tier2Unlocked };
  if (!input.coordinatorApproved) return { current: 3, completed, tier2Unlocked };
  if (!input.stormCompleted) return { current: 4, completed, tier2Unlocked };
  if (!input.patientConfirmed) return { current: 5, completed, tier2Unlocked };
  if (!input.inboundProposalReady) return { current: 6, completed, tier2Unlocked };
  return { current: 6, completed, tier2Unlocked };
}
