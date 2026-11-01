# Task 2a — Kimi K3.1 Pro: one new educational game mode for OpenPath

**Model:** `zenmux/moonshotai/kimi-k3.1-pro` on ZenMux (1,048,576-token context). A
`kimi-k3.1-pro-highspeed` variant also exists on the same route if you need faster turns.
**Repo:** `C:\Users\marki\openpath`
**Branch:** `feat/game-mode-streak-siege` — do not commit to main.

---

You are adding **one complete, polished, playable game mode** to OpenPath, a local-first gamified
learning platform (React 19, TypeScript 7, Vite 8, Tailwind 4, Fastify + SQLite, `ts-fsrs` spaced
repetition). Quality of finish matters more than breadth: one mode that feels finished beats three
that don't.

---

## 1. Read the existing game first (do this before writing anything)

The platform already has exactly one game mode — **Race** — a live multiplayer room. Study it
completely; your mode must match its level of finish and its conventions:

```
client/src/pages/race/RaceHost.tsx      (10.8 KB — host creates a room)
client/src/pages/race/RaceJoin.tsx      (2.6 KB)
client/src/pages/race/RacePlay.tsx      (18.0 KB — the play loop)
client/src/pages/race/use-race-room.ts  (8.2 KB — WebSocket hook)
client/src/pages/race/race-format.ts    (1.1 KB — shared types/formatting)
```

Also read:
- `client/src/pages/student/Flashcards.tsx` — spaced repetition via `ts-fsrs`
- `client/src/pages/student/QuizPlayer.tsx` — single-player quiz loop
- `client/src/store/*`, `client/src/lib/*` — state and API helpers
- `server/` — routes and schema, so you use the real API, not mock data
- `CLAUDE.md` / `README.md` if present, for coding conventions

**Do not invent a parallel data layer.** Reuse the existing quiz/question types, the existing
store, and the existing API endpoints.

---

## 2. The mode to build: **Streak Siege** (single-player, timed)

A solo, session-based mode built on spaced repetition. Rationale: it reuses `ts-fsrs`, needs no
multiplayer infrastructure, and gives the app a game you can play alone — which Race cannot.

Requirements:

- **Core loop:** questions drawn from the student's due/weak cards via `ts-fsrs` scheduling.
  Correct answer extends the streak and the clock; wrong answer breaks the streak and costs time.
- **Difficulty ramp:** later questions get less time, so the run has a natural arc and a score that
  means something.
- **End condition:** timer expiry or all questions exhausted → results screen.
- **Results:** score, longest streak, accuracy, and **what got scheduled next** (show the SR effect —
  this is what makes it *educational* rather than a quiz-with-a-timer).
- **Persistence:** record the run so it integrates with the existing leaderboard/XP/badges systems.
  Find how Race awards XP and follow the same path.
- **Accessibility:** full keyboard play (1-4 to answer, Enter to advance), visible focus states,
  and `prefers-reduced-motion` respected for any animation.
- **Mobile:** must be playable at 375px width without horizontal scroll.

Visual language: match the existing dark, restrained aesthetic. Use `framer-motion` (already a
dependency), `lucide-react`, and `canvas-confetti` for the streak milestones. Do not add any new
dependency.

---

## 3. Hard constraints

1. **No new npm dependencies.** Everything you need is already installed.
2. **No changes to existing behaviour.** Add routes/pages; do not refactor Race, QuizPlayer, or
   shared components beyond additive, non-breaking props. If you believe a shared change is
   required, explain why in your report instead of doing it silently.
3. **TypeScript strict.** No `any` in new code, no non-null assertions to silence the compiler.
4. **Server changes only if unavoidable** (e.g. a new table for run history). If you add one, write
   the migration in the existing style and say so clearly in the report.
5. **Keep files reviewable.** No 1000-line component; split into small files under
   `client/src/pages/streak/` mirroring the `race/` directory shape.

---

## 4. Acceptance tests (all must pass — paste the output)

```
pnpm typecheck      # tsc, both projects
pnpm lint           # oxlint --type-aware
node scripts/verify-features.mjs
node scripts/smoke-test.mjs
pnpm build
```

Then **actually play it**: `pnpm dev`, log in as the seeded student
(`grace.hopper@openpath.dev` / `learn1234`), play one full run from start to results, and confirm
the score is recorded. Report what you observed, not just that it compiles.

---

## 5. Report format

- The route(s) added and how a user reaches the mode.
- A short description of the game loop and why the SR integration is educational.
- Evidence: the five commands above, plus a screenshot or a truthful description of the played run.
- What you deliberately left out of scope, and the file/line where a future contributor would add it.
- Anything that made you fight the existing codebase — that is useful feedback.
