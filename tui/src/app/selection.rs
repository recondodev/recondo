#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupKey {
    Provider(String),
    Model(String),
    Framework(String),
}

#[derive(Debug, Default)]
pub struct SelectionRegistry {
    session_id: Option<String>,
    turn_id: Option<String>,
    group: Option<GroupKey>,
}

impl SelectionRegistry {
    pub fn session(&self) -> Option<&str> {
        self.session_id.as_deref()
    }
    pub fn turn(&self) -> Option<&str> {
        self.turn_id.as_deref()
    }
    pub fn group(&self) -> Option<&GroupKey> {
        self.group.as_ref()
    }
    pub fn set_session(&mut self, v: Option<String>) {
        self.session_id = v;
    }
    pub fn set_turn(&mut self, v: Option<String>) {
        self.turn_id = v;
    }
    pub fn set_group(&mut self, v: Option<GroupKey>) {
        self.group = v;
    }
}
