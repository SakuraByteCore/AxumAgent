# AxumAgent Termux / Android aarch64 binaries

These binaries are built for Termux on Android aarch64 devices. They do not require Rust or Cargo on the device.

## Quick start

```bash
pkg update
pkg install -y git ca-certificates

git clone https://github.com/SakuraByteCore/AxumAgent.git
cd AxumAgent

chmod +x artifacts/android-aarch64/sagent-cli artifacts/android-aarch64/sagent-server
./artifacts/android-aarch64/sagent-cli --help
```

## Configure OpenAI-compatible planner

```bash
./artifacts/android-aarch64/sagent-cli config openai \
  --base-url "https://YOUR_ENDPOINT/v1" \
  --api-key "YOUR_API_KEY" \
  --model "YOUR_MODEL"

./artifacts/android-aarch64/sagent-cli config show
```

## Run with auto-started local server

```bash
mkdir -p data
SAGENT_DB_PATH=data/sagent.db \
./artifacts/android-aarch64/sagent-cli run "hello" \
  --spawn-server \
  --server-bin "./artifacts/android-aarch64/sagent-server"
```

## Run server manually

Terminal 1:

```bash
mkdir -p data
PORT=3001 SAGENT_DB_PATH=data/sagent.db ./artifacts/android-aarch64/sagent-server
```

Terminal 2:

```bash
./artifacts/android-aarch64/sagent-cli --url http://127.0.0.1:3001 health
./artifacts/android-aarch64/sagent-cli --url http://127.0.0.1:3001 run "hello"
```
