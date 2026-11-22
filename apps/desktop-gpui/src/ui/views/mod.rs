use std::ops::Range;
use std::sync::Arc;
use std::sync::OnceLock;

use gpui::{
    AnyElement, AnyView, App, AppContext, Bounds, ClipboardItem, ContentMask, Context, CursorStyle,
    Element, ElementId, ElementInputHandler, Entity, EntityInputHandler, EventEmitter, FocusHandle,
    Focusable, FontFeatures, GlobalElementId, Hsla, InspectorElementId, InteractiveElement,
    IntoElement, KeyBinding, LayoutId, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent,
    PaintQuad, ParentElement, Pixels, Point, Render, ScrollEvent, ScrollHandle, ShapedLine,
    SharedString, Style, Styled, TextRun, UTF16Selection, UnderlineStyle, Window, WindowAppearance,
    actions, canvas, div, fill, hsla, point, prelude::FluentBuilder, px, rgb, size,
};

use crate::core::settings::ThemeMode;

pub mod brief;
pub mod detail;
pub mod graph;
pub mod list;
pub mod logo;
pub mod momo;
pub mod onboarding;
pub mod palette;
pub mod review;
pub mod sidebar;

fn hex(v: u32) -> Hsla {
    Hsla::from(rgb(v))
}

/// Cohesive color tokens for Light and Dark modes.
#[derive(Clone, Copy, Debug)]
pub struct ThemePalette {
    pub is_dark: bool,
    pub bg_sunken: Hsla,
    pub bg_app: Hsla,
    pub bg_panel: Hsla,
    pub bg_elevated: Hsla,
    pub bg_floating: Hsla,
    pub bg_input: Hsla,
    pub bg_hover: Hsla,
    pub bg_selected: Hsla,
    pub bg_badge: Hsla,
    /// Semi-transparent floating sheet for the palette and popovers.
    pub glass_floating: Hsla,
    /// Semi-transparent panel sheet for modal dialogs.
    pub glass_panel: Hsla,
    /// Hairline that catches light on a glass edge.
    pub glass_border: Hsla,
    /// 1 px inner top highlight painted on floating glass.
    pub glass_highlight: Hsla,
    /// Dim layer behind glass modals.
    pub glass_scrim: Hsla,
    pub border: Hsla,
    pub border_subtle: Hsla,
    pub border_strong: Hsla,
    pub border_focus: Hsla,
    pub text_primary: Hsla,
    pub text_secondary: Hsla,
    pub text_muted: Hsla,
    pub accent: Hsla,
    pub accent_soft: Hsla,
    pub accent_text: Hsla,
    pub primary_btn_fg: Hsla,
    pub danger: Hsla,
    pub danger_soft: Hsla,
    pub warning: Hsla,
    pub warning_soft: Hsla,
    pub success: Hsla,
    pub success_soft: Hsla,
    pub selection_bg: Hsla,
    pub graph_bg: Hsla,
    pub graph_grid: Hsla,
}

impl ThemePalette {
    pub fn resolve(mode: ThemeMode, appearance: WindowAppearance) -> Self {
        match mode {
            ThemeMode::System => match appearance {
                WindowAppearance::Light | WindowAppearance::VibrantLight => {
                    Self::for_mode(ThemeMode::Light)
                }
                WindowAppearance::Dark | WindowAppearance::VibrantDark => {
                    Self::for_mode(ThemeMode::Dark)
                }
            },
            ThemeMode::Dark | ThemeMode::Light => Self::for_mode(mode),
        }
    }

    pub fn for_mode(mode: ThemeMode) -> Self {
        match mode {
            ThemeMode::Dark | ThemeMode::System => {
                let accent = hex(0xC97B4A);
                Self {
                    is_dark: true,
                    bg_sunken: hex(0x0B0908),
                    bg_app: hex(0x12100E),
                    bg_panel: hex(0x1A1714),
                    bg_elevated: hex(0x221E1A),
                    bg_floating: hex(0x28231F),
                    bg_input: hex(0x12100E),
                    bg_hover: hex(0x1F1B17),
                    bg_selected: hex(0x2A241F),
                    bg_badge: hex(0x221E1A),
                    glass_floating: Hsla {
                        a: 0.97,
                        ..hex(0x28231F)
                    },
                    glass_panel: Hsla {
                        a: 0.98,
                        ..hex(0x1A1714)
                    },
                    glass_border: hsla(0.0, 0.0, 1.0, 0.10),
                    glass_highlight: hsla(0.0, 0.0, 1.0, 0.07),
                    glass_scrim: hsla(0.08, 0.20, 0.03, 0.55),
                    border: hex(0x2E2823),
                    border_subtle: hex(0x241F1A),
                    border_strong: hex(0x3A322A),
                    border_focus: accent,
                    text_primary: hex(0xE8E1D5),
                    text_secondary: hex(0xC9C0B2),
                    text_muted: hex(0xA79D8F),
                    accent,
                    accent_soft: hex(0x2A211B),
                    accent_text: hex(0xE8E1D5),
                    primary_btn_fg: hex(0x12100E),
                    danger: hsla(0.0, 0.72, 0.64, 1.0),
                    danger_soft: hsla(0.0, 0.45, 0.18, 0.6),
                    warning: accent,
                    warning_soft: hex(0x221E1A),
                    success: hex(0x7BBF9A),
                    success_soft: hsla(147.0 / 360.0, 0.36, 0.18, 0.55),
                    selection_bg: Hsla { a: 0.25, ..accent },
                    graph_bg: hex(0x12100E),
                    graph_grid: hex(0x221E1A),
                }
            }
            ThemeMode::Light => {
                let accent = hex(0xB4652A);
                Self {
                    is_dark: false,
                    bg_sunken: hex(0xEBE7DF),
                    bg_app: hex(0xF7F5F1),
                    bg_panel: hex(0xFFFFFF),
                    bg_elevated: hex(0xF1EEE8),
                    bg_floating: hex(0xFFFFFF),
                    bg_input: hex(0xFFFFFF),
                    bg_hover: hex(0xEFEBE3),
                    bg_selected: hex(0xE6E1D7),
                    bg_badge: hex(0xF1EEE8),
                    glass_floating: Hsla {
                        a: 0.97,
                        ..hex(0xFFFFFF)
                    },
                    glass_panel: Hsla {
                        a: 0.98,
                        ..hex(0xFFFFFF)
                    },
                    glass_border: hsla(30.0 / 360.0, 0.18, 0.30, 0.14),
                    glass_highlight: hsla(0.0, 0.0, 1.0, 0.75),
                    glass_scrim: hsla(30.0 / 360.0, 0.20, 0.16, 0.28),
                    border: hex(0xD8D1C6),
                    border_subtle: hex(0xEDE8DF),
                    border_strong: hex(0xBFB4A5),
                    border_focus: accent,
                    text_primary: hex(0x1B1D21),
                    text_secondary: hex(0x45433E),
                    text_muted: hex(0x6D6A64),
                    accent,
                    accent_soft: hex(0xF1EEE8),
                    accent_text: hex(0x1B1D21),
                    primary_btn_fg: hex(0xFFFFFF),
                    danger: hsla(0.0, 0.68, 0.46, 1.0),
                    danger_soft: hsla(0.0, 0.75, 0.94, 1.0),
                    warning: accent,
                    warning_soft: hex(0xF1EEE8),
                    success: hsla(148.0 / 360.0, 0.46, 0.34, 1.0),
                    success_soft: hsla(148.0 / 360.0, 0.45, 0.92, 1.0),
                    selection_bg: Hsla { a: 0.18, ..accent },
                    graph_bg: hex(0xF7F5F1),
                    graph_grid: hex(0xEDE8DF),
                }
            }
        }
    }

    pub fn type_color(&self, node_type: &str) -> Hsla {
        let lower = node_type.to_ascii_lowercase();
        let l = if self.is_dark { 0.62 } else { 0.44 };
        // Warm, low-chroma type hues that belong to the obsidian/copper surface
        // instead of D3's saturated defaults. Saturation stays at or below ~0.41.
        match lower.as_str() {
            "fact" => hsla(203.0 / 360.0, 0.34, l, 1.0),
            "preference" => hsla(268.0 / 360.0, 0.18, l, 1.0),
            "decision" => hsla(23.0 / 360.0, 0.54, l, 1.0),
            "procedural" | "lesson" => hsla(140.0 / 360.0, 0.20, l, 1.0),
            "observation" | "episodic" => hsla(176.0 / 360.0, 0.25, l, 1.0),
            "entity" => hsla(29.0 / 360.0, 0.31, l, 1.0),
            "contradiction" => hsla(11.0 / 360.0, 0.41, l, 1.0),
            "cluster" => hsla(33.0 / 360.0, 0.10, l, 1.0),
            _ => hsla(
                33.0 / 360.0,
                0.08,
                if self.is_dark { 0.58 } else { 0.46 },
                1.0,
            ),
        }
    }

    pub fn provenance_color(&self, provenance: &str) -> Hsla {
        let lower = provenance.to_ascii_lowercase();
        if lower.contains("quarantin") || lower.contains("reject") {
            self.danger
        } else if lower.contains("verif") || lower.contains("direct") {
            self.success
        } else if lower.contains("infer") || lower.contains("synth") {
            self.warning
        } else {
            self.text_secondary
        }
    }

    pub fn edge_color(&self, relation: &str) -> Hsla {
        let lower = relation.to_ascii_lowercase();
        if lower.contains("contradict") {
            self.danger
        } else if lower.contains("supersede") {
            self.warning
        } else if lower.contains("support") || lower.contains("confirm") {
            self.success
        } else if lower.contains("entity") {
            self.type_color("entity")
        } else if lower.contains("tag") {
            self.type_color("observation")
        } else {
            self.accent
        }
    }
}

pub fn status_dot(color: Hsla) -> impl IntoElement {
    div()
        .w(px(7.))
        .h(px(7.))
        .rounded_full()
        .bg(color)
        .flex_shrink_0()
}

/// OpenType tabular numerals (`tnum`) feature set for aligned counts, ages, and scores.
pub fn tabular_nums() -> FontFeatures {
    static TNUM: OnceLock<FontFeatures> = OnceLock::new();
    TNUM.get_or_init(|| FontFeatures(Arc::new(vec![("tnum".to_string(), 1)])))
        .clone()
}

static ICON_FONT_FAMILY: OnceLock<Option<&'static str>> = OnceLock::new();
static MONO_FONT_FAMILY: OnceLock<&'static str> = OnceLock::new();

#[cfg(target_os = "windows")]
const MONO_FONT_CANDIDATES: &[&str] = &["Cascadia Mono", "Consolas", "Courier New"];
#[cfg(target_os = "macos")]
const MONO_FONT_CANDIDATES: &[&str] = &["SF Mono", "Menlo", "Monaco", "Courier New"];
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
const MONO_FONT_CANDIDATES: &[&str] = &[
    "JetBrains Mono",
    "DejaVu Sans Mono",
    "Liberation Mono",
    "Noto Sans Mono",
    "Ubuntu Mono",
    "FreeMono",
    "Courier New",
];

#[cfg(target_os = "windows")]
const DEFAULT_MONO_FONT_FAMILY: &str = "Consolas";
#[cfg(target_os = "macos")]
const DEFAULT_MONO_FONT_FAMILY: &str = "Menlo";
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
const DEFAULT_MONO_FONT_FAMILY: &str = "DejaVu Sans Mono";

/// Choose the first installed monospace font from `candidates`, falling back to `fallback`.
pub fn select_mono_font_family<'a>(
    installed: &[String],
    candidates: &[&'a str],
    fallback: &'a str,
) -> &'a str {
    for &candidate in candidates {
        if installed.iter().any(|name| name == candidate) {
            return candidate;
        }
    }
    fallback
}

/// Detect and cache the best installed monospace font for the current platform.
pub fn init_mono_font_from_window(window: &Window) {
    MONO_FONT_FAMILY.get_or_init(|| {
        let names = window.text_system().all_font_names();
        select_mono_font_family(&names, MONO_FONT_CANDIDATES, DEFAULT_MONO_FONT_FAMILY)
    });
}

/// Return the resolved platform-native monospace font family.
pub fn resolved_mono_font_family() -> &'static str {
    MONO_FONT_FAMILY
        .get()
        .copied()
        .unwrap_or(DEFAULT_MONO_FONT_FAMILY)
}

/// Format a primary-modifier shortcut label for the current platform (`⌘K` on macOS, `Ctrl+K` elsewhere).
pub fn primary_shortcut_label(key: &str) -> String {
    if cfg!(target_os = "macos") {
        format!("⌘{key}")
    } else {
        format!("Ctrl+{key}")
    }
}

/// Detect and cache the native Windows icon font family (`Segoe Fluent Icons` or `Segoe MDL2 Assets`).
pub fn init_icon_font_from_window(window: &Window) {
    ICON_FONT_FAMILY.get_or_init(|| {
        #[cfg(target_os = "windows")]
        {
            let names = window.text_system().all_font_names();
            if names.iter().any(|n| n == "Segoe Fluent Icons") {
                return Some("Segoe Fluent Icons");
            }
            if names.iter().any(|n| n == "Segoe MDL2 Assets") {
                return Some("Segoe MDL2 Assets");
            }
        }
        let _ = window;
        None
    });
}

pub fn resolved_icon_font_family() -> Option<&'static str> {
    ICON_FONT_FAMILY.get().copied().flatten()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UiIcon {
    Close,
    Copy,
    Citation,
    RevealInGraph,
    EyeContext,
    Warning,
    Plus,
    Minus,
    Overflow,
    Search,
    ChevronDown,
    ChevronRight,
    ChevronUp,
    Edit,
    Forget,
    Filter,
    Sort,
    ArrowRight,
    ArrowUp,
    Import,
    Check,
    Refresh,
}

/// Map semantic UI icons to verified Segoe Fluent Icons / Segoe MDL2 Assets PUA glyphs
/// with readable cross-platform symbol fallbacks on macOS/Linux/headless test environments.
pub fn ui_icon_glyph(icon: UiIcon, segoe_available: bool) -> &'static str {
    if segoe_available {
        match icon {
            UiIcon::Close => "\u{E8BB}",
            UiIcon::Copy => "\u{E8C8}",
            UiIcon::Citation => "\u{E943}",
            UiIcon::RevealInGraph => "\u{F003}",
            UiIcon::EyeContext => "\u{E890}",
            UiIcon::Warning => "\u{E7BA}",
            UiIcon::Plus => "\u{E710}",
            UiIcon::Minus => "\u{E738}",
            UiIcon::Overflow => "\u{E712}",
            UiIcon::Search => "\u{E721}",
            UiIcon::ChevronDown => "\u{E70D}",
            UiIcon::ChevronRight => "\u{E76C}",
            UiIcon::ChevronUp => "\u{E70E}",
            UiIcon::Edit => "\u{E70F}",
            UiIcon::Forget => "\u{E74D}",
            UiIcon::Filter => "\u{E71C}",
            UiIcon::Sort => "\u{E8CB}",
            UiIcon::ArrowRight => "\u{E72A}",
            UiIcon::ArrowUp => "\u{E74A}",
            UiIcon::Import => "\u{E8B5}",
            UiIcon::Check => "\u{E73E}",
            UiIcon::Refresh => "\u{E72C}",
        }
    } else {
        match icon {
            UiIcon::Close => "×",
            UiIcon::Copy => "⧉",
            UiIcon::Citation => "§",
            UiIcon::RevealInGraph => "◈",
            UiIcon::EyeContext => "◉",
            UiIcon::Warning => "!",
            UiIcon::Plus => "+",
            UiIcon::Minus => "−",
            UiIcon::Overflow => "•••",
            UiIcon::Search => "⌕",
            UiIcon::ChevronDown => "⌄",
            UiIcon::ChevronRight => "›",
            UiIcon::ChevronUp => "⌃",
            UiIcon::Edit => "✎",
            UiIcon::Forget => "⌫",
            UiIcon::Filter => "≡",
            UiIcon::Sort => "⇅",
            UiIcon::ArrowRight => "→",
            UiIcon::ArrowUp => "↑",
            UiIcon::Import => "⇣",
            UiIcon::Check => "✓",
            UiIcon::Refresh => "↻",
        }
    }
}

/// Centered single-family icon element with exact square box and zero text baseline shift.
pub fn render_ui_icon(icon: UiIcon, size_px: f32, color: Hsla) -> AnyElement {
    let font_family = resolved_icon_font_family();
    let glyph = ui_icon_glyph(icon, font_family.is_some());
    let box_el = div()
        .w(px(size_px))
        .h(px(size_px))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(size_px))
        .line_height(px(size_px))
        .text_color(color);
    match font_family {
        Some(family) => box_el.font_family(family).child(glyph).into_any_element(),
        None => box_el.child(glyph).into_any_element(),
    }
}

/// Renders top/bottom overflow fade cues and a crisp 3 px vertical scrollbar overlay
/// for any scrollable region backed by [`ScrollHandle`].
pub fn render_vertical_scroll_overlay(
    scroll_handle: ScrollHandle,
    fade_bg: Hsla,
    theme: ThemePalette,
) -> AnyElement {
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _cx| {
            let max_y = scroll_handle.max_offset().y.as_f32();
            if max_y <= 2.0 {
                return;
            }
            let scroll_y = (-scroll_handle.offset().y.as_f32()).clamp(0.0, max_y);
            let left = bounds.left().as_f32();
            let top = bounds.top().as_f32();
            let w = bounds.size.width.as_f32();
            let h = bounds.size.height.as_f32();

            if scroll_y > 2.0 {
                let alphas = [0.78_f32, 0.45, 0.18];
                for (i, a) in alphas.iter().enumerate() {
                    let mut c = fade_bg;
                    c.a = *a;
                    window.paint_quad(fill(
                        Bounds::new(
                            point(px(left), px(top + (i as f32) * 4.0)),
                            size(px((w - 10.0).max(0.0)), px(4.0)),
                        ),
                        c,
                    ));
                }
            }

            if max_y - scroll_y > 2.0 {
                let alphas = [0.22_f32, 0.56, 0.88];
                for (i, a) in alphas.iter().enumerate() {
                    let mut c = fade_bg;
                    c.a = *a;
                    window.paint_quad(fill(
                        Bounds::new(
                            point(px(left), px(top + h - 18.0 + (i as f32) * 6.0)),
                            size(px((w - 10.0).max(0.0)), px(6.0)),
                        ),
                        c,
                    ));
                }
            }

            let track_top = top + 4.0;
            let track_h = (h - 8.0).max(16.0);
            let view_h = scroll_handle.bounds().size.height.as_f32().max(h).max(1.0);
            let content_h = view_h + max_y;
            let thumb_h = (track_h * (view_h / content_h)).clamp(20.0, track_h);
            let ratio = (scroll_y / max_y).clamp(0.0, 1.0);
            let thumb_y = track_top + (track_h - thumb_h) * ratio;
            let mut track_bg = theme.border;
            track_bg.a = 0.50;
            let mut thumb_bg = theme.text_secondary;
            thumb_bg.a = 0.85;
            window.paint_quad(fill(
                Bounds::new(
                    point(px(left + w - 6.0), px(track_top)),
                    size(px(3.0), px(track_h)),
                ),
                track_bg,
            ));
            window.paint_quad(gpui::quad(
                Bounds::new(
                    point(px(left + w - 6.0), px(thumb_y)),
                    size(px(3.0), px(thumb_h)),
                ),
                px(1.5),
                thumb_bg,
                px(0.0),
                gpui::transparent_black(),
                Default::default(),
            ));
        },
    )
    .absolute()
    .inset_0()
    .size_full()
    .into_any_element()
}

pub fn section_header(label: impl Into<SharedString>, theme: &ThemePalette) -> impl IntoElement {
    div()
        .flex_shrink_0()
        .px(px(8.))
        .pt(px(12.))
        .pb(px(4.))
        .text_size(px(12.))
        .font_weight(gpui::FontWeight::MEDIUM)
        .text_color(theme.text_muted)
        .child(label.into())
}

/// Crisp keyboard keycap chip used in command palette and shortcut overlays.
pub fn keycap(label: impl Into<SharedString>, theme: &ThemePalette) -> impl IntoElement {
    div()
        .h(px(20.))
        .min_w(px(20.))
        .px(px(6.))
        .rounded(px(4.))
        .bg(theme.bg_sunken)
        .border_1()
        .border_color(theme.border_strong)
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(11.))
        .font_weight(gpui::FontWeight::MEDIUM)
        .text_color(theme.text_secondary)
        .flex_shrink_0()
        .child(label.into())
}

actions!(
    memos_input,
    [
        Backspace,
        Delete,
        Left,
        Right,
        SelectLeft,
        SelectRight,
        SelectAll,
        Home,
        End,
        Paste,
        Cut,
        Copy,
        SubmitInput,
        CancelInput,
        MoveUp,
        MoveDown,
    ]
);

#[derive(Clone, Debug)]
pub enum InputEvent {
    Changed(String),
    Submit(String),
    Cancel,
    MoveUp,
    MoveDown,
    BackspaceWhenEmpty,
}

/// Registers keyboard bindings for [`TextInput`] widgets under key context `"TextInput"`.
pub fn register_input_key_bindings(cx: &mut App) {
    #[cfg(target_os = "macos")]
    let platform_bindings = [
        KeyBinding::new("cmd-a", SelectAll, Some("TextInput")),
        KeyBinding::new("cmd-v", Paste, Some("TextInput")),
        KeyBinding::new("cmd-c", Copy, Some("TextInput")),
        KeyBinding::new("cmd-x", Cut, Some("TextInput")),
        KeyBinding::new("cmd-left", Home, Some("TextInput")),
        KeyBinding::new("cmd-right", End, Some("TextInput")),
    ];
    #[cfg(not(target_os = "macos"))]
    let platform_bindings = [
        KeyBinding::new("ctrl-a", SelectAll, Some("TextInput")),
        KeyBinding::new("ctrl-v", Paste, Some("TextInput")),
        KeyBinding::new("ctrl-c", Copy, Some("TextInput")),
        KeyBinding::new("ctrl-x", Cut, Some("TextInput")),
    ];

    cx.bind_keys([
        KeyBinding::new("backspace", Backspace, Some("TextInput")),
        KeyBinding::new("delete", Delete, Some("TextInput")),
        KeyBinding::new("left", Left, Some("TextInput")),
        KeyBinding::new("right", Right, Some("TextInput")),
        KeyBinding::new("shift-left", SelectLeft, Some("TextInput")),
        KeyBinding::new("shift-right", SelectRight, Some("TextInput")),
        KeyBinding::new("home", Home, Some("TextInput")),
        KeyBinding::new("end", End, Some("TextInput")),
        KeyBinding::new("enter", SubmitInput, Some("TextInput")),
        KeyBinding::new("escape", CancelInput, Some("TextInput")),
        KeyBinding::new("up", MoveUp, Some("TextInput")),
        KeyBinding::new("down", MoveDown, Some("TextInput")),
    ]);
    cx.bind_keys(platform_bindings);
}

#[derive(Clone)]
struct RenderedTextLine {
    byte_range: Range<usize>,
    shaped: ShapedLine,
    top: Pixels,
    height: Pixels,
}

/// Interactive single-line or multiline text input built directly on GPUI's `EntityInputHandler`.
pub struct TextInput {
    focus_handle: FocusHandle,
    content: SharedString,
    placeholder: SharedString,
    selected_range: Range<usize>,
    selection_reversed: bool,
    marked_range: Option<Range<usize>>,
    last_layout: Option<ShapedLine>,
    last_lines: Vec<RenderedTextLine>,
    last_bounds: Option<Bounds<Pixels>>,
    is_selecting: bool,
    multiline: bool,
    height_px: f32,
    scroll_y: f32,
    ensure_cursor_visible: bool,
    leading_icon: Option<UiIcon>,
    theme: ThemePalette,
}

impl TextInput {
    pub fn new(
        cx: &mut Context<Self>,
        placeholder: impl Into<SharedString>,
        theme: ThemePalette,
    ) -> Self {
        Self::with_mode(cx, placeholder, theme, false, 32.0)
    }

    pub fn new_multiline(
        cx: &mut Context<Self>,
        placeholder: impl Into<SharedString>,
        theme: ThemePalette,
    ) -> Self {
        Self::with_mode(cx, placeholder, theme, true, 108.0)
    }

    pub fn with_leading_icon(mut self, icon: UiIcon) -> Self {
        self.leading_icon = Some(icon);
        self
    }

    fn with_mode(
        cx: &mut Context<Self>,
        placeholder: impl Into<SharedString>,
        theme: ThemePalette,
        multiline: bool,
        height_px: f32,
    ) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            content: SharedString::default(),
            placeholder: placeholder.into(),
            selected_range: 0..0,
            selection_reversed: false,
            marked_range: None,
            last_layout: None,
            last_lines: Vec::new(),
            last_bounds: None,
            is_selecting: false,
            multiline,
            height_px,
            scroll_y: 0.0,
            ensure_cursor_visible: false,
            leading_icon: None,
            theme,
        }
    }

    pub fn set_theme(&mut self, theme: ThemePalette, cx: &mut Context<Self>) {
        self.theme = theme;
        self.last_layout = None;
        self.last_lines.clear();
        cx.notify();
    }

    pub fn text(&self) -> &str {
        self.content.as_ref()
    }

    fn sanitize_for_mode(&self, text: &str) -> String {
        if self.multiline {
            sanitize_multiline(text)
        } else {
            sanitize_single_line(text)
        }
    }

    pub fn set_text(&mut self, value: impl Into<SharedString>, cx: &mut Context<Self>) {
        let cleaned = self.sanitize_for_mode(&value.into());
        let len = cleaned.len();
        self.content = cleaned.into();
        self.selected_range = len..len;
        self.selection_reversed = false;
        self.marked_range = None;
        self.last_layout = None;
        self.last_lines.clear();
        self.scroll_y = 0.0;
        self.ensure_cursor_visible = true;
        cx.notify();
    }

    pub fn clear(&mut self, cx: &mut Context<Self>) {
        if self.content.is_empty() {
            return;
        }
        self.content = SharedString::default();
        self.selected_range = 0..0;
        self.selection_reversed = false;
        self.marked_range = None;
        self.last_layout = None;
        self.last_lines.clear();
        self.scroll_y = 0.0;
        cx.emit(InputEvent::Changed(String::new()));
        cx.notify();
    }

    fn left(&mut self, _: &Left, _: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.move_to(self.previous_boundary(self.cursor_offset()), cx);
        } else {
            self.move_to(self.selected_range.start, cx);
        }
    }

    fn right(&mut self, _: &Right, _: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.move_to(self.next_boundary(self.cursor_offset()), cx);
        } else {
            self.move_to(self.selected_range.end, cx);
        }
    }

    fn select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.previous_boundary(self.cursor_offset()), cx);
    }

    fn select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.next_boundary(self.cursor_offset()), cx);
    }

    fn select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, cx);
        self.select_to(self.content.len(), cx);
    }

    fn home(&mut self, _: &Home, _: &mut Window, cx: &mut Context<Self>) {
        if self.multiline {
            if !self.last_lines.is_empty() {
                let ranges: Vec<Range<usize>> = self
                    .last_lines
                    .iter()
                    .map(|l| l.byte_range.clone())
                    .collect();
                let ix = line_index_for_caret(&ranges, self.cursor_offset());
                if let Some(range) = ranges.get(ix) {
                    self.move_to(range.start, cx);
                    return;
                }
            }
            let offset = clamp_char_boundary(&self.content, self.cursor_offset());
            let start = self.content[..offset].rfind('\n').map_or(0, |p| p + 1);
            self.move_to(start, cx);
            return;
        }
        self.move_to(0, cx);
    }

    fn end(&mut self, _: &End, _: &mut Window, cx: &mut Context<Self>) {
        if self.multiline {
            if !self.last_lines.is_empty() {
                let ranges: Vec<Range<usize>> = self
                    .last_lines
                    .iter()
                    .map(|l| l.byte_range.clone())
                    .collect();
                let ix = line_index_for_caret(&ranges, self.cursor_offset());
                if let Some(range) = ranges.get(ix) {
                    self.move_to(range.end, cx);
                    return;
                }
            }
            let offset = clamp_char_boundary(&self.content, self.cursor_offset());
            let end = self.content[offset..]
                .find('\n')
                .map_or(self.content.len(), |p| offset + p);
            self.move_to(end, cx);
            return;
        }
        self.move_to(self.content.len(), cx);
    }

    fn backspace(&mut self, _: &Backspace, window: &mut Window, cx: &mut Context<Self>) {
        if self.content.is_empty() {
            cx.emit(InputEvent::BackspaceWhenEmpty);
            return;
        }
        if self.selected_range.is_empty() {
            self.select_to(self.previous_boundary(self.cursor_offset()), cx);
        }
        self.replace_text_in_range(None, "", window, cx);
    }

    fn delete(&mut self, _: &Delete, window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            self.select_to(self.next_boundary(self.cursor_offset()), cx);
        }
        self.replace_text_in_range(None, "", window, cx);
    }

    fn paste(&mut self, _: &Paste, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            let cleaned = self.sanitize_for_mode(&text);
            self.replace_text_in_range(None, &cleaned, window, cx);
        }
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selected_range.clone()].to_string(),
            ));
        }
    }

    fn cut(&mut self, _: &Cut, window: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.content[self.selected_range.clone()].to_string(),
            ));
            self.replace_text_in_range(None, "", window, cx);
        }
    }

    fn submit(&mut self, _: &SubmitInput, window: &mut Window, cx: &mut Context<Self>) {
        if self.multiline {
            self.replace_text_in_range(None, "\n", window, cx);
        } else {
            cx.emit(InputEvent::Submit(self.content.to_string()));
        }
    }

    fn cancel(&mut self, _: &CancelInput, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(InputEvent::Cancel);
    }

    fn move_up(&mut self, _: &MoveUp, _: &mut Window, cx: &mut Context<Self>) {
        if !self.multiline {
            cx.emit(InputEvent::MoveUp);
            return;
        }
        if self.last_lines.is_empty() {
            return;
        }
        let ranges: Vec<Range<usize>> = self
            .last_lines
            .iter()
            .map(|l| l.byte_range.clone())
            .collect();
        let ix = line_index_for_caret(&ranges, self.cursor_offset());
        if ix == 0 {
            self.move_to(0, cx);
            return;
        }
        let cur = &self.last_lines[ix];
        let rel = self
            .cursor_offset()
            .saturating_sub(cur.byte_range.start)
            .min(cur.byte_range.end.saturating_sub(cur.byte_range.start));
        let target_x = cur.shaped.x_for_index(rel);
        let prev = &self.last_lines[ix - 1];
        let next_rel = prev.shaped.closest_index_for_x(target_x);
        self.move_to(prev.byte_range.start + next_rel, cx);
    }

    fn move_down(&mut self, _: &MoveDown, _: &mut Window, cx: &mut Context<Self>) {
        if !self.multiline {
            cx.emit(InputEvent::MoveDown);
            return;
        }
        if self.last_lines.is_empty() {
            return;
        }
        let ranges: Vec<Range<usize>> = self
            .last_lines
            .iter()
            .map(|l| l.byte_range.clone())
            .collect();
        let ix = line_index_for_caret(&ranges, self.cursor_offset());
        if ix + 1 >= self.last_lines.len() {
            self.move_to(self.content.len(), cx);
            return;
        }
        let cur = &self.last_lines[ix];
        let rel = self
            .cursor_offset()
            .saturating_sub(cur.byte_range.start)
            .min(cur.byte_range.end.saturating_sub(cur.byte_range.start));
        let target_x = cur.shaped.x_for_index(rel);
        let next = &self.last_lines[ix + 1];
        let next_rel = next.shaped.closest_index_for_x(target_x);
        self.move_to(next.byte_range.start + next_rel, cx);
    }

    fn on_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus_handle, cx);
        self.is_selecting = true;
        if event.modifiers.shift {
            self.select_to(self.index_for_mouse_position(event.position), cx);
        } else {
            self.move_to(self.index_for_mouse_position(event.position), cx);
        }
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.is_selecting = false;
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.is_selecting {
            self.select_to(self.index_for_mouse_position(event.position), cx);
        }
    }

    fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        let clamped = clamp_char_boundary(&self.content, offset);
        self.selected_range = clamped..clamped;
        self.ensure_cursor_visible = true;
        cx.notify();
    }

    fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        let offset = clamp_char_boundary(&self.content, offset);
        if self.selection_reversed {
            self.selected_range.start = offset;
        } else {
            self.selected_range.end = offset;
        }
        if self.selected_range.end < self.selected_range.start {
            self.selection_reversed = !self.selection_reversed;
            self.selected_range = self.selected_range.end..self.selected_range.start;
        }
        self.ensure_cursor_visible = true;
        cx.notify();
    }

    fn cursor_offset(&self) -> usize {
        if self.selection_reversed {
            self.selected_range.start
        } else {
            self.selected_range.end
        }
    }

    fn index_for_mouse_position(&self, position: Point<Pixels>) -> usize {
        if self.content.is_empty() {
            return 0;
        }
        let Some(bounds) = self.last_bounds.as_ref() else {
            return self.content.len();
        };
        if self.multiline && !self.last_lines.is_empty() {
            if position.y < bounds.top() && self.scroll_y <= 0.5 {
                return 0;
            }
            let target = self
                .last_lines
                .iter()
                .find(|l| position.y >= l.top && position.y <= l.top + l.height)
                .or_else(|| {
                    if position.y < self.last_lines.first().map_or(bounds.top(), |l| l.top) {
                        self.last_lines.first()
                    } else {
                        self.last_lines.last()
                    }
                });
            if let Some(line) = target {
                let rel = line.shaped.closest_index_for_x(position.x - bounds.left());
                return (line.byte_range.start + rel).min(self.content.len());
            }
        }
        let Some(line) = self.last_layout.as_ref() else {
            return self.content.len();
        };
        if position.y < bounds.top() {
            return 0;
        }
        if position.y > bounds.bottom() {
            return self.content.len();
        }
        line.closest_index_for_x(position.x - bounds.left())
    }

    fn previous_boundary(&self, offset: usize) -> usize {
        let clamped = clamp_char_boundary(&self.content, offset);
        self.content[..clamped]
            .char_indices()
            .next_back()
            .map(|(ix, _)| ix)
            .unwrap_or(0)
    }

    fn next_boundary(&self, offset: usize) -> usize {
        let clamped = clamp_char_boundary(&self.content, offset);
        self.content[clamped..]
            .chars()
            .next()
            .map(|ch| clamped + ch.len_utf8())
            .unwrap_or(self.content.len())
    }

    fn offset_from_utf16(&self, offset: usize) -> usize {
        let mut utf8_offset = 0;
        let mut utf16_count = 0;
        for ch in self.content.chars() {
            if utf16_count >= offset {
                break;
            }
            utf16_count += ch.len_utf16();
            utf8_offset += ch.len_utf8();
        }
        utf8_offset
    }

    fn offset_to_utf16(&self, offset: usize) -> usize {
        let clamped = clamp_char_boundary(&self.content, offset);
        let mut utf16_offset = 0;
        for ch in self.content[..clamped].chars() {
            utf16_offset += ch.len_utf16();
        }
        utf16_offset
    }

    fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_to_utf16(range.start)..self.offset_to_utf16(range.end)
    }

    fn range_from_utf16(&self, range_utf16: &Range<usize>) -> Range<usize> {
        self.offset_from_utf16(range_utf16.start)..self.offset_from_utf16(range_utf16.end)
    }
}

impl EventEmitter<InputEvent> for TextInput {}

impl Focusable for TextInput {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl EntityInputHandler for TextInput {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range_from_utf16(&range_utf16);
        actual_range.replace(self.range_to_utf16(&range));
        Some(self.content[range].to_string())
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.range_to_utf16(&self.selected_range),
            reversed: self.selection_reversed,
        })
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Range<usize>> {
        self.marked_range
            .as_ref()
            .map(|range| self.range_to_utf16(range))
    }

    fn unmark_text(&mut self, _window: &mut Window, _cx: &mut Context<Self>) {
        self.marked_range = None;
    }

    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|r| self.range_from_utf16(r))
            .or_else(|| self.marked_range.clone())
            .unwrap_or_else(|| self.selected_range.clone());

        let sanitized = self.sanitize_for_mode(new_text);
        let updated = format!(
            "{}{}{}",
            &self.content[0..range.start],
            sanitized,
            &self.content[range.end..]
        );
        let changed = updated != self.content.as_ref();
        self.content = updated.into();
        let caret = range.start + sanitized.len();
        self.selected_range = caret..caret;
        self.selection_reversed = false;
        self.marked_range = None;
        self.last_layout = None;
        self.last_lines.clear();
        self.ensure_cursor_visible = true;
        if changed {
            cx.emit(InputEvent::Changed(self.content.to_string()));
        }
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range_utf16: Option<Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|r| self.range_from_utf16(r))
            .or_else(|| self.marked_range.clone())
            .unwrap_or_else(|| self.selected_range.clone());

        let sanitized = self.sanitize_for_mode(new_text);
        let updated = format!(
            "{}{}{}",
            &self.content[0..range.start],
            sanitized,
            &self.content[range.end..]
        );
        let changed = updated != self.content.as_ref();
        self.content = updated.into();
        if !sanitized.is_empty() {
            self.marked_range = Some(range.start..range.start + sanitized.len());
        } else {
            self.marked_range = None;
        }
        self.selected_range = new_selected_range_utf16
            .as_ref()
            .map(|r| self.range_from_utf16(r))
            .map(|r| r.start + range.start..r.end + range.start)
            .unwrap_or_else(|| {
                let end = range.start + sanitized.len();
                end..end
            });
        self.selection_reversed = false;
        self.last_layout = None;
        self.last_lines.clear();
        self.ensure_cursor_visible = true;
        if changed {
            cx.emit(InputEvent::Changed(self.content.to_string()));
        }
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let range = self.range_from_utf16(&range_utf16);
        if self.multiline && !self.last_lines.is_empty() {
            let ranges: Vec<Range<usize>> = self
                .last_lines
                .iter()
                .map(|l| l.byte_range.clone())
                .collect();
            let ix = line_index_for_caret(&ranges, range.start);
            if let Some(line) = self.last_lines.get(ix) {
                let r0 = range.start.saturating_sub(line.byte_range.start);
                let r1 = range
                    .end
                    .saturating_sub(line.byte_range.start)
                    .min(line.byte_range.end.saturating_sub(line.byte_range.start));
                return Some(Bounds::from_corners(
                    point(bounds.left() + line.shaped.x_for_index(r0), line.top),
                    point(
                        bounds.left() + line.shaped.x_for_index(r1),
                        line.top + line.height,
                    ),
                ));
            }
        }
        let layout = self.last_layout.as_ref()?;
        Some(Bounds::from_corners(
            point(
                bounds.left() + layout.x_for_index(range.start),
                bounds.top(),
            ),
            point(
                bounds.left() + layout.x_for_index(range.end),
                bounds.bottom(),
            ),
        ))
    }

    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        let line_point = self.last_bounds?.localize(&point)?;
        if self.multiline && !self.last_lines.is_empty() {
            let target = self
                .last_lines
                .iter()
                .find(|l| point.y >= l.top && point.y <= l.top + l.height)
                .or_else(|| self.last_lines.last())?;
            let rel = target.shaped.index_for_x(point.x - line_point.x)?;
            return Some(self.offset_to_utf16(target.byte_range.start + rel));
        }
        let layout = self.last_layout.as_ref()?;
        let utf8_index = layout.index_for_x(point.x - line_point.x)?;
        Some(self.offset_to_utf16(utf8_index))
    }
}

impl Render for TextInput {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let focused = self.focus_handle.is_focused(window);
        div()
            .key_context("TextInput")
            .track_focus(&self.focus_handle)
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::submit))
            .on_action(cx.listener(Self::cancel))
            .on_action(cx.listener(Self::move_up))
            .on_action(cx.listener(Self::move_down))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .w_full()
            .h(px(self.height_px))
            .px(px(12.))
            .flex()
            .when(self.multiline, |el| {
                el.py(px(8.)).items_start().on_scroll(cx.listener(
                    |this, ev: &ScrollEvent, window, cx| {
                        let line_h = window.line_height();
                        let delta_y = ev.delta.pixel_delta(line_h).y.as_f32();
                        let total_h: f32 = this.last_lines.iter().map(|l| l.height.as_f32()).sum();
                        let view_h = this
                            .last_bounds
                            .map_or((this.height_px - 16.0).max(18.0), |b| {
                                b.size.height.as_f32()
                            });
                        let max_scroll = (total_h - view_h).max(0.0);
                        this.scroll_y = (this.scroll_y - delta_y).clamp(0.0, max_scroll);
                        this.ensure_cursor_visible = false;
                        cx.notify();
                    },
                ))
            })
            .when(!self.multiline, |el| el.items_center())
            .rounded(px(6.))
            .bg(self.theme.bg_input)
            .text_size(px(13.))
            .border_1()
            .when(focused, |el| el.border_color(self.theme.border_focus))
            .when(!focused, |el| el.border_color(self.theme.border))
            .overflow_hidden()
            .when_some(
                self.leading_icon.filter(|_| !self.multiline),
                |row, icon| {
                    row.gap(px(8.)).child(
                        div()
                            .flex_shrink_0()
                            .w(px(14.))
                            .h(px(14.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(render_ui_icon(icon, 14.0, self.theme.text_muted)),
                    )
                },
            )
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.))
                    .when(self.multiline, |d| d.h_full())
                    .child(TextLineElement { input: cx.entity() }),
            )
    }
}

struct TextLineElement {
    input: Entity<TextInput>,
}

struct PrepaintTextState {
    lines: Vec<RenderedTextLine>,
    cursors: Vec<PaintQuad>,
    selections: Vec<PaintQuad>,
    scroll_y: f32,
    multiline: bool,
}

impl Element for TextLineElement {
    type RequestLayoutState = ();
    type PrepaintState = PrepaintTextState;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let multiline = self.input.read(cx).multiline;
        let mut style = Style::default();
        style.size.width = gpui::relative(1.).into();
        style.size.height = if multiline {
            gpui::relative(1.).into()
        } else {
            window.line_height().into()
        };
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let (
            content,
            placeholder,
            selected_range,
            cursor,
            marked_range,
            theme,
            multiline,
            prev_scroll_y,
            ensure_cursor_visible,
        ) = {
            let input = self.input.read(cx);
            (
                input.content.clone(),
                input.placeholder.clone(),
                input.selected_range.clone(),
                input.cursor_offset(),
                input.marked_range.clone(),
                input.theme,
                input.multiline,
                input.scroll_y,
                input.ensure_cursor_visible,
            )
        };

        let style = window.text_style();
        let line_height = window.line_height();
        let font_size = style.font_size.to_pixels(window.rem_size());
        let (display_text, text_color) = if content.is_empty() {
            (placeholder, theme.text_muted)
        } else {
            (content.clone(), theme.text_primary)
        };
        let base_run = TextRun {
            len: display_text.len(),
            font: style.font(),
            color: text_color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };

        let visual_segments: Vec<(Range<usize>, ShapedLine)> = if !multiline {
            let runs = build_slice_runs(
                0..display_text.len(),
                &base_run,
                marked_range.as_ref().filter(|_| !content.is_empty()),
                theme.accent,
            );
            let shaped =
                window
                    .text_system()
                    .shape_line(display_text.clone(), font_size, &runs, None);
            let range = if content.is_empty() {
                0..0
            } else {
                0..display_text.len()
            };
            vec![(range, shaped)]
        } else {
            shape_wrapped_lines(
                display_text.as_ref(),
                content.is_empty(),
                bounds.size.width.max(px(40.)),
                font_size,
                &base_run,
                marked_range.as_ref().filter(|_| !content.is_empty()),
                theme.accent,
                window,
            )
        };

        let ranges: Vec<Range<usize>> = visual_segments.iter().map(|(r, _)| r.clone()).collect();
        let cursor_line_ix = if content.is_empty() {
            0
        } else {
            line_index_for_caret(&ranges, cursor)
        };

        let total_height = line_height.as_f32() * visual_segments.len().max(1) as f32;
        let view_height = bounds.size.height.max(line_height).as_f32();
        let max_scroll = if multiline {
            (total_height - view_height).max(0.0)
        } else {
            0.0
        };
        let mut scroll_y = if multiline {
            prev_scroll_y.clamp(0.0, max_scroll)
        } else {
            0.0
        };
        if multiline && ensure_cursor_visible {
            let cur_top = line_height.as_f32() * cursor_line_ix as f32;
            let cur_bottom = cur_top + line_height.as_f32();
            if cur_top < scroll_y {
                scroll_y = cur_top;
            } else if cur_bottom > scroll_y + view_height {
                scroll_y = cur_bottom - view_height;
            }
            scroll_y = scroll_y.clamp(0.0, max_scroll);
        }

        let base_top = if multiline {
            bounds.top() - px(scroll_y)
        } else {
            bounds.top() + ((bounds.size.height - line_height) * 0.5).max(px(0.))
        };

        let mut lines = Vec::with_capacity(visual_segments.len());
        let mut selections = Vec::new();
        let mut cursors = Vec::new();

        for (ix, (byte_range, shaped)) in visual_segments.into_iter().enumerate() {
            let top = base_top + line_height * (ix as f32);
            if !selected_range.is_empty() && !content.is_empty() {
                let spans_line = selected_range.start <= byte_range.end
                    && selected_range.end >= byte_range.start
                    && (selected_range.start < byte_range.end
                        || selected_range.end > byte_range.start);
                if spans_line
                    && (selected_range.end > byte_range.start
                        || selected_range.start < byte_range.end)
                {
                    let s0 = selected_range.start.max(byte_range.start) - byte_range.start;
                    let s1 = selected_range.end.min(byte_range.end) - byte_range.start;
                    let x0 = shaped.x_for_index(s0);
                    let mut x1 = shaped.x_for_index(s1);
                    if selected_range.end > byte_range.end {
                        x1 += px(4.);
                    }
                    if x1 > x0 {
                        selections.push(fill(
                            Bounds::from_corners(
                                point(bounds.left() + x0, top),
                                point(bounds.left() + x1, top + line_height),
                            ),
                            theme.selection_bg,
                        ));
                    }
                }
            } else if ix == cursor_line_ix {
                let cursor_x = if content.is_empty() {
                    px(0.)
                } else {
                    let rel = cursor
                        .saturating_sub(byte_range.start)
                        .min(byte_range.len());
                    shaped.x_for_index(rel)
                };
                cursors.push(fill(
                    Bounds::new(
                        point(bounds.left() + cursor_x, top),
                        size(px(1.5), line_height),
                    ),
                    theme.accent,
                ));
            }
            lines.push(RenderedTextLine {
                byte_range,
                shaped,
                top,
                height: line_height,
            });
        }

        PrepaintTextState {
            lines,
            cursors,
            selections,
            scroll_y,
            multiline,
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus_handle = self.input.read(cx).focus_handle.clone();
        window.handle_input(
            &focus_handle,
            ElementInputHandler::new(bounds, self.input.clone()),
            cx,
        );

        let lines = std::mem::take(&mut prepaint.lines);
        let selections = std::mem::take(&mut prepaint.selections);
        let mut cursors = std::mem::take(&mut prepaint.cursors);

        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            for selection in selections {
                window.paint_quad(selection);
            }
            for line in &lines {
                if line.top + line.height < bounds.top() || line.top > bounds.bottom() {
                    continue;
                }
                line.shaped
                    .paint(
                        point(bounds.left(), line.top),
                        line.height,
                        gpui::TextAlign::Left,
                        None,
                        window,
                        cx,
                    )
                    .ok();
            }
            if focus_handle.is_focused(window) {
                for cursor in cursors.drain(..) {
                    window.paint_quad(cursor);
                }
            }
        });

        let first_layout = lines.first().map(|l| l.shaped.clone());
        let scroll_y = prepaint.scroll_y;
        let is_multiline = prepaint.multiline;
        self.input.update(cx, |input, _cx| {
            input.last_layout = first_layout;
            input.last_lines = lines;
            input.last_bounds = Some(bounds);
            if is_multiline {
                input.scroll_y = scroll_y;
            }
            input.ensure_cursor_visible = false;
        });
    }
}

fn build_slice_runs(
    slice: Range<usize>,
    base_run: &TextRun,
    marked_range: Option<&Range<usize>>,
    underline_color: Hsla,
) -> Vec<TextRun> {
    let slice_len = slice.len();
    if slice_len == 0 {
        return Vec::new();
    }
    let Some(marked) = marked_range else {
        return vec![TextRun {
            len: slice_len,
            ..base_run.clone()
        }];
    };
    let ov_start = slice.start.max(marked.start);
    let ov_end = slice.end.min(marked.end);
    if ov_start >= ov_end {
        return vec![TextRun {
            len: slice_len,
            ..base_run.clone()
        }];
    }
    vec![
        TextRun {
            len: ov_start - slice.start,
            ..base_run.clone()
        },
        TextRun {
            len: ov_end - ov_start,
            underline: Some(UnderlineStyle {
                color: Some(underline_color),
                thickness: px(1.0),
                wavy: false,
            }),
            ..base_run.clone()
        },
        TextRun {
            len: slice.end - ov_end,
            ..base_run.clone()
        },
    ]
    .into_iter()
    .filter(|r| r.len > 0)
    .collect()
}

#[allow(clippy::too_many_arguments)]
fn shape_wrapped_lines(
    display_text: &str,
    is_placeholder: bool,
    wrap_width: Pixels,
    font_size: Pixels,
    base_run: &TextRun,
    marked_range: Option<&Range<usize>>,
    accent: Hsla,
    window: &mut Window,
) -> Vec<(Range<usize>, ShapedLine)> {
    let logical_ranges = logical_line_ranges(display_text);
    let mut out = Vec::new();
    for log_range in logical_ranges {
        let mut cursor = log_range.start;
        if cursor == log_range.end {
            let shaped =
                window
                    .text_system()
                    .shape_line(SharedString::default(), font_size, &[], None);
            let out_range = if is_placeholder { 0..0 } else { cursor..cursor };
            out.push((out_range, shaped));
            continue;
        }
        while cursor < log_range.end {
            let slice_str = &display_text[cursor..log_range.end];
            let full_runs = build_slice_runs(cursor..log_range.end, base_run, marked_range, accent);
            let full_shaped = window.text_system().shape_line(
                SharedString::from(slice_str.to_string()),
                font_size,
                &full_runs,
                None,
            );
            if full_shaped.width <= wrap_width || wrap_width <= px(24.) {
                let out_range = if is_placeholder {
                    0..0
                } else {
                    cursor..log_range.end
                };
                out.push((out_range, full_shaped));
                break;
            }
            let raw_cut = full_shaped.closest_index_for_x(wrap_width);
            let cut = choose_wrap_break(slice_str, raw_cut);
            let next_end = cursor + cut;
            let sub_runs = build_slice_runs(cursor..next_end, base_run, marked_range, accent);
            let sub_shaped = window.text_system().shape_line(
                SharedString::from(display_text[cursor..next_end].to_string()),
                font_size,
                &sub_runs,
                None,
            );
            let out_range = if is_placeholder {
                0..0
            } else {
                cursor..next_end
            };
            out.push((out_range, sub_shaped));
            cursor = next_end;
        }
    }
    if out.is_empty() {
        let shaped = window
            .text_system()
            .shape_line(SharedString::default(), font_size, &[], None);
        out.push((0..0, shaped));
    }
    out
}

pub(crate) fn logical_line_ranges(text: &str) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    let mut start = 0;
    for (idx, ch) in text.char_indices() {
        if ch == '\n' {
            ranges.push(start..idx);
            start = idx + 1;
        }
    }
    ranges.push(start..text.len());
    ranges
}

pub(crate) fn choose_wrap_break(slice: &str, raw_cut: usize) -> usize {
    if slice.is_empty() {
        return 0;
    }
    let clamped = clamp_char_boundary(slice, raw_cut);
    let min_step = slice.chars().next().map_or(slice.len(), |c| c.len_utf8());
    let candidate = clamped.max(min_step).min(slice.len());
    if candidate >= slice.len() {
        return slice.len();
    }
    if let Some(ws) = slice[..candidate].rfind(|c: char| c.is_ascii_whitespace())
        && ws > 0
    {
        return ws + 1;
    }
    candidate
}

pub(crate) fn line_index_for_caret(lines: &[Range<usize>], caret: usize) -> usize {
    if lines.is_empty() {
        return 0;
    }
    for (i, range) in lines.iter().enumerate() {
        if i + 1 == lines.len() {
            return i;
        }
        let next_start = lines[i + 1].start;
        if (caret >= range.start && caret < range.end)
            || (caret == range.end && next_start > range.end)
        {
            return i;
        }
    }
    lines.len() - 1
}

fn sanitize_single_line(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '\r' | '\n' | '\t' => ' ',
            _ => c,
        })
        .collect()
}

pub(crate) fn sanitize_multiline(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push('\n');
            }
            '\t' => out.push_str("  "),
            _ => out.push(c),
        }
    }
    out
}

fn clamp_char_boundary(text: &str, offset: usize) -> usize {
    let mut best = offset.min(text.len());
    while best > 0 && !text.is_char_boundary(best) {
        best -= 1;
    }
    best
}

struct SimpleTooltip {
    text: SharedString,
    theme: ThemePalette,
}

impl Render for SimpleTooltip {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div().pl(px(4.)).pt(px(4.)).child(
            div()
                .px(px(8.))
                .py(px(4.))
                .rounded(px(6.))
                .bg(self.theme.bg_floating)
                .border_1()
                .border_color(self.theme.border_strong)
                .text_size(px(12.))
                .line_height(px(16.))
                .text_color(self.theme.text_primary)
                .child(self.text.clone()),
        )
    }
}

/// Reusable themed tooltip builder for GPUI `.tooltip(...)`.
pub fn tooltip_view(
    label: impl Into<SharedString>,
    theme: ThemePalette,
) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let text: SharedString = label.into();
    move |_window, cx| {
        let text = text.clone();
        cx.new(|_| SimpleTooltip { text, theme }).into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multiline_helpers_preserve_newlines_and_wrap_boundaries() {
        assert_eq!(sanitize_multiline("a\r\nb\tc\rd"), "a\nb  c\nd");
        assert_eq!(logical_line_ranges(""), vec![0..0]);
        assert_eq!(logical_line_ranges("abc\n"), vec![0..3, 4..4]);
        assert_eq!(logical_line_ranges("abc\ndef"), vec![0..3, 4..7]);

        assert_eq!(choose_wrap_break("hello world again", 8), 6);
        assert_eq!(choose_wrap_break("superlongword", 5), 5);

        let wrapped = vec![0..5, 5..10, 11..14, 15..15];
        assert_eq!(line_index_for_caret(&wrapped, 0), 0);
        assert_eq!(line_index_for_caret(&wrapped, 5), 1);
        assert_eq!(line_index_for_caret(&wrapped, 10), 1);
        assert_eq!(line_index_for_caret(&wrapped, 11), 2);
        assert_eq!(line_index_for_caret(&wrapped, 14), 2);
        assert_eq!(line_index_for_caret(&wrapped, 15), 3);
    }

    #[test]
    fn dark_palette_uses_warm_tokens_and_separates_borders() {
        let dark = ThemePalette::for_mode(ThemeMode::Dark);
        assert_eq!(dark.bg_app, hex(0x12100E));
        assert_eq!(dark.bg_panel, hex(0x1A1714));
        assert_eq!(dark.bg_elevated, hex(0x221E1A));
        assert_eq!(dark.text_primary, hex(0xE8E1D5));
        assert_eq!(dark.text_muted, hex(0xA79D8F));
        assert_eq!(dark.accent, hex(0xC97B4A));
        assert_eq!(dark.border, hex(0x2E2823));
        assert_eq!(dark.border_subtle, hex(0x241F1A));
        assert_ne!(dark.border, dark.border_subtle);

        for icon in [
            UiIcon::Close,
            UiIcon::Copy,
            UiIcon::Citation,
            UiIcon::RevealInGraph,
            UiIcon::EyeContext,
            UiIcon::Warning,
            UiIcon::Plus,
            UiIcon::Minus,
            UiIcon::Overflow,
            UiIcon::Search,
            UiIcon::ChevronDown,
            UiIcon::ChevronRight,
            UiIcon::ChevronUp,
            UiIcon::Edit,
            UiIcon::Forget,
            UiIcon::Filter,
            UiIcon::Sort,
            UiIcon::ArrowRight,
            UiIcon::ArrowUp,
        ] {
            assert!(!ui_icon_glyph(icon, true).is_empty());
            assert!(!ui_icon_glyph(icon, false).is_empty());
        }
    }

    #[test]
    fn select_mono_font_prefers_first_installed_candidate_and_falls_back() {
        let installed = vec![
            "Inter".to_string(),
            "Menlo".to_string(),
            "Monaco".to_string(),
        ];
        assert_eq!(
            select_mono_font_family(&installed, &["SF Mono", "Menlo", "Monaco"], "Courier New"),
            "Menlo"
        );
        assert_eq!(
            select_mono_font_family(&[], &["SF Mono", "Menlo"], "Menlo"),
            "Menlo"
        );
        assert!(!resolved_mono_font_family().is_empty());
        assert!(!primary_shortcut_label("K").is_empty());
    }
}
