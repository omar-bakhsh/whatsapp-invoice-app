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
        methods: ["GET", "POST", "PUT", "DELETE"]
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const settingsPath = path.join(__dirname, 'settings.json');

// --- Helper: Convert Arabic-Indic digits to Latin digits ---
function normalizeDigits(str) {
    if (!str) return "";
    const arabicDigits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
    return str.replace(/[٠-٩]/g, d => arabicDigits.indexOf(d).toString());
}

// --- Helper: Spintax Parser for Message Uniqueness ---
// Example: "{حياك الله|أهلاً بك|مرحباً بك} أستاذ {{name}}" -> randomly chooses one
function parseSpintax(text) {
    if (!text) return "";
    const spintaxRegex = /\{([^{}]+)\}/g;
    let match;
    while ((match = spintaxRegex.exec(text)) !== null) {
        const options = match[1].split('|');
        const randomChoice = options[Math.floor(Math.random() * options.length)].trim();
        text = text.replace(match[0], randomChoice);
        spintaxRegex.lastIndex = 0;
    }
    return text;
}

// --- Settings & Branches Logic with Anti-Ban defaults ---
const DEFAULT_ANTI_BAN = {
    minDelay: 10,       // Minimum delay in seconds
    maxDelay: 20,       // Maximum delay in seconds
    batchSize: 8,       // Number of messages before cooldown
    batchCooldown: 60,  // Cooldown duration in seconds
    simulateTyping: true,
    useSpintax: true,
    dailyLimit: 150
};

function getTodayKey() {
    return new Date().toISOString().slice(0, 10);
}

function migrateSettings(data) {
    if (!data.branches) {
        data = {
            activeBranch: "default",
            branches: {
                "default": {
                    name: "الفرع الرئيسي",
                    messageTemplate: "{حياك الله|أهلاً وسهلاً بك|مرحباً بك} أستاذي الكريم {{name}} 🌹\n\nنتمنى لك ولسيارتك رحلة آمنة! تجد مرفقاً فاتورة الصيانة الخاصة بك.\n\nإذا كانت تجربتك ممتازة، يسعدنا جداً أن تترك لنا كلمة طيبة بتقييمك هنا:\n{{link}}\n\nأما إن كان لديك أي اقتراح لتطوير خدمتنا، فنحن بانتظار رسالتك المباشرة للإدارة:\n0598260665\n\nفي أمان الله، ودمت بخير. 🙏",
                    reviewLink: data.reviewLink || "",
                    blacklist: data.blacklist || [],
                    antiBan: { ...DEFAULT_ANTI_BAN },
                    dailyCount: { [getTodayKey()]: 0 }
                }
            }
        };
    }

    // Ensure all branches have antiBan and dailyCount structure
    for (const key of Object.keys(data.branches)) {
        if (!data.branches[key].antiBan) {
            data.branches[key].antiBan = { ...DEFAULT_ANTI_BAN };
        }
        if (!data.branches[key].dailyCount) {
            data.branches[key].dailyCount = { [getTodayKey()]: 0 };
        }
    }
    return data;
}

function loadSettings() {
    const defaultSettings = {
        activeBranch: "default",
        branches: {
            "default": {
                name: "الفرع الرئيسي",
                messageTemplate: "{حياك الله|أهلاً وسهلاً بك|مرحباً بك} أستاذي الكريم {{name}} 🌹\n\nنتمنى لك ولسيارتك رحلة آمنة! تجد مرفقاً فاتورة الصيانة الخاصة بك.\n\nإذا كانت تجربتك ممتازة، يسعدنا جداً أن تترك لنا كلمة طيبة بتقييمك هنا:\n{{link}}\n\nأما إن كان لديك أي اقتراح لتطوير خدمتنا، فنحن بانتظار رسالتك المباشرة للإدارة:\n0598260665\n\nفي أمان الله، ودمت بخير. 🙏",
                reviewLink: "https://reviewthis.biz/4229286a",
                blacklist: ["966566522351", "966556565135"],
                antiBan: { ...DEFAULT_ANTI_BAN },
                dailyCount: { [getTodayKey()]: 0 }
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

// Migrate settings on start
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

function safeUnlink(filePath) {
    if (filePath && fs.existsSync(filePath)) {
        try {
            fs.unlinkSync(filePath);
        } catch (e) {
            console.error('Error deleting file:', filePath, e.message);
        }
    }
}

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
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1018911162-alpha.html',
            strict: false
        },
        takeoverOnConflict: true,
        restartOnAuthFail: true,
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
        io.emit('error', 'فشلت المصادقة: ' + msg);
    });

    client.on('disconnected', (reason) => {
        console.log(`[Branch ${branchId}] Client disconnected`, reason);
        isWhatsappReady = false;
        lastQR = null;
        io.emit('ready', false);
        if (activeBranchId === branchId) {
            console.log('Attempting to reinitialize client...');
            setTimeout(() => {
                initializeBranch(branchId).catch(err => console.error("Re-Init Error:", err));
            }, 3000);
        }
    });

    client.initialize().catch(err => {
        console.error(`[Branch ${branchId}] Init Error:`, err);
        io.emit('error', 'تعذر تشغيل متصفح الواتساب: ' + err.message);
    });
}

// Initial start
initializeBranch(activeBranchId);

io.on('connection', (socket) => {
    socket.emit('branchSwitched', activeBranchId); 
    if (isWhatsappReady) {
        socket.emit('ready', true);
    } else if (lastQR) {
        socket.emit('qr', lastQR);
    }
});

// --- Phone Extraction Helper ---
function extractPhoneNumber(text, branchId) {
    if (!text) return null;
    const normalizedText = normalizeDigits(text);

    const settings = loadSettings();
    const branchSettings = settings.branches[branchId] || {};
    const blacklist = (branchSettings.blacklist || []).map(b => normalizeDigits(b).replace(/\D/g, ''));
    
    const matches = [];

    // Match 009665XXXXXXXX or +9665XXXXXXXX
    const matchIntl = normalizedText.match(/(?:\+966|00966)[\s-]?([5]\d{8})\b/g);
    if (matchIntl) {
        matchIntl.forEach(m => {
            const clean = m.replace(/\D/g, '');
            if (clean.startsWith('00966')) matches.push('966' + clean.substring(5));
            else if (clean.startsWith('966')) matches.push(clean);
        });
    }

    // Match 05XXXXXXXX
    const match05 = normalizedText.match(/\b05\d{8}\b/g);
    if (match05) match05.forEach(m => matches.push("966" + m.substring(1)));

    // Match 5XXXXXXXX
    const match5 = normalizedText.match(/\b5\d{8}\b/g);
    if (match5) match5.forEach(m => matches.push("966" + m));

    const uniqueMatches = [...new Set(matches)];
    const validMatches = uniqueMatches.filter(num => !blacklist.includes(num));

    return validMatches.length > 0 ? validMatches[0] : null;
}

// Increment daily counter helper
function incrementDailyCount(branchId) {
    const settings = loadSettings();
    const today = getTodayKey();
    if (!settings.branches[branchId]) return;
    if (!settings.branches[branchId].dailyCount) settings.branches[branchId].dailyCount = {};
    settings.branches[branchId].dailyCount[today] = (settings.branches[branchId].dailyCount[today] || 0) + 1;
    saveSettings(settings);
    return settings.branches[branchId].dailyCount[today];
}

// --- Resolve & Send WhatsApp Message with Anti-Ban Behavior ---
async function sendWhatsAppInvoice(phoneNumber, filePath, customerName, branchId) {
    if (!client || !isWhatsappReady) {
        throw new Error('الواتساب غير متصل حالياً.');
    }

    const settings = loadSettings();
    const branchSettings = settings.branches[branchId] || {};
    const antiBan = branchSettings.antiBan || DEFAULT_ANTI_BAN;
    const today = getTodayKey();
    const currentSentToday = (branchSettings.dailyCount && branchSettings.dailyCount[today]) || 0;

    // Check daily limit
    if (antiBan.dailyLimit && currentSentToday >= antiBan.dailyLimit) {
        throw new Error(`تم الوصول للحد اليومي الآمن للحماية من الحظر (${antiBan.dailyLimit} رسالة/يوم).`);
    }

    const cleanNum = normalizeDigits(phoneNumber).replace(/\D/g, '');
    let targetNum = cleanNum;
    if (targetNum.startsWith('05')) {
        targetNum = '966' + targetNum.substring(1);
    } else if (targetNum.startsWith('5') && targetNum.length === 9) {
        targetNum = '966' + targetNum;
    }

    // Resolve WhatsApp contact ID
    let targetId = `${targetNum}@c.us`;
    try {
        const numberDetails = await client.getNumberId(targetNum);
        if (numberDetails && numberDetails._serialized) {
            targetId = numberDetails._serialized;
        }
    } catch (e) {
        console.warn(`Could not verify number ID for ${targetNum}:`, e.message);
    }

    // 1. Simulate Human Typing State
    if (antiBan.simulateTyping) {
        try {
            const chat = await client.getChatById(targetId).catch(() => null);
            if (chat) {
                await chat.sendStateTyping().catch(() => {});
                // Random typing duration: 2.5 - 4.5 seconds
                const typingDuration = 2500 + Math.floor(Math.random() * 2000);
                await new Promise(r => setTimeout(r, typingDuration));
                await chat.clearState().catch(() => {});
            }
        } catch (e) {}
    }

    const media = MessageMedia.fromFilePath(filePath);
    
    // 2. Prepare Message with Spintax Uniqueness
    let caption = branchSettings.messageTemplate || "";
    if (antiBan.useSpintax) {
        caption = parseSpintax(caption);
    }
    
    const customerDisplayName = customerName ? ` ${customerName}` : "";
    caption = caption.replace(/\{\{name\}\}/gi, customerDisplayName);
    caption = caption.replace(/\{\{link\}\}/gi, branchSettings.reviewLink || "");
    caption = caption.replace(/\{\{branch\}\}/gi, branchSettings.name || "");

    // 3. Send message
    const result = await client.sendMessage(targetId, media, { caption });
    
    // Update daily count
    const totalToday = incrementDailyCount(branchId);

    return { result, resolvedNumber: targetNum, totalToday };
}

// --- API Endpoints ---
app.get('/api/settings', (req, res) => {
    res.json(loadSettings());
});

app.post('/api/branches/create', (req, res) => {
    let { branchId, name } = req.body;
    if (!branchId || !name) return res.status(400).json({ error: 'بيانات الفرع ناقصة' });
    
    branchId = branchId.trim().toLowerCase().replace(/\s+/g, '-');
    const settings = loadSettings();
    if (settings.branches[branchId]) {
        return res.status(400).json({ error: 'الفرع موجود مسبقاً' });
    }
    
    const defaultBranch = settings.branches["default"] || Object.values(settings.branches)[0] || {};
    settings.branches[branchId] = {
        name: name.trim(),
        messageTemplate: defaultBranch.messageTemplate || "",
        reviewLink: defaultBranch.reviewLink || "",
        blacklist: defaultBranch.blacklist || [],
        antiBan: { ...(defaultBranch.antiBan || DEFAULT_ANTI_BAN) },
        dailyCount: { [getTodayKey()]: 0 }
    };
    
    saveSettings(settings);
    res.json({ success: true, branches: settings.branches, newBranchId: branchId });
});

app.put('/api/branches/:branchId', (req, res) => {
    const branchId = req.params.branchId;
    const { name } = req.body;
    const settings = loadSettings();
    if (!settings.branches[branchId]) {
        return res.status(404).json({ error: 'الفرع غير موجود' });
    }
    if (name) settings.branches[branchId].name = name.trim();
    saveSettings(settings);
    res.json({ success: true, branch: settings.branches[branchId] });
});

app.delete('/api/branches/:branchId', async (req, res) => {
    const branchId = req.params.branchId;
    const settings = loadSettings();
    
    if (Object.keys(settings.branches).length <= 1) {
        return res.status(400).json({ error: 'لا يمكن حذف الفرع الوحيد المتبقي.' });
    }
    if (!settings.branches[branchId]) {
        return res.status(404).json({ error: 'الفرع غير موجود' });
    }

    delete settings.branches[branchId];
    
    if (settings.activeBranch === branchId) {
        const remainingBranchIds = Object.keys(settings.branches);
        settings.activeBranch = remainingBranchIds[0];
        saveSettings(settings);
        initializeBranch(settings.activeBranch);
    } else {
        saveSettings(settings);
    }

    res.json({ success: true, branches: settings.branches, activeBranch: settings.activeBranch });
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
        ...newBranchSettings,
        antiBan: {
            ...DEFAULT_ANTI_BAN,
            ...(settings.branches[branchId].antiBan || {}),
            ...(newBranchSettings.antiBan || {})
        }
    };
    
    saveSettings(settings);
    res.json({ success: true, settings: settings.branches[branchId] });
});

app.post('/api/whatsapp/restart', async (req, res) => {
    try {
        initializeBranch(activeBranchId);
        res.json({ success: true, message: 'جاري إعادة تشغيل جلسة الواتساب...' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/whatsapp/logout', async (req, res) => {
    try {
        if (client) {
            await client.logout().catch(() => {});
            await client.destroy().catch(() => {});
            client = null;
        }
        isWhatsappReady = false;
        lastQR = null;
        io.emit('ready', false);
        initializeBranch(activeBranchId);
        res.json({ success: true, message: 'تم تسجيل الخروج وإعادة توليد رمز QR' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/send-direct', upload.single('invoice'), async (req, res) => {
    const { phoneNumber, customerName } = req.body;
    const file = req.file;

    if (!file || !phoneNumber) {
        if (file) safeUnlink(file.path);
        return res.status(400).json({ error: 'الملف أو رقم الهاتف مفقود.' });
    }
    if (!isWhatsappReady || !client) {
        safeUnlink(file.path);
        return res.status(400).json({ error: 'الواتساب غير متصل حالياً.' });
    }

    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    
    try {
        const { resolvedNumber, totalToday } = await sendWhatsAppInvoice(phoneNumber, file.path, customerName, activeBranchId);
        safeUnlink(file.path);
        res.json({ success: true, file: originalName, number: resolvedNumber, totalToday });
    } catch (error) {
        console.error(`Error sending direct ${originalName}:`, error);
        safeUnlink(file.path);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3020;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
