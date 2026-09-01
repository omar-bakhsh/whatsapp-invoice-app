const fs = require('fs');
const path = require('path');
const os = require('os');

console.log("Checking Chrome binary permissions...");

const chromePaths = [
    '/local/.cache/puppeteer/chrome',
    path.join(os.homedir(), '.cache/puppeteer/chrome')
];

let fixed = false;

chromePaths.forEach(basePath => {
    if (fs.existsSync(basePath)) {
        const versions = fs.readdirSync(basePath);
        versions.forEach(version => {
            const chromeExe = path.join(basePath, version, 'chrome-linux64', 'chrome');
            if (fs.existsSync(chromeExe)) {
                try {
                    fs.chmodSync(chromeExe, '755'); // Give execute permission
                    console.log('Fixed permissions for:', chromeExe);
                    fixed = true;
                } catch (e) {
                    console.error('Could not fix permissions for:', chromeExe, e.message);
                }
            }
        });
    }
});

if (!fixed) {
    console.log("Could not find Chrome binary to fix, or it was already fine.");
}
