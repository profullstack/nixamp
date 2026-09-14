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

const { app, BrowserWindow, Menu, dialog, shell, clipboard, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { pathToFileURL } = require("node:url");
const { homedir } = require("node:os");
const { join } = require("node:path");

const isDev = !app.isPackaged;

/** Where the bundled CLI lives, packaged or straight out of the repo. */
function resources() {
  const root = isDev ? join(__dirname, "..") : join(process.resourcesPath, "cli");
  return {
    locale: join(root, "dist", "i18n.js"),
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

let locale;
const message = (source) => locale ? locale.t(source) : source;
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
    title: message("Open folder"),
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
        { label: message("Open folder"), accelerator: "CmdOrCtrl+O", click: () => void chooseLibrary() },
        { label: message("Reload Player"), accelerator: "CmdOrCtrl+R", click: () => window?.reload() },
        { type: "separator" },
        {
          label: message("Copy Bundled CLI Path"),
          // The bundle carries the CLI; this is how a person finds it.
          click: () => {
            clipboard.writeText(`ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${bin}"`);
          },
        },
        { type: "separator" },
        { role: "toggleDevTools", label: message("Developer tools") },
        { role: "quit", label: message("Quit") },
      ],
    },
    { label: message("Edit"), submenu: [
      { role: "undo", label: message("Undo") }, { role: "redo", label: message("Redo") },
      { type: "separator" }, { role: "cut", label: message("Cut") },
      { role: "copy", label: message("Copy") }, { role: "paste", label: message("Paste") },
      { role: "selectAll", label: message("Select all") },
    ] },
    { label: message("Interface language"), submenu: locale.UI_LANGUAGES.map(language => ({
      label: language.label, type: "radio", checked: locale.i18n.language === language.code,
      click: () => { void changeLanguage(language.code); },
    })) },
    {
      label: message("Help"),
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
      preload: join(__dirname, "preload.cjs"),
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

async function changeLanguage(code) {
  if (!locale.UI_LANGUAGES.some(language => language.code === code)) return;
  if (!await locale.i18n.setLanguage(code)) return;
  try { writeFileSync(join(app.getPath("userData"), "ui-language.json"), JSON.stringify(code)); } catch { /* Retain the choice for this run. */ }
  buildMenu();
  window?.webContents.send("nixamp:language-changed", code);
}
function isOwnPage(event) {
  return !!window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
    && new URL(event.senderFrame.url).origin === `http://127.0.0.1:${port}`;
}
app.whenReady().then(async () => {
  try {
    locale = await import(pathToFileURL(resources().locale).href);
    let saved;
    try { saved = JSON.parse(readFileSync(join(app.getPath("userData"), "ui-language.json"), "utf8")); } catch { /* First run. */ }
    await locale.i18n.setLanguage(locale.preferredUiLanguage(saved, [process.env.NIXAMP_UI_LANGUAGE, ...app.getPreferredSystemLanguages()]));
    ipcMain.handle("nixamp:language-get", event => isOwnPage(event) ? locale.i18n.language : "en");
    ipcMain.handle("nixamp:language-set", async (event, code) => { if (isOwnPage(event)) await changeLanguage(code); });
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
