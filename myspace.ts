import { ChildProcess, SpawnOptions, spawn } from "child_process";
import { parseArgs } from "node:util";
import * as path from "path";

/** Uniquely identifies a development project. */
type Project = {
    workspaceFolder: string;
};

async function main() {
    const { positionals } = parseArgs({ strict: false });
    const [workspaceFolder, action] = positionals;
    const cli = new Cli({ workspaceFolder });
    switch (action !== undefined ? action.toLowerCase() : "") {
        case "up":
            await setUpContainer(cli);
            break;
        case "tunnel":
            await runTunnel(cli);
            break;
        case "ext":
        case "extensions":
            await installExtensions(cli);
            break;
        case "unregister":
            await unregisterTunnel(cli);
            break;
        case "bash":
            await executeShell(cli, "bash");
            break;
        default:
            console.log("Usage: myspace <project> (up | tunnel | extensions | unregister)");
            break;
    }
}

async function setUpContainer(cli: Cli) {
    // Create the container.
    await cli.up();

    // Download VS Code CLI.
    await waitForChild(
        cli.exec([
            "sh",
            "-c",
            "cd && curl -L https://update.code.visualstudio.com/latest/cli-linux-x64/stable | tar xz",
        ]),
    );

    // Insert custom settings JSON.
    const config = await cli.readConfiguration();
    const settings = config.configuration?.customizations?.vscode?.settings ?? {};
    await waitForChild(cli.exec(["sh", "-c", "mkdir -p ~/.vscode-server/data/Machine/"]));
    const saveSettings = cli.exec(["sh", "-c", "cat >~/.vscode-server/data/Machine/settings.json"], {
        stdio: ["pipe", "inherit", "inherit"],
    });
    saveSettings.stdin.write(JSON.stringify(settings));
    saveSettings.stdin.end();
    await waitForChild(saveSettings);
}

async function runTunnel(cli: Cli) {
    await waitForChild(cli.exec(["sh", "-c", "~/code tunnel"]));
}

async function installExtensions(cli: Cli) {
    const config = await cli.readConfiguration();
    const extensions: string[] = config.configuration?.customizations?.vscode?.extensions ?? [];
    if (extensions.length === 0) {
        return;
    }

    const codeServerFind = cli.exec(["sh", "-c", "find ~/.vscode -name code-server"], {
        stdio: ["ignore", "pipe", "inherit"],
    });
    const codeServerPath = (await waitForChildWithStdout(codeServerFind)).trim();
    if (!codeServerPath) {
        throw "code-server binary not found; have you created a tunnel yet?";
    }
    for (const ext of extensions) {
        await waitForChild(cli.exec([codeServerPath, "--install-extension", ext]));
    }
}

async function unregisterTunnel(cli: Cli) {
    await waitForChild(cli.exec(["sh", "-c", "~/code tunnel unregister"]));
}

async function executeShell(cli: Cli, cmd: string, ...args: string[]) {
    await waitForChild(cli.exec([cmd, ...args]));
}

class Cli {
    private static nodePath = process.argv[0];
    private static modulePath = path.resolve(
        __dirname,
        "@devcontainers",
        "cli",
        "dist",
        "spec-node",
        "devContainersSpecCLI.js",
    );

    private workspaceFolder: [string, string];

    constructor(project: Project) {
        this.workspaceFolder = ["--workspace-folder", project.workspaceFolder];
    }

    async up() {
        const child = Cli.spawn(["up", ...this.workspaceFolder], { stdio: ["ignore", "inherit", "inherit"] });
        await waitForChild(child);
    }

    exec(args: string[], options: SpawnOptions = {}) {
        return Cli.spawn(["exec", ...this.workspaceFolder, ...args], {
            detached: true,
            stdio: ["inherit", "inherit", "inherit"],
            ...options,
        });
    }

    async readConfiguration() {
        const child = Cli.spawn(["read-configuration", ...this.workspaceFolder], {
            stdio: ["ignore", "pipe", "inherit"],
        });
        const text = await waitForChildWithStdout(child);
        return JSON.parse(text);
    }

    private static spawn(args: string[], options: SpawnOptions) {
        console.error("<**>", "devcontainer", ...args);

        // Don't use fork() here; it seems to break the exec command.
        return spawn(Cli.nodePath, [Cli.modulePath, ...args], options);
    }
}

async function waitForChildWithStdout(child: ChildProcess) {
    let data = "";
    child.stdout.on("data", chunk => {
        data += chunk;
    });
    await waitForChild(child);
    return data;
}

async function waitForChild(child: ChildProcess) {
    await new Promise((resolve, reject) => {
        child.on("close", resolve);
        child.on("error", reject);
    });
}

main();
