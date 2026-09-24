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
        if (content.includes('id: newMsgKey,') && content.includes('...(mediaOptions.toJSON ? mediaOptions.toJSON() : {}),')) {
            const targetPattern = /const message = \{[\s\S]*?\.\.\.extraOptions\s*\};/;
            const match = content.match(targetPattern);
            if (match && !content.includes('message.id = newMsgKey;\n        delete message.__x_id;')) {
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

        if (modified) {
            fs.writeFileSync(utilsPath, content, 'utf8');
            console.log('✅ [Patch] Successfully patched whatsapp-web.js to fix "Data passed to getter must include an id property" error!');
        } else {
            console.log('[Patch] whatsapp-web.js is already patched.');
        }
    } catch (e) {
        console.error('[Patch] Error patching whatsapp-web.js:', e.message);
    }
}

patchWWebJS();

module.exports = patchWWebJS;
