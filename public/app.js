const socket = io();

// PDF.js worker setup
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

// DOM Elements - Session & Stats
const qrContainer = document.getElementById('qr-container');
const qrImage = document.getElementById('qr-image');
const loader = document.getElementById('loader');
const readyContainer = document.getElementById('ready-container');
const statusBadge = document.getElementById('status-badge');
const refreshSessionBtn = document.getElementById('refresh-session-btn');
const logoutBtn = document.getElementById('logout-btn');
const activeBranchLabel = document.getElementById('active-branch-label');

const statTotal = document.getElementById('stat-total');
const statSuccess = document.getElementById('stat-success');
const statFailed = document.getElementById('stat-failed');
const statDaily = document.getElementById('stat-daily');

// Tabs & Navigation
const navTabs = document.querySelectorAll('.nav-tab');
const tabBatch = document.getElementById('tab-batch');
const tabDirect = document.getElementById('tab-direct');
const tabSettings = document.getElementById('tab-settings');

// Batch Upload Elements
const dropZone = document.getElementById('drop-zone');
const dropTitle = document.getElementById('drop-title');
const dropDesc = document.getElementById('drop-desc');
const fileInput = document.getElementById('file-input');
const folderInput = document.getElementById('folder-input');
const filesSummaryBar = document.getElementById('files-summary-bar');
const fileCountBadge = document.getElementById('file-count-badge');
const clearSelectedFilesBtn = document.getElementById('clear-selected-files-btn');
const batchProgressContainer = document.getElementById('batch-progress-container');
const progressBarFill = document.getElementById('progress-bar-fill');
const progressStatusText = document.getElementById('progress-status-text');
const progressPercentText = document.getElementById('progress-percent-text');
const antibanTimerBox = document.getElementById('antiban-timer-box');
const antibanTimerText = document.getElementById('antiban-timer-text');
const processBtn = document.getElementById('process-btn');
const cancelBatchBtn = document.getElementById('cancel-batch-btn');

// Direct Send Elements
const directPhone = document.getElementById('direct-phone');
const directName = document.getElementById('direct-name');
const directFilePicker = document.getElementById('direct-file-picker');
const directFileInput = document.getElementById('direct-file-input');
const directFileName = document.getElementById('direct-file-name');
const directSendBtn = document.getElementById('direct-send-btn');
let selectedDirectFile = null;

// Settings & Branch Elements
const branchSelect = document.getElementById('branch-select');
const addBranchBtn = document.getElementById('add-branch-btn');
const deleteBranchBtn = document.getElementById('delete-branch-btn');
const addBranchModal = document.getElementById('add-branch-modal');
const closeModalBtn = document.getElementById('close-modal-btn');
const cancelBranchBtn = document.getElementById('cancel-branch-btn');
const saveNewBranchBtn = document.getElementById('save-new-branch-btn');
const newBranchIdInput = document.getElementById('new-branch-id');
const newBranchNameInput = document.getElementById('new-branch-name');

const settingMessage = document.getElementById('setting-message');
const settingLink = document.getElementById('setting-link');
const settingBlacklist = document.getElementById('setting-blacklist');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const previewText = document.getElementById('preview-text');
const rerollPreviewBtn = document.getElementById('reroll-preview-btn');
const tagBtns = document.querySelectorAll('.tag-btn');

// Anti-Ban Config Inputs
const settingMinDelay = document.getElementById('setting-min-delay');
const settingMaxDelay = document.getElementById('setting-max-delay');
const settingBatchSize = document.getElementById('setting-batch-size');
const settingCooldown = document.getElementById('setting-cooldown');
const settingDailyLimit = document.getElementById('setting-daily-limit');
const settingSimulateTyping = document.getElementById('setting-simulate-typing');

// Results & Table Elements
const resultsBody = document.getElementById('results-body');
const exportCsvBtn = document.getElementById('export-csv-btn');
const clearResultsBtn = document.getElementById('clear-results-btn');
const filterChips = document.querySelectorAll('.filter-chip');
const countAll = document.getElementById('count-all');
const countSuccess = document.getElementById('count-success');
const countError = document.getElementById('count-error');

// State
let activeInput = fileInput;
let selectedFiles = [];
let isReady = false;
let appSettings = {};
let currentBranchId = "default";
let isSwitching = false;
let isProcessingCancelled = false;

// Statistics & Records
let records = [];
let stats = { total: 0, success: 0, failed: 0 };

function getTodayKey() {
    return new Date().toISOString().slice(0, 10);
}

// --- Arabic Digit Normalizer ---
function normalizeDigits(str) {
    if (!str) return "";
    const arabicDigits = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
    return str.replace(/[٠-٩]/g, d => arabicDigits.indexOf(d).toString());
}

// --- Spintax Parser for Message Preview ---
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

// --- Fetch Settings ---
async function fetchSettings() {
    try {
        const response = await fetch('/api/settings');
        appSettings = await response.json();
        currentBranchId = appSettings.activeBranch || "default";
        
        // Populate branches
        branchSelect.innerHTML = '';
        if (appSettings.branches) {
            for (const [bId, bData] of Object.entries(appSettings.branches)) {
                const option = document.createElement('option');
                option.value = bId;
                option.textContent = bData.name || bId;
                if (bId === currentBranchId) option.selected = true;
                branchSelect.appendChild(option);
            }
        }
        
        updateSettingsForm();
        updateBranchDisplay();
        updateDailyQuotaDisplay();
    } catch (err) {
        console.error('Error fetching settings:', err);
    }
}
fetchSettings();

function updateBranchDisplay() {
    const branchName = (appSettings.branches && appSettings.branches[currentBranchId]) 
        ? appSettings.branches[currentBranchId].name 
        : currentBranchId;
    activeBranchLabel.textContent = `الفرع النشط: ${branchName}`;
}

function updateDailyQuotaDisplay() {
    if (!appSettings.branches || !appSettings.branches[currentBranchId]) return;
    const branch = appSettings.branches[currentBranchId];
    const today = getTodayKey();
    const sentCount = (branch.dailyCount && branch.dailyCount[today]) || 0;
    const limit = (branch.antiBan && branch.antiBan.dailyLimit) || 150;
    statDaily.textContent = `${sentCount} / ${limit}`;
}

function updateSettingsForm() {
    if (!appSettings.branches || !appSettings.branches[currentBranchId]) return;
    const branch = appSettings.branches[currentBranchId];
    settingMessage.value = branch.messageTemplate || "";
    settingLink.value = branch.reviewLink || "";
    settingBlacklist.value = (branch.blacklist || []).join(', ');

    const antiBan = branch.antiBan || {};
    settingMinDelay.value = antiBan.minDelay || 10;
    settingMaxDelay.value = antiBan.maxDelay || 20;
    settingBatchSize.value = antiBan.batchSize || 8;
    settingCooldown.value = antiBan.batchCooldown || 60;
    settingDailyLimit.value = antiBan.dailyLimit || 150;
    settingSimulateTyping.checked = antiBan.simulateTyping !== false;

    updateLivePreview();
}

function updateLivePreview() {
    let msg = settingMessage.value || "";
    const branchName = (appSettings.branches && appSettings.branches[currentBranchId]) 
        ? appSettings.branches[currentBranchId].name 
        : "الفرع الرئيسي";
    const link = settingLink.value || "https://reviewthis.biz/example";
    
    msg = parseSpintax(msg);
    msg = msg.replace(/\{\{name\}\}/gi, " أ. محمد الشمري");
    msg = msg.replace(/\{\{link\}\}/gi, link);
    msg = msg.replace(/\{\{branch\}\}/gi, branchName);
    
    previewText.textContent = msg || "(اكتب نص الرسالة في الحقل لمعاينته هنا...)";
}

settingMessage.addEventListener('input', updateLivePreview);
settingLink.addEventListener('input', updateLivePreview);
rerollPreviewBtn.addEventListener('click', updateLivePreview);

// Insert Template Tags
tagBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const tag = btn.getAttribute('data-tag');
        const start = settingMessage.selectionStart;
        const end = settingMessage.selectionEnd;
        const text = settingMessage.value;
        settingMessage.value = text.substring(0, start) + " " + tag + " " + text.substring(end);
        settingMessage.focus();
        updateLivePreview();
    });
});

// Branch Switching
branchSelect.addEventListener('change', async (e) => {
    const newBranch = e.target.value;
    if (newBranch === currentBranchId) return;
    
    isSwitching = true;
    loader.style.display = 'flex';
    qrImage.style.display = 'none';
    readyContainer.style.display = 'none';
    qrContainer.style.display = 'block';
    statusBadge.className = 'badge-status badge-offline';
    statusBadge.querySelector('.status-text').textContent = 'جاري التبديل...';
    
    try {
        await fetch('/api/branches/switch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ branchId: newBranch })
        });
    } catch(err) {
        console.error(err);
        isSwitching = false;
    }
});

// Add Branch Modal
addBranchBtn.addEventListener('click', () => { addBranchModal.style.display = 'flex'; });
closeModalBtn.addEventListener('click', () => { addBranchModal.style.display = 'none'; });
cancelBranchBtn.addEventListener('click', () => { addBranchModal.style.display = 'none'; });

saveNewBranchBtn.addEventListener('click', async () => {
    const bId = newBranchIdInput.value.trim().toLowerCase().replace(/\s+/g, '-');
    const bName = newBranchNameInput.value.trim();
    if (!bId || !bName) {
        alert("الرجاء إدخال رمز واسم الفرع بشكل صحيح");
        return;
    }
    
    saveNewBranchBtn.disabled = true;
    try {
        const res = await fetch('/api/branches/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ branchId: bId, name: bName })
        });
        const result = await res.json();
        if (result.success) {
            await fetchSettings();
            addBranchModal.style.display = 'none';
            newBranchIdInput.value = '';
            newBranchNameInput.value = '';
            branchSelect.value = bId;
            branchSelect.dispatchEvent(new Event('change'));
        } else {
            alert(result.error);
        }
    } catch(err) {
        alert("حدث خطأ أثناء إنشاء الفرع");
    } finally {
        saveNewBranchBtn.disabled = false;
    }
});

// Delete Branch
deleteBranchBtn.addEventListener('click', async () => {
    if (!confirm(`هل أنت متأكد من حذف فرع (${branchSelect.options[branchSelect.selectedIndex]?.text || currentBranchId})؟`)) return;
    
    try {
        const res = await fetch(`/api/branches/${currentBranchId}`, { method: 'DELETE' });
        const result = await res.json();
        if (result.success) {
            await fetchSettings();
            alert('تم حذف الفرع بنجاح');
        } else {
            alert(result.error || 'تعذر حذف الفرع');
        }
    } catch (e) {
        alert('حدث خطأ أثناء الحذف');
    }
});

// Save Settings & Anti-Ban Config
saveSettingsBtn.addEventListener('click', async () => {
    saveSettingsBtn.disabled = true;
    saveSettingsBtn.innerHTML = '<span>جاري الحفظ...</span>';
    
    const newSettings = {
        messageTemplate: settingMessage.value,
        reviewLink: settingLink.value,
        blacklist: settingBlacklist.value.split(',').map(n => n.trim()).filter(n => n.length > 0),
        antiBan: {
            minDelay: parseInt(settingMinDelay.value, 10) || 10,
            maxDelay: parseInt(settingMaxDelay.value, 10) || 20,
            batchSize: parseInt(settingBatchSize.value, 10) || 8,
            batchCooldown: parseInt(settingCooldown.value, 10) || 60,
            dailyLimit: parseInt(settingDailyLimit.value, 10) || 150,
            simulateTyping: settingSimulateTyping.checked,
            useSpintax: true
        }
    };

    try {
        const response = await fetch(`/api/settings/${currentBranchId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newSettings)
        });

        if (response.ok) {
            appSettings.branches[currentBranchId] = {
                ...appSettings.branches[currentBranchId],
                ...newSettings
            };
            updateDailyQuotaDisplay();
            alert('✅ تم حفظ إعدادات الفرع والحماية من الحظر بنجاح!');
        } else {
            alert('فشل حفظ الإعدادات.');
        }
    } catch (err) {
        console.error('Error saving settings:', err);
    } finally {
        saveSettingsBtn.disabled = false;
        saveSettingsBtn.innerHTML = '<span>💾 حفظ إعدادات الفرع والحماية</span>';
    }
});

// WhatsApp Session Management
refreshSessionBtn.addEventListener('click', async () => {
    if (confirm('هل تريد إعادة تهيئة جلسة واتساب وتحديث الرمز؟')) {
        await fetch('/api/whatsapp/restart', { method: 'POST' });
    }
});

logoutBtn.addEventListener('click', async () => {
    if (confirm('هل أنت متأكد من رغبتك في تسجيل الخروج من واتساب لهذا الفرع؟')) {
        await fetch('/api/whatsapp/logout', { method: 'POST' });
    }
});

// Socket.io Real-time Events
socket.on('branchSwitched', (branchId) => {
    currentBranchId = branchId;
    isSwitching = false;
    if (branchSelect.value !== branchId) {
        branchSelect.value = branchId;
    }
    updateSettingsForm();
    updateBranchDisplay();
    updateDailyQuotaDisplay();
});

socket.on('qr', (qrDataUrl) => {
    loader.style.display = 'none';
    qrContainer.style.display = 'block';
    readyContainer.style.display = 'none';
    qrImage.style.display = 'block';
    qrImage.src = qrDataUrl;
    statusBadge.className = 'badge-status badge-offline';
    statusBadge.querySelector('.status-text').textContent = 'بانتظار المسح (QR)';
});

socket.on('ready', (status) => {
    isReady = status;
    if (status) {
        qrContainer.style.display = 'none';
        readyContainer.style.display = 'flex';
        statusBadge.className = 'badge-status badge-online';
        statusBadge.querySelector('.status-text').textContent = 'متصل ومحمي 🛡️';
    } else {
        if (!isSwitching) {
            qrContainer.style.display = 'block';
            readyContainer.style.display = 'none';
            statusBadge.className = 'badge-status badge-offline';
            statusBadge.querySelector('.status-text').textContent = 'غير متصل';
            qrImage.style.display = 'none';
            loader.style.display = 'flex';
        }
    }
    checkReadyState();
    updateBranchDisplay();
});

socket.on('authenticated', () => {
    qrImage.style.display = 'none';
    loader.style.display = 'flex';
    statusBadge.querySelector('.status-text').textContent = 'جاري المزامنة...';
});

socket.on('error', (message) => {
    console.error('Socket Error:', message);
    alert('تنبيه الواتساب: ' + message);
});

// --- Tab Switching ---
navTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        navTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        const tabKey = tab.getAttribute('data-tab');
        if (tabKey === 'batch-files') {
            tabBatch.style.display = 'block';
            tabDirect.style.display = 'none';
            tabSettings.style.display = 'none';
            activeInput = fileInput;
            dropTitle.textContent = 'اسحب وأفلت الفواتير بصيغة PDF هنا';
            dropDesc.textContent = 'أو انقر لتصفح واختيار الملفات من جهازك';
        } else if (tabKey === 'batch-folder') {
            tabBatch.style.display = 'block';
            tabDirect.style.display = 'none';
            tabSettings.style.display = 'none';
            activeInput = folderInput;
            dropTitle.textContent = 'اسحب أو حدد مجلداً كاملاً للفواتير';
            dropDesc.textContent = 'انقر لاختيار مجلد الفواتير دفعة واحدة';
        } else if (tabKey === 'direct-send') {
            tabBatch.style.display = 'none';
            tabDirect.style.display = 'block';
            tabSettings.style.display = 'none';
        } else if (tabKey === 'settings') {
            tabBatch.style.display = 'none';
            tabDirect.style.display = 'none';
            tabSettings.style.display = 'block';
            updateSettingsForm();
        }
    });
});

// --- Batch File Management ---
dropZone.addEventListener('click', () => activeInput.click());
fileInput.addEventListener('change', handleBatchFiles);
folderInput.addEventListener('change', handleBatchFiles);

['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    }, false);
});
['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
    }, false);
});
dropZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    handleBatchFiles({ target: { files } });
});

function handleBatchFiles(e) {
    const files = Array.from(e.target.files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
    selectedFiles = files;
    updateBatchUI();
    checkReadyState();
}

clearSelectedFilesBtn.addEventListener('click', () => {
    selectedFiles = [];
    fileInput.value = '';
    folderInput.value = '';
    updateBatchUI();
    checkReadyState();
});

function updateBatchUI() {
    if (selectedFiles.length > 0) {
        filesSummaryBar.style.display = 'flex';
        fileCountBadge.textContent = `${selectedFiles.length} ملف فاتورة محدد`;
        statTotal.textContent = selectedFiles.length;
    } else {
        filesSummaryBar.style.display = 'none';
        statTotal.textContent = '0';
    }
}

function checkReadyState() {
    processBtn.disabled = !(isReady && selectedFiles.length > 0);
    directSendBtn.disabled = !(isReady && selectedDirectFile && directPhone.value.trim().length >= 8);
}

// --- Direct Single Send Handling ---
directFilePicker.addEventListener('click', () => directFileInput.click());
directFileInput.addEventListener('change', async (e) => {
    if (e.target.files && e.target.files[0]) {
        selectedDirectFile = e.target.files[0];
        directFileName.textContent = `📄 ${selectedDirectFile.name}`;
        
        try {
            const extracted = await extractDataFromPDF(selectedDirectFile);
            if (extracted.number && !directPhone.value) {
                directPhone.value = extracted.number.replace(/^966/, '');
            }
            if (extracted.name && !directName.value) {
                directName.value = extracted.name;
            }
        } catch (err) {}
        checkReadyState();
    }
});
directPhone.addEventListener('input', checkReadyState);

directSendBtn.addEventListener('click', async () => {
    if (!selectedDirectFile || !isReady) return;
    
    let rawPhone = normalizeDigits(directPhone.value).replace(/\D/g, '');
    if (rawPhone.startsWith('05')) rawPhone = '966' + rawPhone.substring(1);
    else if (rawPhone.startsWith('5')) rawPhone = '966' + rawPhone;
    
    const customerName = directName.value.trim();
    const fileName = selectedDirectFile.name;

    directSendBtn.disabled = true;
    directSendBtn.innerHTML = '<span>جاري الإرسال ومحاكاة الكتابة...</span>';

    addRecord(fileName, customerName, rawPhone, 'processing', 'جاري الإرسال الآمن...');

    try {
        const formData = new FormData();
        formData.append('invoice', selectedDirectFile);
        formData.append('phoneNumber', rawPhone);
        formData.append('customerName', customerName);

        const response = await fetch('/api/send-direct', {
            method: 'POST',
            body: formData
        });

        const data = await response.json();
        if (response.ok && data.success) {
            updateRecord(fileName, customerName, rawPhone, 'success', 'تم الإرسال بنجاح');
            alert(`✅ تم إرسال الفاتورة بنجاح إلى (+${rawPhone})`);
            selectedDirectFile = null;
            directFileName.textContent = 'انقر هنا لاختيار ملف الفاتورة';
            directFileInput.value = '';
            directPhone.value = '';
            directName.value = '';
            fetchSettings();
        } else {
            updateRecord(fileName, customerName, rawPhone, 'error', data.error || 'فشل الإرسال');
            alert(`❌ تعذر الإرسال: ${data.error || 'خطأ غير معروف'}`);
        }
    } catch (err) {
        updateRecord(fileName, customerName, rawPhone, 'error', 'خطأ في الاتصال بالخادم');
    } finally {
        directSendBtn.disabled = false;
        directSendBtn.innerHTML = '<span>✉️ إرسال الفاتورة الآن (مع محاكاة الكتابة)</span>';
        checkReadyState();
    }
});

// --- Smart Extraction (PDF & OCR) ---
async function extractDataFromPDF(file) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const page = await pdf.getPage(1);
        
        // 1. Digital text layer
        const textContent = await page.getTextContent();
        const rawText = textContent.items.map(item => item.str).join(' ');
        const normalizedText = normalizeDigits(rawText);
        
        let number = findPhoneNumber(normalizedText);
        let name = findCustomerName(normalizedText);
        
        if (number) return { number, name: name || "" };

        // 2. High-res OCR fallback
        const viewport = page.getViewport({ scale: 2.2 });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        await page.render({ canvasContext: context, viewport: viewport }).promise;
        const imageData = canvas.toDataURL('image/png');

        updateRecord(file.name, name, '---', 'processing', 'جاري المسح الضوئي (OCR)...');
        const result = await Tesseract.recognize(imageData, 'ara+eng');
        const ocrText = normalizeDigits(result.data.text);
        
        return {
            number: findPhoneNumber(ocrText),
            name: name || findCustomerName(ocrText)
        };
    } catch (err) {
        console.error('Extraction Error:', err);
        return { number: null, name: "" };
    }
}

function findPhoneNumber(text) {
    if (!text) return null;
    const branch = appSettings.branches ? appSettings.branches[currentBranchId] : {};
    const blacklist = (branch.blacklist || []).map(b => normalizeDigits(b).replace(/\D/g, ''));
    
    const matches = [];

    // +9665XXXXXXXX or 009665XXXXXXXX
    const matchIntl = text.match(/(?:\+966|00966)[\s-]?([5]\d{8})\b/g);
    if (matchIntl) {
        matchIntl.forEach(m => {
            const clean = m.replace(/\D/g, '');
            if (clean.startsWith('00966')) matches.push('966' + clean.substring(5));
            else if (clean.startsWith('966')) matches.push(clean);
        });
    }

    // 05XXXXXXXX (with optional spaces/dashes)
    const match05 = text.match(/\b05[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d\b/g);
    if (match05) match05.forEach(m => matches.push("966" + m.replace(/\D/g, '').substring(1)));

    // 5XXXXXXXX
    const match5 = text.match(/\b5[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d[\s-]?\d\b/g);
    if (match5) match5.forEach(m => matches.push("966" + m.replace(/\D/g, '')));

    const validMatches = [...new Set(matches)].filter(num => !blacklist.includes(num));

    if (validMatches.length > 1) {
        for (const num of validMatches) {
            const short = num.replace("966", "");
            const idx = text.indexOf(short);
            if (idx !== -1) {
                const ctx = text.substring(Math.max(0, idx - 50), idx + short.length + 30);
                if (ctx.includes("جوال") || ctx.includes("عميل") || ctx.includes("هاتف") || ctx.includes("موبايل")) {
                    return num;
                }
            }
        }
    }

    return validMatches.length > 0 ? validMatches[0] : null;
}

function findCustomerName(text) {
    if (!text) return "";
    const patterns = [
        /(?:اسم\s+العميل|العميل|السيد|المكرم|حضرة\s+السيد)[:\s]+([^\n\r\|0-9]{3,35})/i,
        /الاسم[:\s]+([^\n\r\|0-9]{3,35})/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
            let name = match[1].trim();
            name = name.split(/\s{2,}/)[0];
            name = name.replace(/[\|\_\-\:\d]+$/, "").trim();
            if (name.length > 2) return name;
        }
    }
    return "";
}

// --- Anti-Ban Countdown Helper ---
async function countdown(seconds, labelPrefix = "فاصل أمان ذكي") {
    antibanTimerBox.style.display = 'flex';
    for (let sec = seconds; sec > 0; sec--) {
        if (isProcessingCancelled) break;
        antibanTimerText.textContent = `${labelPrefix}: متبقي ${sec} ثانية...`;
        await new Promise(r => setTimeout(r, 1000));
    }
    antibanTimerBox.style.display = 'none';
}

// --- Batch Execution Loop with Anti-Ban Pacing ---
processBtn.addEventListener('click', async () => {
    if (selectedFiles.length === 0 || !isReady) return;

    isProcessingCancelled = false;
    processBtn.style.display = 'none';
    cancelBatchBtn.style.display = 'inline-flex';
    batchProgressContainer.style.display = 'block';

    const branch = (appSettings.branches && appSettings.branches[currentBranchId]) || {};
    const antiBan = branch.antiBan || { minDelay: 10, maxDelay: 20, batchSize: 8, batchCooldown: 60 };

    const total = selectedFiles.length;
    stats = { total, success: 0, failed: 0 };
    updateStatsUI();

    let consecutiveSent = 0;

    for (let i = 0; i < total; i++) {
        if (isProcessingCancelled) {
            alert('تم إيقاف عملية الإرسال.');
            break;
        }

        const file = selectedFiles[i];
        const percent = Math.round(((i + 1) / total) * 100);
        progressBarFill.style.width = `${percent}%`;
        progressPercentText.textContent = `${percent}% (${i + 1}/${total})`;
        progressStatusText.textContent = `جاري معالجة: ${file.name}`;

        addRecord(file.name, "", "---", "processing", "جاري قراءة واستخراج البيانات...");

        try {
            const extracted = await extractDataFromPDF(file);
            
            if (!extracted.number) {
                updateRecord(file.name, extracted.name || "---", "---", "error", "لم يتم العثور على رقم جوال");
                stats.failed++;
                updateStatsUI();
                continue;
            }

            const phone = extracted.number;
            const name = extracted.name || "";
            updateRecord(file.name, name, `+${phone}`, "sending", "جاري الإرسال الآمن (محاكاة الكتابة)...");

            const formData = new FormData();
            formData.append('invoice', file);
            formData.append('phoneNumber', phone);
            formData.append('customerName', name);

            const res = await fetch('/api/send-direct', { method: 'POST', body: formData });
            const data = await res.json();

            if (res.ok && data.success) {
                updateRecord(file.name, name, `+${phone}`, "success", "تم الإرسال بنجاح");
                stats.success++;
                consecutiveSent++;
            } else {
                updateRecord(file.name, name, `+${phone}`, "error", data.error || "فشل الإرسال");
                stats.failed++;
            }
        } catch (err) {
            updateRecord(file.name, "---", "---", "error", "خطأ أثناء المعالجة");
            stats.failed++;
        }

        updateStatsUI();
        updateDailyQuotaDisplay();

        // Check if more files remain
        if (i < total - 1 && !isProcessingCancelled) {
            // Check for Batch Cooldown
            if (consecutiveSent > 0 && consecutiveSent % antiBan.batchSize === 0) {
                const cooldownDuration = antiBan.batchCooldown || 60;
                await countdown(cooldownDuration, "⏸️ استراحة وتبريد بعد دفعة فواتير (حماية من الحظر)");
            } else {
                // Random Delay between minDelay and maxDelay
                const min = antiBan.minDelay || 10;
                const max = antiBan.maxDelay || 20;
                const randomSeconds = Math.floor(Math.random() * (max - min + 1)) + min;
                await countdown(randomSeconds, "🛡️ فاصل أمان عشوائي");
            }
        }
    }

    processBtn.style.display = 'inline-flex';
    cancelBatchBtn.style.display = 'none';
    antibanTimerBox.style.display = 'none';
    progressStatusText.textContent = 'اكتملت جميع العمليات.';
    selectedFiles = [];
    updateBatchUI();
    checkReadyState();
    fetchSettings();
});

cancelBatchBtn.addEventListener('click', () => {
    isProcessingCancelled = true;
});

// --- Records & Stats UI Handling ---
let recordRows = {};

function addRecord(file, name, phone, status, message) {
    const existing = records.find(r => r.file === file);
    const now = new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });
    
    if (existing) {
        existing.name = name || existing.name;
        existing.phone = phone || existing.phone;
        existing.status = status;
        existing.message = message;
        renderRow(existing);
    } else {
        const newRecord = {
            id: records.length + 1,
            file,
            name: name || "---",
            phone: phone || "---",
            status,
            message,
            time: now
        };
        records.unshift(newRecord);
        renderRow(newRecord, true);
    }
    updateFilterCounts();
}

function updateRecord(file, name, phone, status, message) {
    addRecord(file, name, phone, status, message);
}

function renderRow(rec, isNew = false) {
    if (resultsBody.querySelector('.empty-row')) {
        resultsBody.innerHTML = '';
    }

    let tr = recordRows[rec.file];
    if (!tr) {
        tr = document.createElement('tr');
        tr.dataset.status = rec.status;
        recordRows[rec.file] = tr;
        resultsBody.prepend(tr);
    }

    tr.dataset.status = rec.status;
    let badgeClass = rec.status;

    tr.innerHTML = `
        <td style="color: #94a3b8; font-weight: bold;">${rec.id}</td>
        <td style="font-weight: 700; color: var(--dark);">${rec.file}</td>
        <td>${rec.name}</td>
        <td dir="ltr" style="text-align:right; font-family:monospace; font-weight:700;">${rec.phone}</td>
        <td><span class="status-badge-inline ${badgeClass}">${rec.message}</span></td>
        <td style="color: #64748b; font-size: 0.8rem;">${rec.time}</td>
    `;
}

function updateStatsUI() {
    statTotal.textContent = stats.total;
    statSuccess.textContent = stats.success;
    statFailed.textContent = stats.failed;
}

function updateFilterCounts() {
    countAll.textContent = records.length;
    countSuccess.textContent = records.filter(r => r.status === 'success').length;
    countError.textContent = records.filter(r => r.status === 'error').length;
}

// Table Filter
filterChips.forEach(chip => {
    chip.addEventListener('click', () => {
        filterChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        const filter = chip.getAttribute('data-filter');

        Object.values(recordRows).forEach(tr => {
            if (filter === 'all' || tr.dataset.status === filter) {
                tr.style.display = '';
            } else {
                tr.style.display = 'none';
            }
        });
    });
});

// Clear Log
clearResultsBtn.addEventListener('click', () => {
    if (records.length === 0) return;
    if (confirm('هل تريد مسح سجل العمليات الحالي؟')) {
        records = [];
        recordRows = {};
        resultsBody.innerHTML = '<tr class="empty-row"><td colspan="6">لا توجد عمليات إرسال حتى الآن. قم برفع الفواتير للبدء.</td></tr>';
        updateFilterCounts();
    }
});

// Export to CSV
exportCsvBtn.addEventListener('click', () => {
    if (records.length === 0) {
        alert('لا توجد بيانات لتصديرها.');
        return;
    }

    let csvContent = "\uFEFFرقم,اسم الملف,اسم العميل,رقم الجوال,الحالة,التفاصيل,الوقت\n";
    records.forEach(r => {
        csvContent += `"${r.id}","${r.file}","${r.name}","${r.phone}","${r.status}","${r.message}","${r.time}"\n`;
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `تقرير_إرسال_الفواتير_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
});
