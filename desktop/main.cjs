/**
 * nixamp for the desktop.
 *
 * The window is the PWA, and what it talks to is a real `nixamp serve` running
 * as a child of this process — so the desktop app is the browser player, the
 * terminal player's engine, and the remote-control server, all at once.
 *
 * The CLI travels inside the bundle and is run by Electron's own Node
 * (ELECTRON_RUN_AS_NODE), which is the point: installing the desktop app
 * installs a working nixamp without a system Node anywhere near it.
 */
"use strict";

const { app, BrowserWindow, Menu, dialog, shell, clipboard } = require("electron");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { existsSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const isDev = !app.isPackaged;

/** Where the bundled CLI lives, packaged or straight out of the repo. */
function resources() {
  const root = isDev ? join(__dirname, "..") : join(process.resourcesPath, "cli");
  return {
    serveEntry: join(root, "dist", "serve.js"),
    cliEntry: join(root, "dist", "main.js"),
    bin: join(root, "bin", "nixamp.mjs"),
    web: join(root, "web", "dist"),
  };
}

/** A port nobody is using, asked for rather than guessed. */
function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

let child = null;
let window = null;
let port = 0;
let library = process.env.NIXAMP_LIBRARY || join(homedir(), "Music");

function startServer(root) {
  const { serveEntry, web } = resources();
  if (!existsSync(serveEntry)) {
    throw new Error(`the bundled CLI is missing (${serveEntry}) — run \`bun run build\` first`);
  }
  const args = [serveEntry, root, "--port", String(port), "--host", "127.0.0.1"];
  if (existsSync(web)) args.push("--web", web);

  const proc = spawn(process.execPath, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (chunk) => process.stdout.write(`[nixamp] ${chunk}`));
  proc.stderr.on("data", (chunk) => process.stderr.write(`[nixamp] ${chunk}`));
  proc.on("exit", (code) => {
    if (code !== 0 && code !== null && !app.isQuitting) {
      dialog.showErrorBox("nixamp", `The player stopped unexpectedly (exit ${code}).`);
    }
  });
  return proc;
}

/** Wait for the server to answer, rather than racing it with a fixed delay. */
async function waitForServer(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
}

async function restart(root) {
  library = root;
  child?.kill();
  child = startServer(root);
  const url = `http://127.0.0.1:${port}`;
  await waitForServer(url);
  await window?.loadURL(url);
}

async function chooseLibrary() {
  const chosen = await dialog.showOpenDialog({
    title: "Choose a music folder",
    defaultPath: library,
    properties: ["openDirectory"],
  });
  if (!chosen.canceled && chosen.filePaths[0]) await restart(chosen.filePaths[0]);
}

function buildMenu() {
  const { bin } = resources();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "nixamp",
      submenu: [
        { label: "Open Music Folder…", accelerator: "CmdOrCtrl+O", click: () => void chooseLibrary() },
        { label: "Reload Player", accelerator: "CmdOrCtrl+R", click: () => window?.reload() },
        { type: "separator" },
        {
          label: "Copy Bundled CLI Path",
          // The bundle carries the CLI; this is how a person finds it.
          click: () => {
            clipboard.writeText(`ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${bin}"`);
          },
        },
        { type: "separator" },
        { role: "toggleDevTools" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "Help",
      submenu: [
        { label: "nixamp on GitHub", click: () => void shell.openExternal("https://github.com/profullstack/nixamp") },
        { label: "nixamp.com", click: () => void shell.openExternal("https://nixamp.com") },
      ],
    },
  ]));
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 380,
    minHeight: 420,
    backgroundColor: "#080c09",
    title: "nixamp",
    autoHideMenuBar: process.platform !== "darwin",
    icon: join(__dirname, "build", "icon.png"),
    webPreferences: {
      // The page is our own PWA served over loopback; it needs no privileges.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Anything that is not our own server opens in the real browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const url = `http://127.0.0.1:${port}`;
  if (!(await waitForServer(url))) {
    dialog.showErrorBox("nixamp", "The player did not start listening. Is another copy already running?");
  }
  await window.loadURL(url);
  window.on("closed", () => { window = null; });
}

app.whenReady().then(async () => {
  try {
    port = await freePort();
    child = startServer(library);
  } catch (error) {
    dialog.showErrorBox("nixamp", String(error && error.message ? error.message : error));
    app.quit();
    return;
  }
  buildMenu();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("before-quit", () => { app.isQuitting = true; });
app.on("will-quit", () => { child?.kill(); });
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
