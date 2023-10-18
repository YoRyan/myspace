import { ChildProcess, SpawnOptions, spawn } from "child_process";
import * as fsp from "fs/promises";
import * as net from "net";
import { parseArgs } from "node:util";
import * as path from "path";

/** Uniquely identifies a development project. */
type Project = {
    workspaceFolder: string;
};

const webUiPort = 7999;
const webUiForwardPort = 8000;

async function main() {
    const { positionals } = parseArgs({ strict: false });
    const [workspaceFolder, action] = positionals;
    const cli = new Cli({ workspaceFolder });
    switch (action !== undefined ? action.toLowerCase() : "") {
        case "up":
            await setUpContainer(cli, webUiPort);
            break;
        case "tunnel":
            await runTunnel(cli);
            break;
        case "local":
            await runWebUi(cli, webUiPort, webUiForwardPort);
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
            console.log("Usage: myspace <project> (up | tunnel | local | extensions | unregister)");
            break;
    }
}

async function setUpContainer(cli: Cli, appPort: number) {
    const cliConfig = await cli.readConfiguration();

    // Create the container. Expose the port for the web UI.
    const configFile = await fsp.open(cliConfig.configuration.configFilePath.path);
    const configText = (await fsp.readFile(configFile)).toString();
    const configJson = JSON.parse(configText.replace(/\/\/.*$/gm, ""));
    await configFile.close();
    await cli.up({ ...configJson, appPort });

    // Download VS Code CLI.
    await waitForChild(
        cli.exec([
            "sh",
            "-c",
            "cd && curl -L https://update.code.visualstudio.com/latest/cli-linux-x64/stable | tar xz",
        ]),
    );

    // Insert custom settings JSON.
    const settings = cliConfig.configuration?.customizations?.vscode?.settings ?? {};
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

async function runWebUi(cli: Cli, port: number, forwardPort: number) {
    // App ports are only exposed to localhost, so spin up a simple port proxy.
    // https://stackoverflow.com/a/19637388
    net.createServer(from => {
        const to = net.createConnection({ port });
        from.on("error", to.destroy);
        from.pipe(to);
        to.on("error", from.destroy);
        to.pipe(from);
    }).listen(webUiForwardPort);
    log("**", `Forwarding on port ${forwardPort} for access away from localhost.`, "**");

    await waitForChild(cli.exec(["sh", "-c", `~/code serve-web --host :: --port ${port}`]));
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
    public readonly project: Project;

    private static readonly nodePath = process.argv[0];
    private static readonly modulePath = path.resolve(
        __dirname,
        "@devcontainers",
        "cli",
        "dist",
        "spec-node",
        "devContainersSpecCLI.js",
    );
    private readonly projectOptions: string[];

    constructor(project: Project) {
        this.project = project;
        this.projectOptions = ["--workspace-folder", project.workspaceFolder];
    }

    async up(overrideConfig: any) {
        // Need to use a shell because Node doesn't populate /dev/stdin...
        const child = Cli.spawnInShell(["up", ...this.projectOptions, "--override-config", "/dev/stdin"], {
            stdio: ["pipe", "inherit", "inherit"],
        });
        child.stdin.write(JSON.stringify(overrideConfig));
        child.stdin.write("\n");
        child.stdin.end();
        await waitForChild(child);
    }

    exec(args: string[], options: SpawnOptions = {}) {
        return Cli.spawn(["exec", ...this.projectOptions, ...args], {
            detached: true,
            stdio: ["inherit", "inherit", "inherit"],
            ...options,
        });
    }

    async readConfiguration() {
        const child = Cli.spawn(["read-configuration", ...this.projectOptions], {
            stdio: ["ignore", "pipe", "inherit"],
        });
        const text = await waitForChildWithStdout(child);
        if (!text) {
            throw "unable to read dev container configuration; does this workspace have one?";
        }
        return JSON.parse(text);
    }

    private static spawn(args: string[], options: SpawnOptions) {
        log("devcontainer", ...args);

        // Don't use fork() here; it seems to break the exec command.
        return spawn(Cli.nodePath, [Cli.modulePath, ...args], options);
    }

    private static spawnInShell(args: string[], options: SpawnOptions) {
        log("devcontainer", ...args);

        const shell = escapeShell(Cli.nodePath, Cli.modulePath, ...args);
        return spawn("sh", ["-c", "tee /dev/null | " + shell], options);
    }
}

function escapeShell(...args: string[]) {
    return args.map(a => `'${a.replaceAll("'", "'\\''")}'`).join(" ");
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

function log(...message: any[]) {
    console.error("+", ...message);
}

main();
