use gpui::{
    AnyElement, Bounds, Context, Hsla, InteractiveElement, IntoElement, MouseButton, ParentElement,
    StatefulInteractiveElement, Styled, Window, canvas, div, fill, point, prelude::FluentBuilder,
    px, rgb,
};

use crate::core::easter_eggs::{LogoPhase, LogoPhysics};
use crate::core::health::StoreHealthStatus;
use crate::ui::views::ThemePalette;
use crate::ui::views::momo::paint_momo_at;

/// Visual configuration for [`render_breakable_logo`].
pub struct LogoRenderConfig<'a> {
    pub physics: &'a LogoPhysics,
    pub momo_status: StoreHealthStatus,
    pub no_fun: bool,
    pub theme: ThemePalette,
}

/// Render the 7-block breakable sidebar mark inside a fixed 40px-tall non-blocking stage.
///
/// When `no_fun` is enabled, renders purely static intact cells with no pointer handlers.
pub fn render_breakable_logo<V: gpui::Render + 'static>(
    config: LogoRenderConfig<'_>,
    on_press: impl Fn(&mut V, &gpui::MouseDownEvent, &mut Window, &mut Context<V>) + 'static,
    on_release: impl Fn(&mut V, &gpui::MouseUpEvent, &mut Window, &mut Context<V>) + Clone + 'static,
    cx: &mut Context<V>,
) -> AnyElement {
    let snapshot = config.physics.clone();
    let momo_status = config.momo_status;
    let no_fun = config.no_fun;
    let theme = config.theme;
    let charge_progress = match snapshot.phase {
        LogoPhase::Charging { progress } => Some(progress),
        _ => None,
    };

    let stage = div()
        .id("sidebar-breakable-logo")
        .w(px(64.))
        .h(px(40.))
        .rounded(px(6.))
        .aria_label("MemOS sidebar mark")
        .when(!no_fun, |el| el.focusable().cursor_pointer())
        .focus_visible(move |s| s.border_1().border_color(theme.accent))
        .when(!no_fun, move |el| {
            let on_release_out = on_release.clone();
            el.on_mouse_down(MouseButton::Left, cx.listener(on_press))
                .on_mouse_up(MouseButton::Left, cx.listener(on_release))
                .on_mouse_up_out(MouseButton::Left, cx.listener(on_release_out))
        })
        .child(
            canvas(
                move |_bounds, _window, _cx| (),
                move |bounds, _state, window, _cx| {
                    let origin_x = bounds.left().as_f32() + 18.0;
                    let origin_y = bounds.top().as_f32() + 2.0;

                    // Subtle Momo peeking out over the center valley when reassembled after a hold.
                    if snapshot.momo_peek_amount > 0.02 {
                        let peek_drop = (1.0 - snapshot.momo_peek_amount) * 8.0;
                        paint_momo_at(
                            point(px(origin_x + 7.5), px(origin_y - 4.0 + peek_drop)),
                            13.0,
                            momo_status,
                            1.0,
                            theme,
                            window,
                        );
                    }

                    let copper = Hsla::from(rgb(0xC97B4A));
                    let block_color = if let Some(p) = charge_progress {
                        // Gently warm toward copper while charging >= 600ms.
                        let mut c = theme.text_secondary;
                        c.h = copper.h;
                        c.s = (c.s * (1.0 - p) + copper.s * p).clamp(0.0, 1.0);
                        c.l = (c.l * (1.0 - p * 0.5) + copper.l * (p * 0.5)).clamp(0.0, 1.0);
                        c.a = 0.95;
                        c
                    } else if matches!(snapshot.phase, LogoPhase::Pressed) {
                        theme.text_primary
                    } else if matches!(
                        snapshot.phase,
                        LogoPhase::Falling | LogoPhase::SettledFallen
                    ) {
                        if theme.is_dark {
                            theme.text_muted
                        } else {
                            theme.text_secondary
                        }
                    } else if theme.is_dark {
                        theme.text_secondary
                    } else {
                        theme.text_primary
                    };

                    for (ix, block) in snapshot.blocks.iter().enumerate() {
                        let x = origin_x + block.rest_x + block.offset_x;
                        let y = origin_y + block.rest_y + block.offset_y;
                        let jitter_dx = if charge_progress.is_some() {
                            if ix % 2 == 0 { -0.45 } else { 0.45 }
                        } else {
                            0.0
                        };
                        window.paint_quad(fill(
                            Bounds::from_corners(
                                point(px(x + jitter_dx), px(y)),
                                point(px(x + jitter_dx + block.w), px(y + block.h)),
                            ),
                            block_color,
                        ));
                    }

                    // Thin charge progress bar under mark during >=600ms hold.
                    if let Some(p) = charge_progress {
                        let bar_w = (28.0 * p.clamp(0.0, 1.0)).max(2.0);
                        window.paint_quad(fill(
                            Bounds::from_corners(
                                point(px(origin_x), px(origin_y + 22.0)),
                                point(px(origin_x + bar_w), px(origin_y + 24.0)),
                            ),
                            copper,
                        ));
                    }
                },
            )
            .size_full(),
        );

    stage.into_any_element()
}
