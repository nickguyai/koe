// afterSign hook: notarize and staple the .app before it is packaged into a DMG.
// Reads credentials from environment — no secrets in source.
// Skips automatically when credentials are absent (e.g. local dev, CI without signing).

const { execSync } = require('child_process');
const path = require('path');

exports.default = async function (context) {
  if (process.platform !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('[notarize] Skipping: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  // notarytool requires a zip/pkg/dmg — zip the .app as transport, staple back to the .app
  const zipPath = `${appPath}.zip`;
  console.log(`[notarize] Zipping ${appName}.app for submission...`);
  execSync(`ditto -c -k --keepParent "${appPath}" "${zipPath}"`, { stdio: 'inherit' });

  try {
    console.log(`[notarize] Submitting ${appName}.app.zip for notarization...`);
    execSync(
      `xcrun notarytool submit "${zipPath}" \
        --apple-id "${APPLE_ID}" \
        --password "${APPLE_APP_SPECIFIC_PASSWORD}" \
        --team-id "${APPLE_TEAM_ID}" \
        --wait`,
      { stdio: 'inherit' }
    );
  } finally {
    execSync(`rm -f "${zipPath}"`);
  }

  console.log(`[notarize] Stapling ticket to ${appName}.app...`);
  execSync(`xcrun stapler staple "${appPath}"`, { stdio: 'inherit' });

  console.log(`[notarize] Done — ${appName}.app is notarized and stapled.`);
};
