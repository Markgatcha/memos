// Cargo caches this script's output. Bump this file or pass SOURCE_DATE_EPOCH
// when cutting a release so the Settings footer shows the real build date.
fn main() {
    println!("cargo:rerun-if-changed=assets/memos-icon.rc");
    println!("cargo:rerun-if-changed=assets/memos-icon.ico");
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    println!("cargo:rustc-env=MEMOS_BUILD_DATE={}", compute_build_date());

    #[cfg(windows)]
    {
        embed_resource::compile("assets/memos-icon.rc", embed_resource::NONE)
            .manifest_optional()
            .expect("embed MemOS desktop icon resource");
    }
}

fn compute_build_date() -> String {
    let secs = std::env::var("SOURCE_DATE_EPOCH")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
        });
    let days = (secs / 86_400) as i64;
    // Howard Hinnant civil-from-days algorithm in UTC.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + i64::from(m <= 2);
    format!("{year:04}-{m:02}-{d:02}")
}
