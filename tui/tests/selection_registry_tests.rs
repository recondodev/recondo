use recondo_tui::app::selection::{GroupKey, SelectionRegistry};

#[test]
fn session_selection_persists_across_lenses() {
    let mut s = SelectionRegistry::default();
    s.set_session(Some("ses_abc".into()));
    assert_eq!(s.session(), Some("ses_abc"));
    s.set_group(Some(GroupKey::Provider("anthropic".into())));
    assert_eq!(s.group(), Some(&GroupKey::Provider("anthropic".into())));
    // Explicit clear.
    s.set_session(None);
    assert_eq!(s.session(), None);
    // Group still set.
    assert!(s.group().is_some());
}
