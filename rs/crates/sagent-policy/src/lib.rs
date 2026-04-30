use async_trait::async_trait;
use sagent_types::{Action, Authorization, AuthorizationStatus};

#[async_trait]
pub trait Policy: Send + Sync {
    async fn authorize(&self, action: &Action) -> Authorization;
}

#[derive(Debug, Clone, Default)]
pub struct AllowAllPolicy;

#[async_trait]
impl Policy for AllowAllPolicy {
    async fn authorize(&self, _action: &Action) -> Authorization {
        Authorization { status: AuthorizationStatus::Allowed, message: None }
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
            Authorization { status: AuthorizationStatus::Rejected, message: Some("approval_required".to_string()) }
        } else {
            Authorization { status: AuthorizationStatus::Allowed, message: None }
        }
    }
}
