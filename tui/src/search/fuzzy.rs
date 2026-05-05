/// Subsequence match. Returns Some(score) where higher = better.
/// Score boosts: prefix match, contiguous runs, case-insensitive.
/// A length penalty is applied so shorter haystacks score higher when other
/// signals tie — `ses_zzz` (closer to exact) beats `sessions` for needle `ses`.
pub fn fuzzy_match(needle: &str, hay: &str) -> Option<i64> {
    if needle.is_empty() {
        return Some(0);
    }
    let n = needle.to_ascii_lowercase();
    let h = hay.to_ascii_lowercase();
    let nb = n.as_bytes();
    let hb = h.as_bytes();
    let (mut ni, mut score, mut run, mut last_match): (usize, i64, i64, Option<usize>) =
        (0, 0, 0, None);
    for (i, &c) in hb.iter().enumerate() {
        if ni < nb.len() && c == nb[ni] {
            if last_match.is_some_and(|li| li + 1 == i) {
                run += 2;
            } else {
                run = 1;
            }
            if i == 0 {
                score += 4;
            }
            score += run;
            last_match = Some(i);
            ni += 1;
        }
    }
    if ni == nb.len() {
        Some(score - (hay.len() as i64))
    } else {
        None
    }
}

pub fn fuzzy_filter<'a>(needle: &str, items: &'a [&'a str]) -> Vec<&'a str> {
    let mut scored: Vec<(i64, &str)> = items
        .iter()
        .filter_map(|s| fuzzy_match(needle, s).map(|sc| (sc, *s)))
        .collect();
    scored.sort_by_key(|s| std::cmp::Reverse(s.0));
    scored.into_iter().map(|(_, s)| s).collect()
}
