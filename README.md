# uv Auto venv

[![CI](https://github.com/Weidav/uv-auto-venv/actions/workflows/test.yml/badge.svg)](https://github.com/Weidav/uv-auto-venv/actions/workflows/test.yml) [![Version](https://img.shields.io/badge/version-1.5.0-blue)](https://github.com/Weidav/uv-auto-venv/releases) [![VS Code Version](https://img.shields.io/badge/VS%20Code-%5E1.107.0-blue)](https://code.visualstudio.com/) [![License](https://img.shields.io/github/license/Weidav/uv-auto-venv)](https://github.com/Weidav/uv-auto-venv/blob/main/LICENSE) [![GitHub Stars](https://img.shields.io/github/stars/Weidav/uv-auto-venv?style=social)](https://github.com/Weidav/uv-auto-venv/stargazers)
Stop switching venvs manually. Automatically activates [uv](https://docs.astral.sh/uv/) Python environments the moment you switch tabs in VS Code.

Designed for monorepos with multiple Python projects, when working with scripts that use PEP 723 inline metadata, or in workspaces containing a mix of Python projects and scripts.

The Python extension's built-in venv discovery works well for single-project repositories, but falls short in these scenarios. For PEP 723 inline scripts it doesn't work at all.

## Features

- **Automatic venv activation** — detects and activates the correct Python interpreter every time you change the active editor tab.
- **PEP 723 inline scripts** — recognises `# /// script` metadata and resolves the interpreter with `uv python find --script <file>`.
- **Standard uv projects** — runs `uv python find` from the active file's directory, letting uv resolve the project root automatically.
- **Python Environments extension support** — works with both the classic Python extension API and the new [Python Environments](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs) extension, with per-file environment scoping for inline scripts.
- **Manual trigger** — use the command palette: **uv Auto venv: Reload Virtual Environment**.

> **Note:** This extension does not create virtual environments for you. It only detects and activates the correct interpreter for the active file. Use `uv sync` or `uv run` to create environments as needed.

## Requirements

- [uv](https://docs.astral.sh/uv/) must be installed and available on your `PATH`.
- The [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python) for VS Code.

### Installing uv

Follow the [official installation guide](https://docs.astral.sh/uv/getting-started/installation/), then verify:

```bash
uv --version
```

## Compatibility with Python Environments Extension

Starting with VS Code 2026, Microsoft is rolling out a new [Python Environments](https://marketplace.visualstudio.com/items?itemName=ms-python.vscode-python-envs) extension that replaces parts of the classic Python extension's environment management. When enabled via `python.useEnvironmentsExtension`, tools like debugpy and Pylance read the active interpreter from this new extension instead of the classic API.

**uv Auto venv v1.5.0+ supports both modes automatically:**

| Mode                                                              | How it works                                                                                                                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Classic** (`python.useEnvironmentsExtension: false` or absent)  | Uses the classic `ms-python.python` API (`updateActiveEnvironmentPath`). Scope is per workspace folder.                                                                    |
| **Python Environments** (`python.useEnvironmentsExtension: true`) | Uses the `ms-python.vscode-python-envs` API (`resolveEnvironment` → `setEnvironment`). Scope is per file for PEP 723 scripts and per workspace folder for normal projects. |

The extension detects which mode is active at startup and routes interpreter changes through the correct API. If the Python Environments extension is not installed, it falls back to the classic API automatically.

## Recommended Settings

Add the following to your `.vscode/settings.json`. Choose the section that matches your setup:

### With Python Environments extension (recommended for new setups)

```json
{
  "python.terminal.activateEnvironment": false,
  "python.createEnvironment.contentButton": "hide",
  "python.useEnvironmentsExtension": true
}
```

### Classic Python extension only

```json
{
  "python.terminal.activateEnvironment": false,
  "python.createEnvironment.contentButton": "hide",
  "python.useEnvironmentsExtension": false
}
```

These settings prevent the Python extension's built-in environment management from interfering with this extension.

## Extension Settings

| Setting                          | Type      | Default | Description                                                 |
| -------------------------------- | --------- | ------- | ----------------------------------------------------------- |
| `uv-auto-venv.showNotifications` | `boolean` | `true`  | Show a notification when the Python interpreter is changed. |

## How It Works

1. When you open or switch to a `.py` file that contains [PEP 723](https://peps.python.org/pep-0723/) inline script metadata (`# /// script`), the extension runs `uv python find --script <file>` and sets the returned interpreter. (To save time on large files, only the first 4KB are checked).
2. For all other Python files (detected via VS Code's language ID, supporting `.pyw` and shebangs) it runs `uv python find` from the active file's directory, which respects `pyproject.toml`, `.python-version`, and uv's own resolution rules.
3. The interpreter is only updated when it differs from the currently active one, and tab-switching is debounced by 300ms to avoid unnecessary churn during rapid tab switching.
4. When `python.useEnvironmentsExtension` is enabled, the extension resolves the uv-discovered interpreter path into a Python Environment object and sets it via the python-envs API. This ensures debugpy, Pylance, and the status bar all reflect the correct interpreter.
5. The manual reload command forces a refresh and reapplies the interpreter, which can help when the language server does not pick up environment changes immediately.

## Troubleshooting

If environments are not activating as expected, you can check the **uv Auto venv** output channel in VS Code (`View` -> `Output`, then select `uv Auto venv` from the dropdown) to see diagnostic logs and `uv` command errors. The log will also indicate which API path is being used (classic or python-envs).
