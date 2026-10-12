# RTK support and provisioning policy

## Current provisioner mapping

`scripts/provision-rtk.mjs` pins RTK `v0.51.0` for automated downloads, verifies archive SHA-256 digests (`RTK_CHECKSUMS`), and validates version compatibility across the `[>=0.50.0 <0.52.0]` range (`0.50.x` and `0.51.x`).

| OS reported by Node | Architecture | Provisioned asset | Pinned SHA-256 Checksum (`v0.51.0`) | Release gate |
|---|---|---|---|---|
| Windows (`win32`) | x64 | `rtk-x86_64-pc-windows-msvc.zip` | `1623e9b45d28b15122d69e7314776e1123a804224885ce07e7182fb40080f05c` | Verified in Windows x64 CI (`windows-latest`, Node 22 & 24). |
| macOS (`darwin`) | arm64 | `rtk-aarch64-apple-darwin.tar.gz` | `8817d8b71afc02ac8bf06eb24bcc41c306592ab735b68e8fee9db1ba0de7cb59` | Verified in Apple Silicon macOS CI (`macos-latest`, Node 22 & 24). |
| macOS (`darwin`) | x64 | `rtk-x86_64-apple-darwin.tar.gz` | `bd39c8153f4147358360c7dc51665a8131cc9ee16f81f69a9402ffa500be3cc2` | Checksum-pinned; requires Intel macOS runner or manual `0.50.x`/`0.51.x` install. |
| Linux (`linux`) | x64 | `rtk-x86_64-unknown-linux-musl.tar.gz` | `5028d3b19a8f0990d30fec9fbb07e32782bc5698e618fb1861aad8a9ccba4eb5` | Verified in Ubuntu x64 CI (`ubuntu-latest`, Node 22 & 24). |
| Linux (`linux`) | arm64 | `rtk-aarch64-unknown-linux-gnu.tar.gz` | `8d6d1aad9e69b42481eda7039507d1f7ee93698f87713cecd873d287c1931632` | Checksum-pinned; requires ARM64 Linux runner or manual `0.50.x`/`0.51.x` install. |
| Any other platform/architecture | any | No provisioned asset | — | Fails closed unless a compatible RTK version (`>=0.50.0 <0.52.0`) is installed on `PATH` or `--allow-degraded` is passed. |

RTK release assets: <https://github.com/rtk-ai/rtk/releases/tag/v0.51.0>

## Enforced provisioning and compatibility policy

1. **Enforced version range (`>=0.50.0 <0.52.0`).** `findExistingRtk()` and `isCompatibleRtkVersion()` strictly validate both plugin-local and `PATH` binaries against `[>=0.50.0 <0.52.0]`. Incompatible binaries on `PATH` (e.g., `<0.50.0` or `>=0.52.0`) emit a warning and are rejected so the installer provisions the pinned `v0.51.0` binary into `bin/`.
2. **Hook rewrite & execution resolution.** `scripts/execution-guard-hook.mjs` (`resolveCompatibleRtk()`) verifies `PATH` binary compatibility before invoking `rtk rewrite`. When `PATH` contains an incompatible version or lacks `rtk`, both `runRtkRewrite()` and the resulting shell command are routed to the verified plugin-local binary.
3. **Fail-closed SHA-256 verification.** `ensureRtkInstalled()` computes the SHA-256 digest of downloaded archive bytes via `node:crypto` and compares it against `RTK_CHECKSUMS` before writing or extracting any archive. Checksum mismatches immediately abort provisioning.
4. **Fail-closed installer preflight.** `runInstall()` validates configuration syntax/shape and provisions RTK before mutating user profile configurations (`hooks.json`, `mcp_config.json`, or `node.cmd`). Provisioning failures abort installation unless `--allow-degraded` is explicitly specified.
5. **Manual installation on unsupported architectures.** Users on architectures without a prebuilt mapping (such as Windows ARM64) must install a compatible RTK version (`0.50.x` or `0.51.x`) onto `PATH` or pass `--allow-degraded`. Arbitrary outside-range versions on `PATH` are rejected.

## Release smoke tests

Run these checks on each supported OS/architecture before changing `RTK_VERSION`:

- Provision to a clean temporary `bin` directory; validate the executable launches and its reported version matches `[>=0.50.0 <0.52.0]`.
- Corrupt/truncate a downloaded archive in a test fixture and confirm SHA-256 verification prevents extraction.
- Remove `rtk` from `PATH` and verify the installer either provisions the pinned version or exits clearly before modifying user config.
- Put an incompatible RTK version (`0.60.0`) first on `PATH` and verify `findExistingRtk()` rejects it and `execution-guard-hook.mjs` routes rewrites to the compatible local binary.
- Exercise `rtk read`, `rtk rg`, `rtk find`, and command-rewrite paths with filenames containing spaces, Unicode, and shell metacharacters.
- Verify re-run/idempotency and uninstall/restore using a temporary `AGY_TEST_PROFILE_DIR` sandbox, never a developer's live profile.
