import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { PythonExtension } from "@vscode/python-extension";

const execFileAsync = promisify(execFile);

/**
 * Check if a .py file contains PEP 723 inline script metadata.
 * Looks for a line matching: # /// script
 */
function hasPep723Metadata(filePath: string): boolean {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		return /^# \/\/\/ script\s*$/m.test(content);
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
	} catch {
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
	} catch {
		return null;
	}
}

/**
 * Attempt to set the active Python interpreter for the given workspace folder.
 */
async function setInterpreter(
	pythonApi: PythonExtension,
	pythonPath: string,
	workspaceFolder: vscode.WorkspaceFolder | undefined,
	label: string,
	refreshEnvironment = false
): Promise<void> {
	const config = vscode.workspace.getConfiguration("uv-auto-venv");
	const showNotifications = config.get<boolean>("showNotifications", true);

	const currentEnv = pythonApi.environments.getActiveEnvironmentPath(
		workspaceFolder?.uri
	);
	if (refreshEnvironment) {
		await pythonApi.environments.refreshEnvironments();
		await pythonApi.environments.updateActiveEnvironmentPath(
			"",
			workspaceFolder?.uri
		);
	}
	else if (currentEnv.path === pythonPath) {
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
	pythonApi: PythonExtension,
	refreshEnvironment = false
): Promise<void> {
	const filePath = editor.document.uri.fsPath;
	const fileDir = path.dirname(filePath);
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(
		editor.document.uri
	);

	// 1. PEP 723 inline scripts  ─  `uv python find --script <file>`
	if (filePath.endsWith(".py") && hasPep723Metadata(filePath)) {
		const pythonPath = await uvPythonFindScript(filePath);
		if (pythonPath && fs.existsSync(pythonPath)) {
			await setInterpreter(
				pythonApi,
				pythonPath,
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
		await setInterpreter(
			pythonApi,
			pythonPath,
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

	// Activate for the already-open editor
	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor && activeEditor.document.uri.fsPath.endsWith(".py")) {
		await setupPythonEnvironment(activeEditor, pythonApi);
	}

	// Re-evaluate every time the user switches tabs
	const onEditorChange = vscode.window.onDidChangeActiveTextEditor(
		async (editor) => {
			if (editor && editor.document.uri.fsPath.endsWith(".py")) {
				await setupPythonEnvironment(editor, pythonApi);
			}
		}
	);

	// Manual command
	const manualCmd = vscode.commands.registerCommand(
		"uv-auto-venv.reloadVenv",
		async () => {
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				await setupPythonEnvironment(editor, pythonApi, true);
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
