// Copies the shared web UI (../web) into www/ and adds the HLS player library.
const fs = require('fs');
const path = require('path');
fs.rmSync('www', { recursive: true, force: true });
fs.cpSync(path.join('..', 'web'), 'www', { recursive: true });
fs.mkdirSync(path.join('www', 'vendor'), { recursive: true });
fs.copyFileSync(path.join('node_modules', 'hls.js', 'dist', 'hls.min.js'), path.join('www', 'vendor', 'hls.js'));
console.log('www/ is ready. Now run: npx cap sync');
