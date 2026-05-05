use crate::app::lens::Lens;

#[derive(Debug, Default)]
pub struct PinnedTabs {
    slots: [Option<Lens>; 9],
}

impl PinnedTabs {
    pub fn pin(&mut self, l: Lens) -> Option<u8> {
        for (i, slot) in self.slots.iter_mut().enumerate() {
            if slot.is_none() {
                *slot = Some(l);
                return Some(i as u8 + 1);
            }
        }
        None
    }
    pub fn jump(&self, n: u8) -> Option<Lens> {
        if !(1..=9).contains(&n) {
            return None;
        }
        self.slots[(n - 1) as usize]
    }
}
