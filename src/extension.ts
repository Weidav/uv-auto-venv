import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { PythonExtension } from "@vscode/python-extension";
import type { PythonEnvironmentApi } from "@vscode/python-environments";

const execFileAsync = promisify(execFile);

const log = vscode.window.createOutputChannel("uv Auto venv", { log: true });

// ── Testing instrumentation ─────────────────────────────────────────────

let setupCallCount = 0;

export interface TestingApi {
	/** Number of times setupPythonEnvironment has been called. */
	getSetupCallCount(): number;
	/** Reset the counter (call before a test scenario). */
	resetSetupCallCount(): void;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Check whether the user has opted into the new Python Environments
 * extension (`ms-python.vscode-python-envs`).
 */
function useEnvsExtension(): boolean {
	const config = vscode.workspace.getConfiguration("python");
	return config.get<boolean>("useEnvironmentsExtension", false);
}

/**
 * Try to acquire the python-envs API.  Returns `undefined` when the
 * extension is not installed or the setting is off.
 */
async function getEnvsApi(): Promise<PythonEnvironmentApi | undefined> {
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
	return api as PythonEnvironmentApi;
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
 * interpreter is set through the new python-envs API which supports
 * per-file scope — exactly what PEP 723 inline scripts need, and what
 * debugpy / Pylance actually read when that flag is enabled.
 *
 * Falls back to the classic `updateActiveEnvironmentPath` otherwise.
 */
async function setInterpreter(
	envsApi: PythonEnvironmentApi | undefined,
	pythonApi: PythonExtension,
	pythonPath: string,
	fileUri: vscode.Uri,
	workspaceFolder: vscode.WorkspaceFolder | undefined,
	label: string,
	refreshEnvironment = false
): Promise<void> {
	const config = vscode.workspace.getConfiguration("uv-auto-venv");
	const showNotifications = config.get<boolean>("showNotifications", true);

	// ── python-envs path (preferred when available) ─────────────────────
	if (envsApi) {
		try {
			const env = await envsApi.resolveEnvironment(
				vscode.Uri.file(pythonPath)
			);

			if (env) {
				// Skip if already set (unless forced refresh)
				if (!refreshEnvironment) {
					const current = await envsApi.getEnvironment(fileUri);
					if (current?.envId.id === env.envId.id) {
						return;
					}
				}

				await envsApi.setEnvironment(fileUri, env);
				log.info(
					`[python-envs] ${label} interpreter set to ${env.environmentPath.fsPath} (scope: ${fileUri.fsPath})`
				);

				if (showNotifications) {
					const displayPath = workspaceFolder
						? path.relative(
							workspaceFolder.uri.fsPath,
							env.environmentPath.fsPath
						)
						: env.environmentPath.fsPath;
					const folderSuffix = workspaceFolder
						? ` for ${workspaceFolder.name}`
						: "";
					vscode.window.showInformationMessage(
						`uv-auto-venv: ${label} interpreter set to ${displayPath}${folderSuffix}`
					);
				}
				return;
			}

			log.warn(
				`python-envs could not resolve ${pythonPath}; falling back to classic API`
			);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			log.warn(
				`python-envs setEnvironment failed: ${message}; falling back to classic API`
			);
		}
	}

	// ── classic path (workspace-folder scope) ────────────────────────────
	const currentEnv = pythonApi.environments.getActiveEnvironmentPath(
		workspaceFolder?.uri
	);
	if (refreshEnvironment) {
		await pythonApi.environments.refreshEnvironments();
		// Clear cached path first so the update is not treated as a no-op
		await pythonApi.environments.updateActiveEnvironmentPath(
			"",
			workspaceFolder?.uri
		);
	} else if (currentEnv.path === pythonPath) {
		return; // already set
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
	envsApi: PythonEnvironmentApi | undefined,
	pythonApi: PythonExtension,
	refreshEnvironment = false
): Promise<void> {
	setupCallCount++;
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
): Promise<TestingApi> {
	const pythonApi = await PythonExtension.api();

	// When python.useEnvironmentsExtension is on, debugpy and Pylance read
	// the interpreter from ms-python.vscode-python-envs instead of the
	// classic ms-python.python API.  Acquire the new API so we write to
	// the channel that is actually being read.
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

	return {
		getSetupCallCount: () => setupCallCount,
		resetSetupCallCount: () => { setupCallCount = 0; },
	};
}

export function deactivate(): void { }
