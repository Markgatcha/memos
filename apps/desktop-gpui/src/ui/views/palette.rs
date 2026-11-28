use std::ops::Range;
use std::time::Duration;

use gpui::{
    Animation, AnimationExt, AnyElement, AppContext, Context, Entity, EventEmitter, Focusable,
    FontWeight, InteractiveElement, IntoElement, MouseButton, ParentElement, Render, Role,
    SharedString, StatefulInteractiveElement, Styled, Subscription, Window, div,
    prelude::FluentBuilder, px,
};

use crate::ui::motion::{DURATION_NORMAL_MS, ease_out_cubic};

use crate::core::model::{GraphMode, MemoryListItem, SortOrder, ViewMode, format_relative_age};
use crate::core::settings::SavedView;
use crate::ui::views::{InputEvent, TextInput, ThemePalette, keycap, status_dot};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PaletteAction {
    JumpToMemory(String),
    NewMemory,
    EditSelectedMemory,
    ForgetSelectedMemory,
    SwitchView(ViewMode),
    OpenToday,
    OpenReview,
    SwitchGraphMode(GraphMode),
    FitGraphView,
    SetSort(SortOrder),
    ToggleTheme,
    ToggleRowDensity,
    OpenHealth,
    OpenDreamDiff,
    OpenTimeTravel,
    PreviewContext,
    OpenContextPack,
    TogglePinSelected,
    CompareSelected,
    QuickCapture,
    /// Read-only stand-in for write commands: explains and opens Settings.
    ExplainWriteMode,
    ToggleInspector,
    ToggleGraphFocus,
    OpenSearchSyntax,
    ManageSavedView(String),
    SaveCurrentView,
    DeleteSavedView(String),
    OpenShortcuts,
    CopyActiveMarkdown,
    OpenHarnesses,
    OpenSettings,
    OptimizeStore,
    OpenLogs,
    CopyDiagnostics,
    ClearFilters,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum PaletteGroup {
    Recent,
    Navigate,
    Views,
    Actions,
}

impl PaletteGroup {
    pub fn label(self) -> &'static str {
        match self {
            PaletteGroup::Recent => "Recent",
            PaletteGroup::Navigate => "Navigate",
            PaletteGroup::Views => "Views",
            PaletteGroup::Actions => "Actions",
        }
    }
}

#[derive(Clone, Debug)]
pub struct PaletteEntry {
    pub title: String,
    pub subtitle: String,
    pub badge: &'static str,
    pub shortcut: Option<&'static str>,
    pub group: PaletteGroup,
    pub action: PaletteAction,
    /// Extra search terms (synonyms) that are not shown.
    pub keywords: &'static str,
    pub match_score: i32,
    pub title_matches: Vec<Range<usize>>,
}

#[derive(Clone, Debug)]
pub enum PaletteEvent {
    Execute(PaletteAction),
    Closed,
}

/// Modal Ctrl/Cmd+K command palette for jumping to memories and running app commands.
pub struct CommandPalette {
    is_open: bool,
    input: Entity<TextInput>,
    entries: Vec<PaletteEntry>,
    selected_ix: usize,
    memories_snapshot: Vec<MemoryListItem>,
    saved_views_snapshot: Vec<SavedView>,
    recent_titles: Vec<String>,
    write_mode: bool,
    has_selection: bool,
    theme: ThemePalette,
    _subscriptions: Vec<Subscription>,
}

impl CommandPalette {
    pub fn new(theme: ThemePalette, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| {
            TextInput::new(cx, "Search memories or run a command", theme)
                .with_leading_icon(crate::ui::views::UiIcon::Search)
        });
        let sub = cx.subscribe_in(&input, window, |this, _, event, _window, cx| match event {
            InputEvent::Changed(query) => {
                this.rebuild_entries(query);
                cx.notify();
            }
            InputEvent::MoveUp => {
                if !this.entries.is_empty() {
                    this.selected_ix = if this.selected_ix == 0 {
                        this.entries.len() - 1
                    } else {
                        this.selected_ix - 1
                    };
                    cx.notify();
                }
            }
            InputEvent::MoveDown => {
                if !this.entries.is_empty() {
                    this.selected_ix = (this.selected_ix + 1) % this.entries.len();
                    cx.notify();
                }
            }
            InputEvent::Submit(_) => {
                if let Some(entry) = this.entries.get(this.selected_ix).cloned() {
                    this.record_recent(&entry);
                    this.is_open = false;
                    cx.emit(PaletteEvent::Execute(entry.action));
                    cx.notify();
                }
            }
            InputEvent::Cancel => {
                this.is_open = false;
                cx.emit(PaletteEvent::Closed);
                cx.notify();
            }
            InputEvent::BackspaceWhenEmpty => {}
        });

        let mut palette = Self {
            is_open: false,
            input,
            entries: Vec::new(),
            selected_ix: 0,
            memories_snapshot: Vec::new(),
            saved_views_snapshot: Vec::new(),
            recent_titles: Vec::new(),
            write_mode: false,
            has_selection: false,
            theme,
            _subscriptions: vec![sub],
        };
        palette.rebuild_entries("");
        palette
    }

    pub fn set_write_context(
        &mut self,
        write_mode: bool,
        has_selection: bool,
        cx: &mut Context<Self>,
    ) {
        if self.write_mode != write_mode || self.has_selection != has_selection {
            self.write_mode = write_mode;
            self.has_selection = has_selection;
            let q = self.input.read(cx).text().to_string();
            self.rebuild_entries(&q);
            cx.notify();
        }
    }

    pub fn is_open(&self) -> bool {
        self.is_open
    }

    pub fn open(
        &mut self,
        items: &[MemoryListItem],
        saved_views: &[SavedView],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // Keep a bounded local slice for instant Ctrl+K jump without duplicating 50k items.
        self.memories_snapshot = items.iter().take(2000).cloned().collect();
        self.saved_views_snapshot = saved_views.to_vec();
        self.is_open = true;
        self.input.update(cx, |input, cx| input.set_text("", cx));
        self.rebuild_entries("");
        let focus_handle = self.input.focus_handle(cx);
        window.focus(&focus_handle, cx);
        cx.notify();
    }

    pub fn close(&mut self, cx: &mut Context<Self>) {
        if self.is_open {
            self.is_open = false;
            cx.emit(PaletteEvent::Closed);
            cx.notify();
        }
    }

    pub fn set_theme(&mut self, theme: ThemePalette, cx: &mut Context<Self>) {
        self.theme = theme;
        self.input
            .update(cx, |input, cx| input.set_theme(theme, cx));
        cx.notify();
    }

    fn record_recent(&mut self, entry: &PaletteEntry) {
        if matches!(
            entry.action,
            PaletteAction::JumpToMemory(_) | PaletteAction::DeleteSavedView(_)
        ) {
            return;
        }
        self.recent_titles.retain(|t| t != &entry.title);
        self.recent_titles.insert(0, entry.title.clone());
        self.recent_titles.truncate(4);
    }

    fn rebuild_entries(&mut self, query: &str) {
        self.entries = filter_palette_entries_full(
            query,
            &self.memories_snapshot,
            &self.recent_titles,
            &self.saved_views_snapshot,
            self.write_mode,
            self.has_selection,
        );
        self.selected_ix = 0;
    }
}

/// Pure subsequence + substring matcher returning `(score, matched_byte_ranges)` on `text`.
pub fn fuzzy_match_ranges(text: &str, query: &str) -> Option<(i32, Vec<Range<usize>>)> {
    let q_clean: String = query.chars().filter(|c| !c.is_whitespace()).collect();
    if q_clean.is_empty() {
        return Some((0, Vec::new()));
    }
    let q_lower: Vec<char> = q_clean.to_ascii_lowercase().chars().collect();
    let chars: Vec<(usize, char)> = text.char_indices().collect();

    // Fast path: contiguous substring match in lowercase (handles common commands cleanly).
    let text_lower = text.to_ascii_lowercase();
    let needle_lower: String = q_lower.iter().collect();
    if text_lower.len() == text.len()
        && let Some(pos) = text_lower.find(&needle_lower)
    {
        let boundary = pos == 0
            || text[..pos]
                .chars()
                .next_back()
                .is_some_and(|c| matches!(c, ' ' | ':' | '-' | '_' | '/'));
        let bonus = if pos == 0 {
            160
        } else if boundary {
            135
        } else {
            95
        };
        let ranges: Vec<Range<usize>> = std::iter::once(pos..pos + needle_lower.len()).collect();
        return Some((bonus - (pos as i32), ranges));
    }

    let mut qi = 0usize;
    let mut ranges: Vec<Range<usize>> = Vec::new();
    let mut score = 40_i32;
    let mut prev_match_ix: Option<usize> = None;

    for (ix, &(byte_start, ch)) in chars.iter().enumerate() {
        if qi >= q_lower.len() {
            break;
        }
        let lc = ch.to_ascii_lowercase();
        if lc == q_lower[qi] {
            let byte_end = byte_start + ch.len_utf8();
            if let Some(last) = ranges.last_mut()
                && last.end == byte_start
            {
                last.end = byte_end;
            } else {
                ranges.push(byte_start..byte_end);
            }

            if ix == 0 {
                score += 24;
            } else {
                let prev_ch = chars[ix - 1].1;
                if matches!(prev_ch, ' ' | ':' | '-' | '_' | '/') {
                    score += 18;
                }
            }
            if let Some(prev) = prev_match_ix
                && prev + 1 == ix
            {
                score += 14;
            }
            score -= (ix as i32).min(12) / 3;
            prev_match_ix = Some(ix);
            qi += 1;
        }
    }

    if qi == q_lower.len() {
        Some((score, ranges))
    } else {
        None
    }
}

/// Splits `text` into contiguous `(slice, is_bold_match)` runs from sorted byte ranges.
pub fn split_highlight_segments(text: &str, ranges: &[Range<usize>]) -> Vec<(String, bool)> {
    if ranges.is_empty() {
        return vec![(text.to_string(), false)];
    }
    let mut out = Vec::new();
    let mut cursor = 0usize;
    for r in ranges {
        let start = r.start.clamp(cursor, text.len());
        let end = r.end.clamp(start, text.len());
        if start > cursor {
            out.push((text[cursor..start].to_string(), false));
        }
        if end > start {
            out.push((text[start..end].to_string(), true));
        }
        cursor = end;
    }
    if cursor < text.len() {
        out.push((text[cursor..].to_string(), false));
    }
    out
}

/// `(title, subtitle, badge, shortcut, group, action, keywords)`.
type StaticCommand = (
    &'static str,
    &'static str,
    &'static str,
    Option<&'static str>,
    PaletteGroup,
    PaletteAction,
    &'static str,
);

fn static_palette_commands() -> Vec<PaletteEntry> {
    use PaletteGroup::{Actions, Views};
    #[rustfmt::skip]
    let entries: Vec<StaticCommand> = vec![
        ("Show list", "Browse memories as a list", "View", Some("Ctrl 1"), Views, PaletteAction::SwitchView(ViewMode::List), "switch view rows"),
        ("Show graph", "See how memories connect", "View", Some("Ctrl 2"), Views, PaletteAction::SwitchView(ViewMode::Graph), "switch view network map"),
        ("Open Today", "What changed in the last day, and standing issues", "Today", Some("Ctrl 3"), Views, PaletteAction::OpenToday, "brief daily digest"),
        ("Open Review queue", "Memories agents proposed that are waiting for a decision", "Review", Some("Ctrl 4"), Views, PaletteAction::OpenReview, "approve reject pending candidates"),
        ("Fit graph view", "Center and fit every visible node", "Graph", Some("0"), Views, PaletteAction::FitGraphView, "zoom reset"),
        ("Focus on selected node", "Dim everything but the selection and its direct links", "Graph", Some("F"), Views, PaletteAction::ToggleGraphFocus, "neighborhood isolate"),
        ("Graph by namespace", "Cluster memories by namespace", "Graph", None, Views, PaletteAction::SwitchGraphMode(GraphMode::Namespace), "mode ns"),
        ("Graph by tag", "Cluster memories by their first tag", "Graph", None, Views, PaletteAction::SwitchGraphMode(GraphMode::Tag), "mode"),
        ("Graph by entity", "Group memories that mention the same entity", "Graph", None, Views, PaletteAction::SwitchGraphMode(GraphMode::Entity), "mode people"),
        ("Graph over time", "Lay memories out by creation date", "Graph", None, Views, PaletteAction::SwitchGraphMode(GraphMode::Temporal), "mode temporal timeline"),
        ("Graph contradictions", "Show only memories that conflict, and their links", "Graph", None, Views, PaletteAction::SwitchGraphMode(GraphMode::Contradictions), "mode conflicts"),
        ("Clear filters", "Reset search, scopes and facets", "Filter", None, Views, PaletteAction::ClearFilters, "reset all"),
        ("Save current view…", "Keep this search, filter and sort in the sidebar", "View", None, Views, PaletteAction::SaveCurrentView, "bookmark"),
        ("Search syntax", "Scopes like type:, tag:, ns:, is:stale and after:", "Search", Some("Ctrl /"), Views, PaletteAction::OpenSearchSyntax, "help tokens query builder filter"),
        ("Build context pack", "Collect memories for an agent within a token budget", "Context", Some("C"), Actions, PaletteAction::OpenContextPack, "ai prompt copy export what the ai sees"),
        ("Preview context for current view", "Context pack from the memories in this view", "Context", None, Actions, PaletteAction::PreviewContext, "ai sees prompt"),
        ("Pin selected memory", "Add or remove the selection from the context pack", "Context", Some("P"), Actions, PaletteAction::TogglePinSelected, "unpin collect basket"),
        ("Compare with conflicting memory", "Side by side with the memory it contradicts", "Conflict", Some("X"), Actions, PaletteAction::CompareSelected, "contradiction diff versus"),
        ("Show or hide inspector", "Toggle the detail pane for the selection", "View", Some("I"), Actions, PaletteAction::ToggleInspector, "detail panel"),
        ("Store health", "Cleanup suggestions: conflicts, stale and duplicate memories", "Health", None, Actions, PaletteAction::OpenHealth, "fix issues score what to fix"),
        ("Dream diff timeline", "Promotions, merges, decay and conflicts over time", "Timeline", None, Actions, PaletteAction::OpenDreamDiff, "history activity"),
        ("Time travel", "See the store as it stood on a past date", "Timeline", None, Views, PaletteAction::OpenTimeTravel, "as of asof history past bitemporal rewind"),
        ("Copy selected memory as Markdown", "Heading, metadata line, body and citation", "Copy", None, Actions, PaletteAction::CopyActiveMarkdown, "clipboard export"),
        ("Toggle theme", "Switch between dark and light", "Look", None, Actions, PaletteAction::ToggleTheme, "color appearance dark light mode"),
        ("Toggle row density", "Comfortable or compact list rows", "Look", None, Actions, PaletteAction::ToggleRowDensity, "compact spacing"),
        ("Sort by recency", "Most recently updated first", "Sort", None, Actions, PaletteAction::SetSort(SortOrder::Recency), "newest order"),
        ("Sort by importance", "Most important first", "Sort", None, Actions, PaletteAction::SetSort(SortOrder::Importance), "order"),
        ("Sort by trust", "Most trusted first", "Sort", None, Actions, PaletteAction::SetSort(SortOrder::Trust), "order"),
        ("Open tools", "Connect Claude Code, Codex, Cursor and other harnesses", "Tools", None, Actions, PaletteAction::OpenHarnesses, "harness integrations mcp"),
        ("Optimize store", "Add missing read-path indexes. Safe to repeat", "Store", None, Actions, PaletteAction::OptimizeStore, "index speed database"),
        ("Open settings", "Appearance, store, writing and privacy", "Settings", None, Actions, PaletteAction::OpenSettings, "preferences config write mode"),
        ("Keyboard shortcuts", "Every key the workbench understands", "Help", Some("?"), Actions, PaletteAction::OpenShortcuts, "keys hotkeys"),
        ("Open logs folder", "Rotating logs and local crash reports", "Diagnostics", None, Actions, PaletteAction::OpenLogs, "debug"),
        ("Copy diagnostics", "Versions, counts and log paths. No memory text", "Diagnostics", None, Actions, PaletteAction::CopyDiagnostics, "support debug"),
    ];

    entries
        .into_iter()
        .map(
            |(title, subtitle, badge, shortcut, group, action, keywords)| PaletteEntry {
                title: title.to_string(),
                subtitle: subtitle.to_string(),
                badge,
                shortcut,
                group,
                action,
                keywords,
                match_score: 0,
                title_matches: Vec::new(),
            },
        )
        .collect()
}

/// Every word of the query is a prefix of some keyword.
fn keywords_match(keywords: &str, q_lower: &str) -> bool {
    !keywords.is_empty()
        && q_lower
            .split_whitespace()
            .all(|w| keywords.split_whitespace().any(|k| k.starts_with(w)))
}

/// Pure ranking/filter helper backing the Ctrl/Cmd+K command palette.
pub fn filter_palette_entries(
    query: &str,
    memories_snapshot: &[MemoryListItem],
) -> Vec<PaletteEntry> {
    filter_palette_entries_with_recents(query, memories_snapshot, &[])
}

pub fn filter_palette_entries_with_recents(
    query: &str,
    memories_snapshot: &[MemoryListItem],
    recent_titles: &[String],
) -> Vec<PaletteEntry> {
    filter_palette_entries_with_views(query, memories_snapshot, recent_titles, &[])
}

pub fn filter_palette_entries_with_views(
    query: &str,
    memories_snapshot: &[MemoryListItem],
    recent_titles: &[String],
    saved_views: &[SavedView],
) -> Vec<PaletteEntry> {
    filter_palette_entries_full(
        query,
        memories_snapshot,
        recent_titles,
        saved_views,
        false,
        false,
    )
}

pub fn filter_palette_entries_full(
    query: &str,
    memories_snapshot: &[MemoryListItem],
    recent_titles: &[String],
    saved_views: &[SavedView],
    write_mode: bool,
    has_selection: bool,
) -> Vec<PaletteEntry> {
    let trimmed = query.trim();
    let q_lower = trimmed.to_ascii_lowercase();
    let mut recent_matches = Vec::new();
    let mut view_matches = Vec::new();
    let mut action_matches = Vec::new();

    let mut all_cmds = static_palette_commands();
    all_cmds.insert(
        0,
        PaletteEntry {
            title: "Capture memory".to_string(),
            subtitle: if write_mode {
                "Quick one-field capture with #tags, ns: and type:".to_string()
            } else {
                "Editing is off. Opens Settings to turn on write mode".to_string()
            },
            badge: "Write",
            shortcut: Some(if cfg!(target_os = "macos") {
                "⌘ N"
            } else {
                "Ctrl N"
            }),
            group: PaletteGroup::Actions,
            action: if write_mode {
                PaletteAction::QuickCapture
            } else {
                PaletteAction::ExplainWriteMode
            },
            keywords: "new add note quick store write",
            match_score: 0,
            title_matches: Vec::new(),
        },
    );
    if write_mode {
        all_cmds.insert(
            1,
            PaletteEntry {
                title: "New memory with all fields…".to_string(),
                subtitle: "Full composer: type, pool, namespace, tags and context".to_string(),
                badge: "Write",
                shortcut: None,
                group: PaletteGroup::Actions,
                action: PaletteAction::NewMemory,
                keywords: "create add write full composer",
                match_score: 0,
                title_matches: Vec::new(),
            },
        );
        if has_selection {
            all_cmds.insert(
                2,
                PaletteEntry {
                    title: "Edit selected memory".to_string(),
                    subtitle: "Saves a new version that supersedes this one".to_string(),
                    badge: "Write",
                    shortcut: None,
                    group: PaletteGroup::Actions,
                    action: PaletteAction::EditSelectedMemory,
                    keywords: "change update supersede",
                    match_score: 0,
                    title_matches: Vec::new(),
                },
            );
            all_cmds.insert(
                3,
                PaletteEntry {
                    title: "Forget selected memory…".to_string(),
                    subtitle: "Asks for confirmation, then forgets it through the writer"
                        .to_string(),
                    badge: "Write",
                    shortcut: None,
                    group: PaletteGroup::Actions,
                    action: PaletteAction::ForgetSelectedMemory,
                    keywords: "delete remove",
                    match_score: 0,
                    title_matches: Vec::new(),
                },
            );
        }
    }
    for view in saved_views.iter().filter(|v| !v.built_in) {
        all_cmds.push(PaletteEntry {
            title: format!("Delete saved view: {}", view.name),
            subtitle: format!("Remove custom view \"{}\" from sidebar", view.name),
            badge: "View",
            shortcut: None,
            group: PaletteGroup::Views,
            action: PaletteAction::DeleteSavedView(view.id.clone()),
            keywords: "remove",
            match_score: 0,
            title_matches: Vec::new(),
        });
        all_cmds.push(PaletteEntry {
            title: format!("Rename or update view: {}", view.name),
            subtitle: "Rename it, or replace its filters with the current ones".to_string(),
            badge: "View",
            shortcut: None,
            group: PaletteGroup::Views,
            action: PaletteAction::ManageSavedView(view.id.clone()),
            keywords: "edit manage saved view",
            match_score: 0,
            title_matches: Vec::new(),
        });
    }

    for mut cmd in all_cmds {
        let is_recent = recent_titles.iter().any(|r| r == &cmd.title);
        if is_recent {
            cmd.group = PaletteGroup::Recent;
        }
        let target_vec = match cmd.group {
            PaletteGroup::Recent => &mut recent_matches,
            PaletteGroup::Views => &mut view_matches,
            PaletteGroup::Actions | PaletteGroup::Navigate => &mut action_matches,
        };

        if trimmed.is_empty() {
            target_vec.push(cmd);
            continue;
        }

        if let Some((score, ranges)) = fuzzy_match_ranges(&cmd.title, trimmed) {
            cmd.match_score = score + if is_recent { 15 } else { 0 };
            cmd.title_matches = ranges;
            target_vec.push(cmd);
        } else if let Some((sub_score, _)) = fuzzy_match_ranges(&cmd.subtitle, trimmed) {
            cmd.match_score = (sub_score / 2) - 10;
            target_vec.push(cmd);
        } else if cmd.badge.to_ascii_lowercase().contains(&q_lower)
            || keywords_match(cmd.keywords, &q_lower)
        {
            cmd.match_score = 10;
            target_vec.push(cmd);
        }
    }

    if !trimmed.is_empty() {
        let re_score = |entries: Vec<PaletteEntry>| -> Vec<PaletteEntry> {
            entries
                .into_iter()
                .filter_map(|mut entry| {
                    if let Some((s, ranges)) = fuzzy_match_ranges(&entry.title, trimmed) {
                        let substr_bonus = if entry.title.to_ascii_lowercase().contains(&q_lower) {
                            120
                        } else {
                            0
                        };
                        entry.title_matches = ranges;
                        entry.match_score = s + 220 + substr_bonus;
                        Some(entry)
                    } else if entry.badge.to_ascii_lowercase().contains(&q_lower) {
                        entry.title_matches.clear();
                        entry.match_score = 75;
                        Some(entry)
                    } else if keywords_match(entry.keywords, &q_lower) {
                        entry.title_matches.clear();
                        entry.match_score = 60;
                        Some(entry)
                    } else if entry.subtitle.to_ascii_lowercase().contains(&q_lower) {
                        entry.title_matches.clear();
                        entry.match_score = 45;
                        Some(entry)
                    } else {
                        None
                    }
                })
                .collect()
        };

        recent_matches = re_score(recent_matches);
        view_matches = re_score(view_matches);
        action_matches = re_score(action_matches);

        let best_non_recent = view_matches
            .iter()
            .chain(action_matches.iter())
            .map(|e| e.match_score)
            .max()
            .unwrap_or(i32::MIN);

        let mut kept_recent = Vec::with_capacity(recent_matches.len());
        for mut entry in recent_matches {
            let direct_title = !entry.title_matches.is_empty();
            if direct_title && entry.match_score + 30 >= best_non_recent {
                kept_recent.push(entry);
            } else {
                let natural_group = match entry.action {
                    PaletteAction::SwitchView(_)
                    | PaletteAction::OpenToday
                    | PaletteAction::OpenReview
                    | PaletteAction::SwitchGraphMode(_)
                    | PaletteAction::FitGraphView
                    | PaletteAction::SaveCurrentView
                    | PaletteAction::DeleteSavedView(_)
                    | PaletteAction::ManageSavedView(_)
                    | PaletteAction::ToggleGraphFocus
                    | PaletteAction::OpenSearchSyntax
                    | PaletteAction::ClearFilters => PaletteGroup::Views,
                    _ => PaletteGroup::Actions,
                };
                entry.group = natural_group;
                match natural_group {
                    PaletteGroup::Views => view_matches.push(entry),
                    _ => action_matches.push(entry),
                }
            }
        }
        recent_matches = kept_recent;

        recent_matches.sort_by_key(|a| std::cmp::Reverse(a.match_score));
        view_matches.sort_by_key(|a| std::cmp::Reverse(a.match_score));
        action_matches.sort_by_key(|a| std::cmp::Reverse(a.match_score));
    }

    // Add matching memories under `Navigate` so users can jump directly from Ctrl+K.
    let citation_hint = q_lower
        .strip_prefix("[mem:")
        .and_then(|s| s.strip_suffix(']'))
        .or_else(|| q_lower.strip_prefix("mem:"))
        .unwrap_or(&q_lower);

    let mut mem_matches = Vec::new();
    for item in memories_snapshot {
        let title = format!("#{} {}", item.short_id, item.preview);
        if trimmed.is_empty() {
            mem_matches.push(PaletteEntry {
                title,
                subtitle: format!("{} · {}", item.node_type, item.namespace),
                badge: "Memory",
                shortcut: None,
                group: PaletteGroup::Navigate,
                action: PaletteAction::JumpToMemory(item.id.clone()),
                keywords: "",
                match_score: 0,
                title_matches: Vec::new(),
            });
            if mem_matches.len() >= 12 {
                break;
            }
            continue;
        }

        let id_match = item.short_id.as_ref().contains(citation_hint)
            || item.id.to_ascii_lowercase().contains(&q_lower);
        let fuzzy_title = fuzzy_match_ranges(&title, trimmed);
        let ns_match = item.namespace.to_ascii_lowercase().contains(&q_lower);
        if id_match || fuzzy_title.is_some() || ns_match {
            let (score, ranges) = match fuzzy_title {
                Some((s, r)) => (s + if id_match { 80 } else { 0 }, r),
                None => (if id_match { 110 } else { 20 }, Vec::new()),
            };
            mem_matches.push(PaletteEntry {
                title,
                subtitle: format!("{} · {}", item.node_type, item.namespace),
                badge: "Memory",
                shortcut: None,
                group: PaletteGroup::Navigate,
                action: PaletteAction::JumpToMemory(item.id.clone()),
                keywords: "",
                match_score: score,
                title_matches: ranges,
            });
        }
    }
    if !trimmed.is_empty() {
        mem_matches.sort_by_key(|a| std::cmp::Reverse(a.match_score));
    }
    mem_matches.truncate(12);

    let mut results = Vec::new();
    results.extend(recent_matches);
    if !trimmed.is_empty() {
        let best_view = view_matches
            .first()
            .map(|e| e.match_score)
            .unwrap_or(i32::MIN);
        let best_action = action_matches
            .first()
            .map(|e| e.match_score)
            .unwrap_or(i32::MIN);
        let best_mem = mem_matches
            .first()
            .map(|e| e.match_score)
            .unwrap_or(i32::MIN);
        let best_cmd = best_view.max(best_action);
        if best_mem > best_cmd
            && (trimmed.starts_with("[mem:") || trimmed.starts_with("mem:") || best_cmd < 200)
        {
            results.extend(mem_matches);
            if best_view >= best_action {
                results.extend(view_matches);
                results.extend(action_matches);
            } else {
                results.extend(action_matches);
                results.extend(view_matches);
            }
        } else if best_view >= best_action {
            results.extend(view_matches);
            results.extend(action_matches);
            results.extend(mem_matches);
        } else {
            results.extend(action_matches);
            results.extend(view_matches);
            results.extend(mem_matches);
        }
    } else {
        results.extend(mem_matches);
        results.extend(view_matches);
        results.extend(action_matches);
    }
    results
}

impl EventEmitter<PaletteEvent> for CommandPalette {}

impl Render for CommandPalette {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.is_open {
            return div().into_any_element();
        }

        let theme = self.theme;
        let vp_w = window.viewport_size().width;
        let show_preview = vp_w >= px(820.) && !self.entries.is_empty();
        let modal_w = (vp_w - px(48.)).min(if show_preview { px(780.) } else { px(560.) });
        let selected_entry = self.entries.get(self.selected_ix).cloned();

        let mut list_elements: Vec<AnyElement> = Vec::new();
        let mut last_group: Option<PaletteGroup> = None;

        for (ix, entry) in self.entries.iter().take(24).enumerate() {
            if last_group != Some(entry.group) {
                last_group = Some(entry.group);
                list_elements.push(
                    div()
                        .w_full()
                        .px(px(12.))
                        .pt(if ix == 0 { px(6.) } else { px(10.) })
                        .pb(px(4.))
                        .text_size(px(11.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(theme.text_muted)
                        .child(entry.group.label())
                        .into_any_element(),
                );
            }

            let selected = ix == self.selected_ix;
            let action = entry.action.clone();
            let title_for_recent = entry.clone();
            let subtitle: SharedString = entry.subtitle.clone().into();
            let segments = split_highlight_segments(&entry.title, &entry.title_matches);

            list_elements.push(
                div()
                    .id(("palette-row", ix))
                    .role(Role::ListItem)
                    .aria_label(entry.title.clone())
                    .aria_selected(selected)
                    .w_full()
                    .px(px(12.))
                    .py(px(7.))
                    .cursor_pointer()
                    .when(selected, |el| el.bg(theme.bg_selected))
                    .when(!selected, |el| el.hover(move |s| s.bg(theme.bg_elevated)))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.record_recent(&title_for_recent);
                        this.is_open = false;
                        cx.emit(PaletteEvent::Execute(action.clone()));
                        cx.notify();
                    }))
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(px(10.))
                    .child(
                        div()
                            .w(px(2.))
                            .h(px(28.))
                            .rounded(px(1.))
                            .flex_shrink_0()
                            .bg(if selected {
                                theme.accent
                            } else {
                                gpui::transparent_black()
                            }),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w(px(0.))
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(
                                div()
                                    .w_full()
                                    .min_w(px(0.))
                                    .overflow_hidden()
                                    .flex()
                                    .items_center()
                                    .text_size(px(13.))
                                    .text_color(if entry.title_matches.is_empty() || selected {
                                        theme.text_primary
                                    } else {
                                        theme.text_secondary
                                    })
                                    .children(segments.into_iter().map(|(seg, is_match)| {
                                        div()
                                            .flex_shrink_0()
                                            .font_weight(if is_match {
                                                FontWeight::BOLD
                                            } else if selected {
                                                FontWeight::MEDIUM
                                            } else {
                                                FontWeight::NORMAL
                                            })
                                            .text_color(if is_match || selected {
                                                theme.text_primary
                                            } else {
                                                theme.text_secondary
                                            })
                                            .child(SharedString::from(seg))
                                    })),
                            )
                            .child(
                                div()
                                    .w_full()
                                    .truncate()
                                    .text_size(px(12.))
                                    .text_color(theme.text_muted)
                                    .child(subtitle),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .flex_shrink_0()
                            .when_some(entry.shortcut, |row, sc| row.child(keycap(sc, &theme)))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(theme.text_muted)
                                    .child(entry.badge),
                            ),
                    )
                    .into_any_element(),
            );
        }

        let preview_panel = selected_entry.map(|entry| {
            let matched_mem = match &entry.action {
                PaletteAction::JumpToMemory(id) => {
                    self.memories_snapshot.iter().find(|m| &m.id == id).cloned()
                }
                _ => None,
            };

            div()
                .w(px(260.))
                .flex_shrink_0()
                .h_full()
                .p(px(14.))
                .border_l_1()
                .border_color(theme.border_subtle)
                .bg(theme.bg_sunken)
                .flex()
                .flex_col()
                .gap(px(10.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(
                            div()
                                .text_size(px(11.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(theme.text_muted)
                                .child(entry.group.label()),
                        )
                        .child(
                            div()
                                .text_size(px(11.))
                                .text_color(theme.text_muted)
                                .child(entry.badge),
                        ),
                )
                .child(
                    div()
                        .text_size(px(14.))
                        .line_height(px(19.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.text_primary)
                        .child(SharedString::from(entry.title)),
                )
                .child(
                    div()
                        .text_size(px(12.))
                        .line_height(px(17.))
                        .text_color(theme.text_secondary)
                        .child(SharedString::from(entry.subtitle)),
                )
                .when_some(matched_mem, |col, item| {
                    let now_ms = crate::core::health::now_unix_ms();
                    let age = format_relative_age(item.updated_at, now_ms);
                    col.child(
                        div()
                            .mt(px(4.))
                            .p(px(10.))
                            .rounded(px(8.))
                            .bg(theme.bg_panel)
                            .border_1()
                            .border_color(theme.border_subtle)
                            .flex()
                            .flex_col()
                            .gap(px(6.))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.))
                                    .child(status_dot(theme.type_color(&item.node_type)))
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .text_color(theme.text_secondary)
                                            .child(SharedString::from(format!(
                                                "{} · {}",
                                                item.node_type, item.namespace
                                            ))),
                                    ),
                            )
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .line_height(px(17.))
                                    .text_color(theme.text_primary)
                                    .child(SharedString::from(item.preview.to_string())),
                            )
                            .child(div().text_size(px(11.)).text_color(theme.text_muted).child(
                                SharedString::from(format!(
                                    "Trusted {:.0}% · {}",
                                    item.trust_score * 100.0,
                                    age
                                )),
                            )),
                    )
                })
        });

        div()
            .id("palette-backdrop")
            .absolute()
            .inset_0()
            .bg(theme.glass_scrim)
            .flex()
            .justify_center()
            .items_start()
            .pt(px(72.))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    this.close(cx);
                }),
            )
            .child(
                div()
                    .id("palette-modal")
                    .role(Role::Dialog)
                    .aria_label("Command palette")
                    .w(modal_w)
                    .max_h(px(520.))
                    .rounded(px(16.))
                    .bg(theme.glass_floating)
                    .border_1()
                    .border_color(theme.glass_border)
                    .shadow_lg()
                    .relative()
                    .overflow_hidden()
                    .flex()
                    .flex_col()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| {
                        cx.stop_propagation();
                    })
                    .child(
                        div()
                            .absolute()
                            .top(px(0.))
                            .left(px(14.))
                            .right(px(14.))
                            .h(px(1.))
                            .bg(theme.glass_highlight),
                    )
                    .child(
                        div()
                            .p(px(10.))
                            .border_b_1()
                            .border_color(theme.border_subtle)
                            .child(self.input.clone()),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_h(px(0.))
                            .max_h(px(410.))
                            .flex()
                            .flex_row()
                            .overflow_hidden()
                            .child(
                                div()
                                    .id("palette-list")
                                    .flex_1()
                                    .min_w(px(0.))
                                    .overflow_y_scroll()
                                    .when(list_elements.is_empty(), |el| {
                                        el.child(
                                            div()
                                                .p(px(16.))
                                                .text_size(px(13.))
                                                .text_color(theme.text_muted)
                                                .child("No matching commands or loaded memories."),
                                        )
                                    })
                                    .children(list_elements),
                            )
                            .when(show_preview, |row| row.children(preview_panel)),
                    )
                    .child(
                        div()
                            .h(px(34.))
                            .px(px(12.))
                            .bg(theme.bg_app)
                            .border_t_1()
                            .border_color(theme.border_subtle)
                            .flex()
                            .items_center()
                            .justify_between()
                            .text_size(px(12.))
                            .text_color(theme.text_muted)
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(6.))
                                    .child(keycap("↑", &theme))
                                    .child(keycap("↓", &theme))
                                    .child("select")
                                    .child(div().w(px(6.)))
                                    .child(keycap("Enter", &theme))
                                    .child("run")
                                    .child(div().w(px(6.)))
                                    .child(keycap("Esc", &theme))
                                    .child("close"),
                            )
                            .child(format!("{} results", self.entries.len())),
                    )
                    .with_animation(
                        "palette-glass-entrance",
                        Animation::new(Duration::from_millis(DURATION_NORMAL_MS))
                            .with_easing(ease_out_cubic),
                        |el, t| el.opacity(0.55 + 0.45 * t),
                    ),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_items(count: usize) -> Vec<MemoryListItem> {
        (0..count)
            .map(|i| {
                let id = format!("{i:04}0000-0000-4000-8000-000000000001");
                MemoryListItem {
                    short_id: format!("{i:04}").into(),
                    id,
                    preview: format!("Apollo architectural decision {i}").into(),
                    node_type: "decision".into(),
                    namespace: if i % 2 == 0 {
                        "work".into()
                    } else {
                        "personal".into()
                    },
                    provenance: "user-verified".into(),
                    source: "cli".into(),
                    harness: "codex".into(),
                    tags: vec!["rust".into()],
                    importance: 0.8,
                    trust_score: 0.9,
                    created_at: 1_700_000_000_000 + i as i64,
                    updated_at: 1_700_000_000_000 + i as i64,
                    has_contradiction: false,
                    quarantined: false,
                }
            })
            .collect()
    }

    #[test]
    fn palette_filters_commands_and_caps_memory_matches() {
        let items = sample_items(20);
        let empty = filter_palette_entries("", &items);
        let cmd_count = empty
            .iter()
            .filter(|e| !matches!(e.action, PaletteAction::JumpToMemory(_)))
            .count();
        let mem_count = empty
            .iter()
            .filter(|e| matches!(e.action, PaletteAction::JumpToMemory(_)))
            .count();
        assert!(cmd_count >= 18);
        assert_eq!(mem_count, 12);

        let by_cite = filter_palette_entries("[mem:0014]", &items);
        assert!(by_cite.iter().any(|e| matches!(
            &e.action,
            PaletteAction::JumpToMemory(id) if id.starts_with("0014")
        )));

        let by_cmd = filter_palette_entries("contradictions", &items);
        assert!(by_cmd.iter().any(|e| matches!(
            e.action,
            PaletteAction::SwitchGraphMode(GraphMode::Contradictions)
        )));

        let by_health = filter_palette_entries("health", &items);
        assert!(
            by_health
                .iter()
                .any(|e| e.action == PaletteAction::OpenHealth)
        );

        let by_fit = filter_palette_entries("fgv", &items);
        assert!(
            by_fit
                .iter()
                .any(|e| e.action == PaletteAction::FitGraphView)
        );

        let by_md = filter_palette_entries("markdown", &items);
        assert!(
            by_md
                .iter()
                .any(|e| e.action == PaletteAction::CopyActiveMarkdown)
        );
    }

    #[test]
    fn fuzzy_matcher_produces_byte_ranges_for_bold_highlights() {
        let (score, ranges) = fuzzy_match_ranges("Fit graph view", "fgv").expect("fuzzy match");
        assert!(score > 0);
        assert_eq!(ranges.len(), 3);
        let segs = split_highlight_segments("Fit graph view", &ranges);
        assert_eq!(segs[0], ("F".to_string(), true));
        assert_eq!(segs[2], ("g".to_string(), true));
        assert_eq!(segs[4], ("v".to_string(), true));
    }

    #[test]
    fn recent_commands_promote_to_recent_group() {
        let items = sample_items(2);
        let recents = vec!["Store health".to_string()];
        let out = filter_palette_entries_with_recents("", &items, &recents);
        assert_eq!(out[0].group, PaletteGroup::Recent);
        assert_eq!(out[0].action, PaletteAction::OpenHealth);
    }

    #[test]
    fn recent_does_not_outrank_direct_title_match_for_theme_query() {
        let items = sample_items(5);
        let recents = vec!["Store health".to_string(), "Open settings".to_string()];
        let out = filter_palette_entries_with_recents("theme", &items, &recents);
        assert!(!out.is_empty());
        assert_eq!(
            out[0].action,
            PaletteAction::ToggleTheme,
            "expected Toggle theme first for 'theme', got {:?}",
            out.iter()
                .map(|e| (&e.title, e.group, e.match_score))
                .collect::<Vec<_>>()
        );
        assert!(
            out.iter().all(|e| e.action != PaletteAction::OpenHealth),
            "Store Health subtitle must not fuzzy-match 'theme'"
        );
    }

    #[test]
    fn custom_views_expose_delete_actions_and_context_preview_in_palette() {
        let items = sample_items(3);
        let mut views = SavedView::defaults();
        views.push(SavedView {
            id: "custom-auth".to_string(),
            name: "#auth · decision".to_string(),
            filter: crate::core::model::QueryFilter::default(),
            built_in: false,
        });
        let del = filter_palette_entries_with_views("delete saved view", &items, &[], &views);
        assert_eq!(
            del[0].action,
            PaletteAction::DeleteSavedView("custom-auth".to_string())
        );
        let manage = filter_palette_entries_with_views("rename", &items, &[], &views);
        assert!(
            manage
                .iter()
                .any(|e| e.action == PaletteAction::ManageSavedView("custom-auth".to_string()))
        );
        let by_alias = filter_palette_entries_with_views("what the ai sees", &items, &[], &views);
        assert_eq!(by_alias[0].action, PaletteAction::OpenContextPack);
        assert_eq!(
            del[0].action,
            PaletteAction::DeleteSavedView("custom-auth".to_string())
        );

        let ctx = filter_palette_entries_with_views("preview context", &items, &[], &views);
        assert!(
            ctx.iter()
                .any(|e| e.action == PaletteAction::PreviewContext)
        );

        let save = filter_palette_entries_with_views("save current view", &items, &[], &views);
        assert!(
            save.iter()
                .any(|e| e.action == PaletteAction::SaveCurrentView)
        );
    }

    #[test]
    fn write_commands_require_write_mode_and_selection_where_applicable() {
        let items = sample_items(2);
        let read_only = filter_palette_entries_full("", &items, &[], &[], false, true);
        assert!(read_only.iter().all(|e| {
            !matches!(
                e.action,
                PaletteAction::NewMemory
                    | PaletteAction::EditSelectedMemory
                    | PaletteAction::ForgetSelectedMemory
            )
        }));

        let write_no_sel = filter_palette_entries_full("", &items, &[], &[], true, false);
        assert!(
            write_no_sel
                .iter()
                .any(|e| e.action == PaletteAction::NewMemory)
        );
        assert!(write_no_sel.iter().all(|e| {
            !matches!(
                e.action,
                PaletteAction::EditSelectedMemory | PaletteAction::ForgetSelectedMemory
            )
        }));

        let write_with_sel = filter_palette_entries_full("", &items, &[], &[], true, true);
        assert!(
            write_with_sel
                .iter()
                .any(|e| e.action == PaletteAction::EditSelectedMemory)
        );
        assert!(
            write_with_sel
                .iter()
                .any(|e| e.action == PaletteAction::ForgetSelectedMemory)
        );
    }
}
