//! Quick-capture parsing.
//!
//! Quick capture is a single text field. Directives at the start or end of the
//! note become structured fields so the common case needs no form:
//!
//! - `#tag` adds a tag
//! - `ns:name` (or `namespace:name`) sets the namespace
//! - `type:decision` sets the memory type
//!
//! Hashtags in the middle of a sentence stay in the text and are also added as
//! tags, so "Ship #auth changes Friday" keeps reading naturally.

/// Structured result of parsing quick-capture text.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CaptureDraft {
    pub content: String,
    pub tags: Vec<String>,
    pub namespace: Option<String>,
    pub node_type: Option<String>,
}

impl CaptureDraft {
    /// Human validation message, or `None` when the draft can be saved.
    pub fn validation_error(&self) -> Option<&'static str> {
        if self.content.trim().is_empty() {
            Some("Write something to capture.")
        } else {
            None
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Directive {
    Tag(String),
    Namespace(String),
    Type(String),
}

fn clean_tag(raw: &str) -> Option<String> {
    let t = raw.trim_end_matches(['.', ',', ';', ':', '!', '?', ')']);
    let valid = !t.is_empty()
        && t.chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '/' | '.'));
    valid.then(|| t.to_string())
}

fn parse_directive(token: &str) -> Option<Directive> {
    if let Some(rest) = token.strip_prefix('#') {
        return clean_tag(rest).map(Directive::Tag);
    }
    let (key, val) = token.split_once(':')?;
    let val = val.trim();
    if val.is_empty() || val.contains(':') {
        return None;
    }
    match key.to_ascii_lowercase().as_str() {
        "ns" | "namespace" => Some(Directive::Namespace(val.to_string())),
        "type"
            if val
                .chars()
                .all(|c| c.is_ascii_alphabetic() || c == '_' || c == '-') =>
        {
            Some(Directive::Type(val.to_ascii_lowercase()))
        }
        _ => None,
    }
}

fn push_tag(tags: &mut Vec<String>, tag: String) {
    if !tags.iter().any(|t| t.eq_ignore_ascii_case(&tag)) {
        tags.push(tag);
    }
}

/// Parse quick-capture text into a draft. Line breaks inside the note are kept.
pub fn parse_capture(raw: &str) -> CaptureDraft {
    let mut draft = CaptureDraft::default();

    // Tokenize while remembering byte spans so the body keeps its own spacing.
    let tokens: Vec<(usize, usize)> = {
        let mut out = Vec::new();
        let mut start: Option<usize> = None;
        for (ix, ch) in raw.char_indices() {
            if ch.is_whitespace() {
                if let Some(s) = start.take() {
                    out.push((s, ix));
                }
            } else if start.is_none() {
                start = Some(ix);
            }
        }
        if let Some(s) = start {
            out.push((s, raw.len()));
        }
        out
    };

    let is_directive = |&(s, e): &(usize, usize)| parse_directive(&raw[s..e]).is_some();
    let lead = tokens.iter().take_while(|t| is_directive(t)).count();
    let trail = tokens[lead..]
        .iter()
        .rev()
        .take_while(|t| is_directive(t))
        .count();

    let apply = |d: Directive, draft: &mut CaptureDraft| match d {
        Directive::Tag(t) => push_tag(&mut draft.tags, t),
        Directive::Namespace(n) => draft.namespace = Some(n),
        Directive::Type(t) => draft.node_type = Some(t),
    };

    let body_tokens = &tokens[lead..tokens.len() - trail];
    // Apply in reading order: leading directives, inline tags, trailing directives.
    for &(s, e) in &tokens[..lead] {
        if let Some(d) = parse_directive(&raw[s..e]) {
            apply(d, &mut draft);
        }
    }
    for &(s, e) in body_tokens {
        if let Some(Directive::Tag(t)) = parse_directive(&raw[s..e]) {
            push_tag(&mut draft.tags, t);
        }
    }
    for &(s, e) in &tokens[tokens.len() - trail..] {
        if let Some(d) = parse_directive(&raw[s..e]) {
            apply(d, &mut draft);
        }
    }
    if let (Some(first), Some(last)) = (body_tokens.first(), body_tokens.last()) {
        draft.content = raw[first.0..last.1].to_string();
    }
    draft
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trailing_and_leading_directives_become_fields() {
        let d = parse_capture("type:decision Use PKCE for all OAuth flows #auth #security ns:work");
        assert_eq!(d.content, "Use PKCE for all OAuth flows");
        assert_eq!(d.tags, vec!["auth", "security"]);
        assert_eq!(d.namespace.as_deref(), Some("work"));
        assert_eq!(d.node_type.as_deref(), Some("decision"));
        assert_eq!(d.validation_error(), None);
    }

    #[test]
    fn inline_hashtags_stay_in_text_and_are_tagged() {
        let d = parse_capture("Ship the #auth changes on Friday.");
        assert_eq!(d.content, "Ship the #auth changes on Friday.");
        assert_eq!(d.tags, vec!["auth"]);
        assert_eq!(d.namespace, None);
    }

    #[test]
    fn line_breaks_and_urls_are_preserved() {
        let d = parse_capture("Release steps:\n1. tag\n2. see https://example.com/x #release");
        assert_eq!(
            d.content,
            "Release steps:\n1. tag\n2. see https://example.com/x"
        );
        assert_eq!(d.tags, vec!["release"]);
    }

    #[test]
    fn duplicate_tags_dedupe_case_insensitively_and_punctuation_is_trimmed() {
        let d = parse_capture("Note about #Auth, then #auth.");
        assert_eq!(d.tags, vec!["Auth"]);
    }

    #[test]
    fn empty_or_directive_only_input_fails_validation() {
        assert_eq!(
            parse_capture("   ").validation_error(),
            Some("Write something to capture.")
        );
        let d = parse_capture("#auth ns:work");
        assert_eq!(d.content, "");
        assert_eq!(d.tags, vec!["auth"]);
        assert!(d.validation_error().is_some());
    }

    #[test]
    fn non_directive_colons_are_left_alone() {
        let d = parse_capture("Meeting at 10:30 about foo:bar");
        assert_eq!(d.content, "Meeting at 10:30 about foo:bar");
        assert!(d.tags.is_empty());
        assert_eq!(d.node_type, None);
    }
}
