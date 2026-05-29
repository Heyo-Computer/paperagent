use serde::{Deserialize, Serialize};

use super::link::LinkRef;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoItem {
    pub id: String,
    pub title: String,
    pub completed: bool,
    #[serde(default)]
    pub has_spec: bool,
    /// Outgoing links from this todo to list items / book pages (T-009).
    #[serde(default)]
    pub links: Vec<LinkRef>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DayEntry {
    #[serde(default)]
    pub date: String,
    pub todos: Vec<TodoItem>,
}

impl DayEntry {
    pub fn new(date: String) -> Self {
        Self {
            date,
            todos: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Backlog {
    #[serde(default)]
    pub items: Vec<TodoItem>,
}
