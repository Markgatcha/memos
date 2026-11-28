//! Bitemporal "as of" time travel: see the store as it stood at a past moment.
//!
//! A memory counts as *present* at time `t` when, matching the SDK's
//! `validAt` semantics (`src/storage/sqlite.ts`):
//!
//! - it had been created (`created_at <= t`),
//! - its validity window covers `t` (`valid_from` null or `<= t`, `valid_to`
//!   null or `>= t`, inclusive on both ends like the SDK), and
//! - it had not expired (`expires_at` null, zero, or later than `t`).
//!
//! Forgotten memories are deleted rows, so they cannot be reconstructed; the
//! UI says so instead of pretending the past view is complete.
//!
//! Timestamps in the store are mixed-unit: `valid_*` are milliseconds,
//! `expires_at` is written in seconds by the SDK, and very old stores used
//! seconds for `created_at`. Every comparison goes through [`normalize_ms`]
//! (and the matching SQL expression in `db.rs`).

/// Values below this are treated as Unix seconds, the same cutoff `db.rs`
/// and `model::normalize_timestamp_ms` already use.
pub const SECONDS_CUTOFF: i64 = 10_000_000_000;

pub const DAY_MS: i64 = 86_400_000;

/// Same rule as `model::normalize_timestamp_ms`; re-exported under a short
/// name so the predicate below reads like the SQL it mirrors.
pub use crate::core::model::normalize_timestamp_ms as normalize_ms;

/// SQL expression normalising a possibly-seconds timestamp column to ms.
pub fn sql_ms(col: &str) -> String {
    format!("(CASE WHEN {col} > 0 AND {col} < {SECONDS_CUTOFF} THEN {col} * 1000 ELSE {col} END)")
}

/// Parse `YYYY-MM-DD` to the last millisecond of that UTC day, so "as of
/// March 1" still includes everything written on March 1.
pub fn parse_as_of_date(raw: &str) -> Option<i64> {
    let s = raw.trim();
    if s.len() != 10 {
        return None;
    }
    let b = s.as_bytes();
    if b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let year: i32 = s[0..4].parse().ok()?;
    let month = time::Month::try_from(s[5..7].parse::<u8>().ok()?).ok()?;
    let day: u8 = s[8..10].parse().ok()?;
    let date = time::Date::from_calendar_date(year, month, day).ok()?;
    let start = date
        .midnight()
        .assume_utc()
        .unix_timestamp()
        .saturating_mul(1000);
    Some(start + DAY_MS - 1)
}

/// `YYYY-MM-DD` (UTC) for a millisecond timestamp.
pub fn format_as_of_date(ms: i64) -> String {
    match time::OffsetDateTime::from_unix_timestamp(ms.div_euclid(1000)) {
        Ok(dt) => format!(
            "{:04}-{:02}-{:02}",
            dt.year(),
            u8::from(dt.month()),
            dt.day()
        ),
        Err(_) => "invalid date".to_string(),
    }
}

/// Human label such as `Mar 4, 2026` (UTC, same calendar as the token).
pub fn format_as_of_label(ms: i64) -> String {
    match time::OffsetDateTime::from_unix_timestamp(ms.div_euclid(1000)) {
        Ok(dt) => {
            let month = match dt.month() {
                time::Month::January => "Jan",
                time::Month::February => "Feb",
                time::Month::March => "Mar",
                time::Month::April => "Apr",
                time::Month::May => "May",
                time::Month::June => "Jun",
                time::Month::July => "Jul",
                time::Month::August => "Aug",
                time::Month::September => "Sep",
                time::Month::October => "Oct",
                time::Month::November => "Nov",
                time::Month::December => "Dec",
            };
            format!("{month} {}, {}", dt.day(), dt.year())
        }
        Err(_) => "an unknown date".to_string(),
    }
}

/// Pure predicate mirroring the SQL clause, for tests and in-memory checks.
pub fn present_at(
    as_of_ms: i64,
    created_at: i64,
    valid_from: Option<i64>,
    valid_to: Option<i64>,
    expires_at: Option<i64>,
) -> bool {
    normalize_ms(created_at) <= as_of_ms
        && valid_from.is_none_or(|v| normalize_ms(v) <= as_of_ms)
        && valid_to.is_none_or(|v| normalize_ms(v) >= as_of_ms)
        && expires_at.is_none_or(|e| e <= 0 || normalize_ms(e) > as_of_ms)
}

/// Bucket widths the timeline can use, smallest first.
const WIDTHS: [i64; 4] = [DAY_MS, 7 * DAY_MS, 30 * DAY_MS, 365 * DAY_MS];

/// Upper bound on bars, so a decade-old store still fits a 900 px window.
pub const MAX_BUCKETS: i64 = 120;

/// Pick the smallest bucket width that keeps the span within `MAX_BUCKETS`.
pub fn bucket_width_ms(span_ms: i64) -> i64 {
    let span = span_ms.max(1);
    let ceil_div = |a: i64, b: i64| (a + b - 1) / b;
    WIDTHS
        .into_iter()
        .find(|w| ceil_div(span, *w) <= MAX_BUCKETS)
        .unwrap_or_else(|| ceil_div(span, MAX_BUCKETS).max(DAY_MS))
}

/// One bar of the timeline histogram.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TimelineBucket {
    pub start_ms: i64,
    /// Memories first written in this bucket.
    pub created: u32,
    /// Memories whose validity ended here (superseded or closed).
    pub ended: u32,
    /// Memories whose TTL ran out here.
    pub expired: u32,
}

impl TimelineBucket {
    pub fn activity(&self) -> u32 {
        self.created + self.ended + self.expired
    }

    pub fn end_ms(&self, width_ms: i64) -> i64 {
        self.start_ms + width_ms - 1
    }
}

/// Activity over the store's whole life, aligned to `width_ms` buckets.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Timeline {
    pub origin_ms: i64,
    pub width_ms: i64,
    pub buckets: Vec<TimelineBucket>,
    /// Whether the store records validity windows at all (older stores do
    /// not, and then only creation and expiry are meaningful).
    pub has_validity: bool,
    pub has_expiry: bool,
}

impl Timeline {
    /// Build from raw `(bucket_index, count)` rows produced by SQL.
    pub fn from_counts(
        origin_ms: i64,
        width_ms: i64,
        last_ms: i64,
        created: &[(i64, u32)],
        ended: &[(i64, u32)],
        expired: &[(i64, u32)],
    ) -> Self {
        let width = width_ms.max(1);
        let len = ((last_ms - origin_ms).max(0) / width + 1).clamp(1, MAX_BUCKETS * 2) as usize;
        let mut buckets: Vec<TimelineBucket> = (0..len)
            .map(|i| TimelineBucket {
                start_ms: origin_ms + i as i64 * width,
                ..TimelineBucket::default()
            })
            .collect();
        let mut add = |rows: &[(i64, u32)], f: fn(&mut TimelineBucket) -> &mut u32| {
            for &(ix, n) in rows {
                if let Some(b) = usize::try_from(ix).ok().and_then(|i| buckets.get_mut(i)) {
                    *f(b) += n;
                }
            }
        };
        add(created, |b| &mut b.created);
        add(ended, |b| &mut b.ended);
        add(expired, |b| &mut b.expired);
        Self {
            origin_ms,
            width_ms: width,
            buckets,
            has_validity: false,
            has_expiry: false,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.buckets.iter().all(|b| b.activity() == 0)
    }

    pub fn max_activity(&self) -> u32 {
        self.buckets
            .iter()
            .map(TimelineBucket::activity)
            .max()
            .unwrap_or(0)
    }

    pub fn bucket_index(&self, ms: i64) -> Option<usize> {
        if ms < self.origin_ms {
            return None;
        }
        let ix = ((ms - self.origin_ms) / self.width_ms.max(1)) as usize;
        (ix < self.buckets.len()).then_some(ix)
    }

    /// End of the nearest earlier bucket with any activity, for "previous
    /// change" stepping. `None` when nothing happened before `as_of_ms`'s
    /// bucket.
    pub fn previous_change(&self, as_of_ms: i64) -> Option<i64> {
        let current = self.bucket_index(as_of_ms).unwrap_or(self.buckets.len());
        self.buckets[..current.min(self.buckets.len())]
            .iter()
            .rev()
            .find(|b| b.activity() > 0)
            .map(|b| b.end_ms(self.width_ms))
    }

    /// End of the next bucket with activity after `as_of_ms`'s bucket.
    /// `None` means the next step is "now".
    pub fn next_change(&self, as_of_ms: i64) -> Option<i64> {
        let start = match self.bucket_index(as_of_ms) {
            Some(ix) => ix + 1,
            None if as_of_ms < self.origin_ms => 0,
            None => return None,
        };
        self.buckets
            .get(start..)?
            .iter()
            .find(|b| b.activity() > 0)
            .map(|b| b.end_ms(self.width_ms))
    }
}

/// Counts describing the store at `as_of` relative to today.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AsOfSummary {
    /// Memories present at `as_of` (and still in the store today).
    pub present: usize,
    /// Of those, how many have since been superseded or closed.
    pub since_ended: usize,
    /// Of those, how many have since expired.
    pub since_expired: usize,
    /// Memories written after `as_of`.
    pub created_after: usize,
}

impl AsOfSummary {
    pub fn sentence(&self) -> String {
        let mut s = format!(
            "{} {} then",
            self.present,
            if self.present == 1 {
                "memory existed"
            } else {
                "memories existed"
            }
        );
        let mut since = Vec::new();
        if self.since_ended > 0 {
            since.push(format!("{} since superseded", self.since_ended));
        }
        if self.since_expired > 0 {
            since.push(format!("{} since expired", self.since_expired));
        }
        if self.created_after > 0 {
            since.push(format!("{} written later", self.created_after));
        }
        if !since.is_empty() {
            s.push_str(" · ");
            s.push_str(&since.join(" · "));
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: i64 = 1_767_225_600_000; // 2026-01-01T00:00:00Z

    #[test]
    fn as_of_dates_round_trip_and_cover_the_whole_day() {
        let end = parse_as_of_date("2026-01-01").unwrap();
        assert_eq!(end, T + DAY_MS - 1);
        assert_eq!(format_as_of_date(end), "2026-01-01");
        assert_eq!(format_as_of_label(end), "Jan 1, 2026");
        assert!(parse_as_of_date("2026-02-30").is_none());
        assert!(parse_as_of_date("26-01-01").is_none());
    }

    #[test]
    fn presence_matches_sdk_valid_at_semantics() {
        // Created before, open window: present.
        assert!(present_at(T, T - 10, None, None, None));
        // Created after: not yet.
        assert!(!present_at(T, T + 1, None, None, None));
        // Window is inclusive on both ends, like the SDK's validAt.
        assert!(present_at(T, T - 10, Some(T), Some(T), None));
        assert!(!present_at(T, T - 10, Some(T + 1), None, None));
        assert!(!present_at(T, T - 10, None, Some(T - 1), None));
        // expires_at in seconds is normalised; expiry exactly at T is gone.
        assert!(present_at(T, T - 10, None, None, Some(T / 1000 + 1)));
        assert!(!present_at(T, T - 10, None, None, Some(T / 1000)));
        // Zero expiry means "never" in older stores.
        assert!(present_at(T, T - 10, None, None, Some(0)));
        // Seconds-era created_at.
        assert!(present_at(T, T / 1000 - 5, None, None, None));
    }

    #[test]
    fn bucket_width_scales_with_span() {
        assert_eq!(bucket_width_ms(30 * DAY_MS), DAY_MS);
        assert_eq!(bucket_width_ms(200 * DAY_MS), 7 * DAY_MS);
        assert_eq!(bucket_width_ms(3 * 365 * DAY_MS), 30 * DAY_MS);
        assert_eq!(bucket_width_ms(40 * 365 * DAY_MS), 365 * DAY_MS);
        assert!(200 * 365 * DAY_MS / bucket_width_ms(200 * 365 * DAY_MS) <= MAX_BUCKETS);
    }

    #[test]
    fn stepping_skips_quiet_buckets() {
        let tl = Timeline::from_counts(
            T,
            DAY_MS,
            T + 9 * DAY_MS,
            &[(0, 3), (4, 1)],
            &[(7, 2)],
            &[(9, 1)],
        );
        assert_eq!(tl.buckets.len(), 10);
        assert_eq!(tl.max_activity(), 3);
        let mid = T + 5 * DAY_MS + 10;
        assert_eq!(tl.previous_change(mid), Some(T + 5 * DAY_MS - 1));
        assert_eq!(tl.next_change(mid), Some(T + 8 * DAY_MS - 1));
        assert_eq!(
            tl.next_change(T + 9 * DAY_MS),
            None,
            "last bucket steps to now"
        );
        assert_eq!(
            tl.previous_change(T),
            None,
            "nothing before the first bucket"
        );
        assert_eq!(tl.next_change(T - DAY_MS), Some(T + DAY_MS - 1));
    }

    #[test]
    fn out_of_range_counts_are_ignored() {
        let tl = Timeline::from_counts(T, DAY_MS, T, &[(0, 1), (5, 9), (-1, 9)], &[], &[]);
        assert_eq!(tl.buckets.len(), 1);
        assert_eq!(tl.max_activity(), 1);
    }

    #[test]
    fn summary_sentence_reads_naturally() {
        let s = AsOfSummary {
            present: 12,
            since_ended: 2,
            since_expired: 0,
            created_after: 40,
        };
        assert_eq!(
            s.sentence(),
            "12 memories existed then · 2 since superseded · 40 written later"
        );
        assert_eq!(
            AsOfSummary {
                present: 1,
                ..Default::default()
            }
            .sentence(),
            "1 memory existed then"
        );
    }
}
