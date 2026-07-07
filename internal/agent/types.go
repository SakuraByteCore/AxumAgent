package agent

import "encoding/json"

type Observation struct {
	Summary string         `json:"summary,omitempty"`
	URL     string         `json:"url,omitempty"`
	Title   string         `json:"title,omitempty"`
	Data    map[string]any `json:"data,omitempty"`
}

type Action struct {
	Type    string          `json:"type"`
	Tool    string          `json:"tool,omitempty"`
	Name    string          `json:"name,omitempty"`
	Input   json.RawMessage `json:"input,omitempty"`
	Message string          `json:"message,omitempty"`
	Level   string          `json:"level,omitempty"`
	Answer  string          `json:"answer,omitempty"`
}

type Decision struct {
	Rationale string `json:"rationale"`
	Action    Action `json:"action"`
	Model     string `json:"model,omitempty"`
}

type HistoryStep struct {
	Step      int    `json:"step"`
	Rationale string `json:"rationale"`
	Action    Action `json:"action"`
	Result    string `json:"result"`
	URL       string `json:"url,omitempty"`
	Title     string `json:"title,omitempty"`
}

type Result struct {
	Answer string        `json:"answer"`
	Steps  []HistoryStep `json:"steps"`
}
