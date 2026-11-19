use std::time::{Duration, Instant};

pub const KONAMI_TIMEOUT: Duration = Duration::from_secs(2);
pub const LOGO_CHARGE_HOLD: Duration = Duration::from_millis(600);
pub const CELEBRATE_100_DURATION: Duration = Duration::from_millis(600);
pub const LOGO_BLOCK_COUNT: usize = 7;

/// Discrete keys considered by the Konami code detector.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KonamiKey {
    Up,
    Down,
    Left,
    Right,
    B,
    A,
    Other,
}

impl KonamiKey {
    pub fn from_key_name(raw: &str) -> Self {
        match raw.to_ascii_lowercase().as_str() {
            "up" | "arrowup" => KonamiKey::Up,
            "down" | "arrowdown" => KonamiKey::Down,
            "left" | "arrowleft" => KonamiKey::Left,
            "right" | "arrowright" => KonamiKey::Right,
            "b" => KonamiKey::B,
            "a" => KonamiKey::A,
            _ => KonamiKey::Other,
        }
    }
}

/// Stateful detector for `↑ ↑ ↓ ↓ ← → ← → B A` with a 2-second inter-key timeout.
#[derive(Clone, Debug)]
pub struct KonamiDetector {
    progress: usize,
    last_key_at: Option<Instant>,
}

impl Default for KonamiDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl KonamiDetector {
    const SEQUENCE: [KonamiKey; 10] = [
        KonamiKey::Up,
        KonamiKey::Up,
        KonamiKey::Down,
        KonamiKey::Down,
        KonamiKey::Left,
        KonamiKey::Right,
        KonamiKey::Left,
        KonamiKey::Right,
        KonamiKey::B,
        KonamiKey::A,
    ];

    pub fn new() -> Self {
        Self {
            progress: 0,
            last_key_at: None,
        }
    }

    pub fn reset(&mut self) {
        self.progress = 0;
        self.last_key_at = None;
    }

    pub fn progress(&self) -> usize {
        self.progress
    }

    /// Feed a non-repeat, non-modifier key event when no text input is focused.
    /// Returns `true` when the complete 10-key sequence finishes within the 2s inter-key budget.
    pub fn push(&mut self, key: KonamiKey, now: Instant) -> bool {
        if let Some(prev) = self.last_key_at
            && now.saturating_duration_since(prev) > KONAMI_TIMEOUT
        {
            self.progress = 0;
        }
        self.last_key_at = Some(now);

        if Self::SEQUENCE[self.progress] == key {
            self.progress += 1;
            if self.progress == Self::SEQUENCE.len() {
                self.progress = 0;
                self.last_key_at = None;
                return true;
            }
            return false;
        }

        // Preserve valid prefix overlaps (e.g. ↑ ↑ ↑ keeps progress at 2).
        self.progress = match (self.progress, key) {
            (2, KonamiKey::Up) => 2,
            (_, KonamiKey::Up) => 1,
            _ => 0,
        };
        if self.progress == 0 {
            self.last_key_at = None;
        }
        false
    }
}

/// Outcome returned when observing the active store's memory count.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Celebrate100Outcome {
    None,
    PersistOnly,
    AnimateAndPersist,
}

/// Tracks one-time transition celebration when a store crosses from `< 100` to `>= 100` in-session.
#[derive(Clone, Debug)]
pub struct Celebrate100Tracker {
    celebrated: bool,
    last_observed_count: Option<usize>,
}

impl Celebrate100Tracker {
    pub fn new(already_celebrated: bool) -> Self {
        Self {
            celebrated: already_celebrated,
            last_observed_count: None,
        }
    }

    pub fn is_celebrated(&self) -> bool {
        self.celebrated
    }

    /// Record a freshly queried total memory count.
    /// - Initial load never animates; if already `>= 100`, marks `celebrated_100` quietly.
    /// - In-session crossing from `< 100` to `>= 100` animates (unless `--no-fun`) and persists `celebrated_100`.
    pub fn observe_count(&mut self, new_count: usize, no_fun: bool) -> Celebrate100Outcome {
        let Some(prev) = self.last_observed_count else {
            self.last_observed_count = Some(new_count);
            if new_count >= 100 && !self.celebrated {
                self.celebrated = true;
                return Celebrate100Outcome::PersistOnly;
            }
            return Celebrate100Outcome::None;
        };

        self.last_observed_count = Some(new_count);
        if !self.celebrated && prev < 100 && new_count >= 100 {
            self.celebrated = true;
            if no_fun {
                return Celebrate100Outcome::PersistOnly;
            }
            return Celebrate100Outcome::AnimateAndPersist;
        }
        Celebrate100Outcome::None
    }
}

pub const MOMO_IDLE_THRESHOLD: Duration = Duration::from_secs(210);
pub const MOMO_PEEK_COOLDOWN: Duration = Duration::from_secs(600);
pub const MOMO_PEEK_DURATION: Duration = Duration::from_millis(2100);

/// Animation sample produced by [`MomoPeekController`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PeekSample {
    pub animating: bool,
    pub slide_px: f32,
    pub eye_open: f32,
}

impl Default for PeekSample {
    fn default() -> Self {
        Self {
            animating: false,
            slide_px: 0.0,
            eye_open: 1.0,
        }
    }
}

/// Manages footer Momo idle peek timing:
/// - Triggers after 3-6 minutes of window idle (default 3m30s), with no modal or onboarding open
/// - Slides in 8px from footer edge, blinks twice, retreats after ~2s
/// - Fires at most once per 10 minutes
/// - Completely disabled when `reduce_motion` or `--no-fun` is set
#[derive(Clone, Debug)]
pub struct MomoPeekController {
    idle_threshold: Duration,
    cooldown: Duration,
    last_activity_at: Instant,
    last_peek_at: Option<Instant>,
    active_since: Option<Instant>,
}

impl MomoPeekController {
    pub fn new(now: Instant) -> Self {
        Self {
            idle_threshold: MOMO_IDLE_THRESHOLD,
            cooldown: MOMO_PEEK_COOLDOWN,
            last_activity_at: now,
            last_peek_at: None,
            active_since: None,
        }
    }

    pub fn record_activity(&mut self, now: Instant) {
        self.last_activity_at = now;
    }

    pub fn is_peeking(&self) -> bool {
        self.active_since.is_some()
    }

    pub fn trigger_for_preview(&mut self, now: Instant) {
        self.active_since = Some(now);
        self.last_peek_at = Some(now);
    }

    pub fn should_start_peek(
        &self,
        now: Instant,
        suppressed_by_overlay: bool,
        reduce_motion: bool,
        no_fun: bool,
    ) -> bool {
        if self.active_since.is_some() || suppressed_by_overlay || reduce_motion || no_fun {
            return false;
        }
        if now.saturating_duration_since(self.last_activity_at) < self.idle_threshold {
            return false;
        }
        self.last_peek_at
            .is_none_or(|prev| now.saturating_duration_since(prev) >= self.cooldown)
    }

    /// Evaluate the current peek transform + double-blink state.
    pub fn poll(
        &mut self,
        now: Instant,
        suppressed_by_overlay: bool,
        reduce_motion: bool,
        no_fun: bool,
    ) -> PeekSample {
        if suppressed_by_overlay || reduce_motion || no_fun {
            self.active_since = None;
            return PeekSample::default();
        }
        if self.active_since.is_none()
            && self.should_start_peek(now, suppressed_by_overlay, reduce_motion, no_fun)
        {
            self.active_since = Some(now);
            self.last_peek_at = Some(now);
        }

        let Some(started) = self.active_since else {
            return PeekSample::default();
        };

        let t = now.saturating_duration_since(started).as_secs_f32();
        let total = MOMO_PEEK_DURATION.as_secs_f32();
        if t >= total {
            self.active_since = None;
            return PeekSample::default();
        }

        // Smooth 0 -> 8px transform in (0..0.24s), hold (~1.6s), retreat 8px -> 0px (1.84..2.1s).
        let slide_px = if t < 0.24 {
            let u = t / 0.24;
            let ease = 1.0 - (1.0 - u).powi(3);
            8.0 * ease
        } else if t > total - 0.26 {
            let u = ((t - (total - 0.26)) / 0.26).clamp(0.0, 1.0);
            let ease = 1.0 - u.powi(2);
            8.0 * ease
        } else {
            8.0
        };

        // Two discrete blinks inside the ~1.6s visible hold.
        let eye_open = if (0.50..=0.64).contains(&t) || (1.08..=1.22).contains(&t) {
            0.08
        } else {
            1.0
        };

        PeekSample {
            animating: true,
            slide_px,
            eye_open,
        }
    }
}

/// Interactive click poses for Momo (`idle -> peek -> squash -> happy-eyes -> idle`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MomoPose {
    #[default]
    Idle,
    Peek,
    Squash,
    HappyEyes,
}

impl MomoPose {
    pub fn next(self) -> Self {
        match self {
            MomoPose::Idle => MomoPose::Peek,
            MomoPose::Peek => MomoPose::Squash,
            MomoPose::Squash => MomoPose::HappyEyes,
            MomoPose::HappyEyes => MomoPose::Idle,
        }
    }
}

/// Geometric layout & physics state for one block cell in the 7-block sidebar logo.
#[derive(Clone, Copy, Debug)]
pub struct LogoBlock {
    pub rest_x: f32,
    pub rest_y: f32,
    pub w: f32,
    pub h: f32,
    pub offset_x: f32,
    pub offset_y: f32,
    pub vel_x: f32,
    pub vel_y: f32,
    pub start_x: f32,
    pub start_y: f32,
    pub crack_tilt_deg: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LogoPhase {
    Intact,
    Pressed,
    Charging { progress: f32 },
    Falling,
    SettledFallen,
    Reassembling { t: f32 },
    PeekSettled,
}

/// Pure physics & state machine for the breakable sidebar logo (7 block cells).
#[derive(Clone, Debug)]
pub struct LogoPhysics {
    pub blocks: [LogoBlock; LOGO_BLOCK_COUNT],
    pub phase: LogoPhase,
    pub press_started_at: Option<Instant>,
    pub momo_peek_amount: f32,
    pub crack_level: f32,
    pub floor_height: f32,
}

impl Default for LogoPhysics {
    fn default() -> Self {
        Self::new()
    }
}

impl LogoPhysics {
    pub fn new() -> Self {
        // Architectural 7-cell 'M' mark inside 28x20 canvas.
        let coords = [
            (0.0, 0.0, 6.0, 9.0),
            (0.0, 10.5, 6.0, 9.0),
            (7.5, 2.5, 5.5, 6.0),
            (11.5, 7.0, 5.0, 6.0),
            (15.0, 2.5, 5.5, 6.0),
            (22.0, 0.0, 6.0, 9.0),
            (22.0, 10.5, 6.0, 9.0),
        ];
        let mut idx = 0usize;
        let blocks = coords.map(|(x, y, w, h)| {
            let b = LogoBlock {
                rest_x: x,
                rest_y: y,
                w,
                h,
                offset_x: 0.0,
                offset_y: 0.0,
                vel_x: 0.0,
                vel_y: 0.0,
                start_x: 0.0,
                start_y: 0.0,
                crack_tilt_deg: ((idx as f32) - 3.0) * 6.0,
            };
            idx += 1;
            b
        });
        Self {
            blocks,
            phase: LogoPhase::Intact,
            press_started_at: None,
            momo_peek_amount: 0.0,
            crack_level: 0.0,
            floor_height: 36.0,
        }
    }

    pub fn is_animating(&self) -> bool {
        matches!(
            self.phase,
            LogoPhase::Charging { .. } | LogoPhase::Falling | LogoPhase::Reassembling { .. }
        )
    }

    pub fn start_press(&mut self, now: Instant) {
        self.press_started_at = Some(now);
        self.phase = LogoPhase::Pressed;
    }

    pub fn poll_charge(&mut self, now: Instant) -> bool {
        let Some(started) = self.press_started_at else {
            return false;
        };
        let elapsed = now.saturating_duration_since(started);
        if elapsed >= LOGO_CHARGE_HOLD {
            let extra = (elapsed - LOGO_CHARGE_HOLD).as_secs_f32().clamp(0.0, 0.4) / 0.4;
            let progress = (0.35 + extra * 0.65).clamp(0.0, 1.0);
            self.phase = LogoPhase::Charging { progress };
            return true;
        }
        false
    }

    pub fn release(&mut self, now: Instant, reduce_motion: bool) {
        let held = self
            .press_started_at
            .take()
            .is_some_and(|t| now.saturating_duration_since(t) >= LOGO_CHARGE_HOLD);

        if held {
            for b in &mut self.blocks {
                b.start_x = b.offset_x;
                b.start_y = b.offset_y;
                b.vel_x = 0.0;
                b.vel_y = 0.0;
            }
            self.crack_level = 0.0;
            if reduce_motion {
                for b in &mut self.blocks {
                    b.offset_x = 0.0;
                    b.offset_y = 0.0;
                }
                self.momo_peek_amount = 1.0;
                self.phase = LogoPhase::PeekSettled;
            } else {
                self.momo_peek_amount = 0.1;
                self.phase = LogoPhase::Reassembling { t: 0.0 };
            }
            return;
        }

        // Quick click -> crack + fall
        self.crack_level = 1.0;
        self.momo_peek_amount = 0.0;
        if reduce_motion {
            for (ix, b) in self.blocks.iter_mut().enumerate() {
                let floor_off = (self.floor_height - (b.rest_y + b.h)).max(0.0);
                b.offset_x = ((ix as f32) - 3.0) * 3.5;
                b.offset_y = floor_off;
                b.vel_x = 0.0;
                b.vel_y = 0.0;
            }
            self.phase = LogoPhase::SettledFallen;
        } else {
            let impulses = [-48.0_f32, -26.0, -14.0, 8.0, 22.0, 44.0, 30.0];
            for (ix, b) in self.blocks.iter_mut().enumerate() {
                b.vel_x = impulses[ix % impulses.len()];
                b.vel_y = -28.0 - (ix as f32 % 3.0) * 14.0;
            }
            self.phase = LogoPhase::Falling;
        }
    }

    /// Advance animation by `dt_secs`. Returns `true` if another frame should be scheduled.
    pub fn step(&mut self, dt_secs: f32) -> bool {
        let dt = dt_secs.clamp(0.001, 0.05);
        match self.phase {
            LogoPhase::Falling => {
                let mut moving = false;
                let gravity = 390.0_f32;
                for b in &mut self.blocks {
                    b.vel_y += gravity * dt;
                    b.offset_x = (b.offset_x + b.vel_x * dt).clamp(-14.0, 14.0);
                    b.offset_y += b.vel_y * dt;
                    let max_y = (self.floor_height - (b.rest_y + b.h)).max(0.0);
                    if b.offset_y >= max_y {
                        b.offset_y = max_y;
                        if b.vel_y.abs() > 24.0 {
                            b.vel_y = -b.vel_y * 0.28;
                            b.vel_x *= 0.55;
                            moving = true;
                        } else {
                            b.vel_y = 0.0;
                            b.vel_x *= 0.5;
                            if b.vel_x.abs() > 2.0 {
                                moving = true;
                            } else {
                                b.vel_x = 0.0;
                            }
                        }
                    } else {
                        moving = true;
                    }
                }
                if !moving {
                    self.phase = LogoPhase::SettledFallen;
                    return false;
                }
                true
            }
            LogoPhase::Reassembling { t } => {
                let next_t = (t + dt / 0.28).min(1.0);
                let ease = 1.0 - (1.0 - next_t).powi(3);
                for b in &mut self.blocks {
                    b.offset_x = b.start_x * (1.0 - ease);
                    b.offset_y = b.start_y * (1.0 - ease);
                }
                self.momo_peek_amount = ease;
                if next_t >= 1.0 {
                    for b in &mut self.blocks {
                        b.offset_x = 0.0;
                        b.offset_y = 0.0;
                    }
                    self.momo_peek_amount = 1.0;
                    self.phase = LogoPhase::PeekSettled;
                    return false;
                }
                self.phase = LogoPhase::Reassembling { t: next_t };
                true
            }
            LogoPhase::Charging { progress } => {
                let next = (progress + dt * 1.4).min(1.0);
                self.phase = LogoPhase::Charging { progress: next };
                true
            }
            LogoPhase::Intact
            | LogoPhase::Pressed
            | LogoPhase::SettledFallen
            | LogoPhase::PeekSettled => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn konami_sequence_matches_timeout_and_prefix_fallback() {
        let mut det = KonamiDetector::new();
        let t0 = Instant::now();
        let seq = [
            KonamiKey::Up,
            KonamiKey::Up,
            KonamiKey::Down,
            KonamiKey::Down,
            KonamiKey::Left,
            KonamiKey::Right,
            KonamiKey::Left,
            KonamiKey::Right,
            KonamiKey::B,
        ];
        for (ix, k) in seq.into_iter().enumerate() {
            assert!(
                !det.push(k, t0 + Duration::from_millis((ix as u64) * 150)),
                "should not fire before final A"
            );
        }
        assert!(det.push(KonamiKey::A, t0 + Duration::from_millis(1500)));
        assert_eq!(det.progress(), 0);

        // Inter-key gap > 2s resets sequence.
        assert!(!det.push(KonamiKey::Up, t0));
        assert!(!det.push(KonamiKey::Up, t0 + Duration::from_millis(200)));
        assert_eq!(det.progress(), 2);
        assert!(!det.push(KonamiKey::Down, t0 + Duration::from_secs(3)));
        assert_eq!(det.progress(), 0);
    }

    #[test]
    fn celebrate_100_only_fires_on_in_session_transition_and_once_per_install() {
        let mut t_already = Celebrate100Tracker::new(false);
        assert_eq!(
            t_already.observe_count(120, false),
            Celebrate100Outcome::PersistOnly
        );
        assert!(t_already.is_celebrated());
        assert_eq!(
            t_already.observe_count(125, false),
            Celebrate100Outcome::None
        );

        let mut t_cross = Celebrate100Tracker::new(false);
        assert_eq!(t_cross.observe_count(99, false), Celebrate100Outcome::None);
        assert_eq!(
            t_cross.observe_count(100, false),
            Celebrate100Outcome::AnimateAndPersist
        );
        assert!(t_cross.is_celebrated());
        assert_eq!(t_cross.observe_count(105, false), Celebrate100Outcome::None);

        let mut t_nofun = Celebrate100Tracker::new(false);
        assert_eq!(t_nofun.observe_count(99, true), Celebrate100Outcome::None);
        assert_eq!(
            t_nofun.observe_count(100, true),
            Celebrate100Outcome::PersistOnly
        );
    }

    #[test]
    fn logo_physics_stops_animating_when_settled_and_supports_hold_reassemble() {
        let mut phys = LogoPhysics::new();
        assert!(!phys.is_animating());

        let t0 = Instant::now();
        phys.start_press(t0);
        assert!(!phys.poll_charge(t0 + Duration::from_millis(300)));
        phys.release(t0 + Duration::from_millis(120), false);
        assert_eq!(phys.phase, LogoPhase::Falling);

        let mut steps = 0;
        while phys.step(0.016) {
            steps += 1;
            assert!(steps < 300, "logo fall must settle cleanly");
        }
        assert_eq!(phys.phase, LogoPhase::SettledFallen);
        assert!(!phys.is_animating());

        // Hold >= 600ms -> charge -> release -> reassemble with Momo peeking.
        let t1 = t0 + Duration::from_secs(2);
        phys.start_press(t1);
        assert!(phys.poll_charge(t1 + LOGO_CHARGE_HOLD));
        assert!(matches!(phys.phase, LogoPhase::Charging { .. }));
        phys.release(t1 + LOGO_CHARGE_HOLD, false);
        assert!(matches!(phys.phase, LogoPhase::Reassembling { .. }));

        steps = 0;
        while phys.step(0.016) {
            steps += 1;
            assert!(steps < 120, "logo reassemble must settle cleanly");
        }
        assert_eq!(phys.phase, LogoPhase::PeekSettled);
        assert!(phys.momo_peek_amount >= 1.0);
        assert!(!phys.is_animating());
    }

    #[test]
    fn momo_peek_respects_idle_cooldown_overlays_reduced_motion_and_no_fun() {
        let t0 = Instant::now();
        let mut ctrl = MomoPeekController::new(t0);

        // Before 3-6 min threshold: stays idle.
        assert!(!ctrl.should_start_peek(t0 + Duration::from_secs(120), false, false, false));
        assert!(
            !ctrl
                .poll(t0 + Duration::from_secs(120), false, false, false)
                .animating
        );

        // Modal/onboarding open, reduced motion, or --no-fun suppress peek.
        let after_idle = t0 + Duration::from_secs(220);
        assert!(!ctrl.should_start_peek(after_idle, true, false, false));
        assert!(!ctrl.should_start_peek(after_idle, false, true, false));
        assert!(!ctrl.should_start_peek(after_idle, false, false, true));

        // Clean idle fires peek: slides 8px, blinks twice, retreats by ~2.1s.
        let s_start = ctrl.poll(after_idle, false, false, false);
        assert!(s_start.animating);
        let s_hold = ctrl.poll(after_idle + Duration::from_millis(350), false, false, false);
        assert!(s_hold.animating);
        assert!((s_hold.slide_px - 8.0).abs() < 0.01);
        assert_eq!(s_hold.eye_open, 1.0);

        let blink1 = ctrl.poll(after_idle + Duration::from_millis(550), false, false, false);
        assert!(blink1.eye_open < 0.2);
        let blink2 = ctrl.poll(
            after_idle + Duration::from_millis(1140),
            false,
            false,
            false,
        );
        assert!(blink2.eye_open < 0.2);

        let finished = ctrl.poll(
            after_idle + Duration::from_millis(2200),
            false,
            false,
            false,
        );
        assert!(!finished.animating);
        assert_eq!(finished.slide_px, 0.0);

        // Within 10-minute cooldown: must not peek again even after 4 min idle.
        let within_cooldown = after_idle + Duration::from_secs(300);
        assert!(!ctrl.should_start_peek(within_cooldown, false, false, false));

        // After 10-minute cooldown (with idle time >= threshold): allowed again.
        let after_cooldown = after_idle + MOMO_PEEK_COOLDOWN + Duration::from_secs(10);
        assert!(ctrl.should_start_peek(after_cooldown, false, false, false));
    }
}
