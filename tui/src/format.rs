use chrono::{DateTime, Utc};

pub fn format_cost(v: f64) -> String {
    format!("${:.2}", v)
}

pub fn format_compact_count(v: f64) -> String {
    let abs = v.abs();
    if abs >= 1.0e9 {
        format!("{:.1}B", v / 1.0e9)
    } else if abs >= 1.0e6 {
        format!("{:.1}M", v / 1.0e6)
    } else if abs >= 1.0e3 {
        format!("{:.1}K", v / 1.0e3)
    } else {
        format!("{}", v as i64)
    }
}

pub fn format_time_ago(t: DateTime<Utc>) -> String {
    let secs = (Utc::now() - t).num_seconds().max(0);
    if secs < 60 {
        format!("{}s", secs)
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else if secs < 86_400 {
        format!("{}h", secs / 3600)
    } else {
        format!("{}d", secs / 86_400)
    }
}
