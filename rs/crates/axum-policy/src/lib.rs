use async_trait::async_trait;
use axum_types::{Action, Authorization, AuthorizationStatus};

#[async_trait]
pub trait Policy: Send + Sync {
    async fn authorize(&self, action: &Action) -> Authorization;
}

#[derive(Debug, Clone, Default)]
pub struct AllowAllPolicy;

#[async_trait]
impl Policy for AllowAllPolicy {
    async fn authorize(&self, _action: &Action) -> Authorization {
        Authorization {
            status: AuthorizationStatus::Allowed,
            message: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ConfirmOnToolPolicy {
    pub confirm_tools: Vec<String>,
}

#[async_trait]
impl Policy for ConfirmOnToolPolicy {
    async fn authorize(&self, action: &Action) -> Authorization {
        let tool = match action {
            Action::Tool(t) => Some(&t.tool),
            _ => None,
        };

        if tool.is_some_and(|t| self.confirm_tools.iter().any(|x| x == t)) {
            Authorization {
                status: AuthorizationStatus::Rejected,
                message: Some("approval_required".to_string()),
            }
        } else {
            Authorization {
                status: AuthorizationStatus::Allowed,
                message: None,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum_types::ToolAction;

    #[tokio::test]
    async fn allow_all_policy_allows_tool_actions() {
        let policy = AllowAllPolicy;
        let auth = policy
            .authorize(&Action::Tool(ToolAction {
                tool: "echo".to_string(),
                name: "echo".to_string(),
                input: None,
            }))
            .await;

        assert!(matches!(auth.status, AuthorizationStatus::Allowed));
        assert!(auth.message.is_none());
    }

    #[tokio::test]
    async fn confirm_on_tool_policy_rejects_configured_tool() {
        let policy = ConfirmOnToolPolicy {
            confirm_tools: vec!["fs".to_string()],
        };
        let auth = policy
            .authorize(&Action::Tool(ToolAction {
                tool: "fs".to_string(),
                name: "read_file".to_string(),
                input: None,
            }))
            .await;

        assert!(matches!(auth.status, AuthorizationStatus::Rejected));
        assert_eq!(auth.message.as_deref(), Some("approval_required"));
    }

    #[tokio::test]
    async fn confirm_on_tool_policy_allows_unconfigured_tool() {
        let policy = ConfirmOnToolPolicy {
            confirm_tools: vec!["fs".to_string()],
        };
        let auth = policy
            .authorize(&Action::Tool(ToolAction {
                tool: "echo".to_string(),
                name: "echo".to_string(),
                input: None,
            }))
            .await;

        assert!(matches!(auth.status, AuthorizationStatus::Allowed));
    }
}
