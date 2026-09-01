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
const defaultSettings = {
    messageTemplate: "حياك الله أستاذي الكريم {{name}} 🌹\n\nنتمنى لك ولسيارتك رحلة آمنة! تجد مرفقاً فاتورة الصيانة الخاصة بك.\n\nإذا كانت تجربتك ممتازة، يسعدنا جداً أن تترك لنا كلمة طيبة بتقييمك هنا:\n{{link}}\n\nأما إن كان لديك أي اقتراح أو ملاحظة لتطوير خدمتنا، فنحن بانتظار رسالتك المباشرة للإدارة عبر الرقم:\n0598260665\n\nفي أمان الله، ودمت بخير. 🙏",
    reviewLink: "https://reviewthis.biz/4229286a",
    blacklist: ["966566522351", "966556565135"]
};

function loadSettings() {
    if (!fs.existsSync(settingsPath)) {
        fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 4));
        return defaultSettings;
    }
    try {
        const data = fs.readFileSync(settingsPath, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return defaultSettings;
    }
}

function saveSettings(settings) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 4));
}

const uploadPath = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath);

// Configuration for file upload
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadPath),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Buffer.from(file.originalname, 'latin1').toString('utf8'))
});
const upload = multer({ storage });

let isWhatsappReady = false;
let lastQR = null;

// Initialize WhatsApp Web Client
const client = new Client({
    authStrategy: new LocalAuth(),
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

console.log('Initializing WhatsApp...');

client.on('qr', async (qr) => {
    console.log('QR RECEIVED: Please scan the QR code on your screen.');
    try {
        lastQR = await qrcode.toDataURL(qr);
        io.emit('qr', lastQR);
    } catch(err) {
        console.error('Error generating QR', err);
    }
});

client.on('ready', () => {
    console.log('WhatsApp Client is ready!');
    isWhatsappReady = true;
    lastQR = null;
    io.emit('ready', true);
});

client.on('authenticated', () => {
    console.log('WhatsApp AUTHENTICATED');
    lastQR = null;
    io.emit('authenticated', true);
});

client.on('auth_failure', msg => {
    console.error('AUTHENTICATION FAILURE', msg);
    io.emit('error', 'Authentication failed: ' + msg);
});

client.on('disconnected', (reason) => {
    console.log('Client was logged out', reason);
    isWhatsappReady = false;
    lastQR = null;
    io.emit('ready', false);
    // Suggest restart
    console.log('Restarting client...');
    client.initialize().catch(err => {
        console.error("WhatsApp Re-Initialization Error:", err);
    });
});

client.initialize().catch(err => {
    console.error("WhatsApp Initialization Error:", err);
});

io.on('connection', (socket) => {
    console.log('Frontend client connected');
    if (isWhatsappReady) {
        socket.emit('ready', true);
    } else if (lastQR) {
        socket.emit('qr', lastQR);
    }
});

// Settings API
app.get('/api/settings', (req, res) => {
    res.json(loadSettings());
});

app.post('/api/settings', (req, res) => {
    const newSettings = req.body;
    if (!newSettings) return res.status(400).json({ error: 'بيانات غير صالحة' });
    saveSettings(newSettings);
    res.json({ success: true });
});

// Extract Phone Number Logic
function extractPhoneNumber(text) {
    const settings = loadSettings();
    const blacklist = settings.blacklist || [];
    
    // 1. Better search without removing all spaces (to keep word boundaries)
    // This avoids matching parts of the Tax Number (15 digits)
    const matches = [];

    // Look for 05xxxxxxxx using word boundaries
    const match05 = text.match(/\b05\d{8}\b/g);
    if (match05) match05.forEach(m => matches.push("966" + m.substring(1)));

    // Look for 5xxxxxxxx using word boundaries
    const match5 = text.match(/\b5\d{8}\b/g);
    if (match5) match5.forEach(m => matches.push("966" + m));

    // 2. Filter out center numbers
    const validMatches = matches.filter(num => !blacklist.includes(num));

    // Return the first valid one
    return validMatches.length > 0 ? validMatches[0] : null;
}

// Direct Send endpoint (used when Frontend already extracted the number via OCR)
app.post('/api/send-direct', upload.single('invoice'), async (req, res) => {
    const { phoneNumber, customerName } = req.body;
    const file = req.file;

    if (!file || !phoneNumber) {
        return res.status(400).json({ error: 'الملف أو رقم الهاتف مفقود.' });
    }

    if (!isWhatsappReady) {
        return res.status(400).json({ error: 'الواتساب غير متصل.' });
    }

    const settings = loadSettings();
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    
    try {
        const numberId = `${phoneNumber}@c.us`;
        const media = MessageMedia.fromFilePath(file.path);
        
        const customerDisplayName = customerName ? ` ${customerName}` : "";
        
        // Prepare dynamic caption
        let caption = settings.messageTemplate || "";
        caption = caption.replace("{{name}}", customerDisplayName);
        caption = caption.replace("{{link}}", settings.reviewLink || "");

        await client.sendMessage(numberId, media, { caption });
        console.log(`Direct Sent to ${customerDisplayName} (${phoneNumber})`);
        
        res.json({ success: true, file: originalName, number: phoneNumber });

    } catch (error) {
        console.error(`Error sending direct ${originalName}:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Original bulk process endpoint (kept as fallback)
app.post('/api/process', upload.array('invoices'), async (req, res) => {
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: 'لم يتم رفع أي ملفات.' });
    }

    if (!isWhatsappReady) {
        return res.status(400).json({ error: 'الواتساب غير متصل.' });
    }

    const results = [];

    for (const file of req.files) {
        const filePath = file.path;
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        
        try {
            io.emit('statusUpdate', { file: originalName, status: 'processing', message: 'جاري استخراج الرقم...' });

            const dataBuffer = fs.readFileSync(filePath);
            const data = await pdfParse(dataBuffer);
            
            let text = data.text || "";
            let currentNumber = extractPhoneNumber(text);
            
            if (!currentNumber || text.trim().length < 10) {
                 results.push({ file: originalName, success: false, reason: 'لم يتم العثور على نص أو رقم جوال.' });
                 io.emit('statusUpdate', { file: originalName, status: 'error', message: 'لم يتم العثور على رقم (تلقائي)' });
                 continue;
            }

            io.emit('statusUpdate', { file: originalName, status: 'sending', message: `الرقم: +${currentNumber}` });

            const numberId = `${currentNumber}@c.us`;
            const media = MessageMedia.fromFilePath(filePath);
            const caption = `مرحباً بك، مرفق طيه الفاتورة الخاصة بك، شكراً لتعاملك معنا.`;

            await client.sendMessage(numberId, media, { caption });
            
            results.push({ file: originalName, success: true, number: currentNumber });
            io.emit('statusUpdate', { file: originalName, status: 'success', message: `تم الإرسال بنجاح (${currentNumber})` });

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
