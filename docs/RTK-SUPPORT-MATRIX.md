# RTK support and provisioning policy

## Current provisioner mapping

The upstream `scripts/provision-rtk.mjs` currently pins RTK `v0.51.0` and maps these platform/architecture pairs to release assets. This is the provisioner's mapping, not yet a guarantee that every combination has passed end-to-end tests.

| OS reported by Node | Architecture | Provisioned asset | Release gate |
|---|---|---|---|
| Windows (`win32`) | x64 | `rtk-x86_64-pc-windows-msvc.zip` | Test extraction, executable launch, PATH detection, and junction/copy install behavior on a standard Windows runner. |
| macOS (`darwin`) | arm64 | `rtk-aarch64-apple-darwin.tar.gz` | Test on Apple Silicon or a matching CI runner. |
| macOS (`darwin`) | x64 | `rtk-x86_64-apple-darwin.tar.gz` | Test on Intel macOS or a matching CI runner. |
| Linux (`linux`) | x64 | `rtk-x86_64-unknown-linux-musl.tar.gz` | Test on the target runner/container libc environment. |
| Linux (`linux`) | arm64 | `rtk-aarch64-unknown-linux-gnu.tar.gz` | Test on a matching ARM64 Linux runner. |
| Any other platform/architecture | any | No provisioned asset | Fail with a clear message unless a separately installed RTK version is explicitly supported. |

RTK release assets: <https://github.com/rtk-ai/rtk/releases/tag/v0.51.0>

## Current policy gaps to close before release

1. **Define accepted versions.** The provisioner uses `v0.51.0` when downloading, but `findExistingRtk()` accepts any `rtk --version` output it can run. Specify a tested version or supported range and enforce it, or produce a clear compatibility warning and an explicit override mechanism.
2. **Verify downloaded bytes.** Pinning a URL/version is not integrity verification. Verify the asset's published SHA-256 checksum or signature before extraction; fail closed when verification fails. Do not extract an unverified archive.
3. **Fail the install when the required dependency is unavailable.** The installer currently catches RTK provisioning errors and continues into configuration writes. Decide whether degraded installation is supported; if RTK is mandatory, validate it before modifying the user's profile and stop on failure.
4. **Test behavior after version upgrades.** RTK `v0.51.0` release notes include a breaking change affecting implicit shell expansion. Smoke-test the actual commands and rewrites used by the Antigravity hook against the pinned release before shipping it.
5. **Document manual installation.** Provide a verified install path for users on unsupported architectures. Make clear that installing an arbitrary RTK version via PATH is not guaranteed to be compatible.
6. **Do not promise Windows ARM64 support until tested.** The current built-in asset map does not define a Windows ARM64 archive.

## Release smoke tests

Run these checks on each supported OS/architecture before changing `RTK_VERSION`:

- Provision to a clean temporary `bin` directory; validate the executable launches and its reported version matches policy.
- Corrupt/truncate a downloaded archive in a test fixture and confirm verification prevents extraction.
- Remove `rtk` from `PATH` and verify the installer either provisions the pinned version or exits clearly before modifying user config.
- Put an incompatible RTK version first on `PATH` and verify the chosen policy is followed.
- Exercise the project's actual `rtk read`, grep/search, find/list, and command-rewrite paths with filenames containing spaces, Unicode, and shell metacharacters.
- Verify re-run/idempotency and uninstall/restore using a temporary Antigravity config directory, never a developer's live profile.
