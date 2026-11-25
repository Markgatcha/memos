use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gpui::{
    AccessibleAction, AnyElement, Bounds, Context, CursorStyle, EventEmitter, FontWeight, Hsla,
    InteractiveElement, IntoElement, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent,
    ParentElement, PathBuilder, Pixels, Point, Render, Role, ScrollDelta, ScrollEvent, ShapedLine,
    SharedString, StatefulInteractiveElement, Styled, Task, TextAlign, TextRun, Window, canvas,
    div, fill, point, prelude::FluentBuilder, px, quad, size,
};
use lyon::geom::QuadraticBezierSegment;
use lyon::math::point as lyon_point;
use lyon::path::Event as LyonEvent;

use crate::core::model::{
    GraphEdgeData, GraphMode, GraphNodeData, GraphSnapshot, short_citation_id,
};
use crate::ui::views::{ThemePalette, UiIcon, render_ui_icon, status_dot, tooltip_view};

const MAX_PAN_WORLD: f32 = 12_000.0;
const MIN_ZOOM: f32 = 0.08;
const MAX_ZOOM: f32 = 6.0;

#[derive(Clone, Debug)]
pub enum GraphEvent {
    SwitchMode(GraphMode),
    /// Open the full inspector for a memory (Enter, or Open in the graph card).
    SelectMemory(String),
    /// A node was picked on the canvas; the graph shows its compact card.
    Inspect(Option<String>),
    Hover(Option<String>),
    PopoverOpened,
}

#[derive(Clone, Debug)]
pub struct PositionedNode {
    pub x: f32,
    pub y: f32,
    pub radius: f32,
    pub data: GraphNodeData,
}

#[derive(Clone, Debug)]
pub struct GroupAnchorLabel {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub count: usize,
}

#[derive(Clone, Debug)]
pub struct TimelineTick {
    pub x: f32,
    pub label: String,
}

#[derive(Clone, Debug)]
pub struct ComputedLayout {
    pub mode: GraphMode,
    pub nodes: Vec<PositionedNode>,
    pub edges: Vec<GraphEdgeData>,
    pub group_labels: Vec<GroupAnchorLabel>,
    pub timeline_ticks: Vec<TimelineTick>,
    pub total_matching_nodes: usize,
    pub clustered_nodes: usize,
    pub min_x: f32,
    pub max_x: f32,
    pub min_y: f32,
    pub max_y: f32,
    pub elapsed_ms: f32,
}

#[derive(Clone, Copy, Debug)]
struct GraphViewport {
    pan_x: f32,
    pan_y: f32,
    zoom: f32,
}

impl Default for GraphViewport {
    fn default() -> Self {
        Self {
            pan_x: 0.0,
            pan_y: 0.0,
            zoom: 1.0,
        }
    }
}

impl GraphViewport {
    fn world_to_screen(self, bounds: Bounds<Pixels>, wx: f32, wy: f32) -> Point<Pixels> {
        let cx = bounds.origin.x.as_f32() + bounds.size.width.as_f32() * 0.5;
        let cy = bounds.origin.y.as_f32() + bounds.size.height.as_f32() * 0.5;
        point(
            px(cx + (wx + self.pan_x) * self.zoom),
            px(cy + (wy + self.pan_y) * self.zoom),
        )
    }

    fn screen_to_world(self, bounds: Bounds<Pixels>, pos: Point<Pixels>) -> (f32, f32) {
        let cx = bounds.origin.x.as_f32() + bounds.size.width.as_f32() * 0.5;
        let cy = bounds.origin.y.as_f32() + bounds.size.height.as_f32() * 0.5;
        let wx = (pos.x.as_f32() - cx) / self.zoom - self.pan_x;
        let wy = (pos.y.as_f32() - cy) / self.zoom - self.pan_y;
        (wx, wy)
    }
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct LabelCacheKey {
    text: SharedString,
    size_tenth_px: u32,
    fg_bits: u32,
    halo_bits: u32,
}

#[derive(Default)]
struct LabelShapeCache {
    entries: HashMap<LabelCacheKey, (ShapedLine, ShapedLine)>,
}

impl LabelShapeCache {
    fn get_or_shape(
        &mut self,
        text: &SharedString,
        size_px: Pixels,
        fg: Hsla,
        halo_bg: Hsla,
        font: &gpui::Font,
        window: &mut Window,
    ) -> &(ShapedLine, ShapedLine) {
        if self.entries.len() >= 512 {
            self.entries.clear();
        }
        let key = LabelCacheKey {
            text: text.clone(),
            size_tenth_px: (size_px.as_f32() * 10.0).round() as u32,
            fg_bits: hsla_bits(fg),
            halo_bits: hsla_bits(halo_bg),
        };
        self.entries.entry(key).or_insert_with(|| {
            let halo_run = TextRun {
                len: text.len(),
                font: font.clone(),
                color: halo_bg,
                background_color: None,
                underline: None,
                strikethrough: None,
            };
            let halo_line =
                window
                    .text_system()
                    .shape_line(text.clone(), size_px, &[halo_run], None);
            let fg_run = TextRun {
                len: text.len(),
                font: font.clone(),
                color: fg,
                background_color: None,
                underline: None,
                strikethrough: None,
            };
            let fg_line = window
                .text_system()
                .shape_line(text.clone(), size_px, &[fg_run], None);
            (halo_line, fg_line)
        })
    }
}

fn hsla_bits(c: Hsla) -> u32 {
    let h = (c.h.clamp(0.0, 1.0) * 255.0).round() as u32;
    let s = (c.s.clamp(0.0, 1.0) * 255.0).round() as u32;
    let l = (c.l.clamp(0.0, 1.0) * 255.0).round() as u32;
    let a = (c.a.clamp(0.0, 1.0) * 255.0).round() as u32;
    (h << 24) | (s << 16) | (l << 8) | a
}

#[derive(Clone)]
struct CanvasRenderData {
    layout: Arc<ComputedLayout>,
    viewport: GraphViewport,
    selected_id: Option<String>,
    hovered_node: Option<usize>,
    hovered_edge: Option<usize>,
    external_hovered_id: Option<String>,
    constellation: bool,
    drift_phase: f32,
    has_legend: bool,
    /// Node indices kept at full strength in focus mode (selection + neighbors).
    focus: Option<Arc<HashSet<usize>>>,
    theme: ThemePalette,
    label_cache: Rc<RefCell<LabelShapeCache>>,
}

/// Selected node plus its direct neighbors, by layout index.
pub(crate) fn neighborhood(layout: &ComputedLayout, memory_id: &str) -> Option<HashSet<usize>> {
    let center = layout
        .nodes
        .iter()
        .position(|n| n.data.memory_id.as_deref() == Some(memory_id))?;
    let mut set = HashSet::new();
    set.insert(center);
    for e in &layout.edges {
        if e.source_idx == center {
            set.insert(e.target_idx);
        } else if e.target_idx == center {
            set.insert(e.source_idx);
        }
    }
    Some(set)
}

/// Facts for the compact graph inspector card.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct NodeSummary {
    pub label: String,
    pub node_type: String,
    pub group: String,
    pub importance: f32,
    pub created_at: i64,
    pub links: usize,
    pub conflicts: usize,
}

pub(crate) fn summarize_node(layout: &ComputedLayout, memory_id: &str) -> Option<NodeSummary> {
    let (ix, node) = layout
        .nodes
        .iter()
        .enumerate()
        .find(|(_, n)| n.data.memory_id.as_deref() == Some(memory_id))?;
    let mut links = 0;
    let mut conflicts = 0;
    for e in &layout.edges {
        if e.source_idx == ix || e.target_idx == ix {
            links += 1;
            if e.is_contradiction {
                conflicts += 1;
            }
        }
    }
    Some(NodeSummary {
        label: strip_short_id_prefix(&node.data.label, node.data.memory_id.as_deref()).to_string(),
        node_type: node.data.node_type.clone(),
        group: node.data.group.clone(),
        importance: node.data.importance,
        created_at: node.data.created_at,
        links,
        conflicts,
    })
}

/// Interactive GPUI graph canvas with background force/temporal layout and lyon edges.
pub struct GraphView {
    mode: GraphMode,
    layout: Option<Arc<ComputedLayout>>,
    is_loading: bool,
    error: Option<String>,
    viewport: GraphViewport,
    selected_id: Option<String>,
    /// Node index for arrow-key traversal; separate from mouse selection so
    /// the ring survives until the next reload.
    keyboard_index: Option<usize>,
    pending_center_on_load: bool,
    needs_fit_on_bounds: bool,
    hovered_node: Option<usize>,
    hovered_edge: Option<usize>,
    external_hovered_id: Option<String>,
    last_bounds: Option<Bounds<Pixels>>,
    dragging: bool,
    last_drag_pos: Option<Point<Pixels>>,
    drag_distance: f32,
    mode_menu_open: bool,
    constellation: bool,
    drift_phase: f32,
    active_visible: bool,
    window_active: bool,
    no_fun: bool,
    layout_generation: u64,
    focus_mode: bool,
    focus_set: Option<Arc<HashSet<usize>>>,
    inspector_dismissed: bool,
    label_cache: Rc<RefCell<LabelShapeCache>>,
    _layout_task: Option<Task<()>>,
    _drift_task: Option<Task<()>>,
    theme: ThemePalette,
}

/// Ambient (non-selected) node labels stay out of the overview. The fit
/// zoom now fills the canvas (~1.2), so showing every top-importance label
/// there just produces collisions; zoom in to read names.
pub const GRAPH_AMBIENT_LABEL_MIN_ZOOM: f32 = 1.5;

pub(crate) fn is_node_hovered(
    hovered_node: Option<usize>,
    node_ix: usize,
    external_hovered_id: Option<&str>,
    memory_id: Option<&str>,
) -> bool {
    hovered_node == Some(node_ix)
        || (external_hovered_id.is_some() && memory_id == external_hovered_id)
}

pub(crate) fn should_show_node_label(
    node_in_canvas: bool,
    is_selected: bool,
    is_hovered: bool,
    zoom: f32,
    is_top_important: bool,
) -> bool {
    node_in_canvas
        && (is_selected || is_hovered || (zoom >= GRAPH_AMBIENT_LABEL_MIN_ZOOM && is_top_important))
}

pub(crate) type LabelRect = (f32, f32, f32, f32);

#[derive(Clone, Copy, Debug)]
pub(crate) struct LabelPlacement {
    pub x: f32,
    pub y: f32,
    pub rect: LabelRect,
}

pub(crate) fn rects_overlap_any(a: LabelRect, list: &[LabelRect]) -> bool {
    list.iter()
        .any(|&(ox0, oy0, ox1, oy1)| a.0 < ox1 && a.2 > ox0 && a.1 < oy1 && a.3 > oy0)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn pick_non_overlapping_label_pos(
    anchor_x: f32,
    anchor_y: f32,
    radius: f32,
    label_w: f32,
    label_h: f32,
    pad_x: f32,
    pad_y: f32,
    canvas: LabelRect,
    occupied: &[LabelRect],
    hud_rects: &[LabelRect],
    priority: bool,
) -> Option<LabelPlacement> {
    let (l, t, r_edge, b) = canvas;
    let max_y = (b - label_h - 4.0).max(t + 4.0);
    let y0 = if priority {
        (anchor_y - 7.0).clamp(t + 4.0, max_y)
    } else {
        let candidate = anchor_y - 7.0;
        if candidate < t + 4.0 || candidate + label_h > b - 4.0 {
            return None;
        }
        candidate
    };

    let right_x = anchor_x + radius + 6.0;
    let left_x = anchor_x - radius - 6.0 - label_w;
    let mk_rect = |lx: f32| -> LabelRect {
        (
            lx - pad_x,
            y0 - pad_y,
            lx + label_w + pad_x,
            y0 + label_h + pad_y,
        )
    };
    let right_rect = mk_rect(right_x);
    let left_rect = mk_rect(left_x);

    let right_in_bounds = right_rect.0 >= l + 4.0 && right_rect.2 <= r_edge - 4.0;
    let left_in_bounds = left_rect.0 >= l + 4.0 && left_rect.2 <= r_edge - 4.0;

    if right_in_bounds && !rects_overlap_any(right_rect, occupied) {
        return Some(LabelPlacement {
            x: right_x,
            y: y0,
            rect: right_rect,
        });
    }
    if left_in_bounds && !rects_overlap_any(left_rect, occupied) {
        return Some(LabelPlacement {
            x: left_x,
            y: y0,
            rect: left_rect,
        });
    }
    if !priority {
        return None;
    }

    if right_in_bounds && !rects_overlap_any(right_rect, hud_rects) {
        return Some(LabelPlacement {
            x: right_x,
            y: y0,
            rect: right_rect,
        });
    }
    if left_in_bounds && !rects_overlap_any(left_rect, hud_rects) {
        return Some(LabelPlacement {
            x: left_x,
            y: y0,
            rect: left_rect,
        });
    }

    // Clamp priority (selected/hovered) labels inside canvas horizontal bounds as last resort.
    let max_x = (r_edge - label_w - 6.0).max(l + 6.0);
    let clamped_x = right_x.clamp(l + 6.0, max_x);
    let clamped_rect = mk_rect(clamped_x);
    if !rects_overlap_any(clamped_rect, hud_rects) {
        Some(LabelPlacement {
            x: clamped_x,
            y: y0,
            rect: clamped_rect,
        })
    } else {
        None
    }
}

impl GraphView {
    pub fn new(mode: GraphMode, theme: ThemePalette) -> Self {
        Self {
            mode,
            layout: None,
            is_loading: true,
            error: None,
            viewport: GraphViewport::default(),
            selected_id: None,
            keyboard_index: None,
            pending_center_on_load: false,
            needs_fit_on_bounds: false,
            hovered_node: None,
            hovered_edge: None,
            external_hovered_id: None,
            last_bounds: None,
            dragging: false,
            last_drag_pos: None,
            drag_distance: 0.0,
            mode_menu_open: false,
            constellation: false,
            drift_phase: 0.0,
            active_visible: false,
            window_active: true,
            no_fun: false,
            layout_generation: 0,
            focus_mode: false,
            focus_set: None,
            inspector_dismissed: false,
            label_cache: Rc::new(RefCell::new(LabelShapeCache::default())),
            _layout_task: None,
            _drift_task: None,
            theme,
        }
    }

    pub fn set_external_hovered_id(&mut self, hovered_id: Option<String>, cx: &mut Context<Self>) {
        if self.external_hovered_id != hovered_id {
            self.external_hovered_id = hovered_id;
            cx.notify();
        }
    }

    /// Dim everything except the selected node and its direct neighbors.
    pub fn toggle_focus_mode(&mut self, cx: &mut Context<Self>) {
        self.focus_mode = !self.focus_mode;
        self.recompute_focus();
        cx.notify();
    }

    pub fn is_focus_mode(&self) -> bool {
        self.focus_mode
    }

    fn recompute_focus(&mut self) {
        self.focus_set = if self.focus_mode {
            match (&self.layout, &self.selected_id) {
                (Some(layout), Some(id)) => neighborhood(layout, id).map(Arc::new),
                _ => None,
            }
        } else {
            None
        };
    }

    /// Zoom around the canvas center (toolbar buttons and +/- keys).
    pub fn zoom_by(&mut self, factor: f32, cx: &mut Context<Self>) {
        self.needs_fit_on_bounds = false;
        self.viewport.zoom = (self.viewport.zoom * factor).clamp(MIN_ZOOM, MAX_ZOOM);
        cx.notify();
    }

    fn select_on_canvas(&mut self, memory_id: Option<String>, cx: &mut Context<Self>) {
        self.selected_id = memory_id.clone();
        self.inspector_dismissed = false;
        self.recompute_focus();
        cx.emit(GraphEvent::Inspect(memory_id));
        cx.notify();
    }

    pub fn fit_view(&mut self, cx: &mut Context<Self>) {
        self.mode_menu_open = false;
        self.needs_fit_on_bounds = true;
        self.fit_to_bounds(None);
        cx.notify();
    }

    pub fn is_constellation(&self) -> bool {
        self.constellation
    }

    pub fn set_no_fun(&mut self, no_fun: bool, cx: &mut Context<Self>) {
        self.no_fun = no_fun;
        if no_fun {
            self.constellation = false;
            self._drift_task = None;
        }
        cx.notify();
    }

    pub fn set_active_visible(&mut self, visible: bool, cx: &mut Context<Self>) {
        if self.active_visible != visible {
            self.active_visible = visible;
            self.sync_drift_task(cx);
        }
    }

    /// Pause constellation drift when the window is in the background.
    pub fn set_window_active(&mut self, active: bool, cx: &mut Context<Self>) {
        if self.window_active != active {
            self.window_active = active;
            self.sync_drift_task(cx);
        }
    }

    pub fn set_constellation(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if self.no_fun {
            return;
        }
        if self.constellation != enabled {
            self.constellation = enabled;
            self.sync_drift_task(cx);
            cx.notify();
        }
    }

    pub fn toggle_constellation(&mut self, cx: &mut Context<Self>) {
        let next = !self.constellation;
        self.set_constellation(next, cx);
    }

    fn sync_drift_task(&mut self, cx: &mut Context<Self>) {
        if !self.constellation
            || !self.active_visible
            || !self.window_active
            || self.no_fun
            || cx.reduce_motion()
        {
            self._drift_task = None;
            return;
        }
        if self._drift_task.is_some() {
            return;
        }
        self._drift_task = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(33))
                    .await;
                let mut keep_going = false;
                let res = this.update(cx, |view, cx| {
                    if !view.constellation
                        || !view.active_visible
                        || !view.window_active
                        || view.no_fun
                        || cx.reduce_motion()
                    {
                        view._drift_task = None;
                        keep_going = false;
                        return;
                    }
                    // Gentle constellation drift ~0.18 rad/s.
                    view.drift_phase = (view.drift_phase + 0.006) % std::f32::consts::TAU;
                    keep_going = true;
                    cx.notify();
                });
                if res.is_err() || !keep_going {
                    break;
                }
            }
        }));
    }

    pub fn mode(&self) -> GraphMode {
        self.mode
    }

    pub fn set_mode(&mut self, mode: GraphMode, cx: &mut Context<Self>) {
        self.mode_menu_open = false;
        if self.mode != mode {
            self.mode = mode;
            self.hovered_node = None;
            self.hovered_edge = None;
            cx.notify();
        }
    }

    pub fn set_loading(&mut self, loading: bool, cx: &mut Context<Self>) {
        self.is_loading = loading;
        if loading {
            self.error = None;
        }
        cx.notify();
    }

    pub fn has_open_popover(&self) -> bool {
        self.mode_menu_open
    }

    pub fn close_popovers(&mut self, cx: &mut Context<Self>) {
        if self.mode_menu_open {
            self.mode_menu_open = false;
            cx.notify();
        }
    }

    pub fn set_error(&mut self, err: Option<String>, cx: &mut Context<Self>) {
        self.is_loading = false;
        self.error = err;
        cx.notify();
    }

    pub fn set_theme(&mut self, theme: ThemePalette, cx: &mut Context<Self>) {
        if self.theme.is_dark != theme.is_dark {
            self.label_cache.borrow_mut().entries.clear();
        }
        self.theme = theme;
        cx.notify();
    }

    pub fn set_selected(
        &mut self,
        memory_id: Option<String>,
        center: bool,
        cx: &mut Context<Self>,
    ) {
        self.selected_id = memory_id.clone();
        self.inspector_dismissed = false;
        self.recompute_focus();
        if center {
            if let (Some(id), Some(layout)) = (memory_id, &self.layout)
                && let Some(node) = layout
                    .nodes
                    .iter()
                    .find(|n| n.data.memory_id.as_deref() == Some(id.as_str()))
            {
                self.pending_center_on_load = false;
                self.needs_fit_on_bounds = false;
                self.viewport.pan_x = -node.x;
                self.viewport.pan_y = -node.y;
                if self.viewport.zoom < 1.15 {
                    self.viewport.zoom = 1.25;
                }
            } else {
                self.pending_center_on_load = true;
            }
        }
        cx.notify();
    }

    /// Move the keyboard cursor through real (non-cluster) nodes.
    pub fn step_keyboard(&mut self, delta: isize, cx: &mut Context<Self>) {
        let Some(layout) = self.layout.as_ref() else {
            return;
        };
        let indices: Vec<usize> = layout
            .nodes
            .iter()
            .enumerate()
            .filter(|(_, n)| n.data.memory_id.is_some())
            .map(|(i, _)| i)
            .collect();
        if indices.is_empty() {
            return;
        }
        let current = self
            .keyboard_index
            .and_then(|k| indices.iter().position(|&i| i == k));
        let next = match current {
            Some(p) => (p as isize)
                .saturating_add(delta)
                .clamp(0, indices.len() as isize - 1) as usize,
            None => {
                if delta < 0 {
                    indices.len() - 1
                } else {
                    0
                }
            }
        };
        let ix = indices[next];
        let memory_id = layout.nodes.get(ix).and_then(|n| n.data.memory_id.clone());
        self.keyboard_index = Some(ix);
        self.select_on_canvas(memory_id, cx);
    }

    /// Currently ringed node, used by Enter to open the detail pane.
    pub fn keyboard_selected_id(&self) -> Option<String> {
        self.selected_id.clone()
    }

    /// Schedule force-directed / temporal layout strictly on GPUI's background executor.
    pub fn apply_snapshot(&mut self, snapshot: GraphSnapshot, cx: &mut Context<Self>) {
        self.mode = snapshot.mode;
        self.is_loading = true;
        self.error = None;
        self.hovered_node = None;
        self.hovered_edge = None;
        self.keyboard_index = None;
        self.layout_generation = self.layout_generation.wrapping_add(1);
        let generation = self.layout_generation;
        let selected_id = self.selected_id.clone();
        cx.notify();

        self._layout_task = Some(cx.spawn(async move |this, cx| {
            let computed = cx
                .background_executor()
                .spawn(async move { compute_graph_layout(&snapshot) })
                .await;

            let _ = this.update(cx, |view, cx| {
                if view.layout_generation != generation {
                    return;
                }
                tracing::info!(
                    mode = view.mode.label(),
                    nodes = computed.nodes.len(),
                    edges = computed.edges.len(),
                    clustered = computed.clustered_nodes,
                    layout_ms = computed.elapsed_ms,
                    "graph layout ready"
                );
                view.label_cache.borrow_mut().entries.clear();
                view.layout = Some(Arc::new(computed));
                view.is_loading = false;
                view.recompute_focus();
                let focus_id = if std::mem::take(&mut view.pending_center_on_load) {
                    selected_id.as_deref()
                } else {
                    None
                };
                view.needs_fit_on_bounds = focus_id.is_none();
                view.fit_to_bounds(focus_id);
                cx.notify();
            });
        }));
    }

    fn fit_to_bounds(&mut self, focus_id: Option<&str>) {
        let Some(layout) = &self.layout else {
            return;
        };
        if let Some(id) = focus_id
            && let Some(node) = layout
                .nodes
                .iter()
                .find(|n| n.data.memory_id.as_deref() == Some(id))
        {
            self.needs_fit_on_bounds = false;
            self.viewport.pan_x = -node.x;
            self.viewport.pan_y = -node.y;
            self.viewport.zoom = 1.2;
            return;
        }
        let (vp_w, vp_h) = self
            .last_bounds
            .map(|b| {
                (
                    b.size.width.as_f32().max(320.0),
                    b.size.height.as_f32().max(240.0),
                )
            })
            .unwrap_or((860.0, 620.0));
        self.viewport = compute_fit_viewport(layout, vp_w, vp_h);
    }

    fn on_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.mode_menu_open {
            self.mode_menu_open = false;
            cx.notify();
        }
        self.dragging = true;
        self.needs_fit_on_bounds = false;
        self.last_drag_pos = Some(event.position);
        self.drag_distance = 0.0;
    }

    fn on_mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.dragging && event.dragging() {
            if let Some(prev) = self.last_drag_pos {
                let dx = event.position.x.as_f32() - prev.x.as_f32();
                let dy = event.position.y.as_f32() - prev.y.as_f32();
                self.drag_distance += (dx * dx + dy * dy).sqrt();
                self.viewport.pan_x = (self.viewport.pan_x + dx / self.viewport.zoom)
                    .clamp(-MAX_PAN_WORLD, MAX_PAN_WORLD);
                self.viewport.pan_y = (self.viewport.pan_y + dy / self.viewport.zoom)
                    .clamp(-MAX_PAN_WORLD, MAX_PAN_WORLD);
                self.last_drag_pos = Some(event.position);
                cx.notify();
            }
            return;
        }

        let (Some(bounds), Some(layout)) = (self.last_bounds, &self.layout) else {
            return;
        };
        let node_hit = hit_test_node(
            layout,
            self.viewport,
            bounds,
            event.position,
            self.constellation,
            self.drift_phase,
        );
        let edge_hit = if node_hit.is_none() {
            hit_test_edge(
                layout,
                self.viewport,
                bounds,
                event.position,
                self.constellation,
                self.drift_phase,
            )
        } else {
            None
        };
        if node_hit != self.hovered_node || edge_hit != self.hovered_edge {
            let node_changed = node_hit != self.hovered_node;
            self.hovered_node = node_hit;
            self.hovered_edge = edge_hit;
            if node_changed {
                let hovered_id = node_hit
                    .and_then(|ix| layout.nodes.get(ix))
                    .and_then(|n| n.data.memory_id.clone());
                cx.emit(GraphEvent::Hover(hovered_id));
            }
            cx.notify();
        }
    }

    fn on_mouse_up(&mut self, event: &MouseUpEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let was_click = self.dragging && self.drag_distance < 4.5;
        self.dragging = false;
        self.last_drag_pos = None;

        if !was_click {
            return;
        }
        let (Some(bounds), Some(layout)) = (self.last_bounds, &self.layout) else {
            return;
        };
        if let Some(node_ix) = hit_test_node(
            layout,
            self.viewport,
            bounds,
            event.position,
            self.constellation,
            self.drift_phase,
        ) && let Some(node) = layout.nodes.get(node_ix)
        {
            if let Some(memory_id) = &node.data.memory_id {
                let memory_id = memory_id.clone();
                self.select_on_canvas(Some(memory_id), cx);
            } else {
                // Cluster node: zoom smoothly onto cluster center.
                self.needs_fit_on_bounds = false;
                self.viewport.pan_x = -node.x;
                self.viewport.pan_y = -node.y;
                self.viewport.zoom = (self.viewport.zoom * 1.45).clamp(MIN_ZOOM, MAX_ZOOM);
                cx.notify();
            }
        }
    }

    fn on_scroll(&mut self, event: &ScrollEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let dy = match event.delta {
            ScrollDelta::Pixels(p) => p.y.as_f32() / 120.0,
            ScrollDelta::Lines(l) => l.y * 0.45,
        };
        if dy.abs() < f32::EPSILON {
            return;
        }
        self.needs_fit_on_bounds = false;
        let factor = (1.0 + dy * 0.16).clamp(0.7, 1.4);
        let old_zoom = self.viewport.zoom;
        let new_zoom = (old_zoom * factor).clamp(MIN_ZOOM, MAX_ZOOM);
        if (new_zoom - old_zoom).abs() < 1e-4 {
            return;
        }

        if let Some(bounds) = self.last_bounds {
            let (wx, wy) = self.viewport.screen_to_world(bounds, event.position);
            self.viewport.zoom = new_zoom;
            let cx_px = bounds.origin.x.as_f32() + bounds.size.width.as_f32() * 0.5;
            let cy_px = bounds.origin.y.as_f32() + bounds.size.height.as_f32() * 0.5;
            self.viewport.pan_x = (event.position.x.as_f32() - cx_px) / new_zoom - wx;
            self.viewport.pan_y = (event.position.y.as_f32() - cy_px) / new_zoom - wy;
        } else {
            self.viewport.zoom = new_zoom;
        }
        cx.notify();
    }
}

impl GraphView {
    fn render_zoom_cluster(&self, cx: &mut Context<Self>) -> AnyElement {
        use crate::ui::views::kit::{ButtonKind, button, icon_button};
        let theme = self.theme;
        let zoom_pct: SharedString = format!("{:.0}%", self.viewport.zoom * 100.0).into();
        div()
            .id("graph-zoom-cluster")
            .absolute()
            .bottom(px(12.))
            .right(px(12.))
            .p(px(2.))
            .rounded(px(8.))
            .bg(theme.bg_panel)
            .border_1()
            .border_color(theme.border_subtle)
            .flex()
            .items_center()
            .gap(px(2.))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                icon_button("graph-zoom-out", UiIcon::Minus, "Zoom out (-)", &theme)
                    .tooltip(tooltip_view("Zoom out (-)", theme))
                    .on_click(cx.listener(|this, _, _, cx| this.zoom_by(0.8, cx))),
            )
            .child(
                div()
                    .w(px(44.))
                    .text_center()
                    .text_size(px(12.))
                    .font_features(crate::ui::views::tabular_nums())
                    .text_color(theme.text_secondary)
                    .child(zoom_pct),
            )
            .child(
                icon_button("graph-zoom-in", UiIcon::Plus, "Zoom in (+)", &theme)
                    .tooltip(tooltip_view("Zoom in (+)", theme))
                    .on_click(cx.listener(|this, _, _, cx| this.zoom_by(1.25, cx))),
            )
            .child(div().w(px(1.)).h(px(16.)).bg(theme.border_subtle))
            .child(
                button("graph-reset-view", "Fit", ButtonKind::Subtle, &theme)
                    .tooltip(tooltip_view("Fit all nodes in view (0)", theme))
                    .on_click(cx.listener(|this, event: &gpui::ClickEvent, _, cx| {
                        this.mode_menu_open = false;
                        if event.click_count() == 3 && !this.no_fun {
                            this.toggle_constellation(cx);
                        } else {
                            this.fit_view(cx);
                        }
                    })),
            )
            .into_any_element()
    }

    fn render_inspector(&self, summary: NodeSummary, cx: &mut Context<Self>) -> AnyElement {
        use crate::ui::views::kit::{ButtonKind, button, icon_button};
        let theme = self.theme;
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let label: SharedString = sanitize_single_line(&summary.label, 120).into();
        let mut facts: Vec<String> = vec![summary.node_type.clone()];
        if !summary.group.trim().is_empty() && summary.group != summary.node_type {
            facts.push(summary.group.clone());
        }
        if summary.created_at > 0 {
            facts.push(format!(
                "{} old",
                crate::core::model::format_relative_age(summary.created_at, now_ms)
            ));
        }
        let facts: SharedString = facts.join(" · ").into();
        let links: SharedString = match summary.links {
            0 => "No links".to_string(),
            1 => "1 link".to_string(),
            n => format!("{n} links"),
        }
        .into();
        let importance: SharedString = format!(
            "importance {:.0}%",
            (summary.importance.clamp(0.0, 1.0) * 100.0).round()
        )
        .into();
        let focus_label = if self.focus_mode { "Show all" } else { "Focus" };
        let open_id = self.selected_id.clone();

        div()
            .id("graph-inspector")
            .role(Role::Region)
            .aria_label("Selected node")
            .absolute()
            .top(px(12.))
            .left(px(12.))
            .w(px(276.))
            .p(px(12.))
            .rounded(px(10.))
            .bg(theme.bg_panel)
            .border_1()
            .border_color(theme.border)
            .shadow_md()
            .flex()
            .flex_col()
            .gap(px(8.))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_scroll(|_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .flex()
                    .items_start()
                    .gap(px(8.))
                    .child(
                        div()
                            .mt(px(5.))
                            .w(px(8.))
                            .h(px(8.))
                            .rounded_full()
                            .flex_shrink_0()
                            .bg(theme.type_color(&summary.node_type)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .text_size(px(13.))
                            .line_height(px(18.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.text_primary)
                            .line_clamp(3)
                            .child(label),
                    )
                    .child(
                        icon_button("graph-inspector-close", UiIcon::Close, "Hide card", &theme)
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.inspector_dismissed = true;
                                cx.notify();
                            })),
                    ),
            )
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(theme.text_muted)
                    .truncate()
                    .child(facts),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .text_size(px(12.))
                    .font_features(crate::ui::views::tabular_nums())
                    .text_color(theme.text_secondary)
                    .child(links)
                    .child(importance)
                    .when(summary.conflicts > 0, |row| {
                        row.child(crate::ui::views::kit::state_marker(
                            if summary.conflicts == 1 {
                                "1 conflict".to_string()
                            } else {
                                format!("{} conflicts", summary.conflicts)
                            },
                            theme.danger,
                        ))
                    }),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .child(
                        button(
                            "graph-inspector-open",
                            "Open",
                            ButtonKind::Secondary,
                            &theme,
                        )
                        .tooltip(tooltip_view("Open in the inspector (Enter)", theme))
                        .on_click(cx.listener(move |_, _, _, cx| {
                            if let Some(id) = open_id.clone() {
                                cx.emit(GraphEvent::SelectMemory(id));
                            }
                        })),
                    )
                    .child(
                        button(
                            "graph-inspector-focus",
                            focus_label,
                            ButtonKind::Subtle,
                            &theme,
                        )
                        .tooltip(tooltip_view(
                            "Dim everything but this node and its links (F)",
                            theme,
                        ))
                        .on_click(cx.listener(|this, _, _, cx| this.toggle_focus_mode(cx))),
                    ),
            )
            .into_any_element()
    }
}

impl EventEmitter<GraphEvent> for GraphView {}

impl Render for GraphView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let view_entity = cx.entity();
        let compact_toolbar = window.viewport_size().width < px(1040.)
            || self.last_bounds.is_some_and(|b| b.size.width < px(640.));

        let mode_buttons: Vec<AnyElement> = GraphMode::ALL
            .into_iter()
            .enumerate()
            .map(|(ix, mode)| {
                let active = self.mode == mode;
                div()
                    .id(("graph-mode", ix))
                    .focusable()
                    .role(Role::Button)
                    .aria_label(mode.label())
                    .flex_shrink_0()
                    .h(px(26.))
                    .px(px(10.))
                    .rounded(px(5.))
                    .cursor_pointer()
                    .flex()
                    .items_center()
                    .text_size(px(12.))
                    .when(active, |el| {
                        el.bg(theme.bg_elevated)
                            .text_color(theme.text_primary)
                            .font_weight(FontWeight::MEDIUM)
                    })
                    .when(!active, |el| {
                        el.text_color(theme.text_muted)
                            .hover(|s| s.bg(theme.bg_selected).text_color(theme.text_primary))
                    })
                    .focus_visible(move |s| s.border_1().border_color(theme.accent))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.mode_menu_open = false;
                        if this.mode != mode {
                            this.mode = mode;
                            cx.emit(GraphEvent::SwitchMode(mode));
                            cx.notify();
                        }
                    }))
                    .child(mode.label())
                    .into_any_element()
            })
            .collect();

        let hovered_edge_info: Option<(SharedString, Hsla)> = self.layout.as_ref().and_then(|l| {
            let edge_ix = self.hovered_edge?;
            let edge = l.edges.get(edge_ix)?;
            Some((
                SharedString::from(edge.relation.clone()),
                theme.edge_color(&edge.relation),
            ))
        });

        let legend_entries: Vec<(String, Hsla)> = if let Some(layout) = &self.layout {
            let mut seen = std::collections::BTreeSet::new();
            let mut entries = Vec::new();
            for node in &layout.nodes {
                let ty = node.data.node_type.trim();
                if !ty.is_empty() && seen.insert(ty.to_string()) {
                    entries.push((ty.to_string(), theme.type_color(ty)));
                }
            }
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            entries.truncate(4);
            if layout.nodes.iter().any(|n| n.data.has_contradiction) {
                entries.push(("contradiction".to_string(), theme.danger));
            }
            entries
        } else {
            Vec::new()
        };

        let stats_summary: Option<SharedString> = self.layout.as_ref().map(|l| {
            // `nodes.len()` is what is drawn (including cluster nodes), not
            // what matched; use the store-side total so a clustered 50k store
            // does not read as "1,936 memories".
            let total = l.total_matching_nodes.max(l.nodes.len());
            if l.clustered_nodes > 0 {
                SharedString::from(format!(
                    "{} memories · {} links · {} grouped",
                    total,
                    l.edges.len(),
                    l.clustered_nodes
                ))
            } else {
                SharedString::from(format!("{} memories · {} links", total, l.edges.len()))
            }
        });
        let has_legend = !legend_entries.is_empty();

        let render_data = self.layout.as_ref().map(|layout| CanvasRenderData {
            layout: layout.clone(),
            viewport: self.viewport,
            selected_id: self.selected_id.clone(),
            hovered_node: self.hovered_node,
            hovered_edge: self.hovered_edge,
            external_hovered_id: self.external_hovered_id.clone(),
            constellation: self.constellation,
            drift_phase: self.drift_phase,
            has_legend,
            focus: self.focus_set.clone(),
            theme,
            label_cache: self.label_cache.clone(),
        });

        let inspector: Option<AnyElement> = if self.inspector_dismissed {
            None
        } else {
            self.selected_id
                .as_deref()
                .zip(self.layout.as_ref())
                .and_then(|(id, layout)| summarize_node(layout, id))
                .map(|summary| self.render_inspector(summary, cx))
        };
        let inspector_shown = inspector.is_some();

        let mode_control: AnyElement = if compact_toolbar {
            div()
                .relative()
                .child({
                    let mode_expand = cx.entity().clone();
                    let mode_collapse = mode_expand.clone();
                    div()
                        .id("graph-mode-dropdown")
                        .focusable()
                        .cursor_pointer()
                        .role(Role::Button)
                        .aria_label("Select graph mode")
                        .aria_expanded(self.mode_menu_open)
                        .h(px(28.))
                        .px(px(10.))
                        .rounded(px(6.))
                        .bg(theme.bg_elevated)
                        .border_1()
                        .border_color(theme.border_subtle)
                        .hover(move |s| s.bg(theme.bg_selected))
                        .focus_visible(move |s| s.border_1().border_color(theme.accent))
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .text_size(px(12.))
                        .text_color(theme.text_primary)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.mode_menu_open = !this.mode_menu_open;
                            if this.mode_menu_open {
                                cx.emit(GraphEvent::PopoverOpened);
                            }
                            cx.notify();
                        }))
                        .on_a11y_action(AccessibleAction::Expand, move |_, _, cx| {
                            mode_expand.update(cx, |this, cx| {
                                if !this.mode_menu_open {
                                    this.mode_menu_open = true;
                                    cx.emit(GraphEvent::PopoverOpened);
                                    cx.notify();
                                }
                            });
                        })
                        .on_a11y_action(AccessibleAction::Collapse, move |_, _, cx| {
                            mode_collapse.update(cx, |this, cx| {
                                if this.mode_menu_open {
                                    this.mode_menu_open = false;
                                    cx.notify();
                                }
                            });
                        })
                        .child(format!("View: {}", self.mode.label()))
                        .child(render_ui_icon(UiIcon::ChevronDown, 12.0, theme.text_muted))
                })
                .when(self.mode_menu_open, |wrap| {
                    wrap.child(
                        gpui::deferred(
                            div()
                                .id("graph-mode-popover")
                                .absolute()
                                .top(px(32.))
                                .left(px(0.))
                                .w(px(164.))
                                .rounded(px(10.))
                                .bg(theme.bg_floating)
                                .border_1()
                                .border_color(theme.border_strong)
                                .p(px(4.))
                                .flex()
                                .flex_col()
                                .gap(px(2.))
                                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                                .children(GraphMode::ALL.into_iter().enumerate().map(
                                    |(ix, mode)| {
                                        let active = self.mode == mode;
                                        div()
                                            .id(("graph-mode-item", ix))
                                            .focusable()
                                            .role(Role::Button)
                                            .aria_label(mode.label())
                                            .cursor_pointer()
                                            .h(px(28.))
                                            .px(px(8.))
                                            .rounded(px(6.))
                                            .bg(if active {
                                                theme.bg_selected
                                            } else {
                                                gpui::transparent_black()
                                            })
                                            .hover(move |s| s.bg(theme.bg_elevated))
                                            .flex()
                                            .items_center()
                                            .gap(px(8.))
                                            .on_click(cx.listener(move |this, _, _, cx| {
                                                this.mode_menu_open = false;
                                                if this.mode != mode {
                                                    this.mode = mode;
                                                    cx.emit(GraphEvent::SwitchMode(mode));
                                                    cx.notify();
                                                }
                                            }))
                                            .child(div().w(px(2.)).h(px(14.)).rounded(px(1.)).bg(
                                                if active {
                                                    theme.accent
                                                } else {
                                                    gpui::transparent_black()
                                                },
                                            ))
                                            .child(
                                                div()
                                                    .text_size(px(12.))
                                                    .text_color(theme.text_primary)
                                                    .child(mode.label()),
                                            )
                                    },
                                )),
                        )
                        .with_priority(10),
                    )
                })
                .into_any_element()
        } else {
            div()
                .p(px(2.))
                .rounded(px(6.))
                .bg(theme.bg_panel)
                .border_1()
                .border_color(theme.border_subtle)
                .flex()
                .items_center()
                .gap(px(2.))
                .children(mode_buttons)
                .into_any_element()
        };

        div()
            .flex_1()
            .min_w(px(0.))
            .h_full()
            .overflow_hidden()
            .bg(theme.graph_bg)
            .flex()
            .flex_col()
            .child(
                div()
                    .h(px(44.))
                    .w_full()
                    .min_w(px(0.))
                    .overflow_hidden()
                    .px(px(12.))
                    .bg(theme.bg_app)
                    .border_b_1()
                    .border_color(theme.border_subtle)
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .child(mode_control)
                    .child(
                        div()
                            .min_w(px(0.))
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .when(self.constellation, |row| {
                                row.child(
                                    div()
                                        .id("graph-constellation-label")
                                        .px(px(8.))
                                        .h(px(24.))
                                        .rounded(px(6.))
                                        .bg(theme.bg_panel)
                                        .border_1()
                                        .border_color(theme.border_subtle)
                                        .flex()
                                        .items_center()
                                        .gap(px(5.))
                                        .text_size(px(11.))
                                        .text_color(theme.text_muted)
                                        .child(status_dot(theme.accent))
                                        .child("Constellation"),
                                )
                            })
                            .when_some(stats_summary, |row, txt| {
                                row.child(
                                    div()
                                        .text_size(px(12.))
                                        .text_color(theme.text_muted)
                                        .truncate()
                                        .child(txt),
                                )
                            }),
                    ),
            )
            .child(
                div()
                    .id("graph-canvas-wrap")
                    .relative()
                    .flex_1()
                    .min_w(px(0.))
                    .min_h(px(0.))
                    .w_full()
                    .overflow_hidden()
                    .cursor(if self.dragging {
                        CursorStyle::ClosedHand
                    } else if self.hovered_node.is_some() || self.hovered_edge.is_some() {
                        CursorStyle::PointingHand
                    } else {
                        CursorStyle::OpenHand
                    })
                    .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
                    .on_mouse_move(cx.listener(Self::on_mouse_move))
                    .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
                    .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
                    .on_scroll(cx.listener(Self::on_scroll))
                    .when_some(self.error.clone(), |el, err| {
                        el.child(
                            div()
                                .size_full()
                                .flex()
                                .items_center()
                                .justify_center()
                                .p(px(24.))
                                .child(
                                    div()
                                        .p(px(14.))
                                        .rounded(px(10.))
                                        .bg(theme.bg_panel)
                                        .border_1()
                                        .border_color(theme.danger)
                                        .text_size(px(13.))
                                        .text_color(theme.danger)
                                        .child(SharedString::from(err)),
                                ),
                        )
                    })
                    .when(self.error.is_none(), |el| {
                        let empty_msg = match self.mode {
                            GraphMode::Contradictions => {
                                "No contradictions detected in the active filter slice."
                            }
                            GraphMode::Entity => {
                                "No entity-indexed memories match the active filters."
                            }
                            _ => "No memories match the active filter slice.",
                        };
                        let is_empty = self
                            .layout
                            .as_ref()
                            .map(|l| l.nodes.is_empty())
                            .unwrap_or(false)
                            && !self.is_loading;

                        if is_empty {
                            el.child(
                                div()
                                    .size_full()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .text_size(px(13.))
                                    .text_color(theme.text_muted)
                                    .child(empty_msg),
                            )
                        } else {
                            el.child(
                                canvas(
                                    move |bounds, _window, cx| {
                                        let mut data = render_data.clone();
                                        view_entity.update(cx, |view, _| {
                                            let size_changed =
                                                view.last_bounds.is_none_or(|prev| {
                                                    (prev.size.width.as_f32()
                                                        - bounds.size.width.as_f32())
                                                    .abs()
                                                        > 2.0
                                                        || (prev.size.height.as_f32()
                                                            - bounds.size.height.as_f32())
                                                        .abs()
                                                            > 2.0
                                                });
                                            view.last_bounds = Some(bounds);
                                            if view.needs_fit_on_bounds && size_changed {
                                                view.fit_to_bounds(None);
                                                view.needs_fit_on_bounds = false;
                                                if let Some(ref mut d) = data {
                                                    d.viewport = view.viewport;
                                                }
                                            }
                                        });
                                        data
                                    },
                                    move |bounds, data, window, cx| {
                                        if let Some(data) = data {
                                            paint_graph_canvas(bounds, &data, window, cx);
                                        }
                                    },
                                )
                                .size_full(),
                            )
                        }
                    })
                    .child(self.render_zoom_cluster(cx))
                    .when_some(inspector, |el, card| el.child(card))
                    .when(self.is_loading, |el| {
                        el.child(
                            div()
                                .absolute()
                                .top(px(12.))
                                .right(px(12.))
                                .px(px(10.))
                                .py(px(5.))
                                .rounded(px(6.))
                                .bg(theme.bg_panel)
                                .border_1()
                                .border_color(theme.border_subtle)
                                .text_size(px(12.))
                                .text_color(theme.text_secondary)
                                .child("Calculating layout…"),
                        )
                    })
                    .when_some(hovered_edge_info, |el, (rel, color)| {
                        el.child(
                            div()
                                .absolute()
                                .top(px(12.))
                                .left(px(if inspector_shown { 300. } else { 12. }))
                                .px(px(10.))
                                .py(px(5.))
                                .rounded(px(6.))
                                .bg(theme.bg_panel)
                                .border_1()
                                .border_color(theme.border_subtle)
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .child(status_dot(color))
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .text_color(theme.text_primary)
                                        .child(rel),
                                ),
                        )
                    })
                    .when(!legend_entries.is_empty(), |el| {
                        el.child(
                            div()
                                .id("graph-legend")
                                .absolute()
                                .bottom(px(12.))
                                .left(px(12.))
                                .max_w(px(340.))
                                .overflow_hidden()
                                .flex()
                                .items_center()
                                .flex_wrap()
                                .gap(px(10.))
                                .children(legend_entries.into_iter().map(|(label, color)| {
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(5.))
                                        .child(status_dot(color))
                                        .child(
                                            div()
                                                .text_size(px(12.))
                                                .text_color(theme.text_muted)
                                                .child(label),
                                        )
                                })),
                        )
                    }),
            )
    }
}

/// Computes deterministic background layout (< 500 ms for 2,000 nodes via spatial grid repulsion).
pub fn compute_graph_layout(snapshot: &GraphSnapshot) -> ComputedLayout {
    let start = Instant::now();
    let n = snapshot.nodes.len();
    if n == 0 {
        return ComputedLayout {
            mode: snapshot.mode,
            nodes: Vec::new(),
            edges: Vec::new(),
            group_labels: Vec::new(),
            timeline_ticks: Vec::new(),
            total_matching_nodes: snapshot.total_matching_nodes,
            clustered_nodes: snapshot.clustered_nodes,
            min_x: -200.0,
            max_x: 200.0,
            min_y: -200.0,
            max_y: 200.0,
            elapsed_ms: start.elapsed().as_secs_f32() * 1000.0,
        };
    }

    if snapshot.mode == GraphMode::Temporal {
        return compute_temporal_layout(snapshot, start);
    }

    // Assign deterministic cluster anchors per group on a phyllotaxis spiral.
    let mut group_map: HashMap<&str, usize> = HashMap::new();
    let mut group_names: Vec<String> = Vec::new();
    let mut group_counts: Vec<usize> = Vec::new();
    let mut node_group = vec![0usize; n];
    let mut node_rank_in_group = vec![0usize; n];
    for (ix, node) in snapshot.nodes.iter().enumerate() {
        let g = if let Some(&id) = group_map.get(node.group.as_str()) {
            id
        } else {
            let id = group_names.len();
            group_map.insert(node.group.as_str(), id);
            group_names.push(node.group.clone());
            group_counts.push(0);
            id
        };
        node_group[ix] = g;
        node_rank_in_group[ix] = group_counts[g];
        group_counts[g] += 1;
    }

    let num_groups = group_names.len().max(1);
    let golden_angle = 2.399_963_2_f32;
    // Small stores get a tighter anchor ring so Fit can zoom in and use the
    // canvas instead of leaving three small clumps in a sea of background.
    let group_scale = if n <= 120 {
        120.0 + (num_groups as f32).sqrt() * 60.0 + (n as f32).sqrt() * 10.0
    } else {
        200.0 + (num_groups as f32).sqrt() * 90.0 + (n as f32).sqrt() * 14.0
    };
    let mut anchors: Vec<(f32, f32)> = Vec::with_capacity(num_groups);
    for g in 0..num_groups {
        let r = if num_groups == 1 {
            0.0
        } else {
            group_scale * ((g as f32 + 0.5) / num_groups as f32).sqrt()
        };
        let angle = g as f32 * golden_angle;
        anchors.push((r * angle.cos(), r * angle.sin()));
    }

    let mut pos_x = vec![0.0_f32; n];
    let mut pos_y = vec![0.0_f32; n];
    let mut vel_x = vec![0.0_f32; n];
    let mut vel_y = vec![0.0_f32; n];
    let mut fx = vec![0.0_f32; n];
    let mut fy = vec![0.0_f32; n];
    let mut radii = vec![7.0_f32; n];

    // Initialize on a per-group Fermat spiral scaled to the group's node count so even
    // single-cluster 2,000-node graphs start well-spaced, while small graphs stay legible.
    let small_scale = if n <= 24 {
        2.8_f32
    } else if n <= 80 {
        1.6_f32
    } else {
        1.0_f32
    };
    for (ix, node) in snapshot.nodes.iter().enumerate() {
        let g = node_group[ix];
        let (ax, ay) = anchors[g];
        let rank = node_rank_in_group[ix] as f32;
        let h = stable_hash(&node.key);
        let jitter_a = (((h & 0xffff) as f32 / 65535.0) - 0.5) * 0.25;
        let local_angle = rank * golden_angle + jitter_a;
        let local_r = 22.0 * small_scale * (rank + 0.5).sqrt();
        pos_x[ix] = ax + local_r * local_angle.cos();
        pos_y[ix] = ay + local_r * local_angle.sin();
        radii[ix] = if node.cluster_count > 1 {
            (14.0 + (node.cluster_count as f32).sqrt() * 3.2).min(38.0)
        } else {
            5.5 + node.importance.clamp(0.0, 1.0) * 4.5
        };
    }

    const GRID_BUCKETS: usize = 4096;
    let mut cell_head = vec![-1_i32; GRID_BUCKETS];
    let mut next_in_cell = vec![-1_i32; n];
    let cell_size = 56.0_f32 * small_scale;
    let max_repel_dist_sq = 3200.0_f32 * small_scale * small_scale;
    let iterations = if n > 1200 {
        28
    } else if n > 400 {
        36
    } else {
        52
    };

    for iter in 0..iterations {
        let cooling = 1.0 - (iter as f32 / iterations as f32) * 0.72;
        fx.fill(0.0);
        fy.fill(0.0);

        cell_head.fill(-1);
        for i in 0..n {
            let cx = (pos_x[i] / cell_size).floor() as i32;
            let cy = (pos_y[i] / cell_size).floor() as i32;
            let b = hash_cell(cx, cy, GRID_BUCKETS - 1);
            next_in_cell[i] = cell_head[b];
            cell_head[b] = i as i32;
        }

        // Local 3x3 cell repulsion for crisp de-overlap in O(N).
        for i in 0..n {
            let cx = (pos_x[i] / cell_size).floor() as i32;
            let cy = (pos_y[i] / cell_size).floor() as i32;
            for dx_cell in -1..=1 {
                for dy_cell in -1..=1 {
                    let b = hash_cell(cx + dx_cell, cy + dy_cell, GRID_BUCKETS - 1);
                    let mut j_idx = cell_head[b];
                    while j_idx >= 0 {
                        let j = j_idx as usize;
                        j_idx = next_in_cell[j];
                        if j <= i {
                            continue;
                        }
                        let mut dx = pos_x[i] - pos_x[j];
                        let mut dy = pos_y[i] - pos_y[j];
                        let dist_sq = dx * dx + dy * dy;
                        if dist_sq > max_repel_dist_sq {
                            continue;
                        }
                        if dist_sq < 0.05 {
                            dx = 0.35 * ((i % 7) as f32 - 3.0).signum().max(0.5);
                            dy = 0.35;
                        }
                        let dist = dist_sq.max(1.0).sqrt();
                        let min_sep = radii[i] + radii[j] + 18.0 * small_scale;
                        let force = (min_sep * min_sep) / dist_sq.max(12.0) * 1.25;
                        let rx = (dx / dist) * force;
                        let ry = (dy / dist) * force;
                        fx[i] += rx;
                        fy[i] += ry;
                        fx[j] -= rx;
                        fy[j] -= ry;
                    }
                }
            }
        }

        for edge in &snapshot.edges {
            let s = edge.source_idx;
            let t = edge.target_idx;
            if s >= n || t >= n || s == t {
                continue;
            }
            let dx = pos_x[t] - pos_x[s];
            let dy = pos_y[t] - pos_y[s];
            let dist = (dx * dx + dy * dy).sqrt().max(1.0);
            let same_group = node_group[s] == node_group[t];
            let rest = if same_group {
                48.0 * small_scale
            } else {
                150.0 * small_scale
            };
            let k =
                if same_group { 0.065 } else { 0.025 } * (0.6 + edge.weight.clamp(0.1, 2.0) * 0.4);
            let pull = (dist - rest) * k;
            let sx = (dx / dist) * pull;
            let sy = (dy / dist) * pull;
            fx[s] += sx;
            fy[s] += sy;
            fx[t] -= sx;
            fy[t] -= sy;
        }

        for i in 0..n {
            let (ax, ay) = anchors[node_group[i]];
            fx[i] += (ax - pos_x[i]) * (0.032 / small_scale) - pos_x[i] * (0.004 / small_scale);
            fy[i] += (ay - pos_y[i]) * (0.032 / small_scale) - pos_y[i] * (0.004 / small_scale);

            vel_x[i] = (vel_x[i] + fx[i] * cooling) * 0.78;
            vel_y[i] = (vel_y[i] + fy[i] * cooling) * 0.78;
            let speed_sq = vel_x[i] * vel_x[i] + vel_y[i] * vel_y[i];
            let max_step = 26.0 * cooling + 2.0;
            if speed_sq > max_step * max_step {
                let scale = max_step / speed_sq.sqrt();
                vel_x[i] *= scale;
                vel_y[i] *= scale;
            }
            pos_x[i] += vel_x[i];
            pos_y[i] += vel_y[i];
        }
    }

    finalize_layout(
        snapshot,
        pos_x,
        pos_y,
        radii,
        &group_names,
        &node_group,
        Vec::new(),
        start,
    )
}

fn compute_fit_viewport(layout: &ComputedLayout, vp_w: f32, vp_h: f32) -> GraphViewport {
    let span_x = (layout.max_x - layout.min_x).max(140.0);
    let span_y = (layout.max_y - layout.min_y).max(140.0);
    let mid_x = (layout.min_x + layout.max_x) * 0.5;
    let mid_y = (layout.min_y + layout.max_y) * 0.5;
    let pad_left = 36.0_f32;
    let pad_right = (vp_w * 0.18).clamp(88.0, 150.0);
    let pad_top = if layout.mode == GraphMode::Temporal {
        64.0
    } else {
        56.0
    };
    let pad_bottom = 68.0_f32;
    let avail_w = (vp_w - pad_left - pad_right).max(140.0);
    let avail_h = (vp_h - pad_top - pad_bottom).max(120.0);
    let zoom = (avail_w / span_x)
        .min(avail_h / span_y)
        .clamp(MIN_ZOOM, 1.8);
    GraphViewport {
        zoom,
        pan_x: -mid_x + (pad_left - pad_right) * 0.5 / zoom,
        pan_y: -mid_y + (pad_top - pad_bottom) * 0.5 / zoom,
    }
}

fn compute_temporal_layout(snapshot: &GraphSnapshot, start: Instant) -> ComputedLayout {
    let n = snapshot.nodes.len();
    let mut group_map: HashMap<String, usize> = HashMap::new();
    let mut group_names: Vec<String> = Vec::new();
    let mut node_group = vec![0usize; n];
    for (ix, node) in snapshot.nodes.iter().enumerate() {
        let g = if let Some(&id) = group_map.get(&node.group) {
            id
        } else {
            let id = group_names.len();
            group_map.insert(node.group.clone(), id);
            group_names.push(node.group.clone());
            id
        };
        node_group[ix] = g;
    }

    let mut pos_x = vec![0.0_f32; n];
    let mut pos_y = vec![0.0_f32; n];
    let mut radii = vec![7.0_f32; n];
    for (ix, node) in snapshot.nodes.iter().enumerate() {
        radii[ix] = if node.cluster_count > 1 {
            (14.0 + (node.cluster_count as f32).sqrt() * 3.0).min(34.0)
        } else {
            5.5 + node.importance.clamp(0.0, 1.0) * 4.5
        };
    }

    let mut ticks = Vec::new();
    if n > 0 {
        // Sort nodes chronologically while keeping same-timestamp groups together.
        let mut sorted: Vec<usize> = (0..n).collect();
        sorted.sort_by(|&a, &b| {
            let ta = if snapshot.nodes[a].created_at > 0 {
                snapshot.nodes[a].created_at
            } else {
                i64::MIN
            };
            let tb = if snapshot.nodes[b].created_at > 0 {
                snapshot.nodes[b].created_at
            } else {
                i64::MIN
            };
            ta.cmp(&tb)
                .then_with(|| node_group[a].cmp(&node_group[b]))
                .then_with(|| a.cmp(&b))
        });

        // Group identical timestamps into atomic runs so equal timestamps align cleanly,
        // then detect large temporal gap jumps so old outliers cannot crush recent clusters.
        let mut runs: Vec<(i64, Vec<usize>)> = Vec::new();
        for ix in sorted {
            let ts = if snapshot.nodes[ix].created_at > 0 {
                snapshot.nodes[ix].created_at
            } else {
                i64::MIN
            };
            if let Some(last) = runs.last_mut()
                && last.0 == ts
            {
                last.1.push(ix);
            } else {
                runs.push((ts, vec![ix]));
            }
        }

        let mut split_points: Vec<(usize, i64)> = Vec::new();
        if runs.len() >= 2 {
            let mut pos_gaps: Vec<(usize, i64)> = Vec::new();
            let mut gap_values: Vec<i64> = Vec::new();
            for i in 0..(runs.len() - 1) {
                if runs[i].0 > i64::MIN && runs[i + 1].0 > runs[i].0 {
                    let g = runs[i + 1].0 - runs[i].0;
                    pos_gaps.push((i + 1, g));
                    gap_values.push(g);
                }
            }
            if !gap_values.is_empty() {
                gap_values.sort_unstable();
                let median_gap = gap_values[gap_values.len() / 2].max(1);
                let outlier_threshold = median_gap.saturating_mul(8).max(3_600_000);
                pos_gaps.retain(|&(_, g)| g > outlier_threshold);
                pos_gaps.sort_by_key(|a| std::cmp::Reverse(a.1));
                pos_gaps.truncate(4);
                pos_gaps.sort_by_key(|&(run_ix, _)| run_ix);
                split_points = pos_gaps;
            }
        }

        let mut epochs: Vec<Vec<(i64, Vec<usize>)>> = Vec::new();
        let mut cursor = 0usize;
        for (split_ix, _) in split_points {
            if split_ix > cursor {
                epochs.push(runs[cursor..split_ix].to_vec());
                cursor = split_ix;
            }
        }
        if cursor < runs.len() {
            epochs.push(runs[cursor..].to_vec());
        }

        // Allocate chronological columns across epochs proportionally so each node reads cleanly
        // at comfortable Fit-view zoom even when one memory predates the rest by months.
        let target_total_cols = if runs.len() <= 1 {
            n.div_ceil(6).clamp(1, 14)
        } else if n <= 16 {
            runs.len().clamp(2, 12)
        } else {
            ((n as f32 / 7.5).ceil() as usize).clamp(4, 28)
        };
        let extra_budget = target_total_cols.saturating_sub(epochs.len());
        let total_epoch_nodes: usize = epochs
            .iter()
            .map(|ep| ep.iter().map(|r| r.1.len()).sum::<usize>())
            .sum::<usize>()
            .max(1);
        let mut epoch_cols: Vec<usize> = vec![1; epochs.len()];
        for (ei, ep) in epochs.iter().enumerate() {
            let ep_nodes: usize = ep.iter().map(|r| r.1.len()).sum();
            let add =
                ((extra_budget * ep_nodes) as f32 / total_epoch_nodes as f32).round() as usize;
            epoch_cols[ei] += add;
        }
        let assigned_sum: usize = epoch_cols.iter().sum();
        if assigned_sum < target_total_cols
            && let Some((largest_ei, _)) = epochs
                .iter()
                .enumerate()
                .max_by_key(|(_, ep)| ep.iter().map(|r| r.1.len()).sum::<usize>())
        {
            epoch_cols[largest_ei] += target_total_cols - assigned_sum;
        }

        struct TemporalColumn {
            rep_ts: i64,
            nodes: Vec<usize>,
        }
        let mut columns: Vec<TemporalColumn> = Vec::new();

        for (ep, &ep_k) in epochs.iter().zip(epoch_cols.iter()) {
            let ep_nodes_flat: Vec<(i64, usize)> = ep
                .iter()
                .flat_map(|(ts, idxs)| idxs.iter().copied().map(move |ix| (*ts, ix)))
                .collect();
            let k = ep_k.clamp(1, ep_nodes_flat.len().max(1));
            let base = ep_nodes_flat.len() / k;
            let rem = ep_nodes_flat.len() % k;
            let mut offset = 0usize;
            for c in 0..k {
                let take = base + usize::from(c < rem);
                if take == 0 {
                    continue;
                }
                let slice = &ep_nodes_flat[offset..offset + take];
                offset += take;
                let rep_ts = slice
                    .iter()
                    .find_map(|&(ts, _)| (ts > i64::MIN).then_some(ts))
                    .unwrap_or(i64::MIN);
                columns.push(TemporalColumn {
                    rep_ts,
                    nodes: slice.iter().map(|&(_, ix)| ix).collect(),
                });
            }
        }

        let num_cols = columns.len().max(1);
        let col_step_x = if num_cols <= 1 {
            0.0
        } else if num_cols <= 14 {
            (1160.0 / (num_cols - 1) as f32).clamp(84.0, 140.0)
        } else {
            (2200.0 / (num_cols - 1) as f32).clamp(58.0, 96.0)
        };
        let max_col_len = columns.iter().map(|c| c.nodes.len()).max().unwrap_or(1);
        let step_y = if max_col_len > 14 { 34.0_f32 } else { 42.0_f32 };

        let mut col_xs = Vec::with_capacity(num_cols);
        for (c, col) in columns.iter().enumerate() {
            let x = if num_cols <= 1 {
                0.0
            } else {
                (c as f32 - (num_cols - 1) as f32 * 0.5) * col_step_x
            };
            col_xs.push(x);
            let m = col.nodes.len();
            for (row_ix, &ix) in col.nodes.iter().enumerate() {
                pos_x[ix] = x;
                pos_y[ix] = (row_ix as f32 - (m.saturating_sub(1) as f32) * 0.5) * step_y;
            }
        }

        let valid_cols: Vec<usize> = columns
            .iter()
            .enumerate()
            .filter_map(|(c, col)| (col.rep_ts > i64::MIN).then_some(c))
            .collect();
        if !valid_cols.is_empty() {
            let tick_count = valid_cols.len().min(6);
            let mut chosen_cols = Vec::with_capacity(tick_count);
            for step in 0..tick_count {
                let idx = if tick_count == 1 {
                    0
                } else {
                    (step * (valid_cols.len() - 1)) / (tick_count - 1)
                };
                chosen_cols.push(valid_cols[idx]);
            }
            chosen_cols.dedup();
            for &c in &chosen_cols {
                let label = format_short_date_ms(columns[c].rep_ts);
                let is_last = Some(&c) == chosen_cols.last();
                if ticks
                    .last()
                    .is_some_and(|prev: &TimelineTick| prev.label == label && !is_last)
                {
                    continue;
                }
                ticks.push(TimelineTick {
                    x: col_xs[c],
                    label,
                });
            }
        }
    }

    finalize_layout(
        snapshot,
        pos_x,
        pos_y,
        radii,
        &group_names,
        &node_group,
        ticks,
        start,
    )
}

#[allow(clippy::too_many_arguments)]
fn finalize_layout(
    snapshot: &GraphSnapshot,
    pos_x: Vec<f32>,
    pos_y: Vec<f32>,
    radii: Vec<f32>,
    group_names: &[String],
    node_group: &[usize],
    timeline_ticks: Vec<TimelineTick>,
    start: Instant,
) -> ComputedLayout {
    let n = snapshot.nodes.len();
    let mut min_x = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_y = f32::NEG_INFINITY;

    let mut g_points: Vec<Vec<(f32, f32, f32)>> = vec![Vec::new(); group_names.len()];

    let mut nodes = Vec::with_capacity(n);
    for (ix, data) in snapshot.nodes.iter().enumerate() {
        let x = pos_x[ix];
        let y = pos_y[ix];
        let r = radii[ix];
        min_x = min_x.min(x - r);
        max_x = max_x.max(x + r);
        min_y = min_y.min(y - r);
        max_y = max_y.max(y + r);

        let g = node_group[ix];
        g_points[g].push((x, y, r));

        nodes.push(PositionedNode {
            x,
            y,
            radius: r,
            data: data.clone(),
        });
    }

    let mut group_labels = Vec::new();
    for (g, name) in group_names.iter().enumerate() {
        let pts = &g_points[g];
        if pts.len() >= 2 {
            let mut xs: Vec<f32> = pts.iter().map(|p| p.0).collect();
            let mut ys: Vec<f32> = pts.iter().map(|p| p.1).collect();
            xs.sort_by(f32::total_cmp);
            ys.sort_by(f32::total_cmp);
            let med_x = xs[xs.len() / 2];
            let med_y = ys[ys.len() / 2];

            // Anchor the label to the group's dense core so outlier nodes pulled by long edges
            // cannot strand the heading in empty space.
            let mut by_dist: Vec<(f32, f32, f32, f32)> = pts
                .iter()
                .map(|&(x, y, r)| {
                    let dx = x - med_x;
                    let dy = y - med_y;
                    (dx * dx + dy * dy, x, y, r)
                })
                .collect();
            by_dist.sort_by(|a, b| a.0.total_cmp(&b.0));
            let core_len = ((pts.len() * 3) / 4).max(2).min(pts.len());
            let mut core_xs: Vec<f32> = by_dist[..core_len].iter().map(|p| p.1).collect();
            core_xs.sort_by(f32::total_cmp);
            let anchor_x = core_xs[core_xs.len() / 2];
            // Clear every node in the group, not just the core, so a heading
            // never lands on top of an outlier node.
            let top_y = pts.iter().map(|p| p.1 - p.2).fold(f32::INFINITY, f32::min);

            group_labels.push(GroupAnchorLabel {
                text: sanitize_single_line(name, 26),
                x: anchor_x,
                y: top_y,
                count: pts.len(),
            });
        }
    }
    group_labels.sort_by_key(|a| std::cmp::Reverse(a.count));
    group_labels.truncate(16);

    ComputedLayout {
        mode: snapshot.mode,
        nodes,
        edges: snapshot.edges.clone(),
        group_labels,
        timeline_ticks,
        total_matching_nodes: snapshot.total_matching_nodes,
        clustered_nodes: snapshot.clustered_nodes,
        min_x,
        max_x,
        min_y,
        max_y,
        elapsed_ms: start.elapsed().as_secs_f32() * 1000.0,
    }
}

fn node_world_pos(
    node: &PositionedNode,
    ix: usize,
    constellation: bool,
    drift_phase: f32,
) -> (f32, f32) {
    if !constellation {
        return (node.x, node.y);
    }
    let seed = ((stable_hash(&node.data.key) % 628) as f32) * 0.01;
    let speed = 1.0 + ((ix % 3) as f32) * 0.22;
    let amp = 4.5 + ((ix % 5) as f32) * 1.1;
    let angle = drift_phase * speed + seed;
    (
        node.x + angle.cos() * amp,
        node.y + (angle * 0.7).sin() * (amp * 0.72),
    )
}

fn edge_bezier_points(
    layout: &ComputedLayout,
    edge: &GraphEdgeData,
    edge_ix: usize,
    vp: GraphViewport,
    bounds: Bounds<Pixels>,
    constellation: bool,
    drift_phase: f32,
) -> Option<(Point<Pixels>, Point<Pixels>, Point<Pixels>)> {
    let s = layout.nodes.get(edge.source_idx)?;
    let t = layout.nodes.get(edge.target_idx)?;
    let (sx, sy) = node_world_pos(s, edge.source_idx, constellation, drift_phase);
    let (tx, ty) = node_world_pos(t, edge.target_idx, constellation, drift_phase);
    let p0 = vp.world_to_screen(bounds, sx, sy);
    let p1 = vp.world_to_screen(bounds, tx, ty);
    let dx = p1.x.as_f32() - p0.x.as_f32();
    let dy = p1.y.as_f32() - p0.y.as_f32();
    let len = (dx * dx + dy * dy).sqrt().max(1.0);
    let nx = -dy / len;
    let ny = dx / len;
    let sign = if edge_ix.is_multiple_of(2) { 1.0 } else { -1.0 };
    let bow = (len * 0.14).clamp(8.0, 42.0) * sign;
    let ctrl = point(
        px((p0.x.as_f32() + p1.x.as_f32()) * 0.5 + nx * bow),
        px((p0.y.as_f32() + p1.y.as_f32()) * 0.5 + ny * bow),
    );
    Some((p0, ctrl, p1))
}

fn hit_test_node(
    layout: &ComputedLayout,
    vp: GraphViewport,
    bounds: Bounds<Pixels>,
    mouse: Point<Pixels>,
    constellation: bool,
    drift_phase: f32,
) -> Option<usize> {
    let mut best: Option<(usize, f32)> = None;
    for (ix, node) in layout.nodes.iter().enumerate() {
        let (wx, wy) = node_world_pos(node, ix, constellation, drift_phase);
        let sp = vp.world_to_screen(bounds, wx, wy);
        let screen_r = (node.radius * vp.zoom).clamp(4.0, 48.0) + 5.0;
        let dx = mouse.x.as_f32() - sp.x.as_f32();
        let dy = mouse.y.as_f32() - sp.y.as_f32();
        let d2 = dx * dx + dy * dy;
        if d2 <= screen_r * screen_r {
            let d = d2.sqrt();
            if best.is_none_or(|(_, prev_d)| d < prev_d) {
                best = Some((ix, d));
            }
        }
    }
    best.map(|(ix, _)| ix)
}

fn hit_test_edge(
    layout: &ComputedLayout,
    vp: GraphViewport,
    bounds: Bounds<Pixels>,
    mouse: Point<Pixels>,
    constellation: bool,
    drift_phase: f32,
) -> Option<usize> {
    let mut best: Option<(usize, f32)> = None;
    let mx = mouse.x.as_f32();
    let my = mouse.y.as_f32();

    for (ix, edge) in layout.edges.iter().enumerate() {
        let Some((p0, ctrl, p1)) =
            edge_bezier_points(layout, edge, ix, vp, bounds, constellation, drift_phase)
        else {
            continue;
        };
        let min_x = p0.x.as_f32().min(ctrl.x.as_f32()).min(p1.x.as_f32()) - 8.0;
        let max_x = p0.x.as_f32().max(ctrl.x.as_f32()).max(p1.x.as_f32()) + 8.0;
        let min_y = p0.y.as_f32().min(ctrl.y.as_f32()).min(p1.y.as_f32()) - 8.0;
        let max_y = p0.y.as_f32().max(ctrl.y.as_f32()).max(p1.y.as_f32()) + 8.0;
        if mx < min_x || mx > max_x || my < min_y || my > max_y {
            continue;
        }
        let seg = QuadraticBezierSegment {
            from: lyon_point(p0.x.as_f32(), p0.y.as_f32()),
            ctrl: lyon_point(ctrl.x.as_f32(), ctrl.y.as_f32()),
            to: lyon_point(p1.x.as_f32(), p1.y.as_f32()),
        };
        let d = distance_to_quad_bezier(seg, mx, my);
        if d <= 7.0 && best.is_none_or(|(_, prev_d)| d < prev_d) {
            best = Some((ix, d));
        }
    }
    best.map(|(ix, _)| ix)
}

fn distance_to_quad_bezier(seg: QuadraticBezierSegment<f32>, px_x: f32, px_y: f32) -> f32 {
    let mut min_dist_sq = f32::INFINITY;
    let mut prev = seg.sample(0.0);
    for step in 1..=8 {
        let cur = seg.sample(step as f32 / 8.0);
        let vx = cur.x - prev.x;
        let vy = cur.y - prev.y;
        let wx = px_x - prev.x;
        let wy = px_y - prev.y;
        let len_sq = vx * vx + vy * vy;
        let t = if len_sq > 1e-4 {
            ((wx * vx + wy * vy) / len_sq).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let proj_x = prev.x + t * vx;
        let proj_y = prev.y + t * vy;
        let dx = px_x - proj_x;
        let dy = px_y - proj_y;
        min_dist_sq = min_dist_sq.min(dx * dx + dy * dy);
        prev = cur;
    }
    min_dist_sq.sqrt()
}

fn paint_graph_canvas(
    bounds: Bounds<Pixels>,
    data: &CanvasRenderData,
    window: &mut Window,
    cx: &mut gpui::App,
) {
    let theme = data.theme;
    window.paint_quad(fill(bounds, theme.graph_bg));

    let text_style = window.text_style();
    let font = text_style.font();
    let vp = data.viewport;

    if data.layout.mode == GraphMode::Temporal && !data.layout.timeline_ticks.is_empty() {
        let mut grid_pb = PathBuilder::stroke(px(1.0));
        for tick in &data.layout.timeline_ticks {
            let top_pt = vp.world_to_screen(bounds, tick.x, -4000.0);
            if top_pt.x.as_f32() < bounds.left().as_f32() - 40.0
                || top_pt.x.as_f32() > bounds.right().as_f32() + 40.0
            {
                continue;
            }
            grid_pb.move_to(point(top_pt.x, bounds.top() + px(56.)));
            grid_pb.line_to(point(top_pt.x, bounds.bottom()));
        }
        if let Ok(path) = grid_pb.build() {
            window.paint_path(path, theme.graph_grid);
        }

        let mut last_tick_right = bounds.left().as_f32() + 6.0;
        let mut cache = data.label_cache.borrow_mut();
        for tick in &data.layout.timeline_ticks {
            let p = vp.world_to_screen(bounds, tick.x, 0.0);
            let x = p.x.as_f32() + 4.0;
            if x < last_tick_right || p.x.as_f32() > bounds.right().as_f32() - 110.0 {
                continue;
            }
            let label: SharedString = tick.label.clone().into();
            let (_, fg_line) = cache.get_or_shape(
                &label,
                px(11.),
                theme.text_muted,
                theme.graph_bg,
                &font,
                window,
            );
            let tick_w = fg_line.width.as_f32();
            if x + tick_w > bounds.right().as_f32() - 104.0 {
                continue;
            }
            fg_line
                .paint(
                    point(px(x), bounds.top() + px(40.)),
                    px(14.),
                    TextAlign::Left,
                    None,
                    window,
                    cx,
                )
                .ok();
            last_tick_right = x + tick_w + 18.0;
        }
    }

    type EdgeCurve = (Point<Pixels>, Point<Pixels>, Point<Pixels>);
    type ActiveEdge = (usize, EdgeCurve, Hsla);

    // Small open arrowhead at the target end, drawn only for the active
    // (hovered/selected) edge so direction is readable without adding noise
    // to the overview.
    fn edge_arrow_curves(ctrl: Point<Pixels>, p1: Point<Pixels>) -> [EdgeCurve; 2] {
        let dx = p1.x.as_f32() - ctrl.x.as_f32();
        let dy = p1.y.as_f32() - ctrl.y.as_f32();
        let len = (dx * dx + dy * dy).sqrt().max(0.001);
        let (ux, uy) = (dx / len, dy / len);
        let tip = point(px(p1.x.as_f32() - ux * 11.0), px(p1.y.as_f32() - uy * 11.0));
        let base = point(px(tip.x.as_f32() - ux * 9.0), px(tip.y.as_f32() - uy * 9.0));
        let left = point(
            px(base.x.as_f32() - uy * 5.0),
            px(base.y.as_f32() + ux * 5.0),
        );
        let right = point(
            px(base.x.as_f32() + uy * 5.0),
            px(base.y.as_f32() - ux * 5.0),
        );
        let mid = |a: Point<Pixels>, b: Point<Pixels>| {
            point(
                px((a.x.as_f32() + b.x.as_f32()) * 0.5),
                px((a.y.as_f32() + b.y.as_f32()) * 0.5),
            )
        };
        [(tip, mid(tip, left), left), (tip, mid(tip, right), right)]
    }

    let mut regular_edges: Vec<EdgeCurve> = Vec::new();
    let mut contradiction_edges: Vec<EdgeCurve> = Vec::new();
    let mut active_edges: Vec<ActiveEdge> = Vec::new();

    for (ix, edge) in data.layout.edges.iter().enumerate() {
        let Some((p0, ctrl, p1)) = edge_bezier_points(
            &data.layout,
            edge,
            ix,
            vp,
            bounds,
            data.constellation,
            data.drift_phase,
        ) else {
            continue;
        };
        if !segment_intersects_bounds(bounds, p0, ctrl, p1) {
            continue;
        }
        let src_mem_id = data
            .layout
            .nodes
            .get(edge.source_idx)
            .and_then(|n| n.data.memory_id.as_deref());
        let dst_mem_id = data
            .layout
            .nodes
            .get(edge.target_idx)
            .and_then(|n| n.data.memory_id.as_deref());
        let s_selected = data.selected_id.as_deref() == src_mem_id;
        let t_selected = data.selected_id.as_deref() == dst_mem_id;
        let ext_hover_hit = data.external_hovered_id.is_some()
            && (src_mem_id == data.external_hovered_id.as_deref()
                || dst_mem_id == data.external_hovered_id.as_deref());
        let is_hovered = data.hovered_edge == Some(ix)
            || data.hovered_node == Some(edge.source_idx)
            || data.hovered_node == Some(edge.target_idx)
            || ext_hover_hit;

        if let Some(focus) = data.focus.as_ref()
            && !(focus.contains(&edge.source_idx) && focus.contains(&edge.target_idx))
        {
            continue;
        }
        if s_selected || t_selected || is_hovered {
            let mut ec = theme.edge_color(&edge.relation);
            ec.a = if data.constellation { 0.45 } else { 0.70 };
            active_edges.push((ix, (p0, ctrl, p1), ec));
        } else if edge.is_contradiction {
            contradiction_edges.push((p0, ctrl, p1));
        } else {
            regular_edges.push((p0, ctrl, p1));
        }
    }

    let regular_color = Hsla {
        a: if data.constellation { 0.14 } else { 0.35 },
        ..theme.text_muted
    };
    paint_lyon_edge_chunks(&regular_edges, px(1.2), None, regular_color, window);

    let contra_color = Hsla {
        a: if data.constellation { 0.35 } else { 0.70 },
        ..theme.danger
    };
    paint_lyon_edge_chunks(
        &contradiction_edges,
        px(1.8),
        Some(&[px(5.), px(4.)]),
        contra_color,
        window,
    );

    for (ix, curve, color) in active_edges {
        let width = if data.hovered_edge == Some(ix) {
            px(3.0)
        } else {
            px(2.2)
        };
        paint_lyon_edge_chunks(&[curve], width, None, color, window);
        for arrow in edge_arrow_curves(curve.1, curve.2) {
            paint_lyon_edge_chunks(&[arrow], width, None, color, window);
        }
    }

    let l = bounds.left().as_f32();
    let t = bounds.top().as_f32();
    let r_edge = bounds.right().as_f32();
    let b = bounds.bottom().as_f32();
    let mut hud_rects: Vec<(f32, f32, f32, f32)> = vec![
        // Top-right loading badge gutter
        (r_edge - 180.0, t + 6.0, r_edge - 6.0, t + 46.0),
        // Bottom-right zoom cluster
        (r_edge - 196.0, b - 46.0, r_edge - 6.0, b - 6.0),
    ];
    if data.selected_id.is_some() {
        // Top-left inspector card
        hud_rects.push((l + 6.0, t + 6.0, l + 300.0, t + 176.0));
    }
    if data.layout.mode == GraphMode::Temporal && !data.layout.timeline_ticks.is_empty() {
        hud_rects.push((l, t, r_edge, t + 58.0));
    }
    if data.has_legend {
        hud_rects.push((
            l + 6.0,
            b - 54.0,
            (l + 360.0).min(r_edge - 88.0).max(l + 60.0),
            b - 6.0,
        ));
    }
    if data.hovered_edge.is_some() {
        hud_rects.push((
            l + 6.0,
            t + 6.0,
            (l + 240.0).min(r_edge - 110.0).max(l + 60.0),
            t + 44.0,
        ));
    }
    let rects_overlap = |a: (f32, f32, f32, f32), list: &[(f32, f32, f32, f32)]| -> bool {
        list.iter()
            .any(|&(ox0, oy0, ox1, oy1)| a.0 < ox1 && a.2 > ox0 && a.1 < oy1 && a.3 > oy0)
    };
    let mut occupied: Vec<(f32, f32, f32, f32)> = hud_rects.clone();

    if data.focus.is_none() && vp.zoom >= 0.20 && vp.zoom <= 2.4 {
        let mut cache = data.label_cache.borrow_mut();
        for gl in &data.layout.group_labels {
            let p = vp.world_to_screen(bounds, gl.x, gl.y);
            if !bounds.contains(&p) {
                continue;
            }
            let text: SharedString = format!("{} ({})", gl.text, gl.count).into();
            let pos = point(p.x, (p.y - px(22.)).max(px(t + 8.0)));
            let label_w = {
                let (_, fg_line) = cache.get_or_shape(
                    &text,
                    px(12.),
                    theme.text_muted,
                    theme.graph_bg,
                    &font,
                    window,
                );
                fg_line.width.as_f32()
            };
            let rect = (
                pos.x.as_f32() - label_w * 0.5 - 4.0,
                pos.y.as_f32() - 2.0,
                pos.x.as_f32() + label_w * 0.5 + 4.0,
                pos.y.as_f32() + 16.0,
            );
            if rect.0 < l + 4.0
                || rect.2 > r_edge - 4.0
                || rect.1 < t + 4.0
                || rect.3 > b - 4.0
                || rects_overlap(rect, &occupied)
            {
                continue;
            }
            let (halo_line, fg_line) = cache.get_or_shape(
                &text,
                px(12.),
                theme.text_muted,
                theme.graph_bg,
                &font,
                window,
            );
            paint_cached_halo_lines(halo_line, fg_line, pos, TextAlign::Center, window, cx);
            occupied.push(rect);
        }
    }

    let mut ranked: Vec<(usize, f32)> = data
        .layout
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| !n.data.label.trim().is_empty() || n.data.cluster_count > 1)
        .map(|(ix, n)| (ix, n.data.importance))
        .collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let ambient_label_cap = 6;
    let top_label_indices: std::collections::HashSet<usize> = ranked
        .into_iter()
        .take(ambient_label_cap)
        .map(|(ix, _)| ix)
        .collect();

    struct PendingNodeLabel {
        priority: bool,
        anchor_x: f32,
        anchor_y: f32,
        radius: f32,
        text: SharedString,
        color: Hsla,
    }
    let mut pending_labels: Vec<PendingNodeLabel> = Vec::new();

    for (ix, node) in data.layout.nodes.iter().enumerate() {
        let (wx, wy) = node_world_pos(node, ix, data.constellation, data.drift_phase);
        let sp = vp.world_to_screen(bounds, wx, wy);
        let r = (node.radius * vp.zoom).clamp(3.0, 44.0);
        if sp.x.as_f32() + r < l - 12.0
            || sp.x.as_f32() - r > r_edge + 12.0
            || sp.y.as_f32() + r < t - 12.0
            || sp.y.as_f32() - r > b + 12.0
        {
            continue;
        }

        let is_selected = node.data.memory_id.is_some()
            && data.selected_id.as_deref() == node.data.memory_id.as_deref();
        let is_hovered = is_node_hovered(
            data.hovered_node,
            ix,
            data.external_hovered_id.as_deref(),
            node.data.memory_id.as_deref(),
        );
        let dimmed = data.focus.as_ref().is_some_and(|f| !f.contains(&ix));
        let mut fill_color = theme.type_color(&node.data.node_type);
        if dimmed {
            fill_color.a = 0.16;
        }

        if is_selected {
            let halo_r = r + 5.5;
            let halo_bounds = Bounds::new(
                point(px(sp.x.as_f32() - halo_r), px(sp.y.as_f32() - halo_r)),
                size(px(halo_r * 2.0), px(halo_r * 2.0)),
            );
            window.paint_quad(quad(
                halo_bounds,
                px(halo_r),
                Hsla {
                    a: 0.14,
                    ..theme.accent
                },
                px(0.),
                gpui::transparent_black(),
                Default::default(),
            ));
        }

        if is_selected || is_hovered {
            let ring_r = r + 2.5;
            let ring_bounds = Bounds::new(
                point(px(sp.x.as_f32() - ring_r), px(sp.y.as_f32() - ring_r)),
                size(px(ring_r * 2.0), px(ring_r * 2.0)),
            );
            let ring_color = if is_selected {
                theme.accent
            } else {
                Hsla {
                    a: 0.78,
                    ..theme.text_secondary
                }
            };
            window.paint_quad(quad(
                ring_bounds,
                px(ring_r),
                gpui::transparent_black(),
                px(if is_selected { 2.0 } else { 1.5 }),
                ring_color,
                Default::default(),
            ));
        }

        let border_color = if dimmed {
            gpui::transparent_black()
        } else if node.data.has_contradiction {
            theme.danger
        } else if node.data.cluster_count > 1 {
            theme.text_secondary
        } else {
            theme.graph_bg
        };
        let border_w = if node.data.has_contradiction || node.data.cluster_count > 1 {
            px(1.6)
        } else {
            px(1.0)
        };

        let node_bounds = Bounds::new(
            point(px(sp.x.as_f32() - r), px(sp.y.as_f32() - r)),
            size(px(r * 2.0), px(r * 2.0)),
        );
        window.paint_quad(quad(
            node_bounds,
            px(r),
            fill_color,
            border_w,
            border_color,
            Default::default(),
        ));

        let node_in_canvas = sp.x.as_f32() >= l + 4.0
            && sp.x.as_f32() <= r_edge - 4.0
            && sp.y.as_f32() >= t + 4.0
            && sp.y.as_f32() <= b - 4.0;
        let show_node_label = !dimmed
            && should_show_node_label(
                node_in_canvas,
                is_selected,
                is_hovered,
                vp.zoom,
                top_label_indices.contains(&ix),
            );
        if show_node_label {
            if node.data.cluster_count > 1 {
                let count_txt: SharedString = format!("+{}", node.data.cluster_count).into();
                pending_labels.push(PendingNodeLabel {
                    priority: is_selected || is_hovered,
                    anchor_x: sp.x.as_f32(),
                    anchor_y: sp.y.as_f32(),
                    radius: r,
                    text: count_txt,
                    color: theme.text_primary,
                });
            } else {
                let clean = strip_short_id_prefix(&node.data.label, node.data.memory_id.as_deref());
                let max_len = if is_selected || is_hovered { 36 } else { 20 };
                let lbl: SharedString = sanitize_single_line(clean, max_len).into();
                if !lbl.is_empty() {
                    let text_color = if is_selected || is_hovered {
                        theme.text_primary
                    } else {
                        theme.text_secondary
                    };
                    pending_labels.push(PendingNodeLabel {
                        priority: is_selected || is_hovered,
                        anchor_x: sp.x.as_f32(),
                        anchor_y: sp.y.as_f32(),
                        radius: r,
                        text: lbl,
                        color: text_color,
                    });
                }
            }
        }
    }

    let label_size_px = if data.constellation { 10.0 } else { 12.0 };
    let label_size = px(label_size_px);
    // Filter collisions high-priority first so selected/hovered labels stay visible while dense siblings avoid overlap.
    pending_labels.sort_by_key(|item| std::cmp::Reverse(item.priority));
    let mut visible_labels: Vec<(Point<Pixels>, SharedString, Hsla)> = Vec::new();
    let mut cache = data.label_cache.borrow_mut();
    let (pad_x, pad_y) = if vp.zoom < 0.65 {
        (8.0, 5.0)
    } else {
        (2.0, 1.0)
    };
    for item in pending_labels {
        let label_w = {
            let (_, fg_line) = cache.get_or_shape(
                &item.text,
                label_size,
                item.color,
                theme.graph_bg,
                &font,
                window,
            );
            fg_line.width.as_f32().max(14.0)
        };
        let label_h = label_size_px + 4.0;
        if let Some(placement) = pick_non_overlapping_label_pos(
            item.anchor_x,
            item.anchor_y,
            item.radius,
            label_w,
            label_h,
            pad_x,
            pad_y,
            (l, t, r_edge, b),
            &occupied,
            &hud_rects,
            item.priority,
        ) {
            occupied.push(placement.rect);
            visible_labels.push((
                point(px(placement.x), px(placement.y)),
                item.text,
                item.color,
            ));
        }
    }
    visible_labels.reverse();
    for (pos, text, color) in visible_labels {
        let (halo_line, fg_line) =
            cache.get_or_shape(&text, label_size, color, theme.graph_bg, &font, window);
        paint_cached_halo_lines(halo_line, fg_line, pos, TextAlign::Left, window, cx);
    }
}

fn strip_short_id_prefix<'a>(raw: &'a str, memory_id: Option<&str>) -> &'a str {
    let trimmed = raw.trim();
    if let Some((first, rest)) = trimmed.split_once(' ') {
        let rest_trimmed = rest.trim_start();
        if !rest_trimmed.is_empty() {
            if let Some(mem_id) = memory_id {
                let expected = short_citation_id(mem_id);
                if !expected.is_empty() && first == expected {
                    return rest_trimmed;
                }
            }
            if (first.starts_with("[mem:") && first.ends_with(']'))
                || (first.len() == 4 && first.bytes().all(|b| b.is_ascii_hexdigit()))
            {
                return rest_trimmed;
            }
        }
    }
    trimmed
}

fn paint_cached_halo_lines(
    halo_line: &ShapedLine,
    fg_line: &ShapedLine,
    pos: Point<Pixels>,
    align: TextAlign,
    window: &mut Window,
    cx: &mut gpui::App,
) {
    let offsets = [
        (-1.0_f32, 0.0_f32),
        (1.0, 0.0),
        (0.0, -1.0),
        (0.0, 1.0),
        (-0.7, -0.7),
        (0.7, -0.7),
        (-0.7, 0.7),
        (0.7, 0.7),
    ];
    for (dx, dy) in offsets {
        halo_line
            .paint(
                point(pos.x + px(dx), pos.y + px(dy)),
                px(16.),
                align,
                None,
                window,
                cx,
            )
            .ok();
    }
    fg_line.paint(pos, px(16.), align, None, window, cx).ok();
}

/// Constructs curved graph edges via `lyon::path::Path` and paints them via GPUI's stroke path builder.
fn paint_lyon_edge_chunks(
    edges: &[(Point<Pixels>, Point<Pixels>, Point<Pixels>)],
    stroke_width: Pixels,
    dash: Option<&[Pixels]>,
    color: Hsla,
    window: &mut Window,
) {
    // Keep vertex count safely below u16::MAX per GPUI StrokeTessellator batch.
    const CHUNK_SIZE: usize = 192;
    for chunk in edges.chunks(CHUNK_SIZE) {
        let mut builder = lyon::path::Path::builder();
        for &(p0, ctrl, p1) in chunk {
            builder.begin(lyon_point(p0.x.as_f32(), p0.y.as_f32()));
            builder.quadratic_bezier_to(
                lyon_point(ctrl.x.as_f32(), ctrl.y.as_f32()),
                lyon_point(p1.x.as_f32(), p1.y.as_f32()),
            );
            builder.end(false);
        }
        let lyon_path = builder.build();

        let mut pb = PathBuilder::stroke(stroke_width);
        if let Some(d) = dash {
            pb = pb.dash_array(d);
        }
        for event in lyon_path.iter() {
            match event {
                LyonEvent::Begin { at } => {
                    pb.move_to(point(px(at.x), px(at.y)));
                }
                LyonEvent::Quadratic { ctrl, to, .. } => {
                    pb.curve_to(point(px(to.x), px(to.y)), point(px(ctrl.x), px(ctrl.y)));
                }
                LyonEvent::Line { to, .. } => {
                    pb.line_to(point(px(to.x), px(to.y)));
                }
                LyonEvent::Cubic {
                    ctrl1, ctrl2, to, ..
                } => {
                    pb.cubic_bezier_to(
                        point(px(to.x), px(to.y)),
                        point(px(ctrl1.x), px(ctrl1.y)),
                        point(px(ctrl2.x), px(ctrl2.y)),
                    );
                }
                LyonEvent::End { close: true, .. } => {
                    pb.close();
                }
                LyonEvent::End { close: false, .. } => {}
            }
        }
        if let Ok(path) = pb.build() {
            window.paint_path(path, color);
        }
    }
}

fn segment_intersects_bounds(
    bounds: Bounds<Pixels>,
    p0: Point<Pixels>,
    ctrl: Point<Pixels>,
    p1: Point<Pixels>,
) -> bool {
    let min_x = p0.x.as_f32().min(ctrl.x.as_f32()).min(p1.x.as_f32());
    let max_x = p0.x.as_f32().max(ctrl.x.as_f32()).max(p1.x.as_f32());
    let min_y = p0.y.as_f32().min(ctrl.y.as_f32()).min(p1.y.as_f32());
    let max_y = p0.y.as_f32().max(ctrl.y.as_f32()).max(p1.y.as_f32());
    !(max_x < bounds.left().as_f32()
        || min_x > bounds.right().as_f32()
        || max_y < bounds.top().as_f32()
        || min_y > bounds.bottom().as_f32())
}

fn stable_hash(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn hash_cell(cx: i32, cy: i32, mask: usize) -> usize {
    let hx = (cx as i64).wrapping_mul(73856093);
    let hy = (cy as i64).wrapping_mul(19349663);
    ((hx ^ hy) as usize) & mask
}

fn sanitize_single_line(s: &str, max_chars: usize) -> String {
    let mut out = String::new();
    let mut prev_space = true;
    let mut count = 0usize;
    for ch in s.chars() {
        if ch.is_whitespace() {
            if !prev_space {
                if count >= max_chars {
                    out.push('…');
                    break;
                }
                out.push(' ');
                count += 1;
                prev_space = true;
            }
        } else {
            if count >= max_chars {
                out.push('…');
                break;
            }
            out.push(ch);
            count += 1;
            prev_space = false;
        }
    }
    out.trim().to_string()
}

fn format_short_date_ms(ts_ms: i64) -> String {
    let ms = if ts_ms < 10_000_000_000 {
        ts_ms * 1000
    } else {
        ts_ms
    };
    let secs = ms.div_euclid(1000);
    if let Ok(dt) = time::OffsetDateTime::from_unix_timestamp(secs) {
        let fmt = time::macros::format_description!("[year]-[month]-[day]");
        dt.format(&fmt).unwrap_or_else(|_| ts_ms.to_string())
    } else {
        ts_ms.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temporal_layout_orders_chronologically_and_2k_layout_stays_finite() {
        let temporal = GraphSnapshot {
            mode: GraphMode::Temporal,
            nodes: (0..12)
                .map(|i| GraphNodeData {
                    key: format!("n-{i}"),
                    memory_id: Some(format!("id-{i}")),
                    label: format!("Node {i}"),
                    group: "2026-01".to_string(),
                    node_type: "fact".to_string(),
                    importance: 0.6,
                    created_at: 1_700_000_000_000 + i * 86_400_000,
                    cluster_count: 1,
                    has_contradiction: false,
                })
                .collect(),
            edges: Vec::new(),
            total_matching_nodes: 12,
            clustered_nodes: 0,
        };
        let t_layout = compute_graph_layout(&temporal);
        assert_eq!(t_layout.nodes.len(), 12);
        for w in t_layout.nodes.windows(2) {
            assert!(w[0].x <= w[1].x);
        }

        // Single-group worst-case 2,000-node layout
        let dense = GraphSnapshot {
            mode: GraphMode::Namespace,
            nodes: (0..2_000)
                .map(|i| GraphNodeData {
                    key: format!("d-{i}"),
                    memory_id: Some(format!("id-{i}")),
                    label: format!("Node {i}"),
                    group: "default".to_string(),
                    node_type: "fact".to_string(),
                    importance: 0.5,
                    created_at: 1_700_000_000_000 + i,
                    cluster_count: 1,
                    has_contradiction: i % 50 == 0,
                })
                .collect(),
            edges: (0..1_999)
                .map(|i| GraphEdgeData {
                    source_idx: i,
                    target_idx: i + 1,
                    relation: "relates".to_string(),
                    weight: 0.5,
                    is_contradiction: false,
                })
                .collect(),
            total_matching_nodes: 2_000,
            clustered_nodes: 0,
        };
        let dense_layout = compute_graph_layout(&dense);
        assert_eq!(dense_layout.nodes.len(), 2_000);
        assert!(
            dense_layout
                .nodes
                .iter()
                .all(|p| p.x.is_finite() && p.y.is_finite())
        );
        if !cfg!(debug_assertions) {
            assert!(
                dense_layout.elapsed_ms < 250.0,
                "single-group 2k layout took {} ms (budget < 250 ms)",
                dense_layout.elapsed_ms
            );
        }
    }

    #[test]
    fn fit_viewport_keeps_all_nodes_inside_padded_canvas_bounds() {
        let mut nodes = Vec::new();
        let coords = [
            (-520.0_f32, -310.0_f32),
            (640.0, -280.0),
            (-480.0, 410.0),
            (610.0, 420.0),
            (0.0, 0.0),
        ];
        for (i, (x, y)) in coords.into_iter().enumerate() {
            nodes.push(PositionedNode {
                data: GraphNodeData {
                    key: format!("k-{i}"),
                    memory_id: Some(format!("id-{i}")),
                    label: format!("Node {i}"),
                    group: "ns".to_string(),
                    node_type: "fact".to_string(),
                    importance: 0.7,
                    created_at: 1_700_000_000_000 + i as i64,
                    cluster_count: 1,
                    has_contradiction: false,
                },
                x,
                y,
                radius: 10.0,
            });
        }
        let layout = ComputedLayout {
            mode: GraphMode::Namespace,
            nodes,
            edges: Vec::new(),
            group_labels: Vec::new(),
            timeline_ticks: Vec::new(),
            total_matching_nodes: 5,
            clustered_nodes: 0,
            min_x: -520.0,
            max_x: 640.0,
            min_y: -310.0,
            max_y: 420.0,
            elapsed_ms: 1.0,
        };
        let bounds = Bounds::new(point(px(220.), px(56.)), size(px(1316.), px(776.)));
        let vp = compute_fit_viewport(&layout, 1316.0, 776.0);
        for node in &layout.nodes {
            let sp = vp.world_to_screen(bounds, node.x, node.y);
            let r = (node.radius * vp.zoom).clamp(3.0, 44.0);
            assert!(
                sp.x.as_f32() - r >= bounds.left().as_f32() + 8.0,
                "node left clipped at {:?}",
                sp
            );
            assert!(
                sp.x.as_f32() + r <= bounds.right().as_f32() - 8.0,
                "node right clipped at {:?}",
                sp
            );
            assert!(
                sp.y.as_f32() - r >= bounds.top().as_f32() + 12.0,
                "node top clipped at {:?}",
                sp
            );
            assert!(
                sp.y.as_f32() + r <= bounds.bottom().as_f32() - 16.0,
                "node bottom clipped at {:?}",
                sp
            );
        }
    }

    #[test]
    fn temporal_layout_spreads_equal_timestamps_without_exact_overlap() {
        let equal_ts = GraphSnapshot {
            mode: GraphMode::Temporal,
            nodes: (0..18)
                .map(|i| GraphNodeData {
                    key: format!("eq-{i}"),
                    memory_id: Some(format!("id-{i}")),
                    label: format!("Import {i}"),
                    group: "2026-02".to_string(),
                    node_type: "fact".to_string(),
                    importance: 0.6,
                    created_at: 1_700_000_000_000,
                    cluster_count: 1,
                    has_contradiction: false,
                })
                .collect(),
            edges: Vec::new(),
            total_matching_nodes: 18,
            clustered_nodes: 0,
        };
        let layout = compute_graph_layout(&equal_ts);
        assert_eq!(layout.nodes.len(), 18);
        let distinct_y: std::collections::HashSet<i32> = layout
            .nodes
            .iter()
            .map(|n| (n.y * 10.0).round() as i32)
            .collect();
        assert!(
            distinct_y.len() > 1,
            "expected equal-timestamp nodes to spread into parallel sub-tracks, got {:?}",
            distinct_y
        );
        for (i, a) in layout.nodes.iter().enumerate() {
            for b in &layout.nodes[i + 1..] {
                let dist = ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt();
                assert!(
                    dist >= 16.0,
                    "equal-timestamp nodes overlapped at distance {dist}"
                );
            }
        }
    }

    #[test]
    fn temporal_layout_avoids_outlier_collapse_for_recent_cluster() {
        let now_ms = 1_760_000_000_000_i64;
        let day_ms = 86_400_000_i64;
        let mut nodes = Vec::with_capacity(96);
        nodes.push(GraphNodeData {
            key: "quar91e0".to_string(),
            memory_id: Some("quar91e0".to_string()),
            label: "quar Old outlier note".to_string(),
            group: "2025-07".to_string(),
            node_type: "observation".to_string(),
            importance: 0.4,
            created_at: now_ms - 120 * day_ms,
            cluster_count: 1,
            has_contradiction: false,
        });
        for i in 1..96 {
            nodes.push(GraphNodeData {
                key: format!("live_{i:04}"),
                memory_id: Some(format!("live_{i:04}")),
                label: format!("live Design note #{i}"),
                group: "2025-11".to_string(),
                node_type: "fact".to_string(),
                importance: 0.6,
                created_at: now_ms - 48 * 3_600_000 + (i as i64) * 1_500_000,
                cluster_count: 1,
                has_contradiction: false,
            });
        }
        let snapshot = GraphSnapshot {
            mode: GraphMode::Temporal,
            nodes,
            edges: Vec::new(),
            total_matching_nodes: 96,
            clustered_nodes: 0,
        };
        let layout = compute_graph_layout(&snapshot);
        let vp = compute_fit_viewport(&layout, 1300.0, 770.0);
        assert!(
            vp.zoom >= 0.55,
            "expected outlier-resilient temporal zoom >= 0.55, got {}",
            vp.zoom
        );
        for w in layout.nodes.windows(2) {
            assert!(w[0].x <= w[1].x);
        }
        for (i, a) in layout.nodes.iter().enumerate() {
            for b in &layout.nodes[i + 1..] {
                let dist = ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt();
                assert!(
                    dist >= 16.0,
                    "temporal nodes collapsed/overlapped at distance {dist}"
                );
            }
        }
    }

    #[test]
    fn strip_short_id_prefix_removes_alnum_short_ids_from_db_labels() {
        assert_eq!(
            strip_short_id_prefix("auth API session cookies", Some("auth_0001")),
            "API session cookies"
        );
        assert_eq!(
            strip_short_id_prefix("conf Duplicate note", Some("conf_0002")),
            "Duplicate note"
        );
        assert_eq!(
            strip_short_id_prefix("arch Architecture note", Some("arch_0003")),
            "Architecture note"
        );
        assert_eq!(
            strip_short_id_prefix("live Live background writer", Some("live_0004")),
            "Live background writer"
        );
        assert_eq!(
            strip_short_id_prefix("a3f9 Hex prefixed note", None),
            "Hex prefixed note"
        );
        assert_eq!(
            strip_short_id_prefix("[mem:0001] Bracketed citation", None),
            "Bracketed citation"
        );
        assert_eq!(
            strip_short_id_prefix("Live migration plan", Some("0042")),
            "Live migration plan"
        );
    }

    #[test]
    fn linked_node_hover_matches_local_or_external_id() {
        assert!(is_node_hovered(Some(2), 2, None, Some("m1")));
        assert!(is_node_hovered(None, 2, Some("m1"), Some("m1")));
        assert!(!is_node_hovered(None, 2, Some("m1"), Some("m2")));
        assert!(!is_node_hovered(None, 2, Some("m1"), None));
    }

    #[test]
    fn graph_label_zoom_gate_collision_and_bounds_clamp() {
        // Below the ambient threshold, only selected or hovered labels appear.
        let gate = GRAPH_AMBIENT_LABEL_MIN_ZOOM;
        assert!(!should_show_node_label(
            true,
            false,
            false,
            gate - 0.01,
            true
        ));
        assert!(should_show_node_label(true, false, false, gate, true));
        assert!(!should_show_node_label(
            true,
            false,
            false,
            gate - 0.01,
            false
        ));
        assert!(should_show_node_label(true, true, false, 0.25, false));
        assert!(should_show_node_label(true, false, true, 0.25, false));

        // Ambient label skips when both sides overlap existing labels.
        let canvas = (0.0, 0.0, 500.0, 400.0);
        let occupied = vec![(190.0, 180.0, 320.0, 220.0), (40.0, 180.0, 180.0, 220.0)];
        let skipped = pick_non_overlapping_label_pos(
            200.0,
            200.0,
            8.0,
            90.0,
            16.0,
            2.0,
            1.0,
            canvas,
            &occupied,
            &[],
            false,
        );
        assert!(skipped.is_none());

        // Priority (selected/hovered) label near right edge clamps cleanly inside canvas bounds.
        let clamped = pick_non_overlapping_label_pos(
            490.0,
            200.0,
            8.0,
            90.0,
            16.0,
            2.0,
            1.0,
            canvas,
            &[(300.0, 180.0, 420.0, 220.0)],
            &[],
            true,
        )
        .expect("priority label near canvas edge must clamp inside canvas");
        assert!(clamped.x + 90.0 <= 500.0);
        assert!(clamped.x >= 6.0);
    }
}
