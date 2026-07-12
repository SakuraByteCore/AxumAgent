# Android aarch64 artifacts

Android binaries are not checked in after the Axum rename because the previous prebuilt files contained stale the old name crate names, paths, and environment strings.

Rebuild them from the renamed workspace with an Android NDK toolchain available:

```bash
cd rs
cargo build --release --target aarch64-linux-android -p axum-cli -p axum-server
cp target/aarch64-linux-android/release/axum-cli ../artifacts/android-aarch64/axum-cli
cp target/aarch64-linux-android/release/axum-server ../artifacts/android-aarch64/axum-server
```

Required tool example: `aarch64-linux-android-clang` from the Android NDK.
