use serde::{Deserialize, Serialize};

/// A reference from a list item / book page back to a todo.
/// `date` is empty for backlog (undated) todos.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoRef {
    #[serde(default)]
    pub date: String,
    pub todo_id: String,
    #[serde(default)]
    pub label: String,
}

/// A reference from a todo to a list item or a book page.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkRef {
    /// "list" | "book"
    pub kind: String,
    /// list id or book id
    pub target_id: String,
    /// item id or page id
    pub sub_id: String,
    #[serde(default)]
    pub label: String,
}
