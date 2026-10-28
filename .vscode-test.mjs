import { defineConfig } from '@vscode/test-cli';
import { download, makeConsoleReporter, ProgressReportStage } from '@vscode/test-electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

// test-cli's extension installer ignores download.timeout. Prepare VS Code here
// so version resolution can tolerate slow responses without retrying test failures.
let version;
const consoleReporter = await makeConsoleReporter();
for (let attempt = 1; attempt <= 3; attempt++) {
    try {
        await download({
            timeout: 60_000,
            reporter: {
                report(progress) {
                    consoleReporter.report(progress);
                    if (progress.stage === ProgressReportStage.ResolvedVersion) {
                        version = progress.version;
                    }
                },
                error: error => consoleReporter.error(error),
            },
        });
        break;
    } catch (error) {
        if (attempt === 3) throw error;
        console.warn(`VS Code download failed (attempt ${attempt}/3); retrying:`, error);
    }
}

// Project registration writes workspace settings. Run each mode in its own fixture copy.
const workspaces = path.resolve('.vscode-test', 'workspaces');
fs.mkdirSync(workspaces, { recursive: true });

export default defineConfig([false, true].map(useEnvsExtension => {
    const label = useEnvsExtension ? 'python-envs' : 'classic';
    const workspaceFolder = fs.mkdtempSync(path.join(workspaces, `${label}-`));
    fs.cpSync(path.resolve('test-fixtures'), workspaceFolder, { recursive: true });
    fs.mkdirSync(path.join(workspaceFolder, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(workspaceFolder, '.vscode', 'settings.json'), JSON.stringify({
        'python.useEnvironmentsExtension': useEnvsExtension,
        'python.analysis.usePerProjectEnvironments': true,
        'python.terminal.activateEnvironment': false,
        'uv-auto-venv.showNotifications': false,
    }, null, 2));
    return {
        label,
        version,
        files: 'out/test/**/*.test.js',
        workspaceFolder,
        installExtensions: ['ms-python.vscode-python-envs', 'ms-python.vscode-pylance'],
        launchArgs: ['--disable-workspace-trust', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    };
}));
