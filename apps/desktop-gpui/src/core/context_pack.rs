//! Context packs: a local, read-only bundle of memories formatted for pasting
//! into an agent or chat.
//!
//! A pack never truncates a memory's text. To stay under a token budget it
//! leaves whole memories out (keeping the original order) and reports how many
//! were left out, so what is copied is always faithful to the store.

use serde_json::{Value, json};

use crate::core::model::{ContextPreviewItem, format_timestamp_ms, make_single_line_preview};

/// Where a pack's memories come from.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PackSource {
    /// The memory open in the inspector.
    Selected,
    /// The current list filter, in list order.
    #[default]
    CurrentView,
    /// Memories the user pinned explicitly.
    Pinned,
}

impl PackSource {
    pub const ALL: [PackSource; 3] = [Self::Selected, Self::CurrentView, Self::Pinned];

    pub fn label(self) -> &'static str {
        match self {
            Self::Selected => "Selected",
            Self::CurrentView => "Current view",
            Self::Pinned => "Pinned",
        }
    }
}

/// Output shape of the copied pack.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PackFormat {
    /// Citation header + full text, the same shape agents receive from MemOS.
    #[default]
    Plain,
    /// Headings per memory with a metadata line, for notes and docs.
    Markdown,
    /// One line per memory: citation plus a short preview. A digest, not the
    /// full text; labelled as such in the UI.
    Citations,
    /// A JSON object with one compact object per memory.
    Json,
}

impl PackFormat {
    pub const ALL: [PackFormat; 4] = [Self::Plain, Self::Markdown, Self::Citations, Self::Json];

    pub fn label(self) -> &'static str {
        match self {
            Self::Plain => "Plain",
            Self::Markdown => "Markdown",
            Self::Citations => "Citations",
            Self::Json => "JSON",
        }
    }
}

/// Token budget presets. Estimates use the same chars/4 rule as the rest of
/// the app, which is deliberately conservative for English prose.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PackBudget {
    Tokens1k,
    #[default]
    Tokens2k,
    Tokens4k,
    Tokens8k,
    Unlimited,
}

impl PackBudget {
    pub const ALL: [PackBudget; 5] = [
        Self::Tokens1k,
        Self::Tokens2k,
        Self::Tokens4k,
        Self::Tokens8k,
        Self::Unlimited,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::Tokens1k => "1k",
            Self::Tokens2k => "2k",
            Self::Tokens4k => "4k",
            Self::Tokens8k => "8k",
            Self::Unlimited => "No limit",
        }
    }

    pub fn max_tokens(self) -> Option<usize> {
        match self {
            Self::Tokens1k => Some(1_000),
            Self::Tokens2k => Some(2_000),
            Self::Tokens4k => Some(4_000),
            Self::Tokens8k => Some(8_000),
            Self::Unlimited => None,
        }
    }
}

/// Upper bound of memories fetched for a "current view" pack. The budget
/// usually binds first; this keeps the background query bounded.
pub const PACK_VIEW_FETCH_LIMIT: usize = 60;
/// Upper bound for a "No limit" view pack or export. Content loads on a
/// background thread; this keeps a single export bounded in memory.
pub const PACK_EXPORT_VIEW_LIMIT: usize = 1_000;

/// Upper bound of pinned memories, so a pack stays reviewable.
pub const PACK_PIN_LIMIT: usize = 100;

impl PackFormat {
    pub fn file_extension(self) -> &'static str {
        match self {
            PackFormat::Markdown => "md",
            PackFormat::Json => "json",
            PackFormat::Plain | PackFormat::Citations => "txt",
        }
    }
}

/// Suggested export file name, e.g. `memos-pinned-2026-11-25.md`.
pub fn export_file_name(source: PackSource, format: PackFormat, now_ms: i64) -> String {
    let slug = match source {
        PackSource::Selected => "memory",
        PackSource::CurrentView => "view",
        PackSource::Pinned => "pinned",
    };
    let date = format_date(now_ms).unwrap_or_else(|| "export".to_string());
    format!("memos-{slug}-{date}.{}", format.file_extension())
}

/// Estimated tokens for `chars` characters (chars / 4, rounded up).
pub fn estimate_tokens(chars: usize) -> usize {
    chars.div_ceil(4)
}

/// A built pack ready to copy.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ContextPack {
    pub payload: String,
    /// Ids included, in order.
    pub included_ids: Vec<String>,
    /// Memories fetched but left out to stay within budget.
    pub omitted_for_budget: usize,
    /// Total memories the source matched (may exceed what was fetched).
    pub total_matching: usize,
    pub char_count: usize,
    pub estimated_tokens: usize,
    /// The first memory alone is larger than the budget; it is included anyway
    /// so the pack is never silently empty.
    pub first_exceeds_budget: bool,
}

impl ContextPack {
    pub fn included_count(&self) -> usize {
        self.included_ids.len()
    }

    /// Memories matched by the source but not in the pack, for any reason
    /// (budget, or beyond the fetch limit).
    pub fn not_included(&self) -> usize {
        self.total_matching.saturating_sub(self.included_ids.len())
    }
}

fn body_text(item: &ContextPreviewItem) -> &str {
    let content = item.content.trim();
    if content.is_empty() {
        item.summary.trim()
    } else {
        content
    }
}

fn format_date(ts: i64) -> Option<String> {
    if ts <= 0 {
        return None;
    }
    // `format_timestamp_ms` yields `YYYY-MM-DD HH:MM:SS UTC`; a date is enough here.
    format_timestamp_ms(ts).get(..10).map(str::to_string)
}

fn header(format: PackFormat, title: &str, count: usize) -> String {
    let noun = if count == 1 { "memory" } else { "memories" };
    match format {
        PackFormat::Plain => format!("# MemOS memory context ({count} {noun})"),
        PackFormat::Markdown => format!("# {title}\n\n_{count} {noun} from MemOS_"),
        PackFormat::Citations => format!("MemOS citations ({count} {noun})"),
        PackFormat::Json => String::new(),
    }
}

fn segment(format: PackFormat, item: &ContextPreviewItem) -> String {
    let body = body_text(item);
    let summary = item.summary.trim();
    match format {
        PackFormat::Plain => {
            let mut s = format!(
                "[mem:{}] {} · {}\n{}",
                item.short_id, item.node_type, item.namespace, body
            );
            if !summary.is_empty() && !item.content.trim().is_empty() && summary != body {
                s.push_str("\nSummary: ");
                s.push_str(summary);
            }
            s
        }
        PackFormat::Markdown => {
            let heading = if summary.is_empty() {
                make_single_line_preview(body, 80)
            } else {
                make_single_line_preview(summary, 80)
            };
            let mut meta = vec![item.node_type.clone(), item.namespace.clone()];
            if !item.tags.is_empty() {
                meta.push(
                    item.tags
                        .iter()
                        .map(|t| format!("#{t}"))
                        .collect::<Vec<_>>()
                        .join(" "),
                );
            }
            if let Some(date) = format_date(item.updated_at) {
                meta.push(format!("updated {date}"));
            }
            if !item.provenance.trim().is_empty() {
                meta.push(item.provenance.trim().to_string());
            }
            // The full id rides along as an HTML comment: invisible when the
            // Markdown renders, stable for tools that re-import it.
            format!(
                "## [mem:{}] {heading}\n<!-- memos-id: {} -->\n\n_{}_\n\n{body}",
                item.short_id,
                item.id,
                meta.join(" · ")
            )
        }
        PackFormat::Citations => {
            format!(
                "[mem:{}] {}",
                item.short_id,
                make_single_line_preview(if summary.is_empty() { body } else { summary }, 140)
            )
        }
        PackFormat::Json => {
            let mut obj = json!({
                "citation": format!("[mem:{}]", item.short_id),
                "id": item.id,
                "type": item.node_type,
                "namespace": item.namespace,
                "tags": item.tags,
                "content": body,
            });
            if !summary.is_empty() && summary != body {
                obj["summary"] = Value::String(summary.to_string());
            }
            if let Some(date) = format_date(item.updated_at) {
                obj["updated"] = Value::String(date);
            }
            if let Some(date) = format_date(item.created_at) {
                obj["created"] = Value::String(date);
            }
            if !item.provenance.trim().is_empty() {
                obj["provenance"] = Value::String(item.provenance.trim().to_string());
            }
            obj.to_string()
        }
    }
}

fn assemble(format: PackFormat, title: &str, segments: &[&str]) -> String {
    match format {
        PackFormat::Json => {
            let source = Value::String(title.to_string()).to_string();
            let mut out = format!(
                "{{\"source\":{source},\"count\":{},\"memories\":[",
                segments.len()
            );
            for (ix, seg) in segments.iter().enumerate() {
                out.push_str(if ix == 0 { "\n" } else { ",\n" });
                out.push_str(seg);
            }
            out.push_str("\n]}");
            out
        }
        PackFormat::Citations => {
            let mut out = header(format, title, segments.len());
            for seg in segments {
                out.push('\n');
                out.push_str(seg);
            }
            out
        }
        PackFormat::Plain | PackFormat::Markdown => {
            let mut out = header(format, title, segments.len());
            for seg in segments {
                out.push_str("\n\n");
                out.push_str(seg);
            }
            out
        }
    }
}

/// Exact character length of [`assemble`] for `count` segments whose own
/// lengths sum to `segment_chars`, without building the string.
fn assembled_len(format: PackFormat, title: &str, count: usize, segment_chars: usize) -> usize {
    if count == 0 {
        return 0;
    }
    match format {
        PackFormat::Json => {
            let source = Value::String(title.to_string()).to_string();
            let prefix = format!("{{\"source\":{source},\"count\":{count},\"memories\":[");
            // "\n" before the first item, ",\n" before the rest, "\n]}" at the end.
            prefix.chars().count() + 1 + (count - 1) * 2 + segment_chars + 3
        }
        PackFormat::Citations => {
            header(format, title, count).chars().count() + count + segment_chars
        }
        PackFormat::Plain | PackFormat::Markdown => {
            header(format, title, count).chars().count() + count * 2 + segment_chars
        }
    }
}

/// Build a pack from `items` (already in the desired order).
///
/// Whole memories are left out, never cut, when the budget would be exceeded;
/// later, smaller memories may still fit, so the order of what is included is
/// preserved but not necessarily contiguous.
pub fn build_context_pack(
    items: &[ContextPreviewItem],
    total_matching: usize,
    title: &str,
    format: PackFormat,
    budget: PackBudget,
) -> ContextPack {
    let segments: Vec<String> = items.iter().map(|it| segment(format, it)).collect();
    let seg_chars: Vec<usize> = segments.iter().map(|s| s.chars().count()).collect();
    let max_chars = budget.max_tokens().map(|t| t.saturating_mul(4));

    let mut chosen: Vec<usize> = Vec::with_capacity(items.len());
    let mut first_exceeds_budget = false;
    match max_chars {
        None => chosen.extend(0..items.len()),
        Some(limit) => {
            let mut body_chars = 0usize;
            for (ix, &len) in seg_chars.iter().enumerate() {
                let candidate = assembled_len(format, title, chosen.len() + 1, body_chars + len);
                if candidate <= limit {
                    chosen.push(ix);
                    body_chars += len;
                }
            }
            if chosen.is_empty() && !segments.is_empty() {
                chosen.push(0);
                first_exceeds_budget = true;
            }
        }
    }

    let refs: Vec<&str> = chosen.iter().map(|&i| segments[i].as_str()).collect();
    let payload = if refs.is_empty() {
        String::new()
    } else {
        assemble(format, title, &refs)
    };
    let char_count = payload.chars().count();
    debug_assert_eq!(
        char_count,
        assembled_len(
            format,
            title,
            chosen.len(),
            chosen.iter().map(|&i| seg_chars[i]).sum()
        )
    );
    ContextPack {
        included_ids: chosen.iter().map(|&i| items[i].id.clone()).collect(),
        omitted_for_budget: items.len() - chosen.len(),
        total_matching: total_matching.max(items.len()),
        estimated_tokens: estimate_tokens(char_count),
        char_count,
        first_exceeds_budget,
        payload,
    }
}

/// Toggle `id` in an ordered pin list. Returns `true` when it is now pinned.
/// New pins go to the end; the list is capped at [`PACK_PIN_LIMIT`].
pub fn toggle_pin(pins: &mut Vec<String>, id: &str) -> bool {
    if let Some(pos) = pins.iter().position(|p| p == id) {
        pins.remove(pos);
        false
    } else if pins.len() >= PACK_PIN_LIMIT {
        false
    } else {
        pins.push(id.to_string());
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, content: &str) -> ContextPreviewItem {
        ContextPreviewItem {
            id: id.to_string(),
            short_id: id.chars().take(4).collect(),
            node_type: "fact".to_string(),
            namespace: "auth".to_string(),
            content: content.to_string(),
            summary: String::new(),
            tags: vec!["oauth".to_string()],
            updated_at: 1_793_577_600_000,
            created_at: 1_793_491_200_000,
            provenance: "verified".to_string(),
        }
    }

    #[test]
    fn unlimited_pack_includes_everything_in_order() {
        let items = vec![item("aaaa1", "first"), item("bbbb2", "second")];
        let pack = build_context_pack(
            &items,
            2,
            "Current view",
            PackFormat::Plain,
            PackBudget::Unlimited,
        );
        assert_eq!(pack.included_ids, vec!["aaaa1", "bbbb2"]);
        assert_eq!(pack.omitted_for_budget, 0);
        assert!(
            pack.payload
                .starts_with("# MemOS memory context (2 memories)")
        );
        assert!(pack.payload.contains("[mem:aaaa] fact · auth\nfirst"));
        assert_eq!(pack.char_count, pack.payload.chars().count());
        assert_eq!(pack.estimated_tokens, pack.char_count.div_ceil(4));
    }

    #[test]
    fn budget_leaves_whole_memories_out_and_never_truncates() {
        let big = "x".repeat(5_000);
        let items = vec![
            item("aaaa1", "short one"),
            item("bbbb2", &big),
            item("cccc3", "short two"),
        ];
        let pack = build_context_pack(&items, 10, "View", PackFormat::Plain, PackBudget::Tokens1k);
        assert_eq!(pack.included_ids, vec!["aaaa1", "cccc3"]);
        assert_eq!(pack.omitted_for_budget, 1);
        assert!(!pack.payload.contains("xxx"));
        assert!(pack.char_count <= 4_000);
        assert_eq!(pack.not_included(), 8);
    }

    #[test]
    fn oversized_first_memory_is_included_with_a_flag() {
        let items = vec![item("aaaa1", &"y".repeat(9_000))];
        let pack = build_context_pack(&items, 1, "View", PackFormat::Plain, PackBudget::Tokens1k);
        assert_eq!(pack.included_count(), 1);
        assert!(pack.first_exceeds_budget);
        assert!(pack.payload.contains(&"y".repeat(9_000)));
    }

    #[test]
    fn json_pack_is_valid_and_carries_metadata() {
        let mut a = item("aaaa1", "Use \"PKCE\" everywhere");
        a.summary = "PKCE decision".to_string();
        let items = vec![a, item("bbbb2", "second")];
        let pack = build_context_pack(
            &items,
            2,
            "Pinned \"set\"",
            PackFormat::Json,
            PackBudget::Unlimited,
        );
        let parsed: Value = serde_json::from_str(&pack.payload).expect("valid json");
        assert_eq!(parsed["count"], 2);
        assert_eq!(parsed["source"], "Pinned \"set\"");
        assert_eq!(parsed["memories"][0]["citation"], "[mem:aaaa]");
        assert_eq!(parsed["memories"][0]["content"], "Use \"PKCE\" everywhere");
        assert_eq!(parsed["memories"][0]["summary"], "PKCE decision");
        assert_eq!(parsed["memories"][0]["tags"][0], "oauth");
        assert_eq!(parsed["memories"][1]["updated"], "2026-11-02");
        assert_eq!(parsed["memories"][1]["created"], "2026-11-01");
        assert_eq!(parsed["memories"][1]["provenance"], "verified");
        assert_eq!(parsed["memories"][1]["id"], "bbbb2");
        assert!(
            build_context_pack(&items, 2, "x", PackFormat::Markdown, PackBudget::Unlimited)
                .payload
                .contains("<!-- memos-id: aaaa1 -->")
        );
    }

    #[test]
    fn markdown_and_citation_formats_render_expected_shape() {
        let items = vec![item("aaaa1", "Line one\nLine two")];
        let md = build_context_pack(
            &items,
            1,
            "Auth notes",
            PackFormat::Markdown,
            PackBudget::Unlimited,
        );
        assert!(
            md.payload
                .starts_with("# Auth notes\n\n_1 memory from MemOS_")
        );
        assert!(md.payload.contains("## [mem:aaaa] Line one Line two"));
        assert!(
            md.payload
                .contains("_fact · auth · #oauth · updated 2026-11-02 · verified_")
        );
        // Markdown keeps the original line breaks in the body.
        assert!(md.payload.ends_with("Line one\nLine two"));

        let cites =
            build_context_pack(&items, 1, "x", PackFormat::Citations, PackBudget::Unlimited);
        assert_eq!(
            cites.payload,
            "MemOS citations (1 memory)\n[mem:aaaa] Line one Line two"
        );
    }

    #[test]
    fn empty_source_yields_empty_payload() {
        let pack = build_context_pack(&[], 0, "x", PackFormat::Plain, PackBudget::Tokens2k);
        assert!(pack.payload.is_empty());
        assert_eq!(pack.included_count(), 0);
        assert!(!pack.first_exceeds_budget);
    }

    #[test]
    fn export_names_use_source_date_and_extension() {
        let now = 1_793_577_600_000;
        assert_eq!(
            export_file_name(PackSource::Pinned, PackFormat::Markdown, now),
            "memos-pinned-2026-11-02.md"
        );
        assert_eq!(
            export_file_name(PackSource::CurrentView, PackFormat::Json, now),
            "memos-view-2026-11-02.json"
        );
        assert_eq!(
            export_file_name(PackSource::Selected, PackFormat::Citations, now),
            "memos-memory-2026-11-02.txt"
        );
    }

    #[test]
    fn pin_toggle_keeps_order_and_caps() {
        let mut pins = Vec::new();
        assert!(toggle_pin(&mut pins, "a"));
        assert!(toggle_pin(&mut pins, "b"));
        assert!(!toggle_pin(&mut pins, "a"));
        assert_eq!(pins, vec!["b"]);
        for i in 0..PACK_PIN_LIMIT {
            toggle_pin(&mut pins, &format!("n{i}"));
        }
        assert_eq!(pins.len(), PACK_PIN_LIMIT);
        assert!(!toggle_pin(&mut pins, "overflow"));
    }
}
