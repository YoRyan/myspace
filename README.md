# myspace

myspace is GitHub Codespaces but self-hosted. It builds development containers using the [Dev Container CLI](https://github.com/devcontainers/cli) and injects the [Visual Studio Code Server](https://code.visualstudio.com/docs/remote/vscode-server) for access via browser or through a [vscode.dev](https://vscode.dev) tunnel.

It retains all of your Visual Studio Code tooling and preferences.

It has no dependencies (except for the Dev Container CLI, which itself has no dependencies), so it's easy to deploy on lightweight container hosts like Flatcar Linux and Fedora CoreOS.

And, most importantly, it lets you combine the convenience of Codespaces with the power of the hardware you already own.

## Build it

```sh
npm run build
```

```sh
./out/myspace help
```

## Use it

Start a project:

```sh
git clone https://github.com/microsoft/vscode-remote-try-python.git ~/Projects/vscode-remote-try-python
```

Spin up the container:

```sh
myspace ~/Projects/vscode-remote-try-python/ up
```

Authenticate with GitHub, create the tunnel:

```sh
myspace ~/Projects/vscode-remote-try-python/ tunnel
```

Or try the standalone web server to bypass the latency of a vscode.dev tunnel:

```sh
myspace ~/Projects/vscode-remote-try-python/ local 8000
# Web UI is available at http://0.0.0.0:8000
```

Upon connecting with a browser using either method, the container will download code-server. Once that happens, you will be able to install any extensions defined in devcontainer.json:

```sh
myspace ~/Projects/vscode-remote-try-python/ extensions
```

If you're using a tunnel and have finished working, you can disconnect it to free one of your five slots:

```sh
myspace ~/Projects/vscode-remote-try-python/ unregister
```
