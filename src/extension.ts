import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { PythonExtension } from "@vscode/python-extension";
import type { PythonEnvironmentApi } from "@vscode/python-environments";
import type * as Toml from "smol-toml" with { "resolution-mode": "import" };

// smol-toml shares ESM declarations with its CommonJS entry point.
const { parse: parseToml }: typeof Toml = require("smol-toml");
const execFileAsync = promisify(execFile);

const log = vscode.window.createOutputChannel("uv Auto venv", { log: true });

// ── Helpers ──────────────────────────────────────────────────────────────

/** Run the callback once changes have stopped for the given delay. */
function debounce<T>(callback: (value: T) => void, delay: number): (value: T) => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return (value) => {
		clearTimeout(timer);
		timer = setTimeout(() => callback(value), delay);
	};
}

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
		const options = { cwd: path.dirname(filePath), env: process.env };
		const cacheArgs = ["cache", "dir"];
		// `uv cache dir` cannot read inline settings; supply the script's cache override.
		// Environment variables take precedence over inline configuration in uv.
		if (!process.env.UV_CACHE_DIR) {
			const block = fs.readFileSync(filePath, "utf8")
				.match(/^# \/\/\/ script[ \t]*\r?\n((?:#(?: .*)?\r?\n)*?)# \/\/\/[ \t]*\r?$/m);
			if (block) {
				const metadata = parseToml(block[1].split(/\r?\n/).map(line => line.slice(2)).join("\n")) as {
					tool?: { uv?: { "cache-dir"?: string } };
				};
				const cacheDir = metadata.tool?.uv?.["cache-dir"];
				if (typeof cacheDir === "string") {
					cacheArgs.push("--cache-dir", cacheDir);
				}
			}
		}
		const [{ stdout }, { stdout: cacheDir }] = await Promise.all([
			execFileAsync("uv", ["python", "find", "--script", filePath], options),
			execFileAsync("uv", cacheArgs, options),
		]);
		const pythonPath = stdout.trim();
		const cachePath = cacheDir.trim() ? path.resolve(options.cwd, cacheDir.trim()) : "";
		const relativePath = path.relative(cachePath, pythonPath);
		// Without a cached script environment, uv can return base Python or a project's .venv.
		if (!pythonPath || !cachePath || path.isAbsolute(relativePath)
			|| relativePath === ".." || relativePath.startsWith(".." + path.sep)
			|| !fs.existsSync(path.join(path.dirname(path.dirname(pythonPath)), "pyvenv.cfg"))) {
			log.warn(`No cached environment found for script ${filePath}; keeping the current environment`);
			return null;
		}
		return pythonPath;
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
		// An environment inherited from the shell must not override this project's .venv.
		const env = { ...process.env };
		for (const key of Object.keys(env)) {
			if (["VIRTUAL_ENV", "CONDA_PREFIX"].includes(key.toUpperCase())) {
				delete env[key];
			}
		}
		const { stdout } = await execFileAsync("uv", ["python", "find"], {
			cwd,
			env,
		});
		return stdout.trim() || null;
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		log.warn(`uv python find failed in ${cwd}: ${message}`);
		return null;
	}
}

/** Find the nearest project marker without registering directories outside the workspace. */
function findProjectRoot(fileDir: string, workspaceFolder: vscode.WorkspaceFolder): vscode.Uri | undefined {
	let directory = fileDir;
	const workspacePath = workspaceFolder.uri.fsPath;
	while (true) {
		if (fs.existsSync(path.join(directory, "pyproject.toml"))) {
			return vscode.Uri.file(directory);
		}
		if (directory === workspacePath || path.dirname(directory) === directory) {
			return undefined;
		}
		directory = path.dirname(directory);
	}
}

let interpreterUpdate = Promise.resolve();

/** Serialize mutations so a slow selection cannot overwrite a newer one. */
function setInterpreter(...args: Parameters<typeof applyInterpreter>): Promise<void> {
	const update = interpreterUpdate.then(() => applyInterpreter(...args));
	interpreterUpdate = update.catch(err => log.warn(`Interpreter update failed: ${err}`));
	return update;
}

/** The public registration API returns void before its settings write finishes. */
async function registerPythonProject(
	api: PythonEnvironmentApi,
	projectUri: vscode.Uri,
	workspaceFolder: vscode.WorkspaceFolder
): Promise<void> {
	if (api.getPythonProjects().some(project => project.uri.toString() === projectUri.toString())) {
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const isSaved = () => vscode.workspace.getConfiguration("python-envs", projectUri)
			.get<{ path: string; workspace?: string }[]>("pythonProjects", [])
			.some(project => (!project.workspace || project.workspace === workspaceFolder.name)
				&& path.resolve(workspaceFolder.uri.fsPath, project.path) === projectUri.fsPath);
		const subscription = vscode.workspace.onDidChangeConfiguration(() => check());
		const timer = setTimeout(() => finish(new Error(`Timed out saving project ${projectUri.fsPath}`)), 10000);
		function finish(error?: Error) {
			clearTimeout(timer);
			subscription.dispose();
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		}
		function check() {
			if (isSaved()) {
				finish();
			}
		}
		try {
			api.addPythonProject({ name: path.basename(projectUri.fsPath), uri: projectUri });
			check();
		} catch (error) {
			finish(error instanceof Error ? error : new Error(String(error)));
		}
	});
	log.info(`[python-envs] Registered project ${projectUri.fsPath}`);
}

/**
 * Assign a regular project or switch the shared script scope through python-envs.
 * Classic mode keeps selecting the interpreter for the workspace folder.
 */
async function applyInterpreter(
	envsApi: PythonEnvironmentApi | undefined,
	pythonApi: PythonExtension,
	pythonPath: string,
	scope: vscode.Uri | undefined,
	workspaceFolder: vscode.WorkspaceFolder | undefined,
	label: string,
	refreshEnvironment = false,
	registerProject = false,
	isCurrent = () => true
): Promise<void> {
	const config = vscode.workspace.getConfiguration("uv-auto-venv");
	const showNotifications = config.get<boolean>("showNotifications", true);

	// ── python-envs path (preferred when available) ─────────────────────
	if (envsApi) {
		try {
			if (!isCurrent()) {
				return;
			}
			if (refreshEnvironment) {
				await envsApi.refreshEnvironments(scope);
				if (!isCurrent()) {
					return;
				}
			}
			const env = await envsApi.resolveEnvironment(
				vscode.Uri.file(pythonPath)
			);

			if (!isCurrent()) {
				return;
			}

			if (env) {
				if (registerProject && scope && workspaceFolder) {
					await registerPythonProject(envsApi, scope, workspaceFolder);
				}

				// Skip if already set (unless forced refresh)
				if (!refreshEnvironment) {
					const current = await envsApi.getEnvironment(scope);
					if (current?.envId.id === env.envId.id && current?.envId.managerId === env.envId.managerId) {
						return;
					}
				}

				if (!isCurrent()) {
					return;
				}
				await envsApi.setEnvironment(scope, env);
				log.info(
					`[python-envs] ${label} interpreter set to ${env.environmentPath.fsPath} (scope: ${scope?.fsPath ?? "global"})`
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

			log.warn(`python-envs could not resolve ${pythonPath}; keeping the current environment`);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			log.warn(
				`python-envs setEnvironment failed: ${message}; keeping the current environment`
			);
		}
		// A classic fallback here would overwrite the shared workspace selection.
		return;
	}

	// ── classic path (workspace-folder scope) ────────────────────────────
	if (!isCurrent()) {
		return;
	}
	const currentEnv = pythonApi.environments.getActiveEnvironmentPath(
		workspaceFolder?.uri
	);
	if (refreshEnvironment) {
		await pythonApi.environments.refreshEnvironments();
		if (!isCurrent()) {
			return;
		}
		// Clear cached path first so the update is not treated as a no-op
		await pythonApi.environments.updateActiveEnvironmentPath(
			"",
			workspaceFolder?.uri
		);
	} else if (currentEnv.path === pythonPath) {
		return; // already set
	}

	// Once clearing starts, finish reapplying. Newer selections wait in the mutation queue.
	if (!refreshEnvironment && !isCurrent()) {
		return;
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
	refreshEnvironment = false,
	isCurrent = () => true
): Promise<void> {
	if (editor.document.uri.scheme !== "file") {
		return;
	}
	const filePath = editor.document.uri.fsPath;
	const fileUri = editor.document.uri;
	const fileDir = path.dirname(filePath);
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);

	// 1. PEP 723 inline scripts  ─  `uv python find --script <file>`
	if (filePath.endsWith(".py") && hasPep723Metadata(filePath)) {
		// Use the owning folder's shared selection, never create a per-script project.
		const owner = envsApi?.getPythonProject(fileUri);
		const scope = owner?.uri ?? workspaceFolder?.uri;
		if (envsApi && scope && fs.existsSync(path.join(scope.fsPath, "pyproject.toml"))) {
			log.warn(
				`PEP 723 script ${filePath} is inside the regular project ${scope.fsPath}; ` +
				"move scripts to a separate scope to keep the project's environment fixed"
			);
			return;
		}
		const pythonPath = await uvPythonFindScript(filePath);
		if (pythonPath && fs.existsSync(pythonPath) && isCurrent()) {
			await setInterpreter(
				envsApi,
				pythonApi,
				pythonPath,
				scope,
				workspaceFolder,
				"PEP 723 script",
				refreshEnvironment,
				false,
				isCurrent
			);
		}
		// A failed script lookup must not select the containing project's interpreter.
		return;
	}

	// 2. Normal project  ─  `uv python find` from the file's directory
	const pythonPath = await uvPythonFind(fileDir);
	if (pythonPath && fs.existsSync(pythonPath) && isCurrent()) {
		const projectRoot = envsApi && workspaceFolder ? findProjectRoot(fileDir, workspaceFolder) : undefined;
		const scope = projectRoot ?? envsApi?.getPythonProject(fileUri)?.uri ?? workspaceFolder?.uri;
		await setInterpreter(
			envsApi,
			pythonApi,
			pythonPath,
			scope,
			workspaceFolder,
			"project",
			refreshEnvironment,
			projectRoot !== undefined,
			isCurrent
		);
	}
}

// ── Lifecycle ────────────────────────────────────────────────────────────

export async function activate(
	context: vscode.ExtensionContext
): Promise<void> {
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

	// Re-evaluate every time the user switches tabs, debounced to avoid
	// spawning unnecessary `uv` sub-processes during rapid tab cycling.
	let editorVersion = 0;
	const onDebouncedEditorChange = debounce(({ editor, version }: {
		editor: vscode.TextEditor | undefined; version: number;
	}) => {
		if (editor && editor.document.languageId === "python") {
			setupPythonEnvironment(editor, envsApi, pythonApi, false, () => version === editorVersion).catch(
				(err) => {
					log.warn(`Failed to setup Python environment: ${err}`);
				}
			);
		}
	}, 300);
	const onEditorChange = vscode.window.onDidChangeActiveTextEditor(
		editor => onDebouncedEditorChange({ editor, version: ++editorVersion })
	);

	// Manual command
	const manualCmd = vscode.commands.registerCommand(
		"uv-auto-venv.reloadVenv",
		async () => {
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				const version = ++editorVersion;
				await setupPythonEnvironment(editor, envsApi, pythonApi, true, () => version === editorVersion);
			} else {
				vscode.window.showWarningMessage(
					"uv-auto-venv: no active editor"
				);
			}
		}
	);

	context.subscriptions.push(onEditorChange, manualCmd);

	// Listen for tab changes before starting the initial lookup so it can become stale too.
	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor && activeEditor.document.languageId === "python") {
		const version = editorVersion;
		await setupPythonEnvironment(activeEditor, envsApi, pythonApi, false, () => version === editorVersion);
	}
}

export function deactivate(): void { }
