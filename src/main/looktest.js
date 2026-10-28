'use strict';

/**
 * Visual review run (XODECODE_TEST_KIND=look): starts the app in a throwaway
 * profile with Claude blocked (NO_CLAUDE), runs the steps in the script named
 * by XODECODE_LOOK and saves screenshots to XODECODE_TEAMTEST. The script
 * exports `async ({ run, shot, wait, win }) => {}`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

async function runLookTest(mainWindow) {
  const outDir = process.env.XODECODE_TEAMTEST;
  fs.mkdirSync(outDir, { recursive: true });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const run = (js) => mainWindow.webContents.executeJavaScript(js);
  const shot = async (name) => {
    const image = await mainWindow.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
  };
  mainWindow.webContents.on('console-message', (event) => {
    const { level, message } = event;
    if (level === 'warning' || level === 'error' || level >= 2) console.log(`LOOK_CONSOLE ${message}`);
  });
  await wait(2500);
  const steps = require(path.resolve(process.env.XODECODE_LOOK));
  await steps({ run, shot, wait, win: mainWindow });
  console.log('LOOK_DONE');
  app.quit();
}

module.exports = { runLookTest };
