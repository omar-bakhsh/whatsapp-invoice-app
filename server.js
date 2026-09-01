require('./fix-permissions');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const multer = require('multer');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const pdfParse = require('pdf-parse');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const settingsPath = path.join(__dirname, 'settings.json');

// --- Settings & Branches Logic ---
function migrateSettings(data) {
    if (!data.branches) {
        return {
            activeBranch: "default",
            branches: {
                "default": {
                    name: "الفرع الرئيسي",
                    messageTemplate: data.messageTemplate || "حياك الله أستاذي الكريم {{name}} 🌹\n\nنتمنى لك ولسيارتك رحلة آمنة! تجد مرفقاً فاتورة الصيانة الخاصة بك.\n\nإذا كانت تجربتك ممتازة، يسعدنا جداً أن تترك لنا كلمة طيبة بتقييمك هنا:\n{{link}}\n\nأما إن كان لديك أي اقتراح أو ملاحظة لتطوير خدمتنا، فنحن بانتظار رسالتك المباشرة للإدارة عبر الرقم:\n0598260665\n\nفي أمان الله، ودمت بخير. 🙏",
                    reviewLink: data.reviewLink || "",
                    blacklist: data.blacklist || []
                }
            }
        };
    }
    return data;
}

function loadSettings() {
    let defaultSettings = {
        activeBranch: "default",
        branches: {
            "default": {
                name: "الفرع الرئيسي",
                messageTemplate: "حياك الله أستاذي الكريم {{name}} 🌹\n\nنتمنى لك ولسيارتك رحلة آمنة! تجد مرفقاً فاتورة الصيانة الخاصة بك.\n\nإذا كانت تجربتك ممتازة، يسعدنا جداً أن تترك لنا كلمة طيبة بتقييمك هنا:\n{{link}}\n\nأما إن كان لديك أي اقتراح أو ملاحظة لتطوير خدمتنا، فنحن بانتظار رسالتك المباشرة للإدارة عبر الرقم:\n0598260665\n\nفي أمان الله، ودمت بخير. 🙏",
                reviewLink: "https://reviewthis.biz/4229286a",
                blacklist: ["966566522351", "966556565135"]
            }
        }
    };
    if (!fs.existsSync(settingsPath)) {
        fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 4));
        return defaultSettings;
    }
    try {
        let data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        data = migrateSettings(data);
        return data;
    } catch (e) {
        return defaultSettings;
    }
}

function saveSettings(settings) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
}

// Migrate immediately on start
let initSettings = loadSettings();
saveSettings(initSettings);

const uploadPath = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadPath),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Buffer.from(file.originalname, 'latin1').toString('utf8'))
});
const upload = multer({ storage });

let client = null;
let isWhatsappReady = false;
let lastQR = null;
let activeBranchId = loadSettings().activeBranch || "default";

// --- WhatsApp Client Logic ---
async function initializeBranch(branchId) {
    console.log(`Initializing WhatsApp for branch: ${branchId}...`);
    
    if (client) {
        console.log('Destroying previous WhatsApp client...');
        try {
            await client.destroy();
        } catch (e) {
            console.error('Error destroying client:', e);
        }
        client = null;
    }

    isWhatsappReady = false;
    lastQR = null;
    io.emit('branchSwitched', branchId);
    io.emit('ready', false);
    
    const settings = loadSettings();
    settings.activeBranch = branchId;
    activeBranchId = branchId;
    saveSettings(settings);

    client = new Client({
        authStrategy: new LocalAuth({ clientId: branchId }), 
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
        },
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ],
            executablePath: process.env.CHROME_PATH || null
        }
    });

    client.on('qr', async (qr) => {
        console.log(`[Branch ${branchId}] QR RECEIVED`);
        try {
            lastQR = await qrcode.toDataURL(qr);
            io.emit('qr', lastQR);
        } catch(err) {
            console.error('Error generating QR', err);
        }
    });

    client.on('ready', () => {
        console.log(`[Branch ${branchId}] Client is ready!`);
        isWhatsappReady = true;
        lastQR = null;
        io.emit('ready', true);
    });

    client.on('authenticated', () => {
        console.log(`[Branch ${branchId}] AUTHENTICATED`);
        lastQR = null;
        io.emit('authenticated', true);
    });

    client.on('auth_failure', msg => {
        console.error(`[Branch ${branchId}] AUTH FAILURE`, msg);
        io.emit('error', 'Authentication failed: ' + msg);
    });

    client.on('disconnected', (reason) => {
        console.log(`[Branch ${branchId}] Client logged out`, reason);
        isWhatsappReady = false;
        lastQR = null;
        io.emit('ready', false);
        if (activeBranchId === branchId) {
            console.log('Restarting client...');
            client.initialize().catch(err => console.error("Re-Init Error:", err));
        }
    });

    client.initialize().catch(err => {
        console.error(`[Branch ${branchId}] Init Error:`, err);
    });
}

// Initial start
initializeBranch(activeBranchId);

io.on('connection', (socket) => {
    console.log('Frontend client connected');
    socket.emit('branchSwitched', activeBranchId); 
    if (isWhatsappReady) {
        socket.emit('ready', true);
    } else if (lastQR) {
        socket.emit('qr', lastQR);
    }
});

// --- API Endpoints ---
app.get('/api/settings', (req, res) => {
    res.json(loadSettings());
});

app.post('/api/branches/create', (req, res) => {
    const { branchId, name } = req.body;
    if (!branchId || !name) return res.status(400).json({ error: 'بيانات الفرع ناقصة' });
    
    const settings = loadSettings();
    if (settings.branches[branchId]) {
        return res.status(400).json({ error: 'الفرع موجود مسبقاً' });
    }
    
    const defaultBranch = settings.branches["default"] || Object.values(settings.branches)[0] || {};
    settings.branches[branchId] = {
        name: name,
        messageTemplate: defaultBranch.messageTemplate || "",
        reviewLink: defaultBranch.reviewLink || "",
        blacklist: defaultBranch.blacklist || []
    };
    
    saveSettings(settings);
    res.json({ success: true, branches: settings.branches });
});

app.post('/api/branches/switch', async (req, res) => {
    const { branchId } = req.body;
    const settings = loadSettings();
    if (!settings.branches[branchId]) {
        return res.status(400).json({ error: 'الفرع غير موجود' });
    }
    
    res.json({ success: true });
    initializeBranch(branchId);
});

app.post('/api/settings/:branchId', (req, res) => {
    const branchId = req.params.branchId;
    const newBranchSettings = req.body;
    
    const settings = loadSettings();
    if (!settings.branches[branchId]) {
        return res.status(400).json({ error: 'الفرع غير موجود' });
    }
    
    settings.branches[branchId] = {
        ...settings.branches[branchId],
        ...newBranchSettings
    };
    
    saveSettings(settings);
    res.json({ success: true });
});

function extractPhoneNumber(text, branchId) {
    const settings = loadSettings();
    const branchSettings = settings.branches[branchId] || {};
    const blacklist = branchSettings.blacklist || [];
    
    const matches = [];
    const match05 = text.match(/\b05\d{8}\b/g);
    if (match05) match05.forEach(m => matches.push("966" + m.substring(1)));

    const match5 = text.match(/\b5\d{8}\b/g);
    if (match5) match5.forEach(m => matches.push("966" + m));

    const validMatches = matches.filter(num => !blacklist.includes(num));
    return validMatches.length > 0 ? validMatches[0] : null;
}

app.post('/api/send-direct', upload.single('invoice'), async (req, res) => {
    const { phoneNumber, customerName } = req.body;
    const file = req.file;

    if (!file || !phoneNumber) return res.status(400).json({ error: 'الملف أو رقم الهاتف مفقود.' });
    if (!isWhatsappReady || !client) return res.status(400).json({ error: 'الواتساب غير متصل.' });

    const settings = loadSettings();
    const branchSettings = settings.branches[activeBranchId] || {};
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    
    try {
        const numberId = `${phoneNumber}@c.us`;
        const media = MessageMedia.fromFilePath(file.path);
        
        const customerDisplayName = customerName ? ` ${customerName}` : "";
        let caption = branchSettings.messageTemplate || "";
        caption = caption.replace("{{name}}", customerDisplayName);
        caption = caption.replace("{{link}}", branchSettings.reviewLink || "");

        await client.sendMessage(numberId, media, { caption });
        console.log(`[Branch ${activeBranchId}] Direct Sent to ${customerDisplayName} (${phoneNumber})`);
        
        res.json({ success: true, file: originalName, number: phoneNumber });
    } catch (error) {
        console.error(`Error sending direct ${originalName}:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/process', upload.array('invoices'), async (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'لم يتم رفع أي ملفات.' });
    if (!isWhatsappReady || !client) return res.status(400).json({ error: 'الواتساب غير متصل.' });

    const results = [];
    const currentBranchId = activeBranchId; 

    for (const file of req.files) {
        const filePath = file.path;
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        
        try {
            io.emit('statusUpdate', { file: originalName, status: 'processing', message: 'جاري استخراج الرقم...' });

            const dataBuffer = fs.readFileSync(filePath);
            const data = await pdfParse(dataBuffer);
            
            let text = data.text || "";
            let currentNumber = extractPhoneNumber(text, currentBranchId);
            
            if (!currentNumber || text.trim().length < 10) {
                 results.push({ file: originalName, success: false, reason: 'لم يتم العثور على نص أو رقم جوال.' });
                 io.emit('statusUpdate', { file: originalName, status: 'error', message: 'لم يتم العثور على رقم' });
                 continue;
            }

            io.emit('statusUpdate', { file: originalName, status: 'sending', message: `الرقم: +${currentNumber}` });

            const numberId = `${currentNumber}@c.us`;
            const media = MessageMedia.fromFilePath(filePath);
            
            const settings = loadSettings();
            const branchSettings = settings.branches[currentBranchId] || {};
            let caption = branchSettings.messageTemplate || "";
            caption = caption.replace("{{name}}", "");
            caption = caption.replace("{{link}}", branchSettings.reviewLink || "");

            await client.sendMessage(numberId, media, { caption });
            
            results.push({ file: originalName, success: true, number: currentNumber });
            io.emit('statusUpdate', { file: originalName, status: 'success', message: `تم الإرسال (${currentNumber})` });

            await new Promise(r => setTimeout(r, 2000));

        } catch (error) {
            results.push({ file: originalName, success: false, reason: error.message });
            io.emit('statusUpdate', { file: originalName, status: 'error', message: `خطأ: ${error.message}` });
        }
    }

    res.json({ success: true, processedCount: req.files.length, results });
});

const PORT = process.env.PORT || 3020;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
