package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

type EventSink interface {
	Emit(kind string, payload any)
}

type Runner struct {
	Tools *ToolRegistry
}

func NewRunner(root string) *Runner {
	tools := NewToolRegistry()
	tools.Register(EchoTool{})
	tools.Register(FileTool{Root: root})
	return &Runner{Tools: tools}
}

func (r *Runner) Run(ctx context.Context, task string, maxSteps int, sink EventSink) (Result, error) {
	if maxSteps <= 0 {
		maxSteps = 8
	}
	history := make([]HistoryStep, 0, maxSteps)
	var answer string

	for step := 1; step <= maxSteps; step++ {
		if err := ctx.Err(); err != nil {
			return Result{}, err
		}

		obs := Observation{Summary: "local_go_runtime", Data: map[string]any{"capabilities": []string{"cli", "web", "file_store", "single_active_run", "tool_registry_placeholders"}}}
		sink.Emit("step", map[string]any{"step": step, "stage": "observe", "observation": obs})

		decision := decide(task, step, history)
		sink.Emit("step", map[string]any{"step": step, "stage": "action", "decision": decision})

		result, err := r.execute(ctx, decision.Action)
		if err != nil {
			result = "execute_error: " + err.Error()
		}
		sink.Emit("step", map[string]any{"step": step, "stage": "result", "result": result})

		history = append(history, HistoryStep{Step: step, Rationale: decision.Rationale, Action: decision.Action, Result: result, URL: obs.URL, Title: obs.Title})
		if decision.Action.Type == "finish" {
			answer = decision.Action.Answer
			if answer == "" {
				answer = result
			}
			break
		}
	}

	if answer == "" {
		answer = "max_steps_reached"
	}
	return Result{Answer: answer, Steps: history}, nil
}

func decide(task string, step int, history []HistoryStep) Decision {
	if len(history) == 0 {
		input, _ := json.Marshal(map[string]string{"task": task})
		return Decision{Rationale: "echo task through Go tool registry", Action: Action{Type: "tool", Tool: "echo", Name: "echo", Input: input}}
	}
	last := history[len(history)-1].Result
	return Decision{Rationale: "finish after initial tool result", Action: Action{Type: "finish", Answer: last}}
}

func (r *Runner) execute(ctx context.Context, action Action) (string, error) {
	switch action.Type {
	case "tool":
		return r.Tools.Execute(ctx, action)
	case "ask_user":
		return action.Message, nil
	case "notify_user":
		return fmt.Sprintf("%s:%s", action.Level, action.Message), nil
	case "finish":
		return action.Answer, nil
	default:
		return "", fmt.Errorf("invalid_action:%s", action.Type)
	}
}

type TimedSink struct {
	Started  time.Time
	EmitFunc func(kind string, payload any)
}

func (s TimedSink) Emit(kind string, payload any) {
	s.EmitFunc(kind, payload)
}
