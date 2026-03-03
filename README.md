# uv Auto venv

Stop switching venvs manually. Automatically activates [uv](https://docs.astral.sh/uv/) Python environments the moment you switch tabs in VS Code.

## Features

- **Automatic venv activation** — detects and activates the correct Python interpreter every time you change the active editor tab.
- **PEP 723 inline scripts** — recognises `# /// script` metadata and resolves the interpreter with `uv python find --script <file>`.
- **Standard uv projects** — runs `uv python find` from the active file's directory, letting uv resolve the project root automatically.
- **Manual trigger** — use the command palette: **uv Auto venv: Activate Virtual Environment**.

## Requirements

- [uv](https://docs.astral.sh/uv/) must be installed and available on your `PATH`.
- The [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python) for VS Code.

### Installing uv

Follow the [official installation guide](https://docs.astral.sh/uv/getting-started/installation/), then verify:

```bash
uv --version
```

## Extension Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `uv-auto-venv.showNotifications` | `boolean` | `true` | Show a notification when the Python interpreter is changed. |

## How It Works

1. When you open or switch to a `.py` file that contains [PEP 723](https://peps.python.org/pep-0723/) inline script metadata (`# /// script`), the extension runs `uv python find --script <file>` and sets the returned interpreter.
2. For all other files it runs `uv python find` from the workspace folder, which respects `pyproject.toml`, `.python-version`, and uv's own resolution rules.
3. The interpreter is only updated when it differs from the currently active one to avoid unnecessary churn.

## Release Notes

### 1.0.0

Initial release — automatic venv activation via `uv python find` and `uv python find --script`.
