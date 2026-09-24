require('./fix-permissions');
require('./patch-wwebjs');
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

// --- Helper: Check if filename starts with "Day" (case-insensitive) ---
function isDayReportFile(filename) {
    if (!filename) return false;
    const cleanName = path.basename(filename).trim().toLowerCase();
    return cleanName.startsWith('day');
}

// --- Helper: Extract customer name from filename ---
function extractNameFromFilename(filename) {
    if (!filename) return "";
    let clean = path.basename(filename, path.extname(filename)).trim();
    
    // Remove timestamp prefix if exists (e.g. 1775642361138-)
    clean = clean.replace(/^\d{10,14}[-_]/, '');
    
    // Remove invoice prefix words
    clean = clean.replace(/^(?:فاتورة|فاتوره|receipt|invoice)[-_ ]+/i, '');
    
    // Split by dash, underscore, plus or slash
    const parts = clean.split(/[-_+/]/).map(p => p.trim()).filter(Boolean);
    if (parts.length > 0) {
        let candidate = parts[0];
        // Clean trailing/leading numbers, symbols, barcodes
        candidate = candidate.replace(/[0-9#*]+/g, '').trim();
        if (candidate.length >= 3 && !/^(شبكة|كاش|تحويل|تابي|تمارا|day)$/i.test(candidate)) {
            return candidate;
        }
    }
    return "";
}

// --- Helper: Extract customer name from text ---
function findCustomerNameInText(text) {
    if (!text) return "";
    const patterns = [
        /(?:اسم\s+العميل|إسم\s+العميل|العميل|السيد|المكرم|حضرة\s+السيد|العميل\s+المكرم)\s*[:/=\-]?\s*([^\n\r\|\d]{3,40})/i,
        /(?:customer\s*name|client\s*name|customer)\s*[:/=\-]?\s*([^\n\r\|\d]{3,40})/i,
        /(?:الاسم|الإسم)\s*[:/=\-]?\s*([^\n\r\|\d]{3,40})/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
            let name = match[1].trim();
            name = name.split(/(?:\s{2,}|\t|\n|رقم|جوال|هاتف|تاريخ|date|phone|mobile|vat|ضريبة)/i)[0].trim();
            name = name.replace(/[\|\_\-\:\d#]+$/, "").trim();
            if (name.length >= 3 && !/^(الفرع|المؤسسة|الشركة|نقد|شبكة|كاش)$/i.test(name)) {
                return name;
            }
        }
    }
    return "";
}

// --- Helper: Spintax Parser (Strictly requires | to avoid mangling {tags}) ---
function parseSpintax(text) {
    if (!text) return "";
    const spintaxRegex = /\{([^{}|]+(?:\|[^{}|]+)+)\}/g;
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
    minDelay: 10,
    maxDelay: 20,
    batchSize: 8,
    batchCooldown: 60,
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
    const match05 = normalizedText.match(/\b05[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d\b/g);
    if (match05) match05.forEach(m => matches.push("966" + m.replace(/\D/g, '').substring(1)));

    // Match 5XXXXXXXX
    const match5 = normalizedText.match(/\b5[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d\b/g);
    if (match5) match5.forEach(m => matches.push("966" + m.replace(/\D/g, '')));

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
async function sendWhatsAppInvoice(phoneNumber, filePath, customerName, branchId, originalFileName) {
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

    let targetId = `${targetNum}@c.us`;

    // Try resolving number id safely without crashing on missing contact model
    try {
        const numberDetails = await client.getNumberId(targetNum);
        if (numberDetails && numberDetails._serialized) {
            targetId = numberDetails._serialized;
        }
    } catch (e) {
        console.warn(`Could not verify number ID for ${targetNum}, using default format:`, e.message);
    }

    // 1. Simulate Human Typing State (Direct sendChatstate)
    if (antiBan.simulateTyping && client.pupPage) {
        try {
            await client.pupPage.evaluate(async (chatId) => {
                if (window.WWebJS && window.WWebJS.sendChatstate) {
                    await window.WWebJS.sendChatstate('typing', chatId);
                }
            }, targetId).catch(() => {});
            
            const typingDuration = 2000 + Math.floor(Math.random() * 2000);
            await new Promise(r => setTimeout(r, typingDuration));

            await client.pupPage.evaluate(async (chatId) => {
                if (window.WWebJS && window.WWebJS.sendChatstate) {
                    await window.WWebJS.sendChatstate('stop', chatId);
                }
            }, targetId).catch(() => {});
        } catch (e) {
            // Non-critical
        }
    }

    // If customerName is empty, attempt extracting from filename
    if (!customerName || customerName.trim().length === 0) {
        customerName = extractNameFromFilename(originalFileName || path.basename(filePath));
    }

    const media = MessageMedia.fromFilePath(filePath);
    
    // 2. Prepare Message: FIRST Replace template placeholders ({{name}}, {{link}}, {{branch}})
    let caption = branchSettings.messageTemplate || "";
    
    const customerDisplayName = (customerName && customerName.trim().length > 0) ? ` ${customerName.trim()}` : "";
    const reviewLinkUrl = branchSettings.reviewLink || "";
    const branchNameStr = branchSettings.name || "";

    // Replace both double and single braces
    caption = caption.replace(/\{\{name\}\}/gi, customerDisplayName);
    caption = caption.replace(/\{name\}/gi, customerDisplayName);
    
    caption = caption.replace(/\{\{link\}\}/gi, reviewLinkUrl);
    caption = caption.replace(/\{link\}/gi, reviewLinkUrl);
    
    caption = caption.replace(/\{\{branch\}\}/gi, branchNameStr);
    caption = caption.replace(/\{branch\}/gi, branchNameStr);

    // AFTER replacing variables, apply Spintax uniqueness if enabled
    if (antiBan.useSpintax) {
        caption = parseSpintax(caption);
    }

    // 3. Send message with sendSeen: false to avoid unnecessary model serialization errors
    const result = await client.sendMessage(targetId, media, { caption, sendSeen: false });
    
    // Update daily count
    const totalToday = incrementDailyCount(branchId);

    return { result, resolvedNumber: targetNum, totalToday, customerName: customerName.trim() };
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
    
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');

    // Exclude Day report files
    if (isDayReportFile(originalName)) {
        safeUnlink(file.path);
        return res.status(400).json({ error: 'تم استبعاد هذا الملف لأنه ملف يومي يبدأ بـ Day.' });
    }

    if (!isWhatsappReady || !client) {
        safeUnlink(file.path);
        return res.status(400).json({ error: 'الواتساب غير متصل حالياً.' });
    }
    
    try {
        const { resolvedNumber, totalToday, customerName: finalName } = await sendWhatsAppInvoice(phoneNumber, file.path, customerName, activeBranchId, originalName);
        safeUnlink(file.path);
        res.json({ success: true, file: originalName, number: resolvedNumber, totalToday, customerName: finalName });
    } catch (error) {
        console.error(`Error sending direct ${originalName}:`, error);
        safeUnlink(file.path);
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
        
        // Exclude files starting with "Day"
        if (isDayReportFile(originalName)) {
            safeUnlink(filePath);
            results.push({ file: originalName, success: false, reason: 'تم استبعاد هذا الملف تلقائياً (يبدأ بـ Day).' });
            io.emit('statusUpdate', { file: originalName, status: 'error', message: 'تم استبعاده (يبدأ بـ Day)' });
            continue;
        }

        try {
            io.emit('statusUpdate', { file: originalName, status: 'processing', message: 'جاري استخراج الرقم والاسم...' });

            const dataBuffer = fs.readFileSync(filePath);
            const data = await pdfParse(dataBuffer);
            
            let text = data.text || "";
            let currentNumber = extractPhoneNumber(text, currentBranchId);
            let customerName = findCustomerNameInText(text) || extractNameFromFilename(originalName);
            
            if (!currentNumber || text.trim().length < 5) {
                 results.push({ file: originalName, success: false, reason: 'لم يتم العثور على نص أو رقم جوال.' });
                 io.emit('statusUpdate', { file: originalName, status: 'error', message: 'لم يتم العثور على رقم جوال' });
                 safeUnlink(filePath);
                 continue;
            }

            io.emit('statusUpdate', { file: originalName, status: 'sending', message: `الرقم: +${currentNumber} (${customerName || 'عميل'})` });

            await sendWhatsAppInvoice(currentNumber, filePath, customerName, currentBranchId, originalName);
            
            results.push({ file: originalName, success: true, number: currentNumber, customerName });
            io.emit('statusUpdate', { file: originalName, status: 'success', message: `تم الإرسال (+${currentNumber})` });

            safeUnlink(filePath);
            await new Promise(r => setTimeout(r, 2000));

        } catch (error) {
            safeUnlink(filePath);
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
