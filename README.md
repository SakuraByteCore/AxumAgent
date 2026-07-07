# AxumAgent

Go binary local agent core with CLI and plain HTML/JS web control.

## Install with npm

Install from GitHub:

```bash
npm install -g git+https://github.com/SakuraByteCore/AxumAgent.git --install-links=true
```

Then run:

```bash
sagent validate --spawn-server
sagent serve
```

`--install-links=true` avoids npm leaving the package as a symlink to a temporary git clone when installing directly from GitHub.

The npm entrypoint builds the Go binary on first use and caches it under the user cache directory. A Go toolchain must be available on the target machine.

## Development

```bash
go test ./...
go build -o dist/sagent ./cmd/sagent
```
