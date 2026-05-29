use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artifact {
    /// Basename (final segment).
    pub name: String,
    /// Absolute filesystem path (for `openPath` etc).
    pub path: String,
    /// Path relative to the artifacts root, using `/` separators.
    /// Empty string for the root itself.
    #[serde(default)]
    pub relative_path: String,
    pub size: u64,
    pub created_at: String,
    #[serde(default)]
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactIndex {
    pub artifacts: Vec<Artifact>,
}

impl ArtifactIndex {
    pub fn new() -> Self {
        Self {
            artifacts: Vec::new(),
        }
    }
}
