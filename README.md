# AxumAgent

Go binary local agent core with CLI and plain HTML/JS web control.

## Install with npm

Install from the GitHub source tarball:

```bash
npm install -g https://github.com/SakuraByteCore/AxumAgent/archive/refs/heads/main.tar.gz
```

Then run:

```bash
sagent validate --spawn-server
sagent serve
```

GitHub git shorthand also works when npm is allowed to extract linked packages instead of leaving a temporary clone symlink:

```bash
npm install -g github:SakuraByteCore/AxumAgent --install-links=true
```

The npm entrypoint builds the Go binary on first use and caches it under the user cache directory. A Go toolchain must be available on the target machine.

## Development

```bash
go test ./...
go build -o dist/sagent ./cmd/sagent
```
