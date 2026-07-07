package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Tool interface {
	ID() string
	Execute(ctx context.Context, action Action) (string, error)
}

type ToolRegistry struct {
	tools map[string]Tool
}

func NewToolRegistry() *ToolRegistry {
	return &ToolRegistry{tools: map[string]Tool{}}
}

func (r *ToolRegistry) Register(tool Tool) {
	r.tools[tool.ID()] = tool
}

func (r *ToolRegistry) Execute(ctx context.Context, action Action) (string, error) {
	tool, ok := r.tools[action.Tool]
	if !ok {
		return "", fmt.Errorf("unknown_tool:%s", action.Tool)
	}
	return tool.Execute(ctx, action)
}

type EchoTool struct{}

func (EchoTool) ID() string { return "echo" }

func (EchoTool) Execute(_ context.Context, action Action) (string, error) {
	if action.Name != "echo" {
		return "", fmt.Errorf("unknown_action:echo.%s", action.Name)
	}
	if len(action.Input) == 0 {
		return "{}", nil
	}
	return string(action.Input), nil
}

type FileTool struct {
	Root string
}

func (FileTool) ID() string { return "fs" }

func (t FileTool) Execute(_ context.Context, action Action) (string, error) {
	if action.Name != "read_file" {
		return "", fmt.Errorf("unknown_action:fs.%s", action.Name)
	}
	var in struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(action.Input, &in); err != nil || in.Path == "" {
		return "", fmt.Errorf("missing_input.path")
	}
	root, err := filepath.Abs(t.Root)
	if err != nil {
		return "", err
	}
	full, err := filepath.Abs(filepath.Join(root, in.Path))
	if err != nil {
		return "", err
	}
	if full != root && !strings.HasPrefix(full, root+string(os.PathSeparator)) {
		return "", fmt.Errorf("path_out_of_sandbox")
	}
	b, err := os.ReadFile(full)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
