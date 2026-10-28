import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { runInNewContext } from 'vm';
import * as cp from 'child_process';
import type * as vscode from 'vscode';

type Editor = vscode.TextEditor | undefined;

export function uri(fsPath: string): vscode.Uri {
	return { fsPath, scheme: 'file', toString: () => fsPath } as vscode.Uri;
}

export function editor(project: string, languageId = 'python'): vscode.TextEditor {
	return fileEditor(path.join('workspace', project, 'main.py'), languageId);
}

export function fileEditor(file: string, languageId = 'python'): vscode.TextEditor {
	return { document: { languageId, uri: uri(file) } } as vscode.TextEditor;
}

interface HarnessOptions {
	realUv?: boolean;
	env?: NodeJS.ProcessEnv;
	cacheDir?: string;
	workspaceRoot?: string;
	files?: Record<string, string>;
	projects?: string[];
	findPython?: (args: string[], cwd?: string) => Promise<string>;
	resolve?: boolean;
	envsInstalled?: boolean;
	persistProject?: (save: () => void) => void;
	refreshEnvironments?: () => Promise<void>;
	refreshEnvsEnvironments?: (scope: vscode.Uri | undefined) => Promise<void>;
	resolveEnvironment?: (environmentPath: vscode.Uri) => Promise<Environment | undefined>;
	selectClassic?: (interpreter: string) => Promise<void>;
}

interface Environment {
	envId: { id: string; managerId: string };
	environmentPath: vscode.Uri;
	version?: string;
}

/** Load the real extension in isolation, replacing only external APIs and uv. */
export async function activateExtension(useEnvsExtension: boolean, options: HarnessOptions = {}) {
	const lookups: string[] = [];
	const selections: { interpreter: string; scope: string }[] = [];
	const classicSelections: { interpreter: string; scope: string }[] = [];
	const registrations: string[] = [];
	const warnings: string[] = [];
	const savedProjects: { path: string }[] = [];
	const configListeners = new Set<() => void>();
	const projects = new Map<string, { name: string; uri: vscode.Uri }>();
	for (const p of [options.workspaceRoot, ...(options.projects ?? [])]) {
		if (p) {
			projects.set(p, { name: path.basename(p), uri: uri(p) });
		}
	}
	let onChange: ((editor: Editor) => void) | undefined;
	let manualCommand: (() => Promise<void>) | undefined;
	const selected = new Map<string, Environment>();
	const owner = (file: vscode.Uri | undefined) => file && [...projects.values()]
		.sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)
		.find(p => file.fsPath === p.uri.fsPath || file.fsPath.startsWith(p.uri.fsPath + path.sep));
	const pythonApi = {
		environments: {
			getActiveEnvironmentPath: () => ({ path: '' }),
			refreshEnvironments: async () => { await options.refreshEnvironments?.(); },
			updateActiveEnvironmentPath: async (interpreter: string, scope?: vscode.Uri) => {
				const selection = { interpreter, scope: scope?.fsPath ?? 'global' };
				classicSelections.push(selection);
				selections.push(selection);
				await options.selectClassic?.(interpreter);
			},
		},
	};
	const envsApi = {
		refreshEnvironments: async (scope?: vscode.Uri) => { await options.refreshEnvsEnvironments?.(scope); },
		resolveEnvironment: async (environmentPath: vscode.Uri) => options.resolveEnvironment
			? options.resolveEnvironment(environmentPath) : options.resolve === false ? undefined : ({
			envId: { id: environmentPath.fsPath, managerId: 'venv' }, environmentPath,
		}),
		getPythonProjects: () => [...projects.values()],
		getPythonProject: owner,
		addPythonProject: (project: { name: string; uri: vscode.Uri }) => {
			registrations.push(project.uri.fsPath);
			projects.set(project.uri.fsPath, project);
			const save = () => {
				savedProjects.push({ path: project.uri.fsPath });
				configListeners.forEach(listener => listener());
			};
			if (options.persistProject) {
				options.persistProject(save);
			} else {
				save();
			}
		},
		getEnvironment: async (scope?: vscode.Uri) => selected.get(owner(scope)?.uri.fsPath ?? 'global'),
		setEnvironment: async (scope: vscode.Uri | undefined, env: Environment) => {
			const target = owner(scope)?.uri.fsPath ?? 'global';
			selected.set(target, env);
			selections.push({ interpreter: env.environmentPath.fsPath, scope: target });
		},
	};
	const disposable = { dispose() {} };
	const window: { activeTextEditor: Editor; [key: string]: unknown } = {
		createOutputChannel: () => ({ info() {}, warn: (message: string) => warnings.push(message) }),
		activeTextEditor: undefined,
		onDidChangeActiveTextEditor: (listener: (editor: Editor) => void) => {
			assert.strictEqual(onChange, undefined, 'Register only one editor listener');
			onChange = listener;
			return disposable;
		},
	};
	const vscodeApi = {
		Uri: { file: uri }, window,
		workspace: {
			getConfiguration: () => ({ get: (key: string) => key === 'pythonProjects'
				? savedProjects : key === 'useEnvironmentsExtension' && useEnvsExtension }),
			onDidChangeConfiguration: (listener: () => void) => {
				configListeners.add(listener);
				return { dispose: () => configListeners.delete(listener) };
			},
			getWorkspaceFolder: (file: vscode.Uri) => {
				const root = options.workspaceRoot ?? path.dirname(file.fsPath);
				if (!projects.has(root)) {
					projects.set(root, { name: path.basename(root), uri: uri(root) });
				}
				return { name: path.basename(root), uri: uri(root) };
			},
		},
		extensions: { getExtension: () => options.envsInstalled === false ? undefined : ({ isActive: true, exports: envsApi }) },
		commands: {
			registerCommand: (_name: string, callback: () => Promise<void>) => {
				manualCommand = callback;
				return disposable;
			},
		},
	};
	let openFile = '';
	const execFile = Object.assign(() => assert.fail('Expected promisified execFile'), {
		[promisify.custom]: async (command: string, args: string[], execOptions?: { cwd: string }) => {
			assert.strictEqual(command, 'uv');
			if (args[0] === 'cache') {
				assert.deepStrictEqual(Array.from(args), ['cache', 'dir']);
				return { stdout: options.cacheDir ?? path.join(options.workspaceRoot ?? 'workspace', 'cache') };
			}
			lookups.push(args[2] === '--script' ? args[3] : execOptions!.cwd);
			if (options.findPython) {
				return { stdout: await options.findPython(Array.from(args), execOptions?.cwd) };
			}
			assert.deepStrictEqual(Array.from(args), ['python', 'find']);
			return { stdout: path.join(execOptions!.cwd, '.venv', 'python') + '\n' };
		},
	});
	const dependencies: Record<string, unknown> = {
		vscode: vscodeApi,
		'@vscode/python-extension': { PythonExtension: { api: async () => pythonApi } },
		child_process: options.realUv ? cp : { execFile },
		fs: options.realUv ? fs : {
			openSync: (file: string) => { openFile = file; return 0; },
			readSync: (_fd: number, buffer: Buffer) => buffer.write(options.files?.[openFile] ?? ''),
			closeSync() {},
			existsSync: (file: string) => options.files ? file in options.files : true,
		},
		path, util: { promisify },
	};
	const extension = { exports: {} as typeof import('../extension') };
	runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8'), {
		exports: extension.exports,
		require: (name: string) => {
			assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
			return dependencies[name];
		},
		Buffer, console, process: { env: options.env ?? process.env },
		setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
		clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
	});
	await extension.exports.activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
	assert.ok(onChange, 'Activation must register the editor-change handler');
	return {
		lookups, selections, classicSelections, registrations, warnings, envsApi,
		onChange: (editor: Editor) => { window.activeTextEditor = editor; onChange!(editor); },
		reload: async (editor: vscode.TextEditor) => { window.activeTextEditor = editor; await manualCommand!(); },
	};
}
