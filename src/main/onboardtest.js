'use strict';

/**
 * Visual check of the first-run setup and tour (XODECODE_TEST_KIND=onboard).
 * Clicks through every step in a throwaway profile and saves a screenshot of
 * each to XODECODE_TEAMTEST. Claude is blocked for the run (NO_CLAUDE), so no
 * session starts; the setup only reads `claude auth status`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

async function runOnboardTest(mainWindow) {
  const outDir = process.env.XODECODE_TEAMTEST;
  fs.mkdirSync(outDir, { recursive: true });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const run = (js) => mainWindow.webContents.executeJavaScript(js);
  const shot = async (name) => {
    const image = await mainWindow.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
  };
  const click = (text) =>
    run(`(() => {
      const b = [...document.querySelectorAll('.onboard button')].find((x) => x.textContent.trim() === ${JSON.stringify(text)});
      if (!b) return false;
      b.click();
      return true;
    })()`);

  await wait(4000);
  await shot('1-welcome');
  console.log('ONBOARD_CLICK', await click('Get started'));
  await wait(700);
  await run(`document.querySelectorAll('.onboard-bg')[2]?.click(), true`);
  await wait(900);
  await shot('2-background');
  await click('Next');
  await wait(6000); // let `claude auth status` answer
  await shot('3-claude');
  console.log('ONBOARD_STATUS', await run(`document.querySelector('.onboard-status')?.textContent || ''`));
  await click('Next');
  await wait(700);
  await shot('4-ready');
  await click('Show me around');
  for (let i = 1; i <= 8; i += 1) {
    await wait(900);
    await shot(`5-tour-${i}`);
    if (!(await click(i === 8 ? 'Finish' : 'Next'))) console.log('ONBOARD_MISSING_BUTTON', i);
  }
  await wait(600);
  console.log('ONBOARD_DONE', await run(`({ onboarded: window.__xo.store.state.settings.onboarded, open: Boolean(document.querySelector('.onboard')) })`));
  app.quit();
}

module.exports = { runOnboardTest };
