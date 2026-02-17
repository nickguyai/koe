// afterPack hook: codesign bundled media binaries for macOS notarization.
// electron-builder runs this before the final app signature is applied.

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

exports.default = async function (context) {
  if (process.platform !== 'darwin') return;

  const identity = process.env.CSC_NAME || '-';
  const entitlements = path.join(__dirname, '..', 'entitlements.mac.plist');
  const binDir = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'bin');

  if (!fs.existsSync(binDir)) {
    console.log('[sign-ffmpeg] No bin directory found, skipping.');
    return;
  }

  for (const name of ['ffmpeg', 'ffprobe', 'audiotee']) {
    const binPath = path.join(binDir, name);
    if (!fs.existsSync(binPath)) {
      console.warn(`[sign-ffmpeg] ${name} not found at ${binPath}, skipping.`);
      continue;
    }

    console.log(`[sign-ffmpeg] Signing ${name}...`);
    const args = [
      '--sign', identity,
      '--force',
      '--options', 'runtime',
      '--entitlements', entitlements,
      binPath,
    ];
    execSync(`codesign ${args.map(a => `'${a}'`).join(' ')}`, { stdio: 'inherit' });
  }
};
