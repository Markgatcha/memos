//! Shared motion tokens, easing functions, color interpolation, and reduced-motion detection.

use gpui::{Hsla, hsla};

/// Quick UI feedback: hover states, active press, toggle pills, tooltip fade.
pub const DURATION_FAST_MS: u64 = 120;
/// Standard transitions: panel/drawer reveal, list filter popover, tab underline.
pub const DURATION_NORMAL_MS: u64 = 180;
/// Slower structural motion: onboarding steps, Momo peek slide, Fit-view glide.
pub const DURATION_SMOOTH_MS: u64 = 240;

/// Cubic ease-out (`1 - (1 - t)^3`), clamped to `[0.0, 1.0]`.
#[inline]
pub fn ease_out_cubic(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    let inv = 1.0 - t;
    1.0 - inv * inv * inv
}

/// Quadratic ease-out (`1 - (1 - t)^2`), clamped to `[0.0, 1.0]`.
#[inline]
pub fn ease_out_quad(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    let inv = 1.0 - t;
    1.0 - inv * inv
}

/// Linearly interpolate between `a` and `b` with `t` clamped to `[0.0, 1.0]`.
#[inline]
pub fn lerp_f32(a: f32, b: f32, t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    a + (b - a) * t
}

/// Interpolate two `Hsla` colors via shortest hue arc, clamped to `[0.0, 1.0]`.
pub fn lerp_hsla(a: Hsla, b: Hsla, t: f32) -> Hsla {
    let t = t.clamp(0.0, 1.0);
    let mut dh = b.h - a.h;
    if dh > 0.5 {
        dh -= 1.0;
    } else if dh < -0.5 {
        dh += 1.0;
    }
    let h = (a.h + dh * t).rem_euclid(1.0);
    hsla(
        h,
        lerp_f32(a.s, b.s, t),
        lerp_f32(a.l, b.l, t),
        lerp_f32(a.a, b.a, t),
    )
}

/// Returns true when decorative animations should be suppressed (`--no-fun` or OS preference).
pub fn prefers_reduced_motion(no_fun: bool) -> bool {
    if no_fun {
        return true;
    }
    if matches!(
        std::env::var("MEMOS_REDUCED_MOTION").as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    ) {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        if !windows_client_area_animations_enabled() {
            return true;
        }
    }
    #[cfg(target_os = "macos")]
    {
        if macos_reduce_motion_enabled() {
            return true;
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if linux_reduce_motion_enabled() {
            return true;
        }
    }
    false
}

#[cfg(target_os = "macos")]
fn macos_reduce_motion_enabled() -> bool {
    static CACHED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CACHED.get_or_init(|| {
        std::process::Command::new("defaults")
            .args(["read", "com.apple.universalaccess", "reduceMotion"])
            .output()
            .ok()
            .filter(|out| out.status.success())
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .is_some_and(|val| parse_bool_flag(&val))
    })
}

#[cfg(all(unix, not(target_os = "macos")))]
fn linux_reduce_motion_enabled() -> bool {
    std::env::var("GTK_ENABLE_ANIMATIONS")
        .ok()
        .is_some_and(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "0" | "false" | "no"))
}

#[cfg(any(target_os = "macos", test))]
fn parse_bool_flag(raw: &str) -> bool {
    matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes"
    )
}

#[cfg(target_os = "windows")]
fn windows_client_area_animations_enabled() -> bool {
    const SPI_GETCLIENTAREAANIMATION: u32 = 0x1042;
    #[link(name = "user32")]
    unsafe extern "system" {
        fn SystemParametersInfoW(
            uiAction: u32,
            uiParam: u32,
            pvParam: *mut std::ffi::c_void,
            fWinIni: u32,
        ) -> i32;
    }
    let mut enabled: i32 = 1;
    // SAFETY: `enabled` is a valid stack i32 aligned pointer expecting BOOL output.
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            (&mut enabled as *mut i32).cast(),
            0,
        )
    };
    if ok == 0 { true } else { enabled != 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn easings_respect_endpoints_and_clamp() {
        assert!((ease_out_cubic(-0.5) - 0.0).abs() < 1e-6);
        assert!((ease_out_cubic(0.0) - 0.0).abs() < 1e-6);
        assert!((ease_out_cubic(1.0) - 1.0).abs() < 1e-6);
        assert!((ease_out_cubic(2.0) - 1.0).abs() < 1e-6);
        assert!(ease_out_cubic(0.5) > 0.5);

        assert!((ease_out_quad(0.0) - 0.0).abs() < 1e-6);
        assert!((ease_out_quad(1.0) - 1.0).abs() < 1e-6);
        assert!((ease_out_quad(0.5) - 0.75).abs() < 1e-6);
    }

    #[test]
    fn hsla_interpolation_uses_shortest_hue_arc() {
        let a = hsla(0.95, 0.5, 0.4, 0.2);
        let b = hsla(0.05, 0.5, 0.6, 0.8);
        let mid = lerp_hsla(a, b, 0.5);
        assert!((mid.h - 0.0).abs() < 1e-5 || (mid.h - 1.0).abs() < 1e-5);
        assert!((mid.l - 0.5).abs() < 1e-5);
        assert!((mid.a - 0.5).abs() < 1e-5);
    }

    #[test]
    fn prefers_reduced_motion_honors_no_fun_flag() {
        assert!(prefers_reduced_motion(true));
        assert!(parse_bool_flag("1\n"));
        assert!(parse_bool_flag("true"));
        assert!(!parse_bool_flag("0\n"));
    }
}
