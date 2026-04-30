use std::collections::HashMap;

use async_trait::async_trait;
use sagent_types::{AgentError, ToolAction};
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
        Self { tools: HashMap::new() }
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
            return Err(AgentError::Tool(format!("unknown_action: echo.{}", action.name)));
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
                let canon_full =
                    std::fs::canonicalize(&full).map_err(|e| AgentError::Tool(format!("path_invalid: {e}")))?;

                if !canon_full.starts_with(&canon_root) {
                    return Err(AgentError::Tool("path_out_of_sandbox".to_string()));
                }

                let content = tokio::fs::read_to_string(canon_full)
                    .await
                    .map_err(|e| AgentError::Tool(format!("read_failed: {e}")))?;
                Ok(content)
            }
            _ => Err(AgentError::Tool(format!("unknown_action: fs.{}", action.name))),
        }
    }
}
