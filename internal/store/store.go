package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var ErrActiveRunExists = errors.New("active_run_exists")

type Run struct {
	RunID       string `json:"run_id"`
	Task        string `json:"task"`
	Status      string `json:"status"`
	CreatedAtMS int64  `json:"created_at_ms"`
	UpdatedAtMS int64  `json:"updated_at_ms"`
	NextSeq     int64  `json:"next_seq"`
}

type Event struct {
	RunID   string `json:"run_id"`
	Seq     int64  `json:"seq"`
	TSMS    int64  `json:"ts_ms"`
	Kind    string `json:"type"`
	Payload any    `json:"payload"`
}

type state struct {
	Runs   map[string]*Run `json:"runs"`
	Events []Event         `json:"events"`
}

type Store struct {
	path string
	mu   sync.Mutex
	data state
}

func Open(path string) (*Store, error) {
	s := &Store{path: path, data: state{Runs: map[string]*Run{}, Events: []Event{}}}
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return s, s.persistLocked()
		}
		return nil, err
	}
	if len(b) > 0 {
		if err := json.Unmarshal(b, &s.data); err != nil {
			return nil, err
		}
		if s.data.Runs == nil {
			s.data.Runs = map[string]*Run{}
		}
	}
	return s, nil
}

func (s *Store) InsertRun(runID, task string) (*Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, run := range s.data.Runs {
		if run.Status == "queued" || run.Status == "running" {
			return nil, ErrActiveRunExists
		}
	}
	now := NowMS()
	run := &Run{RunID: runID, Task: task, Status: "queued", CreatedAtMS: now, UpdatedAtMS: now, NextSeq: 1}
	s.data.Runs[runID] = run
	if err := s.persistLocked(); err != nil {
		delete(s.data.Runs, runID)
		return nil, err
	}
	copy := *run
	return &copy, nil
}

func (s *Store) SetStatus(runID, status string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	run := s.data.Runs[runID]
	if run == nil {
		return os.ErrNotExist
	}
	run.Status = status
	run.UpdatedAtMS = NowMS()
	return s.persistLocked()
}

func (s *Store) Status(runID string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run := s.data.Runs[runID]
	if run == nil {
		return "", false
	}
	return run.Status, true
}

func (s *Store) NextSeq(runID string) (int64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run := s.data.Runs[runID]
	if run == nil {
		return 0, false
	}
	return run.NextSeq, true
}

func (s *Store) AppendEvent(runID, kind string, payload any) (Event, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	run := s.data.Runs[runID]
	if run == nil {
		return Event{}, os.ErrNotExist
	}
	event := Event{RunID: runID, Seq: run.NextSeq, TSMS: NowMS(), Kind: kind, Payload: payload}
	run.NextSeq++
	run.UpdatedAtMS = event.TSMS
	s.data.Events = append(s.data.Events, event)
	if err := s.persistLocked(); err != nil {
		return Event{}, err
	}
	return event, nil
}

func (s *Store) EventsSince(runID string, fromSeq int64, limit int) []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	if limit <= 0 {
		limit = 10000
	}
	out := make([]Event, 0)
	for _, event := range s.data.Events {
		if event.RunID == runID && event.Seq >= fromSeq {
			out = append(out, event)
			if len(out) >= limit {
				break
			}
		}
	}
	return out
}

func (s *Store) persistLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func NowMS() int64 {
	return time.Now().UnixMilli()
}
