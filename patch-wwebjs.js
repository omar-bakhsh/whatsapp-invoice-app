const fs = require('fs');
const path = require('path');

function patchWWebJS() {
    const utilsPath = path.join(__dirname, 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');
    if (!fs.existsSync(utilsPath)) {
        console.log('[Patch] Utils.js not found, skipping patch.');
        return;
    }

    try {
        let content = fs.readFileSync(utilsPath, 'utf8');
        let modified = false;

        // Fix: Prevent mediaOptions / toJSON from overwriting message.id with undefined or __x_id
        if (content.includes('id: newMsgKey,') && !content.includes('message.id = newMsgKey;\n        delete message.__x_id;')) {
            const targetPattern = /const message = \{[\s\S]*?\.\.\.extraOptions,?\s*\};/;
            const match = content.match(targetPattern);
            if (match) {
                const fixedBlock = match[0] + '\n        message.id = newMsgKey;\n        delete message.__x_id;';
                content = content.replace(match[0], fixedBlock);
                modified = true;
            }
        }

        // Additional safeguard for sendSeen / getMessageModel
        if (content.includes('window.WWebJS.getMessageModel = (message) => {')) {
            if (!content.includes('if (!message || !message.id) return message;')) {
                content = content.replace(
                    'window.WWebJS.getMessageModel = (message) => {',
                    'window.WWebJS.getMessageModel = (message) => {\n        if (!message || !message.id) return message;'
                );
                modified = true;
            }
        }

        // Fix: Modernize default UserAgent in Constants.js
        const constantsPath = path.join(__dirname, 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Constants.js');
        if (fs.existsSync(constantsPath)) {
            let constantsContent = fs.readFileSync(constantsPath, 'utf8');
            if (constantsContent.includes('Chrome/101.0.4951.67')) {
                constantsContent = constantsContent.replace(
                    /Mozilla\/5\.0 \(Macintosh; Intel Mac OS X 10_14_0\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/101\.0\.4951\.67 Safari\/537\.36/g,
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
                );
                fs.writeFileSync(constantsPath, constantsContent, 'utf8');
                console.log('✅ [Patch] Successfully updated default userAgent in Constants.js to modern Chrome!');
            }
        }

        if (modified) {
            fs.writeFileSync(utilsPath, content, 'utf8');
            console.log('✅ [Patch] Successfully patched whatsapp-web.js to fix "Data passed to getter must include an id property" error!');
        } else {
            console.log('[Patch] whatsapp-web.js Utils.js is already patched.');
        }
    } catch (e) {
        console.error('[Patch] Error patching whatsapp-web.js:', e.message);
    }
}

patchWWebJS();

module.exports = patchWWebJS;
