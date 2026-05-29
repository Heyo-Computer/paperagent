use serde::{Deserialize, Serialize};

use super::link::TodoRef;

/// A page in a book. The markdown body lives in a sibling `.md` file
/// (`books/{bookId}/pages/{pageId}.md`), not in this struct — mirroring the
/// day.json + specs/{id}.md split.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookPage {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub order: i64,
    #[serde(default)]
    pub linked_todos: Vec<TodoRef>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

/// A book: a collection of markdown pages with an ordered table of contents.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Book {
    pub id: String,
    pub name: String,
    /// Table of contents, in display order.
    #[serde(default)]
    pub pages: Vec<BookPage>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

/// Lightweight entry stored in `books/index.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookSummary {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub updated_at: String,
}

impl From<&Book> for BookSummary {
    fn from(b: &Book) -> Self {
        Self {
            id: b.id.clone(),
            name: b.name.clone(),
            updated_at: b.updated_at.clone(),
        }
    }
}
