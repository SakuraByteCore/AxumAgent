use std::collections::HashMap;

use async_trait::async_trait;
use axum_types::{AgentError, ToolAction};
use serde_json::Value;

#[async_trait]
pub trait Tool: Send + Sync {
    fn id(&self) -> &'static str;
    async fn execute(&self, action: &ToolAction) -> Result<String, AgentError>;
}

pub struct ToolRegistry {
    tools: HashMap<String, Box<dyn Tool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    pub fn register<T: Tool + 'static>(&mut self, tool: T) {
        self.tools.insert(tool.id().to_string(), Box::new(tool));
    }

    pub async fn execute(&self, action: &ToolAction) -> Result<String, AgentError> {
        let tool = self
            .tools
            .get(&action.tool)
            .ok_or_else(|| AgentError::Tool(format!("unknown_tool: {}", action.tool)))?;
        tool.execute(action).await
    }
}

#[derive(Debug, Clone, Default)]
pub struct EchoTool;

#[async_trait]
impl Tool for EchoTool {
    fn id(&self) -> &'static str {
        "echo"
    }

    async fn execute(&self, action: &ToolAction) -> Result<String, AgentError> {
        if action.name != "echo" {
            return Err(AgentError::Tool(format!(
                "unknown_action: echo.{}",
                action.name
            )));
        }
        let input = action.input.clone().unwrap_or(Value::Null);
        Ok(input.to_string())
    }
}

#[derive(Debug, Clone)]
pub struct FsTool {
    pub sandbox_root: String,
}

#[async_trait]
impl Tool for FsTool {
    fn id(&self) -> &'static str {
        "fs"
    }

    async fn execute(&self, action: &ToolAction) -> Result<String, AgentError> {
        match action.name.as_str() {
            "read_file" => {
                let path = action
                    .input
                    .as_ref()
                    .and_then(|v| v.get("path"))
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| AgentError::Tool("missing_input.path".to_string()))?;

                let full = std::path::Path::new(&self.sandbox_root).join(path);
                let canon_root = std::fs::canonicalize(&self.sandbox_root)
                    .map_err(|e| AgentError::Tool(format!("sandbox_root_invalid: {e}")))?;
                let canon_full = std::fs::canonicalize(&full)
                    .map_err(|e| AgentError::Tool(format!("path_invalid: {e}")))?;

                if !canon_full.starts_with(&canon_root) {
                    return Err(AgentError::Tool("path_out_of_sandbox".to_string()));
                }

                let content = tokio::fs::read_to_string(canon_full)
                    .await
                    .map_err(|e| AgentError::Tool(format!("read_failed: {e}")))?;
                Ok(content)
            }
            _ => Err(AgentError::Tool(format!(
                "unknown_action: fs.{}",
                action.name
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn echo_tool_returns_json_input() {
        let tool = EchoTool;
        let result = tool
            .execute(&ToolAction {
                tool: "echo".to_string(),
                name: "echo".to_string(),
                input: Some(json!({ "task": "hello" })),
            })
            .await
            .unwrap();

        assert_eq!(result, r#"{"task":"hello"}"#);
    }

    #[tokio::test]
    async fn registry_reports_unknown_tool() {
        let registry = ToolRegistry::new();
        let err = registry
            .execute(&ToolAction {
                tool: "missing".to_string(),
                name: "noop".to_string(),
                input: None,
            })
            .await
            .unwrap_err();

        assert!(err.to_string().contains("unknown_tool: missing"));
    }

    #[tokio::test]
    async fn fs_tool_reads_inside_sandbox() {
        let root = std::env::temp_dir().join(format!("axum-tools-test-{}", std::process::id()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let file = root.join("hello.txt");
        tokio::fs::write(&file, "world").await.unwrap();

        let tool = FsTool {
            sandbox_root: root.to_string_lossy().to_string(),
        };
        let result = tool
            .execute(&ToolAction {
                tool: "fs".to_string(),
                name: "read_file".to_string(),
                input: Some(json!({ "path": "hello.txt" })),
            })
            .await
            .unwrap();

        assert_eq!(result, "world");
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn fs_tool_rejects_path_outside_sandbox() {
        let root =
            std::env::temp_dir().join(format!("axum-tools-test-{}-sandbox", std::process::id()));
        let outside = std::env::temp_dir().join(format!(
            "axum-tools-test-{}-outside.txt",
            std::process::id()
        ));
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::write(&outside, "secret").await.unwrap();

        let tool = FsTool {
            sandbox_root: root.to_string_lossy().to_string(),
        };
        let err = tool
            .execute(&ToolAction {
                tool: "fs".to_string(),
                name: "read_file".to_string(),
                input: Some(json!({ "path": "../".to_string() + outside.file_name().unwrap().to_str().unwrap() })),
            })
            .await
            .unwrap_err();

        assert!(
            err.to_string().contains("path_out_of_sandbox")
                || err.to_string().contains("path_invalid")
        );
        let _ = tokio::fs::remove_dir_all(root).await;
        let _ = tokio::fs::remove_file(outside).await;
    }
}
