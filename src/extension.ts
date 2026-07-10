import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { PythonExtension } from "@vscode/python-extension";

const execFileAsync = promisify(execFile);

const log = vscode.window.createOutputChannel("uv Auto venv", { log: true });

// ── Vendored python-envs types ──────────────────────────────────────────
// VS Code's Python tooling is split across two extensions that don't share
// a unified API or an npm package.  So we get to hand-roll our own types, awesome!

interface PythonEnvsApi {
	resolveEnvironment(
		context: vscode.Uri
	): Promise<PythonEnvItem | undefined>;
	getEnvironment(
		scope: vscode.Uri | undefined
	): Promise<PythonEnvItem | undefined>;
	setEnvironment(
		scope: vscode.Uri | vscode.Uri[] | undefined,
		env: PythonEnvItem
	): Promise<void>;
}

interface PythonEnvItem {
	readonly envId: { id: string; managerId: string };
	readonly environmentPath: vscode.Uri;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Check whether the user has opted into the new Python Environments
 * extension — because apparently one Python extension isn't enough.
 */
function useEnvsExtension(): boolean {
	const config = vscode.workspace.getConfiguration("python");
	return config.get<boolean>("useEnvironmentsExtension", false);
}

/**
 * Try to acquire the python-envs API.  Returns `undefined` when the
 * extension is not installed or the setting is off — in which case
 * VS Code will graciously still honour the classic API.  For now.
 */
async function getEnvsApi(): Promise<PythonEnvsApi | undefined> {
	if (!useEnvsExtension()) {
		return undefined;
	}
	const ext = vscode.extensions.getExtension("ms-python.vscode-python-envs");
	if (!ext) {
		log.info(
			"python.useEnvironmentsExtension is true but ms-python.vscode-python-envs is not installed; using classic API"
		);
		return undefined;
	}
	const api = ext.isActive ? ext.exports : await ext.activate();
	return api as PythonEnvsApi;
}

/**
 * Check if a .py file contains PEP 723 inline script metadata.
 * Looks for a line matching: # /// script
 *
 * Only reads the first 4 KB of the file since the metadata block
 * appears at the top.
 */
function hasPep723Metadata(filePath: string): boolean {
	try {
		const fd = fs.openSync(filePath, "r");
		try {
			const buf = Buffer.alloc(4096);
			const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
			return /^# \/\/\/ script\s*$/m.test(buf.toString("utf-8", 0, bytesRead));
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return false;
	}
}

/**
 * Run `uv python find --script <filePath>` to resolve the Python interpreter
 * for a PEP 723 inline script.
 */
async function uvPythonFindScript(filePath: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("uv", [
			"python",
			"find",
			"--script",
			filePath,
		]);
		return stdout.trim() || null;
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		log.warn(`uv python find --script failed for ${filePath}: ${message}`);
		return null;
	}
}

/**
 * Run `uv python find` in the given working directory to resolve the Python
 * interpreter for a normal uv project.
 */
async function uvPythonFind(cwd: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("uv", ["python", "find"], {
			cwd,
		});
		return stdout.trim() || null;
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		log.warn(`uv python find failed in ${cwd}: ${message}`);
		return null;
	}
}

/**
 * Attempt to set the active Python interpreter.
 *
 * When `envsApi` is available (python.useEnvironmentsExtension is on) the
 * interpreter is set through BOTH the new python-envs API and the classic
 * API, because VS Code's own extensions can't agree on a single source of
 * truth for the active interpreter:
 *   - debugpy / test discovery → reads python-envs API
 *   - Pylance / linters        → reads classic ms-python.python API
 *
 * Yes, we have to write the same information to two places.  No, there is
 * no documented reason why one API couldn't just notify the other.
 */
async function setInterpreter(
	envsApi: PythonEnvsApi | undefined,
	pythonApi: PythonExtension,
	pythonPath: string,
	fileUri: vscode.Uri,
	workspaceFolder: vscode.WorkspaceFolder | undefined,
	label: string,
	refreshEnvironment = false
): Promise<void> {
	const config = vscode.workspace.getConfiguration("uv-auto-venv");
	const showNotifications = config.get<boolean>("showNotifications", true);

	// ── Check if already set (must verify BOTH channels because of course) ─
	if (!refreshEnvironment) {
		const classicCurrent = pythonApi.environments.getActiveEnvironmentPath(
			workspaceFolder?.uri
		);
		let alreadySet = classicCurrent.path === pythonPath;

		if (envsApi && alreadySet) {
			try {
				const currentEnvsEnv = await envsApi.getEnvironment(fileUri);
				const resolved = await envsApi.resolveEnvironment(
					vscode.Uri.file(pythonPath)
				);
				alreadySet =
					alreadySet &&
					!!currentEnvsEnv &&
					!!resolved &&
					currentEnvsEnv.envId.id === resolved.envId.id;
			} catch {
				// If python-envs check fails, fall through and set anyway
				alreadySet = false;
			}
		}

		if (alreadySet) {
			return;
		}
	}

	// ── python-envs path (because debugpy refuses to read the classic API) ─
	if (envsApi) {
		try {
			const env = await envsApi.resolveEnvironment(
				vscode.Uri.file(pythonPath)
			);

			if (env) {
				await envsApi.setEnvironment(fileUri, env);
				log.info(
					`[python-envs] ${label} interpreter set to ${env.environmentPath.fsPath} (scope: ${fileUri.fsPath})`
				);
			} else {
				log.warn(
					`python-envs could not resolve ${pythonPath}; skipping python-envs channel`
				);
			}
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			log.warn(
				`python-envs setEnvironment failed: ${message}; skipping python-envs channel`
			);
		}
	}

	// ── classic path (because Pylance refuses to read the python-envs API) ─
	if (refreshEnvironment) {
		await pythonApi.environments.refreshEnvironments();
		// Clear cached path first so the update is not treated as a no-op
		await pythonApi.environments.updateActiveEnvironmentPath(
			"",
			workspaceFolder?.uri
		);
	}

	try {
		await pythonApi.environments.updateActiveEnvironmentPath(
			pythonPath,
			workspaceFolder?.uri
		);

		if (showNotifications) {
			const displayPath = workspaceFolder
				? path.relative(workspaceFolder.uri.fsPath, pythonPath)
				: pythonPath;
			const folderSuffix = workspaceFolder
				? ` for ${workspaceFolder.name}`
				: "";
			vscode.window.showInformationMessage(
				`uv-auto-venv: ${label} interpreter set to ${displayPath}${folderSuffix}`
			);
		}
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(
			`uv-auto-venv: error setting interpreter - ${message}`
		);
	}
}

/**
 * Core logic: given an active editor, figure out the right Python interpreter
 * via uv and activate it.
 */
async function setupPythonEnvironment(
	editor: vscode.TextEditor,
	envsApi: PythonEnvsApi | undefined,
	pythonApi: PythonExtension,
	refreshEnvironment = false
): Promise<void> {
	const filePath = editor.document.uri.fsPath;
	const fileUri = editor.document.uri;
	const fileDir = path.dirname(filePath);
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);

	// 1. PEP 723 inline scripts  ─  `uv python find --script <file>`
	if (filePath.endsWith(".py") && hasPep723Metadata(filePath)) {
		const pythonPath = await uvPythonFindScript(filePath);
		if (pythonPath && fs.existsSync(pythonPath)) {
			await setInterpreter(
				envsApi,
				pythonApi,
				pythonPath,
				fileUri,
				workspaceFolder,
				"PEP 723 script",
				refreshEnvironment
			);
			return;
		}
	}

	// 2. Normal project  ─  `uv python find` from the file's directory
	const pythonPath = await uvPythonFind(fileDir);
	if (pythonPath && fs.existsSync(pythonPath)) {
		// For normal projects, scope to workspace folder (not individual file)
		const scope = workspaceFolder?.uri ?? fileUri;
		await setInterpreter(
			envsApi,
			pythonApi,
			pythonPath,
			scope,
			workspaceFolder,
			"project",
			refreshEnvironment
		);
	}
}

// ── Lifecycle ────────────────────────────────────────────────────────────

export async function activate(
	context: vscode.ExtensionContext
): Promise<void> {
	const pythonApi = await PythonExtension.api();

	// When python.useEnvironmentsExtension is on, debugpy reads from
	// python-envs while Pylance still reads from the classic API.  Since
	// nobody told these two extensions to talk to each other, we get the
	// privilege of writing to both.
	const envsApi = await getEnvsApi();
	if (envsApi) {
		log.info(
			"python.useEnvironmentsExtension is enabled — using python-envs API"
		);
	} else {
		log.info("Using classic ms-python.python API");
	}

	// Activate for the already-open editor
	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor && activeEditor.document.languageId === "python") {
		await setupPythonEnvironment(activeEditor, envsApi, pythonApi);
	}

	// Re-evaluate every time the user switches tabs, debounced to avoid
	// spawning unnecessary `uv` sub-processes during rapid tab cycling.
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	const onEditorChange = vscode.window.onDidChangeActiveTextEditor(
		(editor) => {
			if (debounceTimer) {
				clearTimeout(debounceTimer);
			}
			debounceTimer = setTimeout(() => {
				if (editor && editor.document.languageId === "python") {
					setupPythonEnvironment(editor, envsApi, pythonApi).catch(
						(err) => {
							console.error(
								"Failed to setup Python environment:",
								err
							);
						}
					);
				}
			}, 300);
		}
	);

	// Manual command
	const manualCmd = vscode.commands.registerCommand(
		"uv-auto-venv.reloadVenv",
		async () => {
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				await setupPythonEnvironment(editor, envsApi, pythonApi, true);
			} else {
				vscode.window.showWarningMessage(
					"uv-auto-venv: no active editor"
				);
			}
		}
	);

	context.subscriptions.push(onEditorChange, manualCmd);
}

export function deactivate(): void { }
