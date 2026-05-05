use crate::app::lens::Lens;

#[derive(Debug)]
pub struct HistoryStack {
    stack: Vec<Lens>,
    cursor: usize,
}

impl HistoryStack {
    pub fn new(initial: Lens) -> Self {
        Self {
            stack: vec![initial],
            cursor: 0,
        }
    }
    pub fn current(&self) -> Lens {
        self.stack[self.cursor]
    }
    pub fn push(&mut self, l: Lens) {
        self.stack.truncate(self.cursor + 1);
        self.stack.push(l);
        self.cursor = self.stack.len() - 1;
    }
    pub fn back(&mut self) -> Option<Lens> {
        if self.cursor == 0 {
            return None;
        }
        self.cursor -= 1;
        Some(self.stack[self.cursor])
    }
    pub fn forward(&mut self) -> Option<Lens> {
        if self.cursor + 1 >= self.stack.len() {
            return None;
        }
        self.cursor += 1;
        Some(self.stack[self.cursor])
    }
}
