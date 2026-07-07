package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/SakuraByteCore/AxumAgent/internal/server"
)

const defaultURL = "http://127.0.0.1:3001"

type globals struct {
	url  string
	json bool
}

type spawnOptions struct {
	spawnServer      bool
	serverBin        string
	serverArgs       multiFlag
	storePath        string
	port             int
	startupTimeoutMS int
}

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, " ") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	g, rest := parseGlobals(args)
	if len(rest) == 0 {
		return usage()
	}
	switch rest[0] {
	case "serve", "server":
		return serve(rest[1:])
	case "ping":
		return ping(g)
	case "health":
		return health(g)
	case "run":
		return runCommand(g, rest[1:])
	case "validate":
		return validateCommand(g, rest[1:])
	case "runs":
		return runsCommand(g, rest[1:])
	default:
		return usage()
	}
}

func parseGlobals(args []string) (globals, []string) {
	g := globals{url: defaultURL}
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--json":
			g.json = true
		case "--url":
			if i+1 < len(args) {
				i++
				g.url = strings.TrimRight(args[i], "/")
			}
		default:
			out = append(out, args[i])
		}
	}
	return g, out
}

func serve(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	host := fs.String("host", envOr("HOST", "127.0.0.1"), "host")
	port := fs.Int("port", envInt("PORT", 3001), "port")
	storePath := fs.String("store-path", envOr("SAGENT_STORE_PATH", "data/sagent-store.json"), "file store path")
	workspace := fs.String("workspace", ".", "tool sandbox root")
	if err := fs.Parse(args); err != nil {
		return err
	}
	srv, err := server.New(*storePath, *workspace)
	if err != nil {
		return err
	}
	addr := net.JoinHostPort(*host, strconv.Itoa(*port))
	fmt.Fprintf(os.Stderr, "listening on http://%s\n", addr)
	return http.ListenAndServe(addr, srv.Handler())
}

func ping(g globals) error {
	started := time.Now()
	resp, err := http.Get(g.url + "/health")
	ok := err == nil && resp.StatusCode >= 200 && resp.StatusCode < 300
	if resp != nil {
		_ = resp.Body.Close()
	}
	if g.json {
		return printJSON(map[string]any{"ok": ok, "url": g.url, "latency_ms": time.Since(started).Milliseconds()})
	}
	if !ok {
		if err != nil {
			return err
		}
		return fmt.Errorf("error")
	}
	fmt.Printf("ok %dms\n", time.Since(started).Milliseconds())
	return nil
}

func health(g globals) error {
	resp, err := http.Get(g.url + "/health")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return errors.New(strings.TrimSpace(string(body)))
	}
	if g.json {
		return printJSON(map[string]any{"ok": strings.TrimSpace(string(body)) == "ok", "body": string(body)})
	}
	fmt.Print(string(body))
	if !bytes.HasSuffix(body, []byte("\n")) {
		fmt.Println()
	}
	return nil
}

func runCommand(g globals, args []string) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	maxSteps := fs.Int("max-steps", 8, "max steps")
	spawn := addSpawnFlags(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() == 0 {
		return fmt.Errorf("task is required")
	}
	task := strings.Join(fs.Args(), " ")
	return withManagedServer(g, spawn, func(g globals) error {
		created, err := createRun(g.url, task, *maxSteps)
		if err != nil {
			return err
		}
		if g.json {
			_ = printJSON(created)
		} else {
			fmt.Printf("run_id %s\n", created.RunID)
		}
		return streamEvents(g.url, created.RunID, 1, func(event map[string]any) error {
			return printEvent(event, g.json)
		})
	})
}

func validateCommand(g globals, args []string) error {
	fs := flag.NewFlagSet("validate", flag.ContinueOnError)
	spawn := addSpawnFlags(fs)
	if err := fs.Parse(args); err != nil {
		return err
	}
	return withManagedServer(g, spawn, func(g globals) error {
		created, err := createRun(g.url, "validate", 2)
		if err != nil {
			return err
		}
		terminal := false
		err = streamEvents(g.url, created.RunID, 1, func(event map[string]any) error {
			kind, _ := event["type"].(string)
			if kind == "done" || kind == "error" {
				terminal = true
			}
			return nil
		})
		if err != nil {
			return err
		}
		if !terminal {
			return fmt.Errorf("no_terminal_event")
		}
		if g.json {
			return printJSON(map[string]any{"ok": true})
		}
		fmt.Println("ok")
		return nil
	})
}

func runsCommand(g globals, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("runs subcommand required")
	}
	switch args[0] {
	case "create":
		fs := flag.NewFlagSet("runs create", flag.ContinueOnError)
		maxSteps := fs.Int("max-steps", 8, "max steps")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		if fs.NArg() == 0 {
			return fmt.Errorf("task is required")
		}
		created, err := createRun(g.url, strings.Join(fs.Args(), " "), *maxSteps)
		if err != nil {
			return err
		}
		if g.json {
			return printJSON(created)
		}
		fmt.Printf("%s %s\n", created.RunID, created.Status)
		return nil
	case "get":
		if len(args) < 2 {
			return fmt.Errorf("run_id is required")
		}
		res, err := getRun(g.url, args[1])
		if err != nil {
			return err
		}
		if g.json {
			return printJSON(res)
		}
		fmt.Printf("%s %s\n", res.RunID, res.Status)
		return nil
	case "events":
		fs := flag.NewFlagSet("runs events", flag.ContinueOnError)
		fromSeq := fs.Int64("from-seq", 1, "from seq")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		if fs.NArg() == 0 {
			return fmt.Errorf("run_id is required")
		}
		return streamEvents(g.url, fs.Arg(0), *fromSeq, func(event map[string]any) error { return printEvent(event, g.json) })
	default:
		return fmt.Errorf("unknown runs subcommand:%s", args[0])
	}
}

type createRunResponse struct {
	RunID  string `json:"run_id"`
	Status string `json:"status"`
}
type getRunResponse struct {
	RunID  string `json:"run_id"`
	Status string `json:"status"`
}

func createRun(baseURL, task string, maxSteps int) (createRunResponse, error) {
	body, _ := json.Marshal(map[string]any{"task": task, "max_steps": maxSteps})
	resp, err := http.Post(baseURL+"/api/runs", "application/json", bytes.NewReader(body))
	if err != nil {
		return createRunResponse{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(resp.Body)
		return createRunResponse{}, errors.New(strings.TrimSpace(string(b)))
	}
	var out createRunResponse
	return out, json.NewDecoder(resp.Body).Decode(&out)
}

func getRun(baseURL, runID string) (getRunResponse, error) {
	resp, err := http.Get(baseURL + "/api/runs/" + runID)
	if err != nil {
		return getRunResponse{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(resp.Body)
		return getRunResponse{}, errors.New(strings.TrimSpace(string(b)))
	}
	var out getRunResponse
	return out, json.NewDecoder(resp.Body).Decode(&out)
}

func streamEvents(baseURL, runID string, fromSeq int64, onEvent func(map[string]any) error) error {
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, fmt.Sprintf("%s/api/runs/%s/events?from_seq=%d", baseURL, runID, fromSeq), nil)
	req.Header.Set("accept", "text/event-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(resp.Body)
		return errors.New(strings.TrimSpace(string(b)))
	}
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			return err
		}
		if err := onEvent(event); err != nil {
			return err
		}
		kind, _ := event["type"].(string)
		if kind == "done" || kind == "error" {
			return nil
		}
	}
	return scanner.Err()
}

func printEvent(event map[string]any, asJSON bool) error {
	if asJSON {
		return printJSON(event)
	}
	kind, _ := event["type"].(string)
	seq := event["seq"]
	payload := event["payload"]
	if kind == "done" {
		if m, ok := payload.(map[string]any); ok && m["answer"] != nil {
			fmt.Printf("done %v %v\n", seq, m["answer"])
			return nil
		}
	}
	b, _ := json.Marshal(payload)
	fmt.Printf("%s %v %s\n", kind, seq, b)
	return nil
}

func addSpawnFlags(fs *flag.FlagSet) *spawnOptions {
	spawn := &spawnOptions{serverBin: os.Args[0], startupTimeoutMS: 10000}
	fs.BoolVar(&spawn.spawnServer, "spawn-server", false, "spawn a local server")
	fs.StringVar(&spawn.serverBin, "server-bin", spawn.serverBin, "server binary")
	fs.Var(&spawn.serverArgs, "server-arg", "extra server arg")
	fs.StringVar(&spawn.storePath, "store-path", "", "store path")
	fs.IntVar(&spawn.port, "port", 0, "server port")
	fs.IntVar(&spawn.startupTimeoutMS, "startup-timeout-ms", spawn.startupTimeoutMS, "startup timeout ms")
	return spawn
}

func withManagedServer(g globals, spawn *spawnOptions, fn func(globals) error) error {
	if spawn == nil || !spawn.spawnServer {
		return fn(g)
	}
	port := spawn.port
	if port == 0 {
		port = pickPort()
	}
	storePath := spawn.storePath
	if storePath == "" {
		storePath = filepath.Join(os.TempDir(), fmt.Sprintf("sagent-cli-%d-%d.json", os.Getpid(), time.Now().UnixMilli()))
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	args := append([]string{"serve", "--host", "127.0.0.1", "--port", strconv.Itoa(port), "--store-path", storePath}, spawn.serverArgs...)
	cmd := exec.CommandContext(ctx, spawn.serverBin, args...)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	defer func() { cancel(); _ = cmd.Wait() }()
	managed := globals{url: fmt.Sprintf("http://127.0.0.1:%d", port), json: g.json}
	if err := waitHealth(managed.url, time.Duration(spawn.startupTimeoutMS)*time.Millisecond); err != nil {
		return err
	}
	return fn(managed)
}

func pickPort() int {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 3001
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func waitHealth(baseURL string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var last error
	for time.Now().Before(deadline) {
		resp, err := http.Get(baseURL + "/health")
		if err == nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
			_ = resp.Body.Close()
			return nil
		}
		if resp != nil {
			_ = resp.Body.Close()
		}
		last = err
		time.Sleep(100 * time.Millisecond)
	}
	if last != nil {
		return last
	}
	return errors.New("server_start_timeout")
}

func printJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	fmt.Println(string(b))
	return nil
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func envInt(name string, fallback int) int {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func usage() error {
	return fmt.Errorf("usage: sagent [--url URL] [--json] <serve|ping|health|run|validate|runs>")
}
