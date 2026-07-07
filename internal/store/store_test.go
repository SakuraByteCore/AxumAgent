package store

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestSingleActiveRunAndEvents(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "store.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.InsertRun("one", "task"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.InsertRun("two", "task"); !errors.Is(err, ErrActiveRunExists) {
		t.Fatalf("expected active run error, got %v", err)
	}
	event, err := s.AppendEvent("one", "status", map[string]string{"status": "running"})
	if err != nil {
		t.Fatal(err)
	}
	if event.Seq != 1 {
		t.Fatalf("seq = %d", event.Seq)
	}
	if err := s.SetStatus("one", "done"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.InsertRun("two", "task"); err != nil {
		t.Fatal(err)
	}
}
