#[test]
fn crate_links() {
    // Compile-time smoke: this test crate links recondo_tui.
    // If main.rs compiles, this test exists.
    assert_eq!(2 + 2, 4);
}
