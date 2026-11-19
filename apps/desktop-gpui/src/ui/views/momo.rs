use gpui::{
    AnyElement, Bounds, ClickEvent, ElementId, Hsla, InteractiveElement, IntoElement,
    ParentElement, PathBuilder, Pixels, Point, Role, StatefulInteractiveElement, Styled, Window,
    canvas, div, fill, point, px, quad, rgb, transparent_black,
};

use crate::core::health::StoreHealthStatus;
use crate::ui::views::ThemePalette;

fn hex_rgba(rgb_hex: u32, alpha: f32) -> Hsla {
    let mut c = Hsla::from(rgb(rgb_hex));
    c.a = alpha.clamp(0.0, 1.0);
    c
}

/// Interactive Momo button for the empty state (`64px`) or footer (`18px`).
///
/// Clicking Momo opens the Store Health panel filtered to his current state.
/// `slide_offset_x_px` shifts only the painted canvas transform so layout never shifts.
#[allow(clippy::too_many_arguments)]
pub fn render_momo_button(
    id: impl Into<ElementId>,
    size_px: f32,
    status: StoreHealthStatus,
    slide_offset_x_px: f32,
    eye_open: f32,
    theme: ThemePalette,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> AnyElement {
    let is_compact = size_px <= 24.0;
    // Hit target always >= 24px. Footer slot has 10px extra internal travel room for the 8px peek transform.
    let pebble_w = size_px * (22.0 / 18.0);
    let box_w = if is_compact {
        (pebble_w + 12.0).max(34.0)
    } else {
        (pebble_w + 12.0).max(76.0)
    };
    let box_h = if is_compact {
        size_px.max(24.0)
    } else {
        (size_px + 8.0).max(68.0)
    };

    div()
        .id(id.into())
        .focusable()
        .cursor_pointer()
        .flex_shrink_0()
        .w(px(box_w))
        .h(px(box_h))
        .overflow_hidden()
        .flex()
        .items_center()
        .justify_center()
        .role(Role::Button)
        .aria_label("Momo, memory mote")
        .focus_visible(move |s| s.rounded(px(6.)).border_1().border_color(theme.accent))
        .on_click(on_click)
        .child(
            canvas(
                move |_bounds, _window, _cx| (),
                move |bounds, _state, window, _cx| {
                    let origin_x = bounds.left().as_f32()
                        + if is_compact {
                            2.0 + slide_offset_x_px
                        } else {
                            (bounds.size.width.as_f32() - pebble_w) * 0.5 + slide_offset_x_px
                        };
                    let origin_y =
                        bounds.top().as_f32() + (bounds.size.height.as_f32() - size_px) * 0.5;
                    paint_momo_at(
                        point(px(origin_x), px(origin_y)),
                        size_px,
                        status,
                        eye_open,
                        theme,
                        window,
                    );
                },
            )
            .size_full(),
        )
        .into_any_element()
}

/// Traces Momo's pebble silhouette into `pb` so fill and hairline outline share exact geometry.
fn trace_pebble_contour(pb: &mut PathBuilder, pt: &impl Fn(f32, f32) -> Point<Pixels>) {
    pb.move_to(pt(3.2, 16.0));
    pb.curve_to(pt(1.2, 10.2), pt(0.8, 14.2));
    pb.curve_to(pt(6.6, 3.0), pt(1.8, 4.4));
    pb.curve_to(pt(13.2, 2.6), pt(10.0, 2.2));
    pb.curve_to(pt(20.4, 8.4), pt(18.0, 3.0));
    pb.curve_to(pt(18.8, 16.0), pt(21.4, 13.6));
    pb.line_to(pt(3.2, 16.0));
    pb.close();
}

/// Paints Momo directly at `top_left` fitting within `height_px` tall (`~22:18` pebble ratio).
pub fn paint_momo_at(
    top_left: Point<Pixels>,
    height_px: f32,
    status: StoreHealthStatus,
    eye_open: f32,
    theme: ThemePalette,
    window: &mut Window,
) {
    let s = (height_px / 18.0).max(0.5);
    let compact_footer = height_px <= 24.0;
    let ox = top_left.x.as_f32();
    let oy = top_left.y.as_f32();
    let pt = |x: f32, y: f32| point(px(ox + x * s), px(oy + y * s));

    // Pebble palette: Cream #E8DCC8 on dark, Warm ink #3A322A on light; copper #C97B4A cheek dot.
    let (base_hex, eye_hex) = if theme.is_dark {
        (0xE8DCC8, 0x1B1D21)
    } else if compact_footer {
        (0x3A322A, 0xFFFFFF)
    } else {
        (0x3A322A, 0xF7F5F1)
    };
    let copper_hex = 0xC97B4A;

    let body_color = match status {
        StoreHealthStatus::Empty => hex_rgba(base_hex, if compact_footer { 0.62 } else { 0.45 }),
        StoreHealthStatus::Stale => {
            if theme.is_dark {
                hex_rgba(0x9E998E, if compact_footer { 0.85 } else { 0.72 })
            } else {
                hex_rgba(0x6D665E, if compact_footer { 0.88 } else { 0.72 })
            }
        }
        StoreHealthStatus::Healthy
        | StoreHealthStatus::Contradictions
        | StoreHealthStatus::Many => hex_rgba(base_hex, 1.0),
    };

    // Soft copper halo (flat, no gradient) for Healthy stores.
    if matches!(status, StoreHealthStatus::Healthy) {
        let mut glow = PathBuilder::fill();
        glow.move_to(pt(2.6, 16.5));
        glow.curve_to(pt(0.0, 9.6), pt(0.2, 14.4));
        glow.curve_to(pt(9.8, 0.8), pt(1.4, 2.0));
        glow.curve_to(pt(21.4, 8.8), pt(18.6, 0.4));
        glow.curve_to(pt(19.4, 16.5), pt(22.2, 14.2));
        glow.line_to(pt(2.6, 16.5));
        glow.close();
        if let Ok(path) = glow.build() {
            window.paint_path(path, hex_rgba(copper_hex, 0.16));
        }
    }

    // Soft slightly irregular pebble with flat bottom (~22x18 reference box).
    let mut pebble = PathBuilder::fill();
    trace_pebble_contour(&mut pebble, &pt);
    if let Ok(path) = pebble.build() {
        window.paint_path(path, body_color);
    }

    // At 18px footer scale, add a subtle 1px contrasting stroke so the silhouette stays crisp.
    if compact_footer {
        let mut outline = PathBuilder::stroke(px(1.0));
        trace_pebble_contour(&mut outline, &pt);
        if let Ok(path) = outline.build() {
            let stroke_color = if theme.is_dark {
                hex_rgba(0x0E1013, 0.55)
            } else {
                hex_rgba(0x1B1D21, 0.48)
            };
            window.paint_path(path, stroke_color);
        }
    }

    let paint_circle =
        |center: Point<Pixels>, rx: f32, ry: f32, color: Hsla, window: &mut Window| {
            let r = rx.min(ry);
            window.paint_quad(quad(
                Bounds::from_corners(
                    point(center.x - px(rx), center.y - px(ry)),
                    point(center.x + px(rx), center.y + px(ry)),
                ),
                px(r),
                color,
                px(0.),
                transparent_black(),
                Default::default(),
            ));
        };

    // One copper #C97B4A cheek dot, tucked cleanly on the right cheek away from the right eye.
    let cheek_r = (0.95 * s).clamp(if compact_footer { 1.3 } else { 1.2 }, 3.2);
    let cheek_pos = pt(16.0, 11.4);
    paint_circle(
        cheek_pos,
        cheek_r,
        cheek_r,
        hex_rgba(
            copper_hex,
            if matches!(status, StoreHealthStatus::Empty | StoreHealthStatus::Stale) {
                0.72
            } else {
                0.98
            },
        ),
        window,
    );

    // Two dot eyes (higher opacity + slightly stronger radius at compact footer scale).
    let eye_color = hex_rgba(
        eye_hex,
        if compact_footer {
            1.0
        } else if matches!(status, StoreHealthStatus::Empty) {
            0.78
        } else {
            0.96
        },
    );
    let eye_look_dy = if matches!(status, StoreHealthStatus::Empty) {
        1.4
    } else {
        0.0
    };
    let eye_size = (2.0 * s.powf(0.5)).clamp(if compact_footer { 2.3 } else { 2.0 }, 4.4);
    let eye_y = 8.4 + eye_look_dy;

    let left_eye = pt(7.2, eye_y);
    let right_eye = pt(12.2, eye_y);

    if eye_open < 0.35 {
        // Closed blink line.
        let blink_h = (1.0 * s.powf(0.4)).clamp(1.1, 2.0);
        for center in [left_eye, right_eye] {
            window.paint_quad(fill(
                Bounds::from_corners(
                    point(center.x - px(eye_size * 0.65), center.y - px(blink_h * 0.5)),
                    point(center.x + px(eye_size * 0.65), center.y + px(blink_h * 0.5)),
                ),
                eye_color,
            ));
        }
    } else if matches!(status, StoreHealthStatus::Many) {
        // Happy-arc eyes + two tiny copper sparkles.
        let arc_span = if compact_footer { 1.65 } else { 1.5 };
        for cx_ref in [7.2_f32, 12.2_f32] {
            let mut arc = PathBuilder::stroke(px((1.35 * s.powf(0.45)).clamp(1.35, 2.4)));
            arc.move_to(pt(cx_ref - arc_span, eye_y + 0.55));
            arc.curve_to(pt(cx_ref + arc_span, eye_y + 0.55), pt(cx_ref, eye_y - 1.7));
            if let Ok(path) = arc.build() {
                window.paint_path(path, eye_color);
            }
        }
        // Two tiny copper sparkles.
        for (sx, sy) in [(2.6_f32, 2.8_f32), (19.6_f32, 3.2_f32)] {
            let mut sp = PathBuilder::stroke(px((1.1 * s.powf(0.4)).clamp(1.0, 1.8)));
            sp.move_to(pt(sx - 1.1, sy));
            sp.line_to(pt(sx + 1.1, sy));
            sp.move_to(pt(sx, sy - 1.1));
            sp.line_to(pt(sx, sy + 1.1));
            if let Ok(path) = sp.build() {
                window.paint_path(path, hex_rgba(copper_hex, 0.92));
            }
        }
    } else {
        // Standard circular dot eyes (with state nuances for Contradictions / Stale).
        let left_r = eye_size * 0.5;
        let right_ry = match status {
            StoreHealthStatus::Contradictions => (left_r * 0.62).max(1.0),
            StoreHealthStatus::Stale => (left_r * 0.54).max(0.95),
            _ => left_r,
        };
        paint_circle(left_eye, left_r, left_r, eye_color, window);
        paint_circle(right_eye, left_r, right_ry, eye_color, window);

        // Small crack between eyes for Contradictions state.
        if matches!(status, StoreHealthStatus::Contradictions) {
            let mut crack = PathBuilder::stroke(px((1.0 * s.powf(0.4)).clamp(1.0, 1.8)));
            crack.move_to(pt(9.7, 4.4));
            crack.line_to(pt(10.3, 6.4));
            crack.line_to(pt(9.3, 8.0));
            crack.line_to(pt(10.0, 9.8));
            if let Ok(path) = crack.build() {
                window.paint_path(path, eye_color);
            }
        }

        // Tiny dust dot for Stale state.
        if matches!(status, StoreHealthStatus::Stale) {
            let dust_c = pt(19.2, 4.0);
            let dr = (0.95 * s.powf(0.45)).clamp(1.0, 2.0);
            paint_circle(dust_c, dr, dr, hex_rgba(base_hex, 0.45), window);
        }
    }
}
