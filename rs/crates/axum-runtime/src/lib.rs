use async_trait::async_trait;
use axum_types::{
    Action, AgentError, AgentResult, Authorization, AuthorizationStatus, Decision, HistoryStep,
    Observation,
};

#[async_trait]
pub trait RuntimeHooks: Send + Sync {
    type State: Send + Sync;

    async fn initialize(&self, task: &str) -> Result<Self::State, AgentError>;

    async fn observe(
        &self,
        state: &Self::State,
        task: &str,
        step: u32,
        history: &[HistoryStep],
    ) -> Result<Observation, AgentError>;

    async fn decide(
        &self,
        state: &Self::State,
        task: &str,
        step: u32,
        history: &[HistoryStep],
        observation: &Observation,
    ) -> Result<Decision, AgentError>;

    async fn authorize(
        &self,
        state: &Self::State,
        task: &str,
        step: u32,
        history: &[HistoryStep],
        observation: &Observation,
        decision: &Decision,
    ) -> Result<Authorization, AgentError>;

    async fn execute(
        &self,
        state: &Self::State,
        task: &str,
        step: u32,
        history: &[HistoryStep],
        observation: &Observation,
        decision: &Decision,
    ) -> Result<String, AgentError>;

    async fn cleanup(&self, _state: &Self::State) {}

    fn should_observe(&self, _last_action: Option<&Action>) -> bool {
        true
    }

    fn on_step_event(&self, _event: RuntimeEvent<'_>) {}
}

#[derive(Debug, Clone)]
pub enum RuntimeEvent<'a> {
    Observe {
        step: u32,
        observation: &'a Observation,
    },
    Action {
        step: u32,
        decision: &'a Decision,
    },
    Result {
        step: u32,
        result: &'a str,
    },
}

pub async fn run_agent<H: RuntimeHooks>(
    hooks: &H,
    task: &str,
    max_steps: u32,
    mut is_cancelled: impl FnMut() -> bool,
) -> Result<AgentResult, AgentError> {
    let state = hooks.initialize(task).await?;
    let mut history: Vec<HistoryStep> = Vec::new();
    let mut final_answer: Option<String> = None;

    let result = async {
        for step in 1..=max_steps {
            if is_cancelled() {
                return Err(AgentError::Cancelled);
            }

            let last_action = history.last().map(|h| &h.action);
            let observation = if hooks.should_observe(last_action) {
                hooks.observe(&state, task, step, &history).await?
            } else {
                Observation {
                    summary: Some("skipped".to_string()),
                    url: None,
                    title: None,
                    data: None,
                }
            };

            hooks.on_step_event(RuntimeEvent::Observe {
                step,
                observation: &observation,
            });

            if is_cancelled() {
                return Err(AgentError::Cancelled);
            }

            let decision = hooks
                .decide(&state, task, step, &history, &observation)
                .await?;
            hooks.on_step_event(RuntimeEvent::Action {
                step,
                decision: &decision,
            });

            if is_cancelled() {
                return Err(AgentError::Cancelled);
            }

            let auth = hooks
                .authorize(&state, task, step, &history, &observation, &decision)
                .await?;

            if matches!(auth.status, AuthorizationStatus::Rejected) {
                let result = auth.message.unwrap_or_else(|| "rejected".to_string());
                history.push(HistoryStep {
                    step,
                    rationale: decision.rationale,
                    action: decision.action,
                    result: result.clone(),
                    url: observation.url.clone(),
                    title: observation.title.clone(),
                });
                hooks.on_step_event(RuntimeEvent::Result {
                    step,
                    result: &result,
                });
                continue;
            }

            let exec_result = match hooks
                .execute(&state, task, step, &history, &observation, &decision)
                .await
            {
                Ok(r) => r,
                Err(e) => format!("execute_error: {e}"),
            };

            if is_cancelled() {
                return Err(AgentError::Cancelled);
            }

            let action = decision.action.clone();
            let rationale = decision.rationale.clone();

            if let Action::Finish { answer } = &action {
                final_answer = Some(answer.clone());
            }

            history.push(HistoryStep {
                step,
                rationale,
                action,
                result: exec_result.clone(),
                url: observation.url.clone(),
                title: observation.title.clone(),
            });

            hooks.on_step_event(RuntimeEvent::Result {
                step,
                result: &exec_result,
            });

            if final_answer.is_some() {
                break;
            }
        }

        Ok(())
    }
    .await;

    hooks.cleanup(&state).await;
    result?;

    Ok(AgentResult {
        answer: final_answer.unwrap_or_else(|| "max_steps_reached".to_string()),
        steps: history,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum_types::{AuthorizationStatus, ToolAction};
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct TestHooks {
        events: Arc<Mutex<Vec<String>>>,
        reject_first: bool,
    }

    #[async_trait::async_trait]
    impl RuntimeHooks for TestHooks {
        type State = ();

        async fn initialize(&self, _task: &str) -> Result<Self::State, AgentError> {
            Ok(())
        }

        async fn observe(
            &self,
            _state: &Self::State,
            _task: &str,
            step: u32,
            _history: &[HistoryStep],
        ) -> Result<Observation, AgentError> {
            Ok(Observation {
                summary: Some(format!("observed-{step}")),
                url: None,
                title: None,
                data: None,
            })
        }

        async fn decide(
            &self,
            _state: &Self::State,
            _task: &str,
            _step: u32,
            history: &[HistoryStep],
            _observation: &Observation,
        ) -> Result<Decision, AgentError> {
            if history.is_empty() {
                Ok(Decision {
                    rationale: "use tool".to_string(),
                    action: Action::Tool(ToolAction {
                        tool: "echo".to_string(),
                        name: "echo".to_string(),
                        input: None,
                    }),
                    model: None,
                    usage: None,
                })
            } else {
                Ok(Decision {
                    rationale: "finish".to_string(),
                    action: Action::Finish {
                        answer: "done".to_string(),
                    },
                    model: None,
                    usage: None,
                })
            }
        }

        async fn authorize(
            &self,
            _state: &Self::State,
            _task: &str,
            step: u32,
            _history: &[HistoryStep],
            _observation: &Observation,
            _decision: &Decision,
        ) -> Result<Authorization, AgentError> {
            if self.reject_first && step == 1 {
                Ok(Authorization {
                    status: AuthorizationStatus::Rejected,
                    message: Some("approval_required".to_string()),
                })
            } else {
                Ok(Authorization {
                    status: AuthorizationStatus::Allowed,
                    message: None,
                })
            }
        }

        async fn execute(
            &self,
            _state: &Self::State,
            _task: &str,
            _step: u32,
            _history: &[HistoryStep],
            _observation: &Observation,
            decision: &Decision,
        ) -> Result<String, AgentError> {
            match &decision.action {
                Action::Finish { answer } => Ok(answer.clone()),
                _ => Ok("tool_result".to_string()),
            }
        }

        fn on_step_event(&self, event: RuntimeEvent<'_>) {
            let name = match event {
                RuntimeEvent::Observe { .. } => "observe",
                RuntimeEvent::Action { .. } => "action",
                RuntimeEvent::Result { .. } => "result",
            };
            self.events.lock().unwrap().push(name.to_string());
        }
    }

    #[tokio::test]
    async fn run_agent_finishes_when_finish_action_is_returned() {
        let hooks = TestHooks::default();
        let result = run_agent(&hooks, "demo", 4, || false).await.unwrap();

        assert_eq!(result.answer, "done");
        assert_eq!(result.steps.len(), 2);
        assert!(matches!(result.steps[1].action, Action::Finish { .. }));
        assert_eq!(hooks.events.lock().unwrap().len(), 6);
    }

    #[tokio::test]
    async fn rejected_authorization_records_message_and_continues() {
        let hooks = TestHooks {
            reject_first: true,
            ..Default::default()
        };
        let result = run_agent(&hooks, "demo", 3, || false).await.unwrap();

        assert_eq!(result.answer, "done");
        assert_eq!(result.steps[0].result, "approval_required");
        assert_eq!(result.steps.len(), 2);
    }

    #[tokio::test]
    async fn cancellation_before_first_step_returns_cancelled() {
        let hooks = TestHooks::default();
        let err = run_agent(&hooks, "demo", 3, || true).await.unwrap_err();

        assert!(matches!(err, AgentError::Cancelled));
    }
}
