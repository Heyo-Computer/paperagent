use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::link::TodoRef;

/// The kind of value a list field holds. Drives the editor widget on the UI side.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FieldKind {
    Text,
    Number,
    Date,
    Bool,
    Select,
}

impl Default for FieldKind {
    fn default() -> Self {
        FieldKind::Text
    }
}

/// A single column in a list's schema. `key` is the stable identity used in
/// `ListItem.values`; `label` is the human-facing column name.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListField {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub kind: FieldKind,
    /// Only meaningful for `FieldKind::Select`.
    #[serde(default)]
    pub options: Option<Vec<String>>,
}

/// A row in a list. `values` is keyed by `ListField.key`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListItem {
    pub id: String,
    #[serde(default)]
    pub values: Map<String, Value>,
    #[serde(default)]
    pub linked_todos: Vec<TodoRef>,
    /// Soft-hide flag. Archived items are kept but hidden from the default view.
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

/// A list: a collection of items with a list-specific schema (`fields`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct List {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub fields: Vec<ListField>,
    #[serde(default)]
    pub items: Vec<ListItem>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

/// Lightweight entry stored in `lists/index.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListSummary {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub updated_at: String,
}

impl From<&List> for ListSummary {
    fn from(l: &List) -> Self {
        Self {
            id: l.id.clone(),
            name: l.name.clone(),
            updated_at: l.updated_at.clone(),
        }
    }
}
