import { ChildProcess, SpawnOptions, spawn } from "child_process";
import * as fsp from "fs/promises";
import * as net from "net";
import { parseArgs } from "node:util";
import * as path from "path";

/**
 * Uniquely identifies a project folder for which development containers are
 * created. */
type Project = {
    workspaceFolder: string;
};

type Persistent = {
    appPort: number;
};

const persistPath = "~/.myspace";

async function main() {
    const { positionals } = parseArgs({ strict: false });
    const [workspaceFolder, action, ...args] = positionals;
    const project: Project = { workspaceFolder };
    switch (action !== undefined ? action.toLowerCase() : "") {
        case "up":
            await setUpContainer(project);
            break;
        case "tunnel":
            await runTunnel(project);
            break;
        case "local":
            const [forwardPort] = args;
            await runWebUi(project, forwardPort ? parseInt(forwardPort) : undefined);
            break;
        case "ext":
        case "extensions":
            await installExtensions(project);
            break;
        case "unregister":
            await unregisterTunnel(project);
            break;
        case "bash":
            await executeShell(project, "bash");
            break;
        default:
            console.log("Usage: myspace <project> (up | tunnel | local [forward_port] | extensions | unregister)");
            break;
    }
}

async function setUpContainer(project: Project) {
    const cliConfig = await Cli.readConfiguration(project);
    const appPort = randomAppPort();

    // Create the container. Expose the port for the web UI.
    const configFile = await fsp.open(cliConfig.configuration.configFilePath.path);
    const configText = (await fsp.readFile(configFile)).toString();
    const configJson = JSON.parse(configText.replace(/\/\/.*$/gm, ""));
    await configFile.close();
    await Cli.up(project, { ...configJson, appPort });

    // Create directory for persistent storage.
    await waitForChild(Cli.exec(project, ["sh", "-c", `mkdir -p ${persistPath}`]));
    await writePersistent(project, { appPort });

    // Download VS Code CLI.
    await waitForChild(
        Cli.exec(project, [
            "sh",
            "-c",
            `cd ${persistPath} && curl -L https://update.code.visualstudio.com/latest/cli-linux-x64/stable | tar xz`,
        ]),
    );

    // Insert custom settings JSON.
    const settings = cliConfig.configuration?.customizations?.vscode?.settings ?? {};
    await waitForChild(Cli.exec(project, ["sh", "-c", "mkdir -p ~/.vscode-server/data/Machine/"]));
    const saveSettings = Cli.exec(project, ["sh", "-c", "cat >~/.vscode-server/data/Machine/settings.json"], {
        stdio: ["pipe", "inherit", "inherit"],
    });
    saveSettings.stdin.write(JSON.stringify(settings));
    saveSettings.stdin.end();
    await waitForChild(saveSettings);
}

async function runTunnel(project: Project) {
    await waitForChild(Cli.exec(project, ["sh", "-c", `${persistPath}/code tunnel`]));
}

async function runWebUi(project: Project, forwardPort: number | undefined) {
    const { appPort } = await readPersistent(project);

    if (forwardPort !== undefined) {
        // App ports are only exposed to localhost, so spin up a simple port proxy.
        // https://stackoverflow.com/a/19637388
        net.createServer(from => {
            const to = net.createConnection({ port: appPort });
            from.on("error", to.destroy);
            from.pipe(to);
            to.on("error", from.destroy);
            to.pipe(from);
        }).listen(forwardPort);
        log("**", `Forwarding on port ${forwardPort} for access away from localhost.`, "**");
    }

    // TODO: It would be preferable to run with the connection token, but that
    // doesn't seem to play nice with the port proxy.
    await waitForChild(
        Cli.exec(project, [
            "sh",
            "-c",
            `${persistPath}/code serve-web  --host :: --port ${appPort} --without-connection-token`,
        ]),
    );
}

async function installExtensions(project: Project) {
    const config = await Cli.readConfiguration(project);
    const extensions: string[] = config.configuration?.customizations?.vscode?.extensions ?? [];
    if (extensions.length === 0) {
        return;
    }

    const codeServerFind = Cli.exec(project, ["sh", "-c", "find ~/.vscode -name code-server"], {
        stdio: ["ignore", "pipe", "inherit"],
    });
    const codeServerPath = (await waitForChildWithStdout(codeServerFind)).trim();
    if (!codeServerPath) {
        throw "code-server binary not found; have you connected from a browser yet?";
    }
    for (const ext of extensions) {
        await waitForChild(Cli.exec(project, [codeServerPath, "--install-extension", ext]));
    }
}

async function unregisterTunnel(project: Project) {
    await waitForChild(Cli.exec(project, ["sh", "-c", `${persistPath}/code tunnel unregister`]));
}

async function executeShell(project: Project, cmd: string, ...args: string[]) {
    await waitForChild(Cli.exec(project, [cmd, ...args]));
}

class Cli {
    private static readonly executableArgs: [string, string] = [
        process.argv[0],
        path.resolve(__dirname, "@devcontainers", "cli", "dist", "spec-node", "devContainersSpecCLI.js"),
    ];

    static async up(project: Project, overrideConfig: any) {
        // Need to use a shell because Node doesn't populate /dev/stdin...
        const child = Cli.spawnInShell(project, "up", ["--override-config", "/dev/stdin"], {
            stdio: ["pipe", "inherit", "inherit"],
        });
        child.stdin.write(JSON.stringify(overrideConfig));
        child.stdin.write("\n");
        child.stdin.end();
        await waitForChild(child);
    }

    static exec(project: Project, args: string[], options: SpawnOptions = {}) {
        return Cli.spawn(project, "exec", args, {
            detached: true,
            stdio: ["inherit", "inherit", "inherit"],
            ...options,
        });
    }

    static async readConfiguration(project: Project) {
        const child = Cli.spawn(project, "read-configuration", [], {
            stdio: ["ignore", "pipe", "inherit"],
        });
        const text = await waitForChildWithStdout(child);
        if (!text) {
            throw "unable to read dev container configuration; does this folder have one?";
        }
        return JSON.parse(text);
    }

    private static spawn(project: Project, command: string, args: string[], options: SpawnOptions) {
        const cliArgs = [command, ...Cli.projectArgs(project), ...args];
        log("devcontainer", ...cliArgs);

        // Don't use fork() here; it seems to break the exec command.
        const [node, modulePath] = Cli.executableArgs;
        return spawn(node, [modulePath, ...cliArgs], options);
    }

    private static spawnInShell(project: Project, command: string, args: string[], options: SpawnOptions) {
        const cliArgs = [command, ...Cli.projectArgs(project), ...args];
        log("devcontainer", ...cliArgs);

        const shell = escapeShell(...Cli.executableArgs, ...cliArgs);
        return spawn("sh", ["-c", "cat | " + shell], options);
    }

    private static projectArgs(project: Project) {
        return ["--workspace-folder", project.workspaceFolder];
    }
}

function randomAppPort() {
    const [first, last] = [49152, 65535];
    return Math.round((last - first) * Math.random()) + first;
}

async function writePersistent(project: Project, data: Persistent) {
    const doWrite = Cli.exec(project, ["sh", "-c", `cat >${persistPath}/persist.json`], {
        stdio: ["pipe", "inherit", "inherit"],
    });
    doWrite.stdin.write(JSON.stringify(data));
    doWrite.stdin.end();
    await waitForChild(doWrite);
}

async function readPersistent(project: Project) {
    const doRead = Cli.exec(project, ["sh", "-c", `cat ${persistPath}/persist.json`], {
        stdio: ["inherit", "pipe", "inherit"],
    });
    const text = await waitForChildWithStdout(doRead);
    return JSON.parse(text) as Persistent;
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
