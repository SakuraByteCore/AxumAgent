package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sync"

	"github.com/egoist/mygo"
)

func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func run() (result error) {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	// 构建产物固定在 desktop/dist，仓库及 Node 依赖随目录保留。
	desktop := filepath.Dir(filepath.Dir(executable))
	cmd := exec.Command("node", filepath.Join(desktop, "bridge.mjs"))
	cmd.Dir = filepath.Dir(desktop)
	cmd.Stderr = os.Stderr
	input, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		return err
	}
	if err = cmd.Start(); err != nil {
		input.Close()
		return err
	}
	var closeOnce sync.Once
	closeInput := func() { closeOnce.Do(func() { input.Close() }) }
	defer closeInput()
	scanner := bufio.NewScanner(output)
	var ready struct {
		Type string `json:"type"`
		URL  string `json:"url"`
	}
	if !scanner.Scan() {
		closeInput()
		return errors.Join(fmt.Errorf("聊天桥接未返回就绪地址"), scanner.Err(), cmd.Wait())
	}
	if err = json.Unmarshal(scanner.Bytes(), &ready); err != nil {
		closeInput()
		return errors.Join(err, cmd.Wait())
	}
	u, err := url.Parse(ready.URL)
	if err != nil || ready.Type != "ready" || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" {
		closeInput()
		return errors.Join(fmt.Errorf("聊天桥接就绪协议无效：%q", ready.URL), cmd.Wait())
	}
	done := make(chan struct{})
	var bridgeErr error
	go func() {
		// 读取 stdout 至 EOF 后 Wait，避免提前关闭 StdoutPipe。
		for scanner.Scan() {
		}
		bridgeErr = errors.Join(scanner.Err(), cmd.Wait())
		close(done)
		mygo.App.WhenReady(func() { mygo.App.Quit() })
	}()
	stop := func() { closeInput(); <-done }
	defer func() { stop(); result = errors.Join(result, bridgeErr) }()
	mygo.App.SetName("Axum Chat")
	mygo.App.WhenReady(func() {
		window := mygo.NewWindow(mygo.WindowOptions{Title: "Axum Chat", URL: ready.URL, Width: 1200, Height: 800})
		window.OnClosed(closeInput)
	})
	mygo.App.OnQuit(stop)
	return mygo.App.Run()
}
