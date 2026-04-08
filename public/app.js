const socket = io();

// PDF.js worker setup
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

// UI Elements
const qrContainer = document.getElementById('qr-container');
const qrImage = document.getElementById('qr-image');
const loader = document.getElementById('loader');
const readyContainer = document.getElementById('ready-container');
const statusBadge = document.getElementById('status-badge');
const tabs = document.querySelectorAll('.tab');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const folderInput = document.getElementById('folder-input');
const processBtn = document.getElementById('process-btn');
const resultsBody = document.getElementById('results-body');

// Settings Elements
const uploadView = document.getElementById('upload-view');
const settingsView = document.getElementById('settings-view');
const settingMessage = document.getElementById('setting-message');
const settingLink = document.getElementById('setting-link');
const settingBlacklist = document.getElementById('setting-blacklist');
const saveSettingsBtn = document.getElementById('save-settings-btn');

let activeInput = fileInput;
let selectedFiles = [];
let isReady = false;
let appSettings = {};

// Fetch Settings on Load
async function fetchSettings() {
    try {
        const response = await fetch('/api/settings');
        appSettings = await response.json();
        
        // Fill form
        settingMessage.value = appSettings.messageTemplate;
        settingLink.value = appSettings.reviewLink;
        settingBlacklist.value = (appSettings.blacklist || []).join(', ');
    } catch (err) {
        console.error('Error fetching settings:', err);
    }
}
fetchSettings();

// Save Settings
saveSettingsBtn.addEventListener('click', async () => {
    saveSettingsBtn.disabled = true;
    saveSettingsBtn.innerHTML = 'جاري الحفظ...';
    
    const newSettings = {
        messageTemplate: settingMessage.value,
        reviewLink: settingLink.value,
        blacklist: settingBlacklist.value.split(',').map(n => n.trim()).filter(n => n.length > 0)
    };

    try {
        const response = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newSettings)
        });

        if (response.ok) {
            appSettings = newSettings;
            alert('تم حفظ الإعدادات بنجاح!');
        } else {
            alert('فشل حفظ الإعدادات.');
        }
    } catch (err) {
        console.error('Error saving settings:', err);
    } finally {
        saveSettingsBtn.disabled = false;
        saveSettingsBtn.innerHTML = 'حفظ الإعدادات';
    }
});

// Socket Events
socket.on('qr', (qrDataUrl) => {
    loader.style.display = 'none';
    qrImage.style.display = 'block';
    qrImage.src = qrDataUrl;
});

socket.on('ready', (status) => {
    isReady = status;
    if (status) {
        qrContainer.style.display = 'none';
        readyContainer.style.display = 'block';
        statusBadge.textContent = 'الواتساب متصل';
        statusBadge.className = 'badge ready';
        checkReadyState();
    } else {
        qrContainer.style.display = 'block';
        readyContainer.style.display = 'none';
        statusBadge.textContent = 'الواتساب غير متصل';
        statusBadge.className = 'badge not-ready';
        qrImage.style.display = 'none';
        loader.style.display = 'block';
        checkReadyState();
    }
});

socket.on('authenticated', () => {
    qrImage.style.display = 'none';
    loader.style.display = 'block';
    document.querySelector('.qr-text').textContent = 'تمت المصادقة، جاري تحميل الواتساب...';
});

// Update the result table in real-time
let rowMap = {};
function updateRow(file, status, message) {
    let tr = rowMap[file];
    
    if (resultsBody.querySelector('.empty-row')) {
        resultsBody.innerHTML = '';
    }

    if (!tr) {
        tr = document.createElement('tr');
        rowMap[file] = tr;
        resultsBody.prepend(tr);
    }

    let statusClass = 'status-sending';
    if(status === 'success') statusClass = 'status-success';
    if(status === 'error') statusClass = 'status-error';

    let displayNum = '---';
    const numMatch = message.match(/\+966\d+/);
    if(numMatch) displayNum = numMatch[0];

    tr.innerHTML = `
        <td>${file}</td>
        <td dir="ltr" style="text-align:right;">${displayNum}</td>
        <td><span class="status-indicator ${statusClass}">${message}</span></td>
    `;
}

socket.on('statusUpdate', (data) => {
    updateRow(data.file, data.status, data.message);
});

// Help functions for OCR
async function extractDataFromPDF(file) {
    try {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const page = await pdf.getPage(1);
        
        // 1. Try to get text layer first
        const textContent = await page.getTextContent();
        const rawText = textContent.items.map(item => item.str).join(' ');
        let number = findPhoneNumber(rawText);
        let name = findCustomerName(rawText);
        
        if (number && name) return { number, name };

        // 2. OCR Fallback
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;

        await page.render({ canvasContext: context, viewport: viewport }).promise;
        const imageData = canvas.toDataURL('image/png');

        updateRow(file.name, 'processing', 'جاري قراءة الصورة (OCR)...');
        const result = await Tesseract.recognize(imageData, 'eng+ara');
        const ocrText = result.data.text;
        
        return {
            number: number || findPhoneNumber(ocrText),
            name: name || findCustomerName(ocrText)
        };

    } catch (err) {
        console.error('OCR Error:', err);
        return { number: null, name: "" };
    }
}

function findPhoneNumber(text) {
    if (!text) return null;
    const blacklist = appSettings.blacklist || [];
    
    const matches = [];
    const match05 = text.match(/\b05\d{8}\b/g);
    if (match05) match05.forEach(m => matches.push("966" + m.substring(1)));

    const match5 = text.match(/\b5\d{8}\b/g);
    if (match5) match5.forEach(m => matches.push("966" + m));

    const validMatches = matches.filter(num => !blacklist.includes(num));

    if (validMatches.length > 1) {
        for (const num of validMatches) {
            const originalNum = num.replace("966", "");
            const index = text.indexOf(originalNum);
            if (index !== -1) {
                const context = text.substring(Math.max(0, index - 50), index);
                if (context.includes("جوال") || context.includes("العميل")) return num;
            }
        }
    }
    return validMatches.length > 0 ? validMatches[0] : null;
}

function findCustomerName(text) {
    if (!text) return "";
    
    const patterns = [
        /(?:اسم|إسم|ا[\s]?سم)\s+(?:العميل)?[:\s]+([^\n\r\|0-9]{3,40})/i,
        /العميل[:\s]+([^\n\r\|0-9]{3,40})/i
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

// Setup Tabs
tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        
        const type = tab.getAttribute('data-type');
        if (type === 'settings') {
            uploadView.style.display = 'none';
            settingsView.style.display = 'block';
        } else {
            uploadView.style.display = 'block';
            settingsView.style.display = 'none';
            activeInput = type === 'files' ? fileInput : folderInput;
            selectedFiles = [];
            updateDropZoneUI();
            checkReadyState();
        }
    });
});

dropZone.addEventListener('click', () => activeInput.click());
fileInput.addEventListener('change', handleFiles);
folderInput.addEventListener('change', handleFiles);

function handleFiles(e) {
    const files = Array.from(e.target.files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
    selectedFiles = files;
    updateDropZoneUI();
    checkReadyState();
}

function updateDropZoneUI() {
    if (selectedFiles.length > 0) {
        dropZone.querySelector('h3').textContent = `تم تحديد ${selectedFiles.length} ملف`;
        dropZone.querySelector('p').textContent = 'جاهز لبدء المعالجة...';
    } else {
        dropZone.querySelector('h3').textContent = 'اسحب الفواتير وأفلتها هنا';
        dropZone.querySelector('p').textContent = 'أو انقر للاختيار';
    }
}

function checkReadyState() {
    processBtn.disabled = !(isReady && selectedFiles.length > 0);
}

// Main Process Loop
processBtn.addEventListener('click', async () => {
    if(selectedFiles.length === 0 || !isReady) return;

    processBtn.disabled = true;
    processBtn.innerHTML = 'جاري المعالجة...';

    rowMap = {};
    resultsBody.innerHTML = '';

    for (const file of selectedFiles) {
        updateRow(file.name, 'processing', 'جاري تحليل الملف...');
        
        try {
            const extractedData = await extractDataFromPDF(file);
            
            if (!extractedData.number) {
                updateRow(file.name, 'error', 'فشل استخراج الرقم من الصورة');
                continue;
            }
            
            const displayName = (extractedData.name && extractedData.name.length > 2) ? extractedData.name : "";
            updateRow(file.name, 'sending', `الرقم: +${extractedData.number} ${displayName ? `(${displayName})` : ''}`);

            const formData = new FormData();
            formData.append('invoice', file);
            formData.append('phoneNumber', extractedData.number);
            formData.append('customerName', displayName);

            const response = await fetch('/api/send-direct', {
                method: 'POST',
                body: formData
            });

            if (response.ok) {
                updateRow(file.name, 'success', `تم الإرسال بنجاح (+${extractedData.number})`);
            } else {
                const err = await response.json();
                updateRow(file.name, 'error', err.error || 'فشل الإرسال');
            }

        } catch (err) {
            updateRow(file.name, 'error', 'خطأ في معالجة الملف');
            console.error(err);
        }
        
        await new Promise(r => setTimeout(r, 2000));
    }

    processBtn.innerHTML = 'إرسال الفواتير';
    selectedFiles = [];
    updateDropZoneUI();
    checkReadyState();
});
