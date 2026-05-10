use recondo_tui::app::history::HistoryStack;
use recondo_tui::app::lens::Lens;

#[test]
fn back_forward_navigates() {
    let mut h = HistoryStack::new(Lens::Realtime);
    h.push(Lens::Sessions);
    h.push(Lens::Cost);
    assert_eq!(h.current(), Lens::Cost);
    assert_eq!(h.back(), Some(Lens::Sessions));
    assert_eq!(h.back(), Some(Lens::Realtime));
    assert_eq!(h.back(), None);
    assert_eq!(h.forward(), Some(Lens::Sessions));
    assert_eq!(h.forward(), Some(Lens::Cost));
    assert_eq!(h.forward(), None);
}

#[test]
fn push_truncates_forward() {
    let mut h = HistoryStack::new(Lens::Realtime);
    h.push(Lens::Sessions);
    h.push(Lens::Cost);
    h.back();
    h.push(Lens::Agents);
    assert_eq!(h.current(), Lens::Agents);
    assert_eq!(h.forward(), None);
}
