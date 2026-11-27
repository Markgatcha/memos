//! Key bindings and global key handling.

use super::*;

pub fn register_app_key_bindings(cx: &mut App) {
    register_input_key_bindings(cx);

    #[cfg(target_os = "macos")]
    cx.bind_keys([
        KeyBinding::new("cmd-k", OpenPalette, None),
        KeyBinding::new("cmd-f", FocusSearch, None),
        KeyBinding::new("cmd-1", SwitchToList, None),
        KeyBinding::new("cmd-2", SwitchToGraph, None),
        KeyBinding::new("cmd-3", OpenTodaySurface, None),
        KeyBinding::new("cmd-4", OpenReviewSurface, None),
        KeyBinding::new("cmd-n", QuickCapture, None),
        KeyBinding::new("cmd-/", ToggleSearchSyntax, None),
        KeyBinding::new("cmd-e", ExportMemories, None),
    ]);

    #[cfg(not(target_os = "macos"))]
    cx.bind_keys([
        KeyBinding::new("ctrl-k", OpenPalette, None),
        KeyBinding::new("ctrl-f", FocusSearch, None),
        KeyBinding::new("ctrl-1", SwitchToList, None),
        KeyBinding::new("ctrl-2", SwitchToGraph, None),
        KeyBinding::new("ctrl-3", OpenTodaySurface, None),
        KeyBinding::new("ctrl-4", OpenReviewSurface, None),
        KeyBinding::new("ctrl-n", QuickCapture, None),
        KeyBinding::new("ctrl-/", ToggleSearchSyntax, None),
        KeyBinding::new("ctrl-e", ExportMemories, None),
    ]);
}

impl MemOSApp {
    pub(super) fn on_root_key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.record_window_activity();
        let mods = event.keystroke.modifiers;
        let key_lower = event.keystroke.key.to_ascii_lowercase();

        if key_lower == "escape" && !mods.control && !mods.alt && !mods.platform {
            if self.forget_confirm_target.is_some() {
                self.forget_confirm_target = None;
                window.focus(&self.focus_handle, cx);
                cx.notify();
                return;
            }
            if self.show_composer_modal {
                self.show_composer_modal = false;
                window.focus(&self.focus_handle, cx);
                cx.notify();
                return;
            }
            if self.show_ingest_modal {
                self.show_ingest_modal = false;
                window.focus(&self.focus_handle, cx);
                cx.notify();
                return;
            }
            if self.show_save_view_modal {
                self.show_save_view_modal = false;
                window.focus(&self.focus_handle, cx);
                cx.notify();
                return;
            }
            if self.pack.open {
                self.close_context_pack(window, cx);
                return;
            }
            if self.compare.open {
                self.close_compare(window, cx);
                return;
            }
            if self.capture.open {
                self.close_quick_capture(window, cx);
                return;
            }
            if self.store_switch.open {
                self.close_store_switcher(window, cx);
                return;
            }
            if self.search_ui.manage_view_id.is_some() {
                self.close_manage_view(window, cx);
                return;
            }
            if self.search_ui.help_open {
                self.close_search_help(cx);
                return;
            }
            if self.show_shortcuts_modal {
                self.show_shortcuts_modal = false;
                window.focus(&self.focus_handle, cx);
                cx.notify();
                return;
            }
            if self.show_dream_diff_modal {
                self.show_dream_diff_modal = false;
                window.focus(&self.focus_handle, cx);
                cx.notify();
                return;
            }
            if self.show_health_modal {
                self.show_health_modal = false;
                window.focus(&self.focus_handle, cx);
                cx.notify();
                return;
            }
            if self.show_settings_modal {
                self.show_settings_modal = false;
                self.flush_dirty_settings();
                window.focus(&self.focus_handle, cx);
                cx.notify();
                return;
            }
            if self.show_harnesses_modal {
                self.show_harnesses_modal = false;
                self.pending_connect_id = None;
                window.focus(&self.focus_handle, cx);
                cx.notify();
                return;
            }
            if self.has_any_popover_open(cx) {
                self.dismiss_popovers(PopoverOwner::None, cx);
                return;
            }
            if self.active_surface == WorkspaceSurface::Memories
                && self.view_mode == ViewMode::Graph
                && !self.has_overlay_open(cx)
                && self.graph_view.update(cx, |g, cx| g.exit_focus_mode(cx))
            {
                return;
            }
            if self.active_surface == WorkspaceSurface::Review
                && !self.has_overlay_open(cx)
                && self.review_view.update(cx, |r, cx| r.clear_checked(cx))
            {
                return;
            }
            if self.detail_open && !self.has_overlay_open(cx) {
                self.close_detail(cx);
                return;
            }
        }

        if self.search_input.focus_handle(cx).is_focused(window) || self.has_overlay_open(cx) {
            self.konami.reset();
            return;
        }
        if mods.control || mods.alt || mods.platform || mods.function {
            return;
        }
        if matches!(
            key_lower.as_str(),
            "shift" | "control" | "alt" | "super" | "meta" | "capslock"
        ) {
            return;
        }

        let is_question = event.keystroke.key == "?" || (key_lower == "/" && mods.shift);
        if is_question && !event.is_held {
            self.open_shortcuts_modal(window, cx);
            return;
        }
        if key_lower == "/" && !mods.shift && !event.is_held {
            let h = self.search_input.focus_handle(cx);
            window.focus(&h, cx);
            return;
        }
        if !event.is_held && !mods.shift && self.handle_workbench_key(&key_lower, window, cx) {
            return;
        }

        match self.active_surface {
            WorkspaceSurface::Today => match key_lower.as_str() {
                "j" | "down" => self.brief_view.update(cx, |b, cx| b.select_relative(1, cx)),
                "k" | "up" => self
                    .brief_view
                    .update(cx, |b, cx| b.select_relative(-1, cx)),
                "enter" if !event.is_held => {
                    self.brief_view.update(cx, |b, cx| b.open_selected(cx));
                }
                _ => {}
            },
            WorkspaceSurface::Review => match key_lower.as_str() {
                "j" | "down" => self
                    .review_view
                    .update(cx, |r, cx| r.select_relative(1, cx)),
                "k" | "up" => self
                    .review_view
                    .update(cx, |r, cx| r.select_relative(-1, cx)),
                "enter" if !event.is_held => {
                    self.review_view.update(cx, |r, cx| r.open_selected(cx));
                }
                "space" if !event.is_held => {
                    self.review_view
                        .update(cx, |r, cx| r.toggle_checked_selected(cx));
                }
                _ => {}
            },
            WorkspaceSurface::Memories if self.view_mode == ViewMode::List => {
                match key_lower.as_str() {
                    "j" | "down" => {
                        self.list_view.update(cx, |l, cx| l.select_relative(1, cx));
                    }
                    "k" | "up" => {
                        self.list_view.update(cx, |l, cx| l.select_relative(-1, cx));
                    }
                    "home" => {
                        self.list_view.update(cx, |l, cx| l.select_edge(true, cx));
                    }
                    "end" => {
                        self.list_view.update(cx, |l, cx| l.select_edge(false, cx));
                    }
                    "enter" if !event.is_held => {
                        self.list_view.update(cx, |l, cx| l.open_selected(cx));
                    }
                    _ => {}
                }
            }
            WorkspaceSurface::Memories if self.view_mode == ViewMode::Graph => {
                match key_lower.as_str() {
                    "j" | "down" | "right" => {
                        self.graph_view.update(cx, |g, cx| g.step_keyboard(1, cx));
                    }
                    "k" | "up" | "left" => {
                        self.graph_view.update(cx, |g, cx| g.step_keyboard(-1, cx));
                    }
                    "home" => {
                        self.graph_view
                            .update(cx, |g, cx| g.step_keyboard(isize::MIN, cx));
                    }
                    "end" => {
                        self.graph_view
                            .update(cx, |g, cx| g.step_keyboard(isize::MAX, cx));
                    }
                    "enter" if !event.is_held => {
                        if let Some(id) = self.graph_view.read(cx).keyboard_selected_id() {
                            self.select_memory(id, false, cx);
                        }
                    }
                    _ => {}
                }
            }
            WorkspaceSurface::Memories => {}
        }

        if self.no_fun || event.is_held {
            return;
        }

        let k = KonamiKey::from_key_name(&key_lower);
        if self.konami.push(k, Instant::now()) {
            let currently_on = self.graph_view.read(cx).is_constellation();
            if !currently_on {
                if self.view_mode != ViewMode::Graph {
                    self.switch_view(ViewMode::Graph, cx);
                }
                self.graph_view.update(cx, |g, cx| {
                    g.set_active_visible(true, cx);
                    g.set_constellation(true, cx);
                });
            } else {
                self.graph_view
                    .update(cx, |g, cx| g.set_constellation(false, cx));
            }
        }
    }

    pub(super) fn on_open_palette(
        &mut self,
        _: &OpenPalette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.palette.read(cx).is_open() {
            self.palette.update(cx, |p, cx| p.close(cx));
        } else {
            self.open_palette(window, cx);
        }
    }

    pub(super) fn on_focus_search(
        &mut self,
        _: &FocusSearch,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let h = self.search_input.focus_handle(cx);
        window.focus(&h, cx);
    }

    pub(super) fn on_switch_list(
        &mut self,
        _: &SwitchToList,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.switch_view(ViewMode::List, cx);
    }

    pub(super) fn on_switch_graph(
        &mut self,
        _: &SwitchToGraph,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.switch_view(ViewMode::Graph, cx);
    }

    pub(super) fn on_toggle_theme(
        &mut self,
        _: &ToggleTheme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle_theme(window, cx);
    }
}
