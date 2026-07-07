package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/SakuraByteCore/AxumAgent/internal/agent"
	"github.com/SakuraByteCore/AxumAgent/internal/store"
	"github.com/SakuraByteCore/AxumAgent/internal/web"
)

type Server struct {
	store       *store.Store
	runner      *agent.Runner
	subscribers map[chan store.Event]struct{}
	mu          sync.Mutex
}

func New(storePath, workspaceRoot string) (*Server, error) {
	st, err := store.Open(storePath)
	if err != nil {
		return nil, err
	}
	root, err := filepath.Abs(workspaceRoot)
	if err != nil {
		return nil, err
	}
	return &Server{store: st, runner: agent.NewRunner(root), subscribers: map[chan store.Event]struct{}{}}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /", s.index)
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("POST /api/runs", s.createRun)
	mux.HandleFunc("GET /api/runs/{run_id}", s.getRun)
	mux.HandleFunc("GET /api/runs/{run_id}/events", s.events)
	return withJSONErrors(mux)
}

func (s *Server) index(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("content-type", "text/html; charset=utf-8")
	_, _ = w.Write(web.IndexHTML)
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	_, _ = w.Write([]byte("ok"))
}

type createRunRequest struct {
	Task     string `json:"task"`
	MaxSteps int    `json:"max_steps"`
}

type createRunResponse struct {
	RunID  string `json:"run_id"`
	Status string `json:"status"`
}

func (s *Server) createRun(w http.ResponseWriter, r *http.Request) {
	var req createRunRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid_json", http.StatusBadRequest)
		return
	}
	if req.Task == "" {
		http.Error(w, "missing_task", http.StatusBadRequest)
		return
	}
	if req.MaxSteps <= 0 {
		req.MaxSteps = 8
	}
	runID, err := newRunID()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	run, err := s.store.InsertRun(runID, req.Task)
	if err != nil {
		if errors.Is(err, store.ErrActiveRunExists) {
			http.Error(w, "active_run_exists", http.StatusConflict)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	go s.run(context.Background(), run.RunID, req.Task, req.MaxSteps)
	writeJSON(w, createRunResponse{RunID: run.RunID, Status: run.Status})
}

type getRunResponse struct {
	RunID  string `json:"run_id"`
	Status string `json:"status"`
}

func (s *Server) getRun(w http.ResponseWriter, r *http.Request) {
	runID := r.PathValue("run_id")
	status, ok := s.store.Status(runID)
	if !ok {
		http.Error(w, "not_found", http.StatusNotFound)
		return
	}
	writeJSON(w, getRunResponse{RunID: runID, Status: status})
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	runID := r.PathValue("run_id")
	status, ok := s.store.Status(runID)
	if !ok {
		http.Error(w, "not_found", http.StatusNotFound)
		return
	}
	fromSeq := int64(1)
	if raw := r.URL.Query().Get("from_seq"); raw != "" {
		if n, err := strconv.ParseInt(raw, 10, 64); err == nil && n > 0 {
			fromSeq = n
		}
	}

	w.Header().Set("content-type", "text/event-stream")
	w.Header().Set("cache-control", "no-cache")
	w.Header().Set("connection", "keep-alive")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming_unsupported", http.StatusInternalServerError)
		return
	}

	ch := s.subscribe()
	defer s.unsubscribe(ch)

	cursor := fromSeq
	terminal := false
	for _, event := range s.store.EventsSince(runID, cursor, 10000) {
		if event.Seq >= cursor {
			cursor = event.Seq + 1
		}
		if isTerminal(event.Kind) {
			terminal = true
		}
		writeSSE(w, event)
		flusher.Flush()
	}
	if terminal || (isTerminal(status) && noMoreEvents(s.store, runID, cursor)) {
		return
	}

	keepalive := time.NewTicker(15 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-keepalive.C:
			_, _ = fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()
		case event := <-ch:
			if event.RunID != runID || event.Seq < cursor {
				continue
			}
			cursor = event.Seq + 1
			writeSSE(w, event)
			flusher.Flush()
			if isTerminal(event.Kind) {
				return
			}
		}
	}
}

func (s *Server) run(ctx context.Context, runID, task string, maxSteps int) {
	_ = s.store.SetStatus(runID, "running")
	s.emit(runID, "status", map[string]string{"status": "running"})
	started := time.Now()
	result, err := s.runner.Run(ctx, task, maxSteps, agent.TimedSink{Started: started, EmitFunc: func(kind string, payload any) {
		s.emit(runID, kind, payload)
	}})
	if err != nil {
		s.emit(runID, "error", map[string]any{"error": err.Error(), "elapsed_ms": time.Since(started).Milliseconds()})
		_ = s.store.SetStatus(runID, "error")
		return
	}
	s.emit(runID, "done", map[string]any{"answer": result.Answer, "steps": result.Steps, "elapsed_ms": time.Since(started).Milliseconds()})
	_ = s.store.SetStatus(runID, "done")
}

func (s *Server) emit(runID, kind string, payload any) {
	event, err := s.store.AppendEvent(runID, kind, payload)
	if err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.subscribers {
		select {
		case ch <- event:
		default:
		}
	}
}

func (s *Server) subscribe() chan store.Event {
	ch := make(chan store.Event, 64)
	s.mu.Lock()
	s.subscribers[ch] = struct{}{}
	s.mu.Unlock()
	return ch
}

func (s *Server) unsubscribe(ch chan store.Event) {
	s.mu.Lock()
	delete(s.subscribers, ch)
	close(ch)
	s.mu.Unlock()
}

func newRunID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func writeSSE(w http.ResponseWriter, event store.Event) {
	b, _ := json.Marshal(event)
	_, _ = fmt.Fprintf(w, "event: event\ndata: %s\n\n", b)
}

func isTerminal(statusOrKind string) bool {
	return statusOrKind == "done" || statusOrKind == "error"
}

func noMoreEvents(st *store.Store, runID string, cursor int64) bool {
	next, ok := st.NextSeq(runID)
	return ok && cursor >= next
}

func withJSONErrors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
	})
}
