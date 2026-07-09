# Changelog

All notable changes to the **uv-auto-venv** extension will be documented in this file.

<!-- Format based on [Keep a Changelog](https://keepachangelog.com/). -->

## [1.5.0] - 2026-07-09

### Added

- **Python Environments extension support** — when `python.useEnvironmentsExtension` is enabled, the extension now routes interpreter changes through the `ms-python.vscode-python-envs` API (`resolveEnvironment` → `setEnvironment`). This makes uv-auto-venv fully compatible with VS Code's new Python Environments experience, including per-file environment scoping for PEP 723 inline scripts.
- Falls back gracefully to the classic `ms-python.python` API when the setting is off or the Python Environments extension is not installed — existing behaviour is unchanged.

### Changed

- Updated documentation: `python.useEnvironmentsExtension` is no longer recommended to be disabled. The README now explains both API paths and provides separate recommended settings for classic and python-envs workflows.

### Fixed

- Debounce integration tests now handle the python-envs extension's independent environment switching, which could cause false failures in the intermediate-environment assertion.

## [1.4.1] - 2026-07-06

### Changed

- Extracted debounce tests into a dedicated `debounce.test.ts` file for better test organization.

### Fixed

- Excluded `.devcontainer/` and `.github/` directories from the published VSIX via `.vscodeignore`.

## [1.4.0] - 2026-07-03

### Added

- Added GitHub Actions workflow for automated testing.
- Added a diagnostic logging output channel ("uv Auto venv") to log `uv` command failures.

### Changed

- Python file detection: Now uses `languageId` instead of file extension checks. This properly supports `.pyw` files, shebang-based detection, and user-configured language associations. (PEP 723 checks still require `.py`).
- Performance: Debounced the tab-switch handler by 300ms, which prevents multiple `uv python find` subprocesses from spawning during rapid tab cycling. Added debounce integration tests
- Performance: The PEP 723 metadata check now only reads the first 4KB of a file, saving time on large scripts.
- Documentation: Added an explanation of the `refreshEnvironments` empty-path workaround to the docs.
- Development: Aligned project to Node v24, ES2024, and enabled stricter TypeScript checks (`noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedParameters`).
- Dependencies: Updated dependencies and removed fixed versions for dev-dependencies.

### Fixed

- Improved error logging by extracting messages from unknown error types in `uv python find` functions.
- Guarded against null locations in the esbuild error handler to prevent build crashes.
- Ensured file descriptors are properly closed when checking for PEP 723 metadata.
- Handled asynchronous errors in Python environment setup to prevent timer callback crashes.
- Removed devcontainer mounts and redundant IDX extension configurations.
- Cleaned up `.gitignore` (removed duplicate `.DS_Store`, added `__pycache__`).

## [1.3.0] - 2026-06-06

### Added

- Automated integration test suite and Python example projects for better stability and testing.
- Dev container configuration with built-in Python and uv support.

### Changed

- Updated dependencies and ensured Antigravity compatibility.

## [1.2.0] - 2026-03-25

### Added

- Manual refresh now forces environment discovery before re-selecting the interpreter, ensuring language server updates are applied.

### Changed

- Changed a manual refresh command to: **uv Auto venv: Reload Virtual Environment**.

## [1.1.0] - 2026-03-05

### Changed

- Interpreter activation is now restricted to `.py` files. Switching to non-Python files no longer triggers a uv lookup or interpreter change.

## [1.0.2] - 2026-03-04

### Changed

- Documented that the extension does not create virtual environments.

### Added

- Added explanation of why the Python extension's built-in venv discovery falls short
- Added recommended Python extension settings to avoid conflicts

## [1.0.1] - 2026-03-04

### Changed

- Updated README with project description.

### Added

- Added extension icon.

## [1.0.0] - 2026-03-03

### Added

- Automatic Python interpreter activation on tab switch.
- PEP 723 inline script support via `uv python find --script <file>`.
- Standard uv project support via `uv python find`.
- Manual command: **uv Auto venv: Activate Virtual Environment**.
- `uv-auto-venv.showNotifications` setting to toggle interpreter-change notifications.

### Fixed

- Run `uv python find` from the open file's directory instead of the workspace root, so nested projects (e.g. monorepos, src-layout) resolve the correct venv.
