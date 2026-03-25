# Changelog

All notable changes to the **uv-auto-venv** extension will be documented in this file.

<!-- Format based on [Keep a Changelog](https://keepachangelog.com/). -->

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
