// تكوين Firebase
const firebaseConfig = {
    apiKey: "AIzaSyDhdID2wAdkpl-Hc-8mWvMz83PNfAgRto8",
    authDomain: "kid-id.firebaseapp.com",
    databaseURL: "https://kid-id-default-rtdb.firebaseio.com",
    projectId: "kid-id",
    storageBucket: "kid-id.appspot.com",
    messagingSenderId: "921217378956"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const database = firebase.database();
const storage = firebase.storage();

// متغيرات عامة
let currentUser = null;
let currentClinicName = null;
let selectedTooth = null;
let currentTreatment = null;
let toothTreatments = {};
let toothConnections = {};
let currentOrderStatus = 1;
let currentCaseId = null;
let currentCasePath = null;
let uploadedFileName = null;
let isReadOnly = false;
let currentSecretCode = null;
let pendingUploadFile = null; // الملف اللي اتختار قبل ما الحالة تتحفظ

// AI Chat
let currentConversation = [];
let openAiApiKey = null;
let aiSystemPrompt = null;

// Real-time listeners
let _caseListener = null;
let _caseListenerPath = null;
let _lastConversationLength = 0;

async function loadOpenAiApiKey() {
    if (openAiApiKey) return openAiApiKey;
    try {
        const snap = await database.ref('1/splashActivity/mainActivity').once('value');
        openAiApiKey = snap.val();
        return openAiApiKey;
    } catch (e) {
        console.error('Error fetching AI key:', e);
        return null;
    }
}

async function loadAiSystemPrompt() {
    if (aiSystemPrompt !== null) return aiSystemPrompt;
    try {
        const snap = await database.ref('dental lap/ai/prompt').once('value');
        aiSystemPrompt = snap.val() || '';
        return aiSystemPrompt;
    } catch (e) {
        console.error('Error fetching AI prompt:', e);
        return '';
    }
}

function showAiChat(prefillText) {
    // المساعد الذكي مقفول قبل حفظ الحالة
    if (!currentCaseId) {
        alert('🔒 احفظ الحالة أولاً لتفعيل المساعد الذكي للاستفسار عن المريض');
        return;
    }
    const overlay = document.getElementById('aiChatOverlay');
    if (!overlay) return;
    const notice = document.getElementById('aiUnsavedNotice');
    if (notice) notice.style.display = 'none';
    overlay.classList.remove('closing');
    overlay.style.display = 'flex';
    // إعادة تشغيل أنيميشن الفتح
    overlay.classList.remove('opening');
    void overlay.offsetWidth; // force reflow
    overlay.classList.add('opening');
    const sendInput = document.getElementById('aiSendInput');
    if (prefillText && sendInput) { sendInput.value = prefillText; }
    if (sendInput) sendInput.focus();
    const messagesDiv = document.getElementById('aiMessages');
    if (messagesDiv && messagesDiv.children.length === 0) {
        // أول رسالة ترحيبية مخصّصة بإسم الدكتور والمريض
        const doctorName  = (currentUser?.doctorName || '').trim();
        const patientName = (document.getElementById('patientName')?.value || '').trim();
        const greeting = `مرحبا دكتور ${doctorName}، عندك استفسار عن حالة المريض ${patientName}؟`;
        addAiMessage('bot', greeting);
    }
}

// إظهار/إخفاء شريط المساعد الذكي حسب حالة الحفظ
function updateAiBarVisibility() {
    const wrap   = document.getElementById('aiBarWrap');
    const locked = document.getElementById('aiBarLocked');
    const saved  = !!currentCaseId;
    if (wrap)   wrap.style.display   = saved ? 'flex'  : 'none';
    if (locked) locked.style.display = saved ? 'none'  : 'block';
}

// إغلاق محادثة الذكاء الاصطناعي مع أنيميشن نزول
function hideAiChat() {
    const overlay = document.getElementById('aiChatOverlay');
    if (!overlay || overlay.style.display === 'none') return;
    overlay.classList.remove('opening');
    overlay.classList.add('closing');
    // ننتظر انتهاء الأنيميشن قبل الإخفاء الفعلي
    setTimeout(() => {
        overlay.style.display = 'none';
        overlay.classList.remove('closing');
    }, 280);
}

// إعادة بناء واجهة الدردشة من سجل محادثة محفوظ (لكل حالة على حدة)
function rebuildAiMessagesUI(conversation) {
    const messagesDiv = document.getElementById('aiMessages');
    if (!messagesDiv) return;
    messagesDiv.innerHTML = '';
    (conversation || []).forEach(m => {
        if (m.role === 'admin') addAiMessage('admin', m.content);
        else addAiMessage(m.role === 'user' ? 'user' : 'bot', m.content);
    });
}

// بناء سياق بيانات الحالة الحالية للذكاء الاصطناعي
function buildCaseContext() {
    const patientName = document.getElementById('patientName')?.value?.trim() || '';
    const notes       = document.getElementById('notes')?.value?.trim() || '';
    const doctorName  = currentUser?.doctorName || '';
    const teethList   = Object.keys(toothTreatments || {});
    const treatmentsSummary = teethList.length
        ? teethList.map(t => `سن ${t}: ${toothTreatments[t]}`).join('، ')
        : 'لا توجد علاجات محددة';
    const statusNames = {1:'الإضافة لقائمة الانتظار',2:'وصول الطلب للمعمل',3:'وصول المندوب للعياده',4:'المعمل',5:'الشحن للعيادة'};
    const lines = [];
    if (patientName)        lines.push(`اسم المريض: ${patientName}`);
    if (doctorName)         lines.push(`اسم الطبيب: د. ${doctorName}`);
    if (currentUser?.governorate) lines.push(`المحافظة: ${currentUser.governorate}`);
    if (currentUser?.area)        lines.push(`المنطقة: ${currentUser.area}`);
    if (currentCaseId)      lines.push(`معرف الحالة: ${currentCaseId}`);
    if (currentSecretCode)  lines.push(`الرقم التأكيدي: ${currentSecretCode}`);
    lines.push(`عدد الأسنان المحددة: ${teethList.length}`);
    lines.push(`العلاجات: ${treatmentsSummary}`);
    lines.push(`حالة الطلب: ${statusNames[currentOrderStatus] || 'غير محدد'}`);
    if (notes)              lines.push(`الملاحظات: ${notes}`);
    if (uploadedFileName)   lines.push(`ملف السكان: ${uploadedFileName}`);
    return lines.join('\n');
}

function addAiMessage(sender, text) {
    const messagesDiv = document.getElementById('aiMessages');
    if (!messagesDiv) return null;
    const div = document.createElement('div');
    if (sender === 'admin') {
        div.className = 'ai-msg-admin';
    } else {
        div.className = sender === 'bot' ? 'ai-msg-bot' : 'ai-msg-user';
    }
    div.textContent = text;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    return div;
}

// كتابة نص الرسالة حرف ورا حرف (تأثير الـ typewriter)
function typeAiMessage(text, speed = 18) {
    return new Promise(resolve => {
        const messagesDiv = document.getElementById('aiMessages');
        if (!messagesDiv) { resolve(); return; }
        const div = document.createElement('div');
        div.className = 'ai-msg-bot';
        messagesDiv.appendChild(div);
        let i = 0;
        const tick = () => {
            if (i >= text.length) { resolve(); return; }
            div.textContent += text.charAt(i);
            i++;
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
            setTimeout(tick, speed);
        };
        tick();
    });
}

// جلب بيانات الطبيب من قاعدة البيانات لاستخدامها في سياق البوت
async function fetchDoctorDataForAi() {
    const doctorKey = (typeof getDoctorKey === 'function') ? getDoctorKey() : (currentUser?.doctorName || currentClinicName);
    if (!doctorKey) return null;
    try {
        const snap = await database.ref(`dental lap/users/doctors/data/${doctorKey}`).once('value');
        return snap.val();
    } catch (e) { console.error('fetchDoctorDataForAi error:', e); return null; }
}

// جلب بيانات الحالة المحفوظة من المسار case data
async function fetchSavedCaseDataForAi() {
    if (!currentCaseId) return null;
    try {
        const path = currentCasePath || `${getDatabasePath()}/${currentCaseId}`;
        const snap = await database.ref(path).once('value');
        return snap.val();
    } catch (e) { console.error('fetchSavedCaseDataForAi error:', e); return null; }
}

async function sendAiMessage() {
    const input = document.getElementById('aiSendInput');
    const text  = input ? input.value.trim() : '';
    if (!text) return;
    if (input) input.value = '';

    addAiMessage('user', text);
    currentConversation.push({ role: 'user', content: text });

    // لو آخر رسالة قبل رسالة المستخدم الحالية كانت من الإدارة — المساعد لا يرد
    const prevMsgs = currentConversation.slice(0, -1);
    const lastNonUser = [...prevMsgs].reverse().find(m => m.role !== 'user');
    if (lastNonUser && lastNonUser.role === 'admin') {
        // حفظ المحادثة فقط بدون رد الذكاء الاصطناعي
        if (currentCasePath) {
            database.ref(currentCasePath + '/conversation').set(currentConversation).catch(() => {});
        }
        return;
    }

    const messagesDiv = document.getElementById('aiMessages');
    const typingDiv   = document.createElement('div');
    typingDiv.className = 'ai-msg-bot ai-typing';
    typingDiv.textContent = '...';
    if (messagesDiv) { messagesDiv.appendChild(typingDiv); messagesDiv.scrollTop = messagesDiv.scrollHeight; }

    const sendBtn = document.getElementById('aiSendBtn');
    if (sendBtn) sendBtn.disabled = true;

    try {
        const apiKey = await loadOpenAiApiKey();
        if (!apiKey) {
            typingDiv.remove();
            addAiMessage('bot', '❌ لم يتم العثور على مفتاح الاتصال بالذكاء الاصطناعي');
            return;
        }

        const promptFromDb = await loadAiSystemPrompt();
        const baseSystem   = promptFromDb && promptFromDb.trim()
            ? promptFromDb
            : 'أنت مساعد ذكي متخصص في طب الأسنان والمختبرات السنية. أجب بالعربية دائماً وكن دقيقاً ومفيداً.';

        // جلب بيانات الطبيب والحالة المحفوظة من فايربيز في كل طلب
        const [doctorData, savedCase] = await Promise.all([
            fetchDoctorDataForAi(),
            fetchSavedCaseDataForAi()
        ]);

        let doctorBlock = '';
        if (doctorData) {
            const dlines = [];
            if (doctorData.doctorName)  dlines.push(`اسم الطبيب: د. ${doctorData.doctorName}`);
            if (doctorData.clinicName)  dlines.push(`اسم العيادة: ${doctorData.clinicName}`);
            if (doctorData.clinicId)    dlines.push(`رقم العيادة: ${doctorData.clinicId}`);
            if (doctorData.phoneNumber) dlines.push(`رقم الهاتف: ${doctorData.phoneNumber}`);
            if (doctorData.email)       dlines.push(`البريد: ${doctorData.email}`);
            if (doctorData.governorate) dlines.push(`المحافظة: ${doctorData.governorate}`);
            if (doctorData.area)        dlines.push(`المنطقة: ${doctorData.area}`);
            if (doctorData.location)    dlines.push(`الموقع: ${doctorData.location}`);
            doctorBlock = `\n\n=== بيانات الطبيب (من dental lap/users/doctors/data/${doctorData.doctorName}) ===\n${dlines.join('\n')}\n=== نهاية بيانات الطبيب ===`;
        }

        let caseBlock = '';
        if (savedCase) {
            const treatmentsList = savedCase.toothTreatments
                ? Object.entries(savedCase.toothTreatments).map(([t,v]) => `سن ${t}: ${v}`).join('، ')
                : 'لا يوجد';
            const statusNames = {1:'الإضافة لقائمة الانتظار',2:'وصول الطلب للمعمل',3:'وصول المندوب للعياده',4:'المعمل',5:'الشحن للعيادة'};
            const clines = [
                `معرف الحالة: ${savedCase.caseId || ''}`,
                `الرقم التأكيدي: ${savedCase.randomCode || ''}`,
                `اسم المريض: ${savedCase.patientName || ''}`,
                `التاريخ: ${savedCase.date || ''}`,
                `حالة الطلب: ${statusNames[savedCase.orderStatus] || savedCase.orderStatus || ''}`,
                `العلاجات: ${treatmentsList}`,
                `الملاحظات: ${savedCase.notes || 'لا يوجد'}`,
                savedCase.scannerFile ? `ملف السكان: ${savedCase.scannerFile}` : null,
                savedCase.scannerFileUrl ? `رابط الملف: ${savedCase.scannerFileUrl}` : null,
            ].filter(Boolean);
            caseBlock = `\n\n=== بيانات الحالة المحفوظة (من ${getDatabasePath()}/${savedCase.caseId}) ===\n${clines.join('\n')}\n=== نهاية بيانات الحالة ===`;
        } else {
            const caseContext = buildCaseContext();
            caseBlock = `\n\n=== بيانات الحالة الحالية (غير محفوظة بعد) ===\n${caseContext}\n=== نهاية البيانات ===`;
        }

        const guardrails = '\n\nتعليمات مهمة: عندما يسألك الطبيب عن نفسه أو "هل تعرفني" أو ما شابه، أجب باسم الطبيب وليس باسم المريض. ميّز دائماً بين بيانات الطبيب وبيانات المريض.';
        const systemMsg = `${baseSystem}${doctorBlock}${caseBlock}${guardrails}`;

        // Send only the last 10 messages from the conversation (exclude admin messages — AI shouldn't see them)
        const recentMessages = currentConversation.filter(m => m.role !== 'admin').slice(-10);

        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [{ role: 'system', content: systemMsg }, ...recentMessages],
                max_tokens: 600
            })
        });

        const data = await resp.json();
        typingDiv.remove();

        if (data.choices && data.choices[0]) {
            const reply = data.choices[0].message.content;
            await typeAiMessage(reply);
            currentConversation.push({ role: 'assistant', content: reply });
            saveConversationToFirebase();
        } else {
            addAiMessage('bot', '❌ حدث خطأ في الرد: ' + (data.error?.message || 'خطأ غير معروف'));
        }
    } catch (err) {
        typingDiv.remove();
        addAiMessage('bot', '❌ تعذر الاتصال: ' + err.message);
    }

    if (sendBtn) sendBtn.disabled = false;
}

async function saveConversationToFirebase() {
    if (!currentCaseId) return;
    try {
        const path = currentCasePath || `${getDatabasePath()}/${currentCaseId}`;
        await database.ref(`${path}/conversation`).set(currentConversation);
    } catch (e) { console.error('Conversation save error:', e); }
}

// أرقام الأسنان
const upperTeeth = [18,17,16,15,14,13,12,11,21,22,23,24,25,26,27,28];
const lowerTeeth = [48,47,46,45,44,43,42,41,31,32,33,34,35,36,37,38];

const adjacentPairs = [];
for (let i = 0; i < upperTeeth.length - 1; i++) {
    adjacentPairs.push([upperTeeth[i], upperTeeth[i+1]]);
}
for (let i = 0; i < lowerTeeth.length - 1; i++) {
    adjacentPairs.push([lowerTeeth[i], lowerTeeth[i+1]]);
}

// شجرة العلاجات الجديدة: 4 فئات رئيسية، كل فئة تحتها مجموعة علاجات،
// وبعض العلاجات لها سؤال متابعة (followUp) لاختيار تفصيل إضافي.
const TREATMENT_TREE = {
    pfm: {
        key: 'pfm',
        label: 'P.F.M',
        color: '#1976d2',
        treatments: [
            { key: 'pfm_porcelain_crown',         label: 'Porcelain Crown (P.F.M)',           price: 250, color: '#1976d2',
                followUp: { question: 'هل التحضيرة طويلة أم قصيرة؟', options: [
                    { key: 'long_prep',  label: 'تحضيرة طويلة' },
                    { key: 'short_prep', label: 'تحضيرة قصيرة' },
                ]}},
            { key: 'pfm_porcelain_crown_gum',     label: 'Porcelain Crown WITH GUM (P.F.M)',  price: 300, color: '#00acc1',
                followUp: { question: 'الزرعات مفتوحة أم مقفولة؟', options: [
                    { key: 'open_implants',   label: 'زرعات مفتوحة' },
                    { key: 'closed_implants', label: 'زرعات مقفولة' },
                ]}},
            { key: 'pfm_repair',                  label: 'Repair Porcelain Crown',            price: 150, color: '#ffb300' },
            { key: 'pfm_casted_metal_crown',      label: 'Casted Metal Crown',                price: 150, color: '#78909c' },
            { key: 'pfm_casted_metal_post_core',  label: 'Casted Metal Post & Core',          price: 250, color: '#455a64' },
            // البونتيك في P.F.M: السعر يأخذ ديناميكياً من السن الملاصق المتصل (الافتراضي = 250)
            { key: 'pfm_pontic',                  label: 'Pontic (P.F.M)',                    price: 250, color: '#ec407a', isPontic: true },
        ]
    },
    zirconium: {
        key: 'zirconium',
        label: 'Zirconium',
        color: '#c2185b',
        treatments: [
            { key: 'zir_full_anatomy',     label: 'Full Anatomy Zirconium Crown (multi layers)', price: 700,  color: '#c2185b' },
            { key: 'zir_full_anatomy_gum', label: 'Full Anatomy Zirconium Crown With gum',       price: 750,  color: '#f48fb1',
                followUp: { question: 'الزرعات مفتوحة أم مقفولة؟', options: [
                    { key: 'open_implants',   label: 'زرعات مفتوحة' },
                    { key: 'closed_implants', label: 'زرعات مقفولة' },
                ]}},
            { key: 'zir_max',     label: 'Zirco Max Crown',         price: 800,  color: '#6a1b9a' },
            { key: 'zir_french',  label: 'French Crown',            price: 900,  color: '#00897b' },
            { key: 'zir_german',  label: 'GERMAN Crown',            price: 1100, color: '#d84315' },
            { key: 'zir_emax',    label: 'E MAX Full Crown (press)',price: 1300, color: '#311b92' },
            // البونتيك في Zirconium: السعر يأخذ ديناميكياً من السن الملاصق المتصل (الافتراضي = 700)
            { key: 'zir_pontic',  label: 'Pontic (Zirconium)',      price: 700,  color: '#d81b60', isPontic: true },
        ]
    },
    temporary: {
        key: 'temporary',
        label: 'Temporary',
        color: '#f57c00',
        treatments: [
            { key: 'tmp_pmma',    label: 'temporary PMMA crown ( cad cam )', price: 100, color: '#fb8c00' },
            { key: 'tmp_acrylic', label: 'temporary Acrylic Crown',          price: 100, color: '#6d4c41' },
            { key: 'tmp_waxup',   label: 'Wax-up digital crown ( mock-up )', price: 50,  color: '#fdd835' },
        ]
    },
    ortho: {
        key: 'ortho',
        label: 'Ortho/Acrylic',
        color: '#2e7d32',
        treatments: [
            { key: 'ortho_space_band',   label: 'Space maintainer & band',         price: 350,  color: '#43a047' },
            { key: 'ortho_space_crown',  label: 'Space maintainer & crown',        price: 450,  color: '#00695c' },
            { key: 'ortho_night_guard',  label: 'Night guard hard & soft u or l',  price: 250,  color: '#9e9d24' },
            { key: 'ortho_vitalium',     label: 'VITALIUM WITH OUT ACRYLIC',       price: 1700, color: '#5d4037' },
        ]
    }
};

let treatmentPanelState = 'empty';
let isDragging = false;
let dragTreatment = undefined;
let dragFromTooth = null;
let dragGhost = null;
let _dragEndedRecently = false;

// =============== دوال لوحة العلاج ===============

// إيجاد بيانات العلاج من المفتاح (مع دعم البيانات القديمة المحفوظة كنص)
function getTreatmentData(treatment) {
    // الصيغة الجديدة: كائن يحوي كل البيانات
    if (treatment && typeof treatment === 'object') return treatment;
    const key = treatment;
    for (const catKey of Object.keys(TREATMENT_TREE)) {
        const cat = TREATMENT_TREE[catKey];
        for (const t of cat.treatments) {
            if (t.key === key) return { ...t, category: catKey, categoryLabel: cat.label };
        }
    }
    const legacy = { zircon: '#c2185b', porcelain: '#2e7d32', pontic: '#c62828', healthy: '#ff8f00' };
    return { key, label: key, color: legacy[key] || '#546e7a', price: 0 };
}

function showTreatmentPanel(toothNumber) {
    document.getElementById('tpEmpty').style.display  = 'none';
    document.getElementById('tpLocked').style.display = 'none';
    document.getElementById('tpActive').style.display = 'flex';
    document.getElementById('tpToothNum').textContent = toothNumber;
    buildMainCategoriesUI();
    treatmentPanelState = 'active';
}

function lockTreatmentPanel(toothNumber, treatmentObj) {
    const td = getTreatmentData(treatmentObj);
    document.getElementById('tpActive').style.display = 'none';
    document.getElementById('tpEmpty').style.display  = 'none';
    document.getElementById('tpLocked').style.display = 'flex';
    const info = document.getElementById('tpLockedInfo');
    const subTxt = td.subOptionLabel ? `<div style="color:#ffd966; font-size:0.72rem; margin-top:4px;">${td.subOptionLabel}</div>` : '';
    const priceTxt = td.isPontic
        ? `<div style="color:#9aa0b4; font-size:0.72rem; margin-top:4px; font-style:italic;">السعر: حسب السن المتصل بالكونكتور</div>`
        : (td.price ? `<div style="color:#90caf9; font-size:0.72rem; margin-top:4px;">السعر: ${td.price} ج</div>` : '');
    info.innerHTML = `
        <div style="background:${td.color}; padding:10px 16px; border-radius:20px; color:white; font-weight:bold; text-align:center; font-size:0.78rem;">${td.label}</div>
        ${subTxt}${priceTxt}
        <div style="color:#b0bec5; font-size:0.78rem; text-align:center; margin-top:6px;">السن رقم ${toothNumber}</div>`;
    treatmentPanelState = 'locked';
}

function resetTreatmentPanel() {
    document.getElementById('tpEmpty').style.display  = 'flex';
    document.getElementById('tpActive').style.display = 'none';
    document.getElementById('tpLocked').style.display = 'none';
    treatmentPanelState = 'empty';
}

// الخطوة 1: عرض الـ 4 فئات الرئيسية
function buildMainCategoriesUI() {
    const list = document.getElementById('tpCategoriesList');
    if (!list) return;
    list.innerHTML = '';

    // الفروع المستخدمة في الحالة الآن (للحفاظ على فرع رئيسي واحد فقط)
    const usedCats = collectCaseCategories(toothTreatments);
    const lockedCat = usedCats.length > 0 ? usedCats[0] : null;

    if (lockedCat) {
        const note = document.createElement('div');
        note.className = 'tp-followup-q';
        note.style.color = '#a5d6a7';
        note.style.background = 'rgba(76,175,80,0.1)';
        note.textContent = `🔒 فرع الحالة: ${TREATMENT_TREE[lockedCat]?.label || lockedCat} — لا يمكن خلطه بفرع آخر`;
        list.appendChild(note);
    }

    const grid = document.createElement('div');
    grid.className = 'tp-main-grid';
    Object.keys(TREATMENT_TREE).forEach(catKey => {
        const cat = TREATMENT_TREE[catKey];
        const btn = document.createElement('button');
        btn.className = 'tp-main-btn';
        btn.style.background = cat.color;
        btn.textContent = cat.label;
        const isDisabled = lockedCat && lockedCat !== catKey;
        if (isDisabled) btn.classList.add('disabled-cat');
        btn.addEventListener('click', () => {
            if (isReadOnly) return;
            if (isDisabled) {
                alert(`🔒 الحالة بدأت بفرع: ${TREATMENT_TREE[lockedCat].label}\nلا يمكن إضافة علاجات من فرع آخر.`);
                return;
            }
            buildSubTreatmentsUI(catKey);
        });
        grid.appendChild(btn);
    });
    list.appendChild(grid);
}

// الخطوة 2: عرض العلاجات الفرعية لفئة محددة
function buildSubTreatmentsUI(catKey) {
    const cat  = TREATMENT_TREE[catKey];
    const list = document.getElementById('tpCategoriesList');
    if (!list || !cat) return;
    list.innerHTML = '';

    // زر رجوع للفئات الرئيسية
    const back = document.createElement('button');
    back.className = 'tp-back-btn';
    back.textContent = '← رجوع للفئات الرئيسية';
    back.addEventListener('click', () => buildMainCategoriesUI());
    list.appendChild(back);

    const header = document.createElement('div');
    header.className = 'tp-sub-header';
    header.style.background = cat.color;
    header.textContent = cat.label;
    list.appendChild(header);

    const wrap = document.createElement('div');
    wrap.className = 'tp-sub-list';
    cat.treatments.forEach(t => {
        const btn = document.createElement('button');
        btn.className = 'tp-treatment-btn';
        btn.style.background = t.color;
        const priceLbl = t.isPontic ? 'حسب الكونكتور' : `${t.price} ج`;
        btn.innerHTML = `<span class="ttb-label">${t.label}</span><span class="ttb-price">${priceLbl}</span>`;
        btn.addEventListener('click', () => {
            if (isReadOnly || !selectedTooth) return;
            if (t.followUp) {
                buildFollowUpUI(catKey, t);
            } else {
                applyChosenTreatment(selectedTooth, catKey, t, null);
            }
        });
        wrap.appendChild(btn);
    });
    list.appendChild(wrap);
}

// الخطوة 3: سؤال متابعة (مثلاً: تحضيرة طويلة/قصيرة، زرعات مفتوحة/مقفولة)
function buildFollowUpUI(catKey, treatment) {
    const list = document.getElementById('tpCategoriesList');
    if (!list) return;
    list.innerHTML = '';

    const back = document.createElement('button');
    back.className = 'tp-back-btn';
    back.textContent = '← رجوع';
    back.addEventListener('click', () => buildSubTreatmentsUI(catKey));
    list.appendChild(back);

    const header = document.createElement('div');
    header.className = 'tp-sub-header';
    header.style.background = treatment.color;
    header.textContent = treatment.label;
    list.appendChild(header);

    const q = document.createElement('div');
    q.className = 'tp-followup-q';
    q.textContent = treatment.followUp.question;
    list.appendChild(q);

    const optsWrap = document.createElement('div');
    optsWrap.className = 'tp-followup-opts';
    treatment.followUp.options.forEach(opt => {
        const btn = document.createElement('button');
        btn.className = 'tp-followup-btn';
        btn.style.background = treatment.color;
        btn.textContent = opt.label;
        btn.addEventListener('click', () => {
            applyChosenTreatment(selectedTooth, catKey, treatment, opt);
        });
        optsWrap.appendChild(btn);
    });
    list.appendChild(optsWrap);
}

// تطبيق العلاج المختار على السن وتخزينه ككائن كامل
function applyChosenTreatment(toothNumber, catKey, treatment, subOption) {
    // إجبار النظام على فرع رئيسي واحد فقط لكامل الحالة
    const existingCats = collectCaseCategories(toothTreatments).filter(c => c !== catKey);
    // السماح بنفس السن لو كان عليه علاج من نفس الفرع، لكن نمنع لو فيه فرع تاني مستخدم
    const currentToothCat = toothTreatments[toothNumber]?.category;
    const otherTeethUsingDifferentCat = Object.entries(toothTreatments).some(([num, t]) =>
        parseInt(num) !== toothNumber && t && t.category && t.category !== catKey
    );
    if (otherTeethUsingDifferentCat) {
        const usedCatLabel = TREATMENT_TREE[existingCats[0]]?.label || existingCats[0];
        const newCatLabel  = TREATMENT_TREE[catKey]?.label || catKey;
        alert(`🚫 لا يمكن خلط فرعين مختلفين في نفس الحالة.\n\nالحالة بدأت بفرع: ${usedCatLabel}\nوحاولت اختيار علاج من فرع: ${newCatLabel}\n\nاحذف العلاجات السابقة أو اختر علاج من نفس الفرع.`);
        return;
    }

    const cat = TREATMENT_TREE[catKey];
    const obj = {
        key:             treatment.key,
        label:           treatment.label,
        color:           treatment.color,
        price:           treatment.price,
        category:        catKey,
        categoryLabel:   cat.label,
        subOption:       subOption ? subOption.key   : null,
        subOptionLabel:  subOption ? subOption.label : null,
        isPontic:        !!treatment.isPontic,
    };
    applyTreatmentToTooth(toothNumber, obj);
    currentTreatment = obj;
    lockTreatmentPanel(toothNumber, obj);
    updateTreatmentsSummary();
}

function clearToothTreatment(toothNumber, btn) {
    if (!btn) btn = Array.from(document.querySelectorAll('.tooth-button')).find(b => parseInt(b.innerText) === toothNumber);
    if (btn) {
        btn.classList.remove('zircon', 'porcelain', 'pontic', 'healthy', 'selected');
        btn.style.background = '';
        btn.style.color = '';
        btn.removeAttribute('data-treatment');
    }
    delete toothTreatments[toothNumber];
    updateSelectedCount();
    updateTreatmentsSummary();
    if (toothNumber === selectedTooth) {
        selectedTooth = null;
        currentTreatment = null;
        resetTreatmentPanel();
    }
}

function startTreatmentDrag(e, fromTooth, treatment) {
    isDragging = true;
    dragFromTooth = fromTooth;
    dragTreatment = treatment; // كائن العلاج الكامل
    const td = getTreatmentData(treatment);
    dragGhost = document.createElement('div');
    dragGhost.style.cssText = `position:fixed;width:44px;height:44px;border-radius:50%;background:${td.color};border:3px solid #ffd700;display:flex;align-items:center;justify-content:center;color:white;font-size:12px;font-weight:bold;z-index:9999;pointer-events:none;left:${e.clientX - 22}px;top:${e.clientY - 22}px;box-shadow:0 0 20px rgba(255,215,0,0.7);`;
    dragGhost.textContent = fromTooth;
    document.body.appendChild(dragGhost);
}

function startClearDrag(e) {
    isDragging = true;
    dragFromTooth = null;
    dragTreatment = null;
    dragGhost = document.createElement('div');
    dragGhost.style.cssText = `position:fixed;width:44px;height:44px;border-radius:50%;background:#3a3a4a;border:3px dashed #aaa;display:flex;align-items:center;justify-content:center;color:#ccc;font-size:18px;font-weight:bold;z-index:9999;pointer-events:none;left:${e.clientX - 22}px;top:${e.clientY - 22}px;`;
    dragGhost.textContent = '✕';
    document.body.appendChild(dragGhost);
}

function handleDragMove(e) {
    if (!isDragging || !dragGhost) return;
    dragGhost.style.left = (e.clientX - 22) + 'px';
    dragGhost.style.top = (e.clientY - 22) + 'px';
    document.querySelectorAll('.tooth-button.drag-over').forEach(b => b.classList.remove('drag-over'));
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el.classList.contains('tooth-button')) el.classList.add('drag-over');
}

function handleDragEnd(e) {
    if (!isDragging) return;
    isDragging = false;
    _dragEndedRecently = true;
    setTimeout(() => { _dragEndedRecently = false; }, 120);
    if (dragGhost) { dragGhost.remove(); dragGhost = null; }
    document.querySelectorAll('.tooth-button.drag-over').forEach(b => b.classList.remove('drag-over'));
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el.classList.contains('tooth-button') && !isReadOnly) {
        const targetTooth = parseInt(el.innerText);
        if (!isNaN(targetTooth)) {
            if (dragTreatment !== null && dragTreatment !== undefined) {
                applyTreatmentToTooth(targetTooth, dragTreatment);
                if (targetTooth === selectedTooth) lockTreatmentPanel(targetTooth, dragTreatment);
            } else if (dragTreatment === null) {
                clearToothTreatment(targetTooth, el);
            }
        }
    }
    dragTreatment = undefined;
    dragFromTooth = null;
}

// =============== الدوال الجديدة للرقم التأكيدي ===============

// دالة لجلب clinicId من بيانات العيادة
async function getClinicId(clinicName) {
    try {
        const clinicRef = database.ref(`dental lap/users/doctors/data/${clinicName}/clinicId`);
        const snapshot = await clinicRef.once('value');
        let clinicId = snapshot.val();

        if (!clinicId) {
            const numbers = clinicName.match(/\d+/g);
            if (numbers) {
                clinicId = numbers.join('');
            } else {
                clinicId = Math.abs(clinicName.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % 900 + 100).toString();
            }
            await database.ref(`dental lap/users/doctors/data/${clinicName}/clinicId`).set(clinicId);
        }
        return clinicId.toString();
    } catch (error) {
        console.error("خطأ في جلب clinicId:", error);
        return "999";
    }
}

// دالة توليد الرقم التأكيدي الجديد (بدون أصفار زائدة)
async function generateSecretCodeV2(clinicName, date, dailyCounter) {
    const clinicId = await getClinicId(clinicName);

    const dateObj = new Date(date);
    const year = dateObj.getFullYear().toString().slice(-2);
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    const datePart = `${year}${month}${day}`;

    // العداد بدون أصفار زائدة (رقم عادي)
    const counterPart = dailyCounter.toString();

    const secretCode = `${datePart}${counterPart}${clinicId}`;

    return secretCode;
}

// إنشاء فهرس عام: dental lap/case data/index/general/{patientName} = secretCode
// و فهرس مفصل: dental lap/case data/index/Detailed/{secretCode} = { year, month, day, doctorName, caseId }
async function saveToSecretCodeIndex(secretCode, caseId, patientName, datePath, doctorName) {
    try {
        const updates = {};
        updates[`dental lap/case data/index/general/${patientName}`] = secretCode;
        updates[`dental lap/case data/index/Detailed/${secretCode}`] = {
            year: datePath.year,
            month: datePath.month,
            day: datePath.day,
            doctorName: doctorName,
            caseId: caseId
        };
        await database.ref().update(updates);
        console.log(`✅ تم حفظ الفهرس: general/${patientName}=${secretCode} و Detailed/${secretCode}`);
        return true;
    } catch (error) {
        console.error("خطأ في حفظ الفهرس:", error);
        return false;
    }
}

// دالة البحث عن حالة بواسطة الرقم التأكيدي (تستخدم الفهرس المفصل الجديد)
async function findCaseBySecretCode(secretCode) {
    try {
        const indexRef = database.ref(`dental lap/case data/index/Detailed/${secretCode}`);
        const snapshot = await indexRef.once('value');
        if (snapshot.exists()) {
            return snapshot.val(); // { year, month, day, doctorName, caseId }
        }
        return null;
    } catch (error) {
        console.error("خطأ في البحث عن الرقم التأكيدي:", error);
        return null;
    }
}

// الحصول على التاريخ الحالي
function getCurrentDatePath() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return { year, month, day, fullPath: `${year}/${month}/${day}` };
}

// اسم الطبيب كمفتاح في فايربيز
function getDoctorKey() {
    return (currentUser?.doctorName || 'unknown').trim();
}

// الحصول على المسار الصحيح للبيانات (تحت اسم الطبيب)
function getDatabasePath() {
    const datePath = getCurrentDatePath();
    return `dental lap/case data/${datePath.fullPath}/${getDoctorKey()}`;
}

// مسار "قائمة الانتظار" (waiting): الحالات تُحفظ هنا أولاً، ثم تُنقل لاحقاً للمسار الطبيعي
// عند الضغط على زر "طلب مندوب".
function getWaitingPath() {
    const datePath = getCurrentDatePath();
    return `dental lap/case data/waiting/${datePath.fullPath}/${getDoctorKey()}`;
}

// عند تحميل حالة من قائمة الانتظار بهدف التعديل، نحفظ هنا مرجع المسار الأصلي
// لكي يقوم saveCaseToFirebase بالكتابة فوقها بدل إنشاء caseId جديد.
let currentEditingPoolCase = null; // { year, month, day, caseId } أو null

// الحصول على مسار الكاونتر الخاص بالطبيب
function getCounterPath(doctorName, date) {
    const dateObj = new Date(date);
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    return `dental lap/case data/${year}/${month}/${day}/${doctorName}/_counters/${date}`;
}

// دالة لجلب بيانات العيادة
async function getClinicData(clinicName) {
    try {
        const clinicRef = database.ref(`dental lap/users/doctors/data/${clinicName}`);
        const snapshot = await clinicRef.once('value');
        const clinicData = snapshot.val();

        if (clinicData) {
            return {
                area: clinicData.area || "",
                governorate: clinicData.governorate || "",
                clinicNumber: clinicData.clinicNumber || "",
                location: clinicData.location || "",
                doctorName: clinicData.doctorName || currentUser?.doctorName || "",
                email: clinicData.email || "",
                clinicId: clinicData.clinicId || ""
            };
        }
        return null;
    } catch (error) {
        console.error("خطأ في جلب بيانات العيادة:", error);
        return null;
    }
}

// دالة لحفظ الطلب في مسار المندوب
async function saveOrderToWorkersPath(caseData, caseId, clinicData, secretCode) {
    try {
        const cleanClinicName = currentClinicName.replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, '_');
        const cleanGovernorate = (clinicData?.governorate || "غير_محدد").replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, '_');
        const cleanArea = (clinicData?.area || "غير_محدد").replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, '_');

        const workersPath = `dental lap/workers/data/مندوب/orders/${cleanClinicName}_${cleanGovernorate}_${cleanArea}/${caseId}`;

        // بيانات إرشادية فقط — تدلّ المندوب على موقع الحالة في المسار الرئيسي
        // dental lap/case data/{year}/{month}/{day}/{doctorName}/{caseId}
        const dp = getCurrentDatePath();
        const orderData = {
            caseId,
            year:       dp.year,
            month:      dp.month,
            day:        dp.day,
            doctorName: clinicData?.doctorName || currentUser?.doctorName || "غير محدد",
            randomCode: secretCode,
        };

        await database.ref(workersPath).set(orderData);
        console.log("✅ تم حفظ الطلب في مسار المندوب بنجاح:", workersPath);
        return true;
    } catch (error) {
        console.error("خطأ في حفظ الطلب في مسار المندوب:", error);
        return false;
    }
}

// عرض الرقم التأكيدي مكان زر رفع السكان (في وسط منطقة الأسنان)
// ترتيب الشارة: اسم المريض (كبير وفوق) → ثم الرقم التأكيدي تحته
function displaySecretCode(patientName, randomCode, scannerFile) {
    const teethContainer = document.getElementById('teethContainer');
    if (!teethContainer) return;
    // إخفاء زر رفع السكان ومؤشر السكان المعلّق، وعرض بادج الرقم التأكيدي
    const uploadBtn = document.getElementById('uploadScannerBtn');
    if (uploadBtn) uploadBtn.style.display = 'none';
    const indicator = document.getElementById('scannerSelectedIndicator');
    if (indicator) indicator.style.display = 'none';

    let codeDisplay = document.getElementById('secretCodeDisplay');
    if (!codeDisplay) {
        codeDisplay = document.createElement('div');
        codeDisplay.id = 'secretCodeDisplay';
        codeDisplay.className = 'secret-code-badge';
        teethContainer.appendChild(codeDisplay);
    }
    const scannerBadge = scannerFile
        ? `<div class="scb-scanner-file">✅ ${escapeHtml(scannerFile)}</div>`
        : '';
    codeDisplay.innerHTML = `
        ${scannerBadge}
        <div class="scb-patient">👤 ${escapeHtml(patientName || '')}</div>
        <div class="scb-label">🔐 الرقم التأكيدي</div>
        <div class="scb-code">${escapeHtml(randomCode || '')}</div>
    `;
    codeDisplay.style.display = 'flex';
}

// إخفاء الرقم التأكيدي وإعادة زر الرفع
function hideSecretCode() {
    const codeDisplay = document.getElementById('secretCodeDisplay');
    if (codeDisplay) codeDisplay.style.display = 'none';
    const uploadBtn = document.getElementById('uploadScannerBtn');
    if (uploadBtn) uploadBtn.style.display = '';
}

// تفعيل/تعطيل وضع القراءة فقط
function setReadOnlyMode(readOnly) {
    isReadOnly = readOnly;

    const inputs = ['patientName', 'notes'];
    inputs.forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            element.readOnly = readOnly;
            element.style.opacity = readOnly ? '0.7' : '1';
            element.style.backgroundColor = readOnly ? '#1a1a2a' : '#1e1e2a';
        }
    });

    const treatmentBtns = document.querySelectorAll('.tp-treatment-btn');
    treatmentBtns.forEach(btn => {
        btn.disabled = readOnly;
        btn.style.opacity = readOnly ? '0.5' : '1';
        btn.style.cursor = readOnly ? 'not-allowed' : 'pointer';
    });

    const saveBtn = document.getElementById('saveBtnDashboard');
    if (saveBtn) {
        saveBtn.disabled = readOnly;
        saveBtn.style.opacity = readOnly ? '0.5' : '1';
        saveBtn.style.cursor = readOnly ? 'not-allowed' : 'pointer';
    }

    const uploadBtn = document.getElementById('uploadScannerBtn');
    if (uploadBtn) {
        uploadBtn.style.pointerEvents = readOnly ? 'none' : 'auto';
        uploadBtn.style.opacity = readOnly ? '0.5' : '1';
    }

    const toothButtons = document.querySelectorAll('.tooth-button');
    toothButtons.forEach(btn => {
        btn.style.pointerEvents = readOnly ? 'none' : 'auto';
        btn.style.opacity = readOnly ? '0.7' : '1';
    });

    const connectionDots = document.querySelectorAll('.connection-dot');
    connectionDots.forEach(dot => {
        dot.style.pointerEvents = readOnly ? 'none' : 'auto';
        dot.style.opacity = readOnly ? '0.5' : '1';
    });

    let readOnlyMsg = document.getElementById('readOnlyMessage');
    if (readOnly) {
        if (!readOnlyMsg) {
            readOnlyMsg = document.createElement('div');
            readOnlyMsg.id = 'readOnlyMessage';
            readOnlyMsg.className = 'readonly-mode-msg';
            readOnlyMsg.innerHTML = '🔒 وضع القراءة فقط - لا يمكن التعديل';
            document.body.appendChild(readOnlyMsg);
            setTimeout(() => { if (readOnlyMsg) readOnlyMsg.remove(); }, 3000);
        }
    } else {
        if (readOnlyMsg) readOnlyMsg.remove();
        hideSecretCode();
        currentSecretCode = null;
    }
}

// التحقق من وجود الحالة مسبقاً
async function checkIfCaseExists(patientName, date) {
    if (!patientName || !date) return false;
    const dateObj = new Date(date);
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    const doctorKey = getDoctorKey();
    // فحص المسارَين: العادي + waiting (قائمة الانتظار) لتجنّب التكرار
    const paths = [
        `dental lap/case data/${year}/${month}/${day}/${doctorKey}`,
        `dental lap/case data/waiting/${year}/${month}/${day}/${doctorKey}`,
    ];
    for (const p of paths) {
        const snap = await database.ref(p).once('value');
        const cases = snap.val();
        if (!cases) continue;
        for (const caseId in cases) {
            if (cases[caseId].patientName === patientName && cases[caseId].date === date) {
                return true;
            }
        }
    }
    return false;
}

// الحصول على عداد يومي مع إرجاع القيمة الجديدة
async function getDailyCounterAndReturn(clinicName, date) {
    const counterPath = getCounterPath(clinicName, date);
    const counterRef = database.ref(counterPath);
    const snapshot = await counterRef.once('value');
    let counter = snapshot.val() || 0;
    counter++;
    await counterRef.set(counter);
    return counter;
}

// تم حذف مسار "dental lap/case type" نهائياً (المسار الصحيح داخل case data).
// المسار البديل المعتمد للفئات هو:
//   dental lap/case data/case type/{branch}/{caseId} = { year, month, day, doctorName }  (مجرد مؤشر)

// تحميل بيانات المستخدم
function loadUserData() {
    const userData = localStorage.getItem('currentUser');
    if (!userData) {
        window.location.href = 'index.html';
        return null;
    }
    const user = JSON.parse(userData);
    currentUser = user;
    // اسم الطبيب أصبح المعرّف الأساسي (بدلاً من اسم العيادة)
    currentClinicName = user.doctorName || user.clinicName || '';
    document.getElementById('welcomeMessage').innerHTML = `مرحباً د. ${user.doctorName || "الطبيب"} 👋`;
    const subtitle = `${user.governorate || ''}${user.area ? ' - ' + user.area : ''}`.trim();
    document.getElementById('clinicSubtitle').innerHTML = subtitle ? `📍 ${subtitle} | نظام متقدم` : 'نظام متقدم';
    return user;
}

// عرض / تحديث / إخفاء شريط التقدم
function showProgressBar() {
    const bar = document.getElementById('uploadProgressBar');
    if (bar) bar.style.display = 'block';
    setProgress(0, '📦 جاري التحضير...');
}
function setProgress(percent, statusText) {
    const fill   = document.getElementById('progressFill');
    const text   = document.getElementById('progressText');
    const status = document.getElementById('progressStatus');
    const p = Math.max(0, Math.min(100, percent));
    if (fill)   fill.style.width = `${p}%`;
    if (text)   text.textContent = `${Math.floor(p)}%`;
    if (status && statusText) status.textContent = statusText;
}
function hideProgressBar(delayMs = 1200) {
    const bar = document.getElementById('uploadProgressBar');
    setTimeout(() => { if (bar) bar.style.display = 'none'; }, delayMs);
}

// رفع ملف فعلي إلى Firebase Storage مع تتبع نسبة التقدم الحقيقية
function uploadFileToStorage(file, storagePath) {
    return new Promise((resolve, reject) => {
        const fileRef  = storage.ref().child(storagePath);
        const uploadTask = fileRef.put(file);

        showProgressBar();
        uploadTask.on('state_changed',
            (snapshot) => {
                const pct = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                let statusText;
                if (pct < 25)      statusText = '📦 جاري بدء الرفع...';
                else if (pct < 60) statusText = '🚚 جاري رفع الملف إلى السيرفر...';
                else if (pct < 95) statusText = '⚙️ يوشك على الانتهاء...';
                else               statusText = '✨ اللمسات الأخيرة...';
                setProgress(pct, statusText);
            },
            (error) => {
                setProgress(0, '❌ فشل الرفع');
                hideProgressBar(1500);
                reject(error);
            },
            async () => {
                try {
                    const url = await uploadTask.snapshot.ref.getDownloadURL();
                    setProgress(100, '✅ اكتمل الرفع بنجاح! 🎉');
                    hideProgressBar();
                    resolve({ url, path: storagePath });
                } catch (e) { reject(e); }
            }
        );
    });
}

// زر رفع الملف: لو الحالة محفوظة بالفعل يرفع فوراً، وإلا يخزن الملف مؤقتاً ويُرفع عند الحفظ
async function uploadScannerFile() {
    if (isReadOnly) { alert("🔒 لا يمكن رفع ملف في وضع القراءة فقط!"); return; }

    const patientName = document.getElementById('patientName').value.trim();
    if (!patientName) { alert("⚠️ الرجاء إدخال اسم المريض أولاً!"); return; }

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.zip,.rar,.7z,.pdf,.jpg,.png';
    fileInput.click();

    fileInput.addEventListener('change', async () => {
        if (fileInput.files.length === 0) return;
        const file = fileInput.files[0];
        uploadedFileName  = file.name;
        pendingUploadFile = file;

        if (currentCaseId) {
            try {
                const path = `scans/${currentClinicName}/${currentCaseId}/${file.name}`;
                const { url } = await uploadFileToStorage(file, path);
                const casePath = currentCasePath || `${getDatabasePath()}/${currentCaseId}`;
                await database.ref(casePath).update({
                    scannerFile:        file.name,
                    scannerFileUrl:     url,
                    scannerStoragePath: path,
                    scannerUploadedAt:  firebase.database.ServerValue.TIMESTAMP
                });
                pendingUploadFile = null;
                alert(`✅ تم رفع الملف بنجاح وربطه بالحالة!`);
            } catch (error) {
                console.error("خطأ:", error);
                alert("❌ حدث خطأ في رفع الملف: " + (error?.message || error));
            }
        } else {
            updateScannerIndicator(file.name);
        }
    });
}

function updateScannerIndicator(fileName) {
    const uploadBtn = document.getElementById('uploadScannerBtn');
    const indicator = document.getElementById('scannerSelectedIndicator');
    const nameEl    = document.getElementById('scannerFileName');
    if (uploadBtn)  uploadBtn.style.display = 'none';
    if (nameEl)     nameEl.textContent = fileName;
    if (indicator)  indicator.style.display = 'flex';
}

function resetScannerIndicator() {
    const indicator = document.getElementById('scannerSelectedIndicator');
    if (indicator)  indicator.style.display = 'none';
    // uploadBtn visibility is managed by hideSecretCode / displaySecretCode
}

function getMainCaseType() {
    const cats = collectCaseCategories(toothTreatments);
    if (cats.includes('zirconium'))  return 'zirconium';
    if (cats.includes('pfm'))        return 'pfm';
    if (cats.includes('ortho'))      return 'ortho';
    if (cats.includes('temporary'))  return 'temporary';
    return 'other';
}

async function saveOrderToCareerLadder(caseData, caseId) {
    try {
        const dp = getCurrentDatePath();
        const mainType = getMainCaseType();
        const hasScannerFile = !!(caseData.scannerFile);

        const orderData = {
            caseId,
            year:       dp.year,
            month:      dp.month,
            day:        dp.day,
            doctorName: currentUser?.doctorName || 'غير محدد',
            caseType:   mainType,
            randomCode: caseData.randomCode,
        };

        // بناء مفتاح العيادة: اسم الطبيب - المحافظة - المنطقة (مُعقَّم لمسارات Firebase)
        const sanitize = (s) => (s || '').trim().replace(/[.#$[\]/]/g, '-');
        const clinicKey = [
            sanitize(currentUser?.doctorName),
            sanitize(currentUser?.governorate),
            sanitize(currentUser?.area)
        ].filter(Boolean).join('-') || 'غير محدد';

        let path;
        if (!hasScannerFile) {
            path = `dental lap/users/workers/jops/Career ladder/مندوب/استلام/${clinicKey}/${caseId}`;
        } else if (mainType === 'zirconium') {
            path = `dental lap/users/workers/jops/Career ladder/مندوب/الاداره/فني جبس/تفتيح مارجن/سكانر زيركون/استلام/${caseId}`;
        } else if (mainType === 'pfm') {
            path = `dental lap/users/workers/jops/Career ladder/مندوب/الاداره/فني جبس/تفتيح مارجن/سكانر معدن/استلام/${caseId}`;
        } else if (mainType === 'ortho') {
            path = `dental lap/users/workers/jops/Career ladder/مندوب/الاداره/فني جبس/طباعة ريزن/استلام/${caseId}`;
        } else {
            path = `dental lap/users/workers/jops/Career ladder/مندوب/استلام/${clinicKey}/${caseId}`;
        }

        await database.ref(path).set(orderData);

        // تسجيل المسار في statusHistory/details داخل الحالة الرئيسية
        try {
            await database.ref(`${getDatabasePath()}/${caseId}/statusHistory/details`).set({
                careerLadderPath: path,
                hasScannerFile:   hasScannerFile,
                caseType:         mainType,
                addedAt:          Date.now()
            });
        } catch (detErr) {
            console.error("خطأ في تسجيل statusHistory/details:", detErr);
        }

        console.log("✅ تم حفظ في Career Ladder:", path);
    } catch (err) {
        console.error("خطأ في حفظ Career Ladder:", err);
    }
}

// تحديث شريط الحالة
function updateStatusBar(status) {
    currentOrderStatus = status;
    const steps    = document.querySelectorAll('.status-step');
    const fillLine = document.getElementById('progressLineFill');
    steps.forEach((step, index) => {
        const stepNum = index + 1;
        step.classList.remove('active', 'completed');
        if (status > 0) {
            if (stepNum < status)        step.classList.add('completed');
            else if (stepNum === status) step.classList.add('active');
        }
    });
    if (fillLine) {
        const pct = (status <= 1) ? 0 : ((status - 1) / 3) * 100;
        fillLine.style.width = `${pct}%`;
    }
    updateMotoBadge(status);
}

function updateMotoBadge(status) {
    const badge = document.getElementById('motoBadge');
    if (!badge) return;
    // المواضع على progress-line بالـ RTL (right: X% من الحافة اليمنى)
    // status 2 → موتو بين step1(يمين) وstep2 → عند 16.5% من اليمين
    // status 3 → بين step2 وstep3 → 49.5%
    // status 4 → بين step3 وstep4 → 82.5%
    const positions = { 2: '16.5%', 3: '49.5%', 4: '82.5%' };
    if (status >= 2 && positions[status]) {
        badge.style.display = 'block';
        badge.style.right   = positions[status];
    } else {
        badge.style.display = 'none';
    }
}

// تطبيق الحالة المرئية من كائن statusHistory البوليان الجديد
// يدعم أيضاً البنية القديمة (مفاتيح رقمية بقيم timestamp)
function applyStatusFromHistory(statusHistory) {
    statusHistory = statusHistory || {};

    // دعم البنية القديمة (4 خطوات بمفاتيح رقمية بـ timestamp): اشتق ثم انقل +1
    // لاستيعاب الخطوة الأولى الجديدة "الإضافة لقائمة الانتظار"
    const hasNewKeys = ("الإضافة لقائمة الانتظار" in statusHistory) ||
                       ("استلام الطلب" in statusHistory) ||
                       ("ارسال مندوب للعياده" in statusHistory) ||
                       ("استلام الحاله" in statusHistory);
    if (!hasNewKeys && (statusHistory[1] || statusHistory[2] || statusHistory[3] || statusHistory[4])) {
        let derived = 0;
        for (let i = 4; i >= 1; i--) { if (statusHistory[i]) { derived = i; break; } }
        // الحالات القديمة موجودة في المسار الطبيعي (تخطّت الـpool)، إذن step 1 مكتمل
        const shifted = derived + 1;
        document.querySelectorAll('.status-step').forEach(s => s.classList.remove('active', 'completed'));
        for (let i = 1; i < shifted; i++) {
            document.querySelector(`.status-step[data-step="${i}"]`)?.classList.add('completed');
        }
        document.querySelector(`.status-step[data-step="${shifted}"]`)?.classList.add('active');
        currentOrderStatus = shifted;
        const fl = document.getElementById('progressLineFill');
        if (fl) fl.style.width = `${((shifted - 1) / 4) * 100}%`;
        const badge = document.getElementById('motoBadge');
        if (badge) badge.style.display = 'none';
        return;
    }

    const inPool   = !!statusHistory["الإضافة لقائمة الانتظار"];
    const arrived  = !!statusHistory["استلام الطلب"];
    const courier  = !!statusHistory["ارسال مندوب للعياده"];
    const received = !!statusHistory["استلام الحاله"];
    const shipped  = !!statusHistory[5];

    // إعادة ضبط جميع الخطوات
    document.querySelectorAll('.status-step').forEach(s => s.classList.remove('active', 'completed'));

    // step 1: الإضافة لقائمة الانتظار
    if (inPool) {
        const s1 = document.querySelector('.status-step[data-step="1"]');
        if (s1) s1.classList.add(arrived || courier || received || shipped ? 'completed' : 'active');
    }
    // step 2: وصول الطلب للمعمل
    if (arrived) {
        const s2 = document.querySelector('.status-step[data-step="2"]');
        if (s2) s2.classList.add(courier || received || shipped ? 'completed' : 'active');
    }
    // step 3: وصول المندوب للعياده
    if (courier) {
        const s3 = document.querySelector('.status-step[data-step="3"]');
        if (s3) s3.classList.add(received || shipped ? 'completed' : 'active');
    }
    // step 4: المعمل
    if (received) {
        const s4 = document.querySelector('.status-step[data-step="4"]');
        if (s4) s4.classList.add(shipped ? 'completed' : 'active');
    }
    // step 5: الشحن للعيادة
    if (shipped) {
        const s5 = document.querySelector('.status-step[data-step="5"]');
        if (s5) s5.classList.add('active');
    }

    currentOrderStatus = shipped ? 5 : received ? 4 : courier ? 3 : arrived ? 2 : inPool ? 1 : 0;

    // شريط التعبئة (5 خطوات → 4 قطاعات → 25% لكل قطاع)
    const fillLine = document.getElementById('progressLineFill');
    if (fillLine) {
        let pct = 0;
        if (shipped)        pct = 100;
        else if (received)  pct = 75;
        else if (courier)   pct = 50;
        else if (arrived)   pct = 25;
        fillLine.style.width = `${pct}%`;
    }

    // الموتوسيكل (مواقع منتصف القطاعات: 12.5%, 37.5%, 62.5%, 87.5%)
    const badge = document.getElementById('motoBadge');
    if (badge) {
        if (received && !shipped) {
            badge.style.display = 'block';
            badge.style.right   = '62.5%';   // بين step 3 و step 4 (راجع للمعمل بالحالة)
        } else if (courier && !received) {
            badge.style.display = 'block';
            badge.style.right   = '37.5%';   // بين step 2 و step 3 (مندوب رايح للعيادة)
        } else {
            badge.style.display = 'none';
        }
    }
}

function updateStepDates(statusHistory) {
    if (!statusHistory) return;
    const stepNames = {
        1: 'الإضافة لقائمة الانتظار',
        2: 'وصول الطلب للمعمل',
        3: 'وصول المندوب للعياده',
        4: 'المعمل',
        5: 'الشحن للعيادة'
    };
    // ربط الخطوة الرقمية بمفتاح بوليان في البنية الجديدة (5 خطوات)
    const newKeyForStep = {
        1: 'الإضافة لقائمة الانتظار',
        2: 'استلام الطلب',
        3: 'ارسال مندوب للعياده',
        4: 'استلام الحاله'
    };

    const tooltipLines = [];
    for (let i = 1; i <= 5; i++) {
        const dateSpan = document.getElementById(`step${i}-date`);
        const numVal   = statusHistory[i];
        const boolVal  = newKeyForStep[i] ? statusHistory[newKeyForStep[i]] : undefined;

        if (numVal) {
            const formatted = new Date(numVal).toLocaleString('ar-EG');
            if (dateSpan) dateSpan.textContent = formatted;
            tooltipLines.push(`${stepNames[i]}: ${formatted}`);
        } else if (boolVal === true) {
            if (dateSpan) dateSpan.textContent = '✅';
            tooltipLines.push(`${stepNames[i]}: ✅ مكتملة`);
        } else if (boolVal === false) {
            if (dateSpan) dateSpan.textContent = '';
            tooltipLines.push(`${stepNames[i]}: ⏳ في الانتظار`);
        } else {
            if (dateSpan) dateSpan.textContent = '';
        }
    }
    // تحديث tooltip خطوة "المعمل" (الآن step 4)
    const tooltip = document.getElementById('step4Tooltip');
    if (tooltip) {
        tooltip.innerHTML = tooltipLines.length
            ? tooltipLines.join('<br>')
            : 'لا توجد بيانات بعد';
    }
}

function setupStatusSteps() {
    document.querySelectorAll('.status-step').forEach(step => {
        step.addEventListener('click', async () => {
            const stepNum = parseInt(step.dataset.step);
            // الخطوة 1 تُفعّل تلقائياً عند الحفظ، والخطوة 2 من زر "طلب مندوب"
            if (stepNum === 1) { alert("ℹ️ هذه المرحلة تُفعّل تلقائياً عند حفظ الحالة في قائمة الانتظار"); return; }
            if (stepNum === 2) { alert("ℹ️ هذه المرحلة تُفعّل من زر 'طلب مندوب' داخل قائمة الانتظار"); return; }
            if (isReadOnly) { alert("🔒 لا يمكن تغيير حالة الطلب في وضع القراءة فقط!"); return; }
            if (!currentCaseId) { alert("⚠️ الرجاء حفظ الحالة أولاً!"); return; }
            if (stepNum > currentOrderStatus + 1) { alert(`⚠️ لا يمكن الانتقال للمرحلة ${stepNum} قبل إكمال المرحلة ${currentOrderStatus}`); return; }
            if (stepNum <= currentOrderStatus) { alert(`⚠️ المرحلة ${stepNum} تم إنجازها بالفعل`); return; }
            await updateOrderStatus(stepNum);
        });
    });
}

async function updateOrderStatus(newStatus) {
    if (isReadOnly || !currentCaseId) return;
    const casePath = currentCasePath || `${getDatabasePath()}/${currentCaseId}`;
    const caseRef = database.ref(casePath);
    const now = Date.now();
    // ربط رقم الخطوة بمفتاح البوليان في statusHistory (5 خطوات)
    const newKeyForStep = {
        1: 'الإضافة لقائمة الانتظار',
        2: 'استلام الطلب',
        3: 'ارسال مندوب للعياده',
        4: 'استلام الحاله'
    };
    try {
        const snapshot = await caseRef.once('value');
        const caseData = snapshot.val();
        if (caseData) {
            const statusHistory = caseData.statusHistory || {};
            const flagKey = newKeyForStep[newStatus];
            if (flagKey) {
                statusHistory[flagKey] = true;
            } else {
                // الخطوة 5 (الشحن للعيادة): نسجّل timestamp
                statusHistory[newStatus] = now;
            }
            await caseRef.update({ orderStatus: newStatus, statusHistory: statusHistory, lastStatusUpdate: now });
            currentOrderStatus = newStatus;
            applyStatusFromHistory(statusHistory);
            updateStepDates(statusHistory);
            const statusNames = {1: 'الإضافة لقائمة الانتظار', 2: 'وصول الطلب للمعمل', 3: 'وصول المندوب للعياده', 4: 'المعمل', 5: 'الشحن للعيادة'};
            alert(`✅ تم تحديث الحالة إلى: ${statusNames[newStatus]}`);
        }
    } catch (error) { console.error("خطأ:", error); }
}

function getTreatmentTypeFromCase(toothTreatments) {
    let hasZircon = false, hasPorcelain = false;
    for (const treatment of Object.values(toothTreatments)) {
        const t = (treatment && typeof treatment === 'object') ? treatment : { key: treatment, category: null };
        // الصيغة القديمة (نص)
        if (t.key === 'zircon')    hasZircon = true;
        if (t.key === 'porcelain') hasPorcelain = true;
        // الصيغة الجديدة (فئات الشجرة)
        if (t.category === 'zirconium') hasZircon = true;
        if (t.category === 'pfm')       hasPorcelain = true;
    }
    return { hasZircon, hasPorcelain };
}

// جمع كل الفئات الرئيسية المستخدمة في الحالة (pfm / zirconium / temporary / ortho)
function collectCaseCategories(toothTreatments) {
    const set = new Set();
    for (const treatment of Object.values(toothTreatments)) {
        if (treatment && typeof treatment === 'object' && treatment.category) {
            set.add(treatment.category);
        }
    }
    return Array.from(set);
}

// إيجاد سعر فعّال للبونتيك من السن الملاصق المتصل (مثلاً emax بـ 1300 بدل 700)
function getPonticEffectiveData(toothNumber, treatmentsMap, connections) {
    connections = connections || {};
    for (const [a, b] of adjacentPairs) {
        if (a !== toothNumber && b !== toothNumber) continue;
        const pairKey = `${a}_${b}`;
        if (!connections[pairKey]) continue;
        const otherTooth = (a === toothNumber) ? b : a;
        const neighbor = treatmentsMap[otherTooth];
        if (!neighbor) continue;
        const nd = getTreatmentData(neighbor);
        if (!nd.isPontic && typeof nd.price === 'number' && nd.price > 0) {
            return nd;
        }
    }
    return null;
}
function getPonticEffectivePrice(toothNumber, treatmentsMap, connections) {
    const nd = getPonticEffectiveData(toothNumber, treatmentsMap, connections);
    return nd ? nd.price : null;
}

// حساب إجمالي سعر الحالة الحالية من toothTreatments
// البونتيك يأخذ سعر السن الملاصق المتصل به (لو موجود)
function calcCaseTotalPrice(treatmentsMap, connections) {
    connections = connections || toothConnections || {};
    let total = 0;
    for (const [tooth, t] of Object.entries(treatmentsMap || {})) {
        const td = getTreatmentData(t);
        let price = (typeof td.price === 'number') ? td.price : 0;
        if (td.isPontic) {
            const adopted = getPonticEffectivePrice(parseInt(tooth), treatmentsMap, connections);
            if (adopted !== null) price = adopted;
        }
        total += price;
    }
    return total;
}

// حفظ فاتورة حالة واحدة وتحديث إجمالي فاتورة الطبيب
// المسار: dental lap/users/doctors/data/{doctorName}/invoices/{caseId}
//         dental lap/users/doctors/data/{doctorName}/invoiceTotal = { amount, casesCount, lastUpdate }
async function saveCaseInvoice(caseData, caseId) {
    const doctorKey = getDoctorKey();
    if (!doctorKey || doctorKey === 'unknown') return 0;

    const items = [];
    const connections = caseData.toothConnections || {};
    Object.entries(caseData.toothTreatments || {}).forEach(([tooth, t]) => {
        const td = getTreatmentData(t);
        let price = td.price || 0;
        if (td.isPontic) {
            const adopted = getPonticEffectivePrice(parseInt(tooth), caseData.toothTreatments || {}, connections);
            if (adopted !== null) price = adopted;
        }
        items.push({
            tooth: parseInt(tooth),
            key:   td.key || '',
            label: td.label || '',
            category: td.category || null,
            subOption: td.subOptionLabel || null,
            isPontic: !!td.isPontic,
            price,
        });
    });
    const total = items.reduce((s, it) => s + (it.price || 0), 0);
    const cats  = collectCaseCategories(caseData.toothTreatments || {});

    const dp = getCurrentDatePath();
    const invoiceEntry = {
        caseId,
        patientName: caseData.patientName,
        date: `${dp.year}/${dp.month}/${dp.day}`,
        timestamp: new Date().toLocaleString('ar-EG'),
        category: cats[0] || null,
        items,
        total,
    };

    // 1) حفظ فاتورة الحالة
    await database.ref(`dental lap/users/doctors/data/${doctorKey}/invoices/${caseId}`).set(invoiceEntry);

    // 2) تحديث الإجمالي عبر transaction (لمنع تعارض)
    const totalRef = database.ref(`dental lap/users/doctors/data/${doctorKey}/invoiceTotal`);
    await totalRef.transaction(curr => {
        const c = curr || { amount: 0, casesCount: 0 };
        c.amount     = (c.amount || 0) + total;
        c.casesCount = (c.casesCount || 0) + 1;
        c.lastUpdate = Date.now();
        return c;
    });

    // 3) تحديث الواجهة فوراً
    await loadDoctorInvoice(true);
    return total;
}

// تحميل وعرض الفاتورة الإجمالية للطبيب من المسار وتحديث الواجهة
async function loadDoctorInvoice(animateBump = false) {
    const doctorKey = getDoctorKey();
    if (!doctorKey || doctorKey === 'unknown') return;
    try {
        const snap = await database.ref(`dental lap/users/doctors/data/${doctorKey}/invoiceTotal`).once('value');
        const data = snap.val() || { outstandingAmount: 0, amount: 0, casesCount: 0 };
        const displayAmount = (data.outstandingAmount !== undefined && data.outstandingAmount !== null) ? data.outstandingAmount : (data.amount || 0);
        updateDoctorInvoiceUI(displayAmount, data.casesCount || 0, animateBump);
    } catch (e) {
        console.error('فشل تحميل الفاتورة الإجمالية:', e);
    }
}

function updateDoctorInvoiceUI(amount, casesCount, animateBump) {
    const totalEl = document.getElementById('diTotal');
    const casesEl = document.getElementById('diCases');
    const wrap    = document.querySelector('#doctorInvoice .di-amount');
    if (!totalEl || !casesEl) return;
    totalEl.textContent = (amount || 0).toLocaleString('en-US');
    casesEl.textContent = `${casesCount || 0} حالة`;
    if (animateBump && wrap) {
        wrap.classList.remove('bump');
        void wrap.offsetWidth;
        wrap.classList.add('bump');
    }
}

// تحديث لوحة "العلاجات المحددة" في البطاقة اليمنى
function updateTreatmentsSummary() {
    const list  = document.getElementById('treatmentsSummaryList');
    const count = document.getElementById('tsCount');
    const total = document.getElementById('treatmentsTotalPrice');
    if (!list || !count || !total) return;

    // تجميع حسب الفئة الرئيسية:
    //  • البونتيك المتصل بكونكتور → يأخذ كاتيجوري ولون وسعر السن المجاور
    //  • البونتيك غير المتصل → مجموعة مستقلة "بونتيك" (رمادي) + سعر = "حسب الكونكتور"
    const grouped = {}; // catKey -> { label, color, items: [{tooth, displayLabel, color, effectivePrice, isOrphanPontic}] }
    let totalPrice = 0;
    Object.entries(toothTreatments).forEach(([tooth, treatment]) => {
        const t = getTreatmentData(treatment);
        const toothNum = parseInt(tooth);

        if (t.isPontic) {
            const neighborData = getPonticEffectiveData(toothNum, toothTreatments, toothConnections);
            if (neighborData) {
                // متصل → يندمج تحت كاتيجوري السن المجاور بنفس اللون والاسم والسعر
                const catKey = neighborData.category || 'other';
                if (!grouped[catKey]) grouped[catKey] = { label: neighborData.categoryLabel || 'أخرى', color: (TREATMENT_TREE[catKey]?.color) || '#546e7a', items: [] };
                grouped[catKey].items.push({
                    tooth: toothNum,
                    displayLabel: neighborData.label,
                    color: neighborData.color,
                    effectivePrice: neighborData.price,
                    isOrphanPontic: false
                });
                totalPrice += neighborData.price;
            } else {
                // غير متصل → مجموعة "بونتيك" مستقلة بدون سعر
                const catKey = '__pontic_orphan__';
                if (!grouped[catKey]) grouped[catKey] = { label: 'بونتيك', color: '#607d8b', items: [] };
                grouped[catKey].items.push({
                    tooth: toothNum,
                    displayLabel: 'بونتيك',
                    color: '#607d8b',
                    effectivePrice: 0,
                    isOrphanPontic: true
                });
            }
        } else {
            const catKey = t.category || 'other';
            if (!grouped[catKey]) grouped[catKey] = { label: t.categoryLabel || 'أخرى', color: (TREATMENT_TREE[catKey]?.color) || '#546e7a', items: [] };
            const price = (typeof t.price === 'number') ? t.price : 0;
            grouped[catKey].items.push({
                tooth: toothNum,
                displayLabel: t.label + (t.subOptionLabel ? ` · ${t.subOptionLabel}` : ''),
                color: t.color,
                effectivePrice: price,
                isOrphanPontic: false
            });
            totalPrice += price;
        }
    });

    count.textContent = Object.keys(toothTreatments).length;
    total.textContent = totalPrice;

    if (Object.keys(grouped).length === 0) {
        list.innerHTML = '<div class="ts-empty">لا توجد علاجات بعد — اختر سنّاً وحدّد علاجه.</div>';
        return;
    }

    list.innerHTML = '';
    Object.keys(grouped).forEach(catKey => {
        const g = grouped[catKey];
        const block = document.createElement('div');
        block.className = 'ts-group';
        block.innerHTML = `<div class="ts-group-header" style="background:${g.color}">${g.label} <span class="ts-group-count">${g.items.length}</span></div>`;
        const itemsWrap = document.createElement('div');
        itemsWrap.className = 'ts-items';
        g.items.sort((a,b) => a.tooth - b.tooth).forEach(({tooth, displayLabel, color, effectivePrice, isOrphanPontic}) => {
            const row = document.createElement('div');
            row.className = 'ts-item';
            const priceCell = isOrphanPontic
                ? `<span class="ts-price" style="color:#ff6b6b; font-style:italic;">حسب الكونكتور</span>`
                : `<span class="ts-price">${effectivePrice || 0} ج</span>`;
            row.innerHTML = `
                <span class="ts-tooth" style="background:${color}">${tooth}</span>
                <span class="ts-label">${displayLabel}</span>
                ${priceCell}
            `;
            itemsWrap.appendChild(row);
        });
        block.appendChild(itemsWrap);
        list.appendChild(block);
    });
}

// =============== دالة حفظ الحالة الرئيسية (المعدلة) ===============
async function saveCaseToFirebase() {
    if (isReadOnly) { alert("🔒 لا يمكن حفظ التعديلات - هذه الحالة للقراءة فقط!"); return false; }

    const patientName = document.getElementById('patientName').value.trim();
    if (!patientName) { alert("⚠️ الرجاء إدخال اسم المريض أولاً!"); return false; }

    const notes = document.getElementById('notes').value.trim();

    if (Object.keys(toothTreatments).length === 0) { alert("⚠️ الرجاء تحديد الأسنان والعلاجات أولاً!"); return false; }

    // التحقق من البونتيك المتصل بكونكتور
    const orphanPontics = [];
    for (const [tooth, treatment] of Object.entries(toothTreatments)) {
        const td = getTreatmentData(treatment);
        if (td.isPontic) {
            const adopted = getPonticEffectivePrice(parseInt(tooth), toothTreatments, toothConnections);
            if (adopted === null || adopted <= 0) orphanPontics.push(tooth);
        }
    }
    if (orphanPontics.length > 0) {
        alert(`⚠️ لا يمكن حفظ الحالة!\n\nالبونتيك التالي غير متصل بكونكتور بسن مجاور له علاج:\nالأسنان: ${orphanPontics.join('، ')}\n\n🔗 الرجاء تفعيل الكونكتور بين البونتيك والسن المجاور له علاج (كراون/زيركون/إلخ) قبل الحفظ.`);
        return false;
    }

    const doctorKey = getDoctorKey();
    const now = Date.now();

    // ===== الفرع 1: تحديث حالة موجودة في قائمة الانتظار (waiting) =====
    if (currentEditingPoolCase && currentCaseId) {
        const ed = currentEditingPoolCase;
        const editPath = `dental lap/case data/waiting/${ed.year}/${ed.month}/${ed.day}/${doctorKey}/${ed.caseId}`;
        try {
            const snap = await database.ref(editPath).once('value');
            const existing = snap.val();
            if (!existing) {
                alert("⚠️ الحالة الأصلية غير موجودة في قائمة الانتظار (قد تكون حُذفت أو أُرسلت).");
                currentEditingPoolCase = null;
                return false;
            }
            const computedTotal = calcCaseTotalPrice(toothTreatments);
            const updated = Object.assign({}, existing, {
                patientName, notes, toothTreatments, toothConnections,
                total: computedTotal,
                paidAmount: existing.paidAmount || 0,
                remainingAmount: Math.max(0, computedTotal - (existing.paidAmount || 0)),
                isPaid: (computedTotal - (existing.paidAmount || 0)) <= 0,
                lastEditedAt: now,
            });
            // رفع ملف معلّق لو موجود
            if (pendingUploadFile) {
                try {
                    const storagePath = `scans/${currentClinicName}/${ed.caseId}/${pendingUploadFile.name}`;
                    const { url } = await uploadFileToStorage(pendingUploadFile, storagePath);
                    updated.scannerFile        = pendingUploadFile.name;
                    updated.scannerFileUrl     = url;
                    updated.scannerStoragePath = storagePath;
                    updated.scannerUploadedAt  = now;
                    pendingUploadFile = null;
                } catch (e) { console.error('فشل رفع الملف:', e); }
            }
            await database.ref(editPath).set(updated);
            // تحديث المؤشّر المسطّح
            await database.ref(`dental lap/users/doctors/data/${doctorKey}/waiting/${ed.caseId}`)
                .update({ patientName, total: computedTotal });
            applyStatusFromHistory(updated.statusHistory);
            updateStepDates(updated.statusHistory);
            displaySecretCode(patientName, updated.randomCode || '', updated.scannerFile || null);
            alert(`✅ تم تحديث الحالة في قائمة الانتظار`);
            return true;
        } catch (e) {
            console.error("خطأ في تحديث حالة pool:", e);
            alert("❌ فشل تحديث الحالة: " + e.message);
            return false;
        }
    }

    // ===== الفرع 2: حفظ حالة جديدة في قائمة الانتظار (waiting) =====
    const today = new Date();
    const date  = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const exists = await checkIfCaseExists(patientName, date);
    if (exists) { alert("⚠️ لا يمكن حفظ الحالة! يوجد حالة سابقة بنفس اسم المريض والتاريخ."); return false; }

    const counter = await getDailyCounterAndReturn(doctorKey, date);
    const secretCodeV2 = await generateSecretCodeV2(currentClinicName, date, counter);
    currentSecretCode = secretCodeV2;

    const caseId = `${patientName}-${counter}`;
    currentCaseId = caseId;
    currentConversation = [];
    const aiMsgsResetEl = document.getElementById('aiMessages');
    if (aiMsgsResetEl) aiMsgsResetEl.innerHTML = '';
    updateAiBarVisibility();

    // الحالة الجديدة في قائمة الانتظار: الخطوة 1 فقط مفعّلة
    const statusHistory = {
        "الإضافة لقائمة الانتظار": true,
        "استلام الطلب":          false,
        "ارسال مندوب للعياده":    false,
        "استلام الحاله":          false,
    };
    const finalOrderStatus = 1;
    const datePath = getCurrentDatePath();

    const caseData = {
        caseId,
        randomCode: secretCodeV2,
        patientName,
        notes,
        toothTreatments,
        toothConnections,
        orderStatus: finalOrderStatus,
        statusHistory,
        createdAt: now,
        date,                                              // للتوافق مع checkIfCaseExists
        _year: datePath.year, _month: datePath.month, _day: datePath.day, // مرجع التاريخ الأصلي
        isReadOnly: false,                                 // قابلة للتعديل أثناء وجودها في الـpool
    };
    if (uploadedFileName) { caseData.scannerFile = uploadedFileName; caseData.scannerUploadedAt = now; }

    try {
        if (pendingUploadFile) {
            try {
                const storagePath = `scans/${currentClinicName}/${caseId}/${pendingUploadFile.name}`;
                const { url } = await uploadFileToStorage(pendingUploadFile, storagePath);
                caseData.scannerFile        = pendingUploadFile.name;
                caseData.scannerFileUrl     = url;
                caseData.scannerStoragePath = storagePath;
                caseData.scannerUploadedAt  = now;
                pendingUploadFile = null;
            } catch (uploadErr) {
                console.error('فشل رفع الملف المرفق:', uploadErr);
                alert('⚠️ تم حفظ الحالة لكن فشل رفع ملف السكان. يمكنك إعادة المحاولة.');
            }
        }

        const computedTotal = calcCaseTotalPrice(toothTreatments);
        caseData.total           = computedTotal;
        caseData.paidAmount      = 0;
        caseData.remainingAmount = computedTotal;
        caseData.isPaid          = computedTotal === 0;

        // ✦ الحفظ في مسار waiting فقط — لا توجد كتابات جانبية في هذه المرحلة.
        //   كل المسارات الأخرى (Secret Index / Workers / Career Ladder / Case Type
        //   / Invoice / Flat Pointer) تُكتب لاحقاً عند الضغط على "طلب مندوب".
        await database.ref(`${getWaitingPath()}/${caseId}`).set(caseData);

        // مؤشر مسطّح تحت الطبيب لاكتشاف كل الحالات في قائمة الانتظار بسرعة
        await database.ref(`dental lap/users/doctors/data/${doctorKey}/waiting/${caseId}`).set({
            year: datePath.year, month: datePath.month, day: datePath.day,
            doctorName: doctorKey, caseId, patientName, createdAt: now,
            total: computedTotal,
        });

        currentOrderStatus = finalOrderStatus;
        applyStatusFromHistory(statusHistory);
        updateStepDates(statusHistory);
        displaySecretCode(patientName, secretCodeV2, caseData.scannerFile || null);

        // الحالة لا تزال قابلة للتعديل (في الـpool) — نفعّل وضع تحرير الـpool
        currentEditingPoolCase = { year: datePath.year, month: datePath.month, day: datePath.day, caseId };
        currentCasePath = `${getWaitingPath()}/${caseId}`;
        _lastConversationLength = 0;
        attachCaseListener();
        updateWaitingBadge();
        return true;
    } catch (error) {
        console.error("خطأ:", error);
        alert("❌ حدث خطأ في حفظ الحالة: " + error.message);
        return false;
    }
}

async function loadExistingCase(patientName, date) {
    const dateObj = new Date(date);
    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    const snapshot = await database.ref(`dental lap/case data/${year}/${month}/${day}/${getDoctorKey()}`).once('value');
    const cases = snapshot.val();
    if (!cases) return;
    for (const caseId in cases) {
        if (cases[caseId].patientName === patientName && cases[caseId].date === date) {
            loadCaseToDashboard(cases[caseId]);
            setReadOnlyMode(true);
            return;
        }
    }
}

function loadCaseToDashboard(caseData) {
    currentCaseId = caseData.caseId;
    currentSecretCode = caseData.randomCode || null;
    if (caseData._year && caseData._month && caseData._day) {
        currentCasePath = `dental lap/case data/${caseData._year}/${caseData._month}/${caseData._day}/${getDoctorKey()}/${caseData.caseId}`;
    } else {
        currentCasePath = `${getDatabasePath()}/${caseData.caseId}`;
    }

    document.getElementById('patientName').value = caseData.patientName || '';
    document.getElementById('notes').value = caseData.notes || '';

    // استرجاع محادثة الذكاء الاصطناعي الخاصة بهذه الحالة فقط
    let convo = caseData.conversation || [];
    if (convo && !Array.isArray(convo)) {
        // فايربيز قد يحوّل المصفوفة إلى كائن — نُعيدها لمصفوفة
        convo = Object.keys(convo).sort((a,b) => Number(a)-Number(b)).map(k => convo[k]);
    }
    currentConversation = convo;
    _lastConversationLength = currentConversation.length;
    rebuildAiMessagesUI(currentConversation);
    attachCaseListener();

    // مسح newNews لما الطبيب يفتح الحالة
    if (currentCasePath && caseData.newNews) {
        database.ref(currentCasePath + '/newNews').set(false).catch(() => {});
    }

    toothTreatments = caseData.toothTreatments || {};
    toothConnections = caseData.toothConnections || {};

    resetTeethUI();
    for (const [tooth, treatment] of Object.entries(toothTreatments)) {
        applyTreatmentToToothUI(parseInt(tooth), treatment);
    }
    setTimeout(() => resetConnectionsUI(), 150);
    updateTreatmentsSummary();

    currentOrderStatus = caseData.orderStatus || 1;
    applyStatusFromHistory(caseData.statusHistory);
    updateStepDates(caseData.statusHistory);
    uploadedFileName = caseData.scannerFile || null;
    currentTreatment = null;
    selectedTooth = null;
    document.querySelectorAll('.tooth-button').forEach(btn => btn.classList.remove('selected'));
    resetTreatmentPanel();
    updateSelectedCount();

    if (currentSecretCode) {
        displaySecretCode(caseData.patientName || '', currentSecretCode, caseData.scannerFile || null);
    } else {
        hideSecretCode();
    }

    setReadOnlyMode(true);
    updateAiBarVisibility();
}

function resetTeethUI() {
    document.querySelectorAll('.tooth-button').forEach(btn => {
        btn.classList.remove('zircon', 'porcelain', 'pontic', 'healthy', 'selected');
        btn.style.background = '';
        btn.style.color = '';
        btn.removeAttribute('data-treatment');
    });
}

function applyTreatmentToToothUI(toothNumber, treatment) {
    const btn = Array.from(document.querySelectorAll('.tooth-button')).find(b => parseInt(b.innerText) === toothNumber);
    if (btn) {
        btn.classList.remove('zircon', 'porcelain', 'pontic', 'healthy');
        const td = getTreatmentData(treatment);
        btn.style.background = td.color;
        btn.style.color = 'white';
        btn.dataset.treatment = td.key || '';
    }
}

function resetConnectionsUI() {
    document.querySelectorAll('.connection-dot').forEach(dot => dot.remove());
    addConnectionDots();
}

// إغلاق نافذة السجل مع تأثير ظهور/اختفاء
function closeOverlayAnimated(overlay) {
    overlay.classList.add('hiding');
    overlay.addEventListener('animationend', () => overlay.remove(), { once: true });
}

function showCaseDetails(caseData) {
    const overlay = document.createElement('div');
    overlay.className = 'records-overlay';
    const card = document.createElement('div');
    card.className = 'records-card';

    let treatmentsHtml = '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); gap: 8px;">';
    for (const [tooth, treatment] of Object.entries(caseData.toothTreatments || {})) {
        let treatmentText = treatment === 'zircon' ? 'زيركونيوم' : treatment === 'porcelain' ? 'بورسلين' : treatment === 'pontic' ? 'بونتيك' : 'صحي';
        treatmentsHtml += `<div style="background:#2a2a38; padding:6px; border-radius:12px; text-align:center;">🦷 ${tooth}<br><small>${treatmentText}</small></div>`;
    }
    treatmentsHtml += '</div>';

    const statusNames = {1: '📥 الإضافة لقائمة الانتظار', 2: '📦 وصول الطلب للمعمل', 3: '🛵 وصول المندوب للعياده', 4: '🏭 المعمل', 5: '🏥 الشحن للعيادة'};
    const progressPercentage = Math.max(0, Math.min(100, ((caseData.orderStatus - 1) / 4) * 100));

    card.innerHTML = `
        <h3 style="color:#ffb74d; text-align:center;">📋 تفاصيل الحالة</h3>
        <div><p><strong>🆔 المعرف:</strong> ${escapeHtml(caseData.caseId)}</p>
        <p><strong>🔐 الرقم التأكيدي:</strong> <span style="font-size: 24px; font-family: monospace; letter-spacing: 2px; color: #ffd700;">${escapeHtml(caseData.randomCode || 'غير متوفر')}</span></p>
        <p><strong>🏥 اسم العيادة:</strong> ${escapeHtml(currentClinicName || '')}</p>
        <p><strong>👤 اسم المريض:</strong> ${escapeHtml(caseData.patientName)}</p>
        <p><strong>📅 التاريخ:</strong> ${escapeHtml(caseData._datePath || `${caseData._year || ''}/${caseData._month || ''}/${caseData._day || ''}`)}</p>
        <p><strong>📝 الملاحظات:</strong> ${escapeHtml(caseData.notes || 'لا توجد')}</p>
        <p><strong>📊 حالة الطلب:</strong> <span style="color:#4caf50;">${statusNames[caseData.orderStatus] || 'غير محدد'}</span></p>
        ${caseData.scannerFile ? `<p><strong>📎 ملف:</strong> ${escapeHtml(caseData.scannerFile)}</p>` : ''}
        <div style="margin: 15px 0;"><div style="background:#2a2a38; border-radius:20px; overflow:hidden; height:12px;"><div style="width:${progressPercentage}%; height:100%; background:linear-gradient(90deg, #4caf50, #ffd700, #ff9800, #ff5722); border-radius:20px 0 0 20px;"></div></div><p style="text-align:center; margin-top:8px;">تقدم الطلب: ${Math.round(progressPercentage)}%</p></div>
        <hr><h4 style="color:#ffb74d;">🦷 الأسنان والعلاجات:</h4>${treatmentsHtml}</div>
        <div style="display:flex; gap:10px; margin-top:20px;"><button class="load-case-btn" style="background:#2e7d32; padding:8px 20px; border-radius:40px; border:none; color:white; cursor:pointer; flex:1;">📂 تحميل الحالة للواجهة</button><button class="close-detail" style="background:#c62828; padding:8px 20px; border-radius:40px; border:none; color:white; cursor:pointer;">إغلاق</button></div>
    `;

    card.querySelector('.close-detail').addEventListener('click', () => closeOverlayAnimated(overlay));
    card.querySelector('.load-case-btn').addEventListener('click', () => { loadCaseToDashboard(caseData); closeOverlayAnimated(overlay); });
    overlay.appendChild(card);
    document.body.appendChild(overlay);
}

// شارة حالة الدفع: تستخدم في السجل (مدفوعة كاملاً / مدفوعة جزئياً / غير مدفوعة)
function buildPaymentBadge(caseData) {
    const total     = Number(caseData.total ?? 0);
    const remaining = Number(caseData.remainingAmount ?? total);
    const paid      = Number(caseData.paidAmount ?? Math.max(0, total - remaining));

    if (total > 0 && remaining <= 0) {
        return {
            badge: `<span class="pay-badge paid">✅ تم دفع ثمن الحالة بالكامل</span>`,
            line:  `<div class="pay-line">الإجمالي: <span class="amt">${total.toLocaleString('en-US')} ج.م</span> — تم السداد كاملاً</div>`,
        };
    }
    if (paid > 0 && remaining > 0) {
        return {
            badge: `<span class="pay-badge partial">💸 مدفوع جزئياً</span>`,
            line:  `<div class="pay-line">المتبقي: <span class="amt">${remaining.toLocaleString('en-US')} ج.م</span> من إجمالي ${total.toLocaleString('en-US')} ج.م</div>`,
        };
    }
    return {
        badge: `<span class="pay-badge unpaid">❌ غير مدفوعة</span>`,
        line:  `<div class="pay-line">المبلغ المطلوب: <span class="amt">${total.toLocaleString('en-US')} ج.م</span></div>`,
    };
}

function resetForm() {
    // تم حذف رسائل التأكيد لطلب المستخدم — البدء فوراً في حالة جديدة بدون تحذيرات

    document.getElementById('patientName').value = '';
    document.getElementById('notes').value = '';
    document.querySelectorAll('.tooth-button').forEach(btn => {
        btn.classList.remove('zircon', 'porcelain', 'pontic', 'healthy', 'selected');
        btn.style.background = '';
        btn.style.color = '';
        btn.removeAttribute('data-treatment');
    });
    document.querySelectorAll('.connection-dot').forEach(dot => dot.classList.remove('connected'));
    toothTreatments = {};
    toothConnections = {};
    selectedTooth = null;
    currentTreatment = null;
    currentCaseId = null;
    currentCasePath = null;
    uploadedFileName = null;
    pendingUploadFile = null;
    currentOrderStatus = 0;
    currentSecretCode = null;
    currentEditingPoolCase = null;
    updateStatusBar(0);
    // مسح علامات ✅ والتواريخ في خطوات البار العلوي (5 خطوات الآن) + إعادة الـ tooltip
    for (let i = 1; i <= 5; i++) {
        const ds = document.getElementById(`step${i}-date`);
        if (ds) ds.textContent = '';
    }
    const step4Tooltip = document.getElementById('step4Tooltip');
    if (step4Tooltip) step4Tooltip.innerHTML = 'لا توجد بيانات بعد';
    // إخفاء الموتوسيكل وإعادة شريط التعبئة
    const fl = document.getElementById('progressLineFill');
    if (fl) fl.style.width = '0%';
    const mb = document.getElementById('motoBadge');
    if (mb) mb.style.display = 'none';
    resetTreatmentPanel();
    updateSelectedCount();
    updateTreatmentsSummary();
    hideSecretCode();
    resetScannerIndicator();
    setReadOnlyMode(false);

    // Reset AI conversation
    currentConversation = [];
    _lastConversationLength = 0;
    const aiMessages = document.getElementById('aiMessages');
    if (aiMessages) aiMessages.innerHTML = '';
    updateAiBarVisibility();
    detachCaseListener();
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m] || m));
}

function updateSelectedCount() {
    document.getElementById('selectedToothCount').innerText = Object.keys(toothTreatments).length;
}

function addConnectionDots() {
    const teethContainer = document.getElementById('teethContainer');
    const toothMap = new Map();
    document.querySelectorAll('.tooth-button').forEach(btn => toothMap.set(parseInt(btn.innerText), btn));
    const containerRect = teethContainer.getBoundingClientRect();

    adjacentPairs.forEach(pair => {
        const tooth1 = toothMap.get(pair[0]);
        const tooth2 = toothMap.get(pair[1]);
        if (tooth1 && tooth2) {
            const rect1 = tooth1.getBoundingClientRect();
            const rect2 = tooth2.getBoundingClientRect();
            // نقطة مركز كل سن، ثم منتصف المركزين تماماً = منتصف الزرّين
            const c1x = rect1.left + rect1.width  / 2;
            const c1y = rect1.top  + rect1.height / 2;
            const c2x = rect2.left + rect2.width  / 2;
            const c2y = rect2.top  + rect2.height / 2;
            const midX = (c1x + c2x) / 2 - containerRect.left;
            const midY = (c1y + c2y) / 2 - containerRect.top;
            const dot = document.createElement('div');
            dot.className = 'connection-dot';
            const pairKey = `${pair[0]}_${pair[1]}`;
            if (toothConnections[pairKey]) dot.classList.add('connected');
            // الإزاحة = نصف قُطر النقطة (18/2 = 9)
            dot.style.left = (midX - 9) + 'px';
            dot.style.top  = (midY - 9) + 'px';
            dot.addEventListener('click', (e) => {
                e.stopPropagation();
                if (isReadOnly) return;
                // منع التفعيل لو السنّتين الملاصقتين مش معالَجَتين (الإلغاء مسموح دائماً)
                const isCurrentlyConnected = dot.classList.contains('connected');
                if (!isCurrentlyConnected) {
                    const t1HasTx = !!toothTreatments[pair[0]];
                    const t2HasTx = !!toothTreatments[pair[1]];
                    if (!t1HasTx || !t2HasTx) {
                        dot.classList.remove('invalid-flash');
                        // إعادة تشغيل الأنيميشن
                        void dot.offsetWidth;
                        dot.classList.add('invalid-flash');
                        setTimeout(() => dot.classList.remove('invalid-flash'), 700);
                        return;
                    }
                }
                dot.classList.toggle('connected');
                toothConnections[pairKey] = dot.classList.contains('connected');
                // إعادة حساب أسعار البونتيك في الملخّص فور تغيّر الكونكتور
                updateTreatmentsSummary();
            });
            teethContainer.appendChild(dot);
        }
    });
}

function applyTreatmentToTooth(toothNumber, treatment) {
    if (isReadOnly) return;
    const btn = Array.from(document.querySelectorAll('.tooth-button')).find(b => parseInt(b.innerText) === toothNumber);
    if (btn) {
        btn.classList.remove('zircon', 'porcelain', 'pontic', 'healthy');
        const td = getTreatmentData(treatment);
        btn.style.background = td.color;
        btn.style.color = 'white';
        btn.dataset.treatment = td.key || '';
        // نخزّن دائماً الكائن الكامل (كي تبقى الفئة والسعر والخيارات الفرعية)
        toothTreatments[toothNumber] = (typeof treatment === 'object') ? treatment : td;
        updateSelectedCount();
        updateTreatmentsSummary();
    }
}

function setupTreatmentButtons() {
    document.querySelectorAll('.treatment-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (isReadOnly) { alert("🔒 لا يمكن تعديل العلاج في وضع القراءة فقط!"); return; }
            const patientName = document.getElementById('patientName').value.trim();
            if (!patientName) { alert("⚠️ الرجاء إدخال اسم المريض أولاً!"); return; }
            document.querySelectorAll('.treatment-btn').forEach(b => b.classList.remove('selected-treatment'));
            btn.classList.add('selected-treatment');
            currentTreatment = btn.dataset.treatment;
            if (selectedTooth) applyTreatmentToTooth(selectedTooth, currentTreatment);
            else alert("👆 الرجاء تحديد السن أولاً!");
        });
    });
}

function initAdvancedDentalSystem() {
    const teethContainer = document.getElementById('teethContainer');
    if (!teethContainer) return;

    const centerX = teethContainer.clientWidth / 2;
    const centerY = teethContainer.clientHeight / 2;
    // هامش 10px من الحافة العلوية + 10px من حقل الذكاء الاصطناعي (الحافة السفلية)
    // نصف قطر الزر = 22px  →  حافة المركز = 10 + 22 = 32px
    // radiusY = centerY - 32 (حافة العلوية للفك العلوي) - 32 (إزاحة الصف) = centerY - 64
    const MARGIN = 32;       // 10px edge + 22px half-button
    const ROW_OFFSET = 28;   // الفجوة بين الفكين العلوي والسفلي
    const radiusY = Math.max(centerY - MARGIN - ROW_OFFSET, 110);
    // نصف القطر الأفقي أضيق لتقريب الضرس الخلفي 18→28 و38→48
    const radiusX = Math.max(centerX * 0.70, 130);

    const drawTooth = (number, x, y) => {
        const button = document.createElement("button");
        button.classList.add("tooth-button");
        button.innerText = number;
        // الإزاحة = نصف عرض الزر (44/2 = 22)
        button.style.left = (x - 22) + "px";
        button.style.top  = (y - 22) + "px";
        if (toothTreatments[number]) {
            const td = getTreatmentData(toothTreatments[number]);
            button.style.background = td.color;
            button.style.color = 'white';
            button.dataset.treatment = td.key || '';
        }

        // الضغط ثم السحب (بدون ضغط مطوّل): بمجرد تحريك الإصبع/الفأرة بمقدار صغير
        // أثناء الضغط، يبدأ السحب فوراً.
        let pressDownPos = null;
        let pressDownEvent = null;
        const DRAG_THRESHOLD = 6; // بكسل
        button.addEventListener('pointerdown', (e) => {
            if (isReadOnly) return;
            pressDownPos = { x: e.clientX, y: e.clientY };
            pressDownEvent = e;
        });
        button.addEventListener('pointermove', (e) => {
            if (!pressDownPos || isDragging || isReadOnly) return;
            const dx = e.clientX - pressDownPos.x;
            const dy = e.clientY - pressDownPos.y;
            if (Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
                const treatment = toothTreatments[number];
                if (treatment) {
                    startTreatmentDrag(e, number, treatment);
                } else {
                    startClearDrag(e);
                }
                pressDownPos = null;
                pressDownEvent = null;
            }
        });
        const cancelPress = () => { pressDownPos = null; pressDownEvent = null; };
        button.addEventListener('pointerup', cancelPress);
        button.addEventListener('pointercancel', cancelPress);
        button.addEventListener('pointerleave', () => { /* السحب يستمر فوق المستند */ });

        button.addEventListener("click", () => {
            if (_dragEndedRecently) return;
            if (isReadOnly) { alert("🔒 لا يمكن تحديد السن في وضع القراءة فقط!"); return; }
            const patientName = document.getElementById('patientName').value.trim();
            if (!patientName) { alert("⚠️ الرجاء إدخال اسم المريض أولاً!"); return; }
            document.querySelectorAll('.tooth-button').forEach(btn => btn.classList.remove('selected'));
            button.classList.add('selected');
            selectedTooth = number;
            updateSelectedCount();
            const existingTreatment = toothTreatments[number];
            if (existingTreatment) {
                lockTreatmentPanel(number, existingTreatment);
            } else {
                showTreatmentPanel(number);
            }
        });
        teethContainer.appendChild(button);
    };

    upperTeeth.forEach((number, index) => {
        const angle = Math.PI + ((index + 1) / (upperTeeth.length + 1)) * Math.PI;
        drawTooth(number, centerX + radiusX * Math.cos(angle), centerY + radiusY * Math.sin(angle) - ROW_OFFSET);
    });
    lowerTeeth.forEach((number, index) => {
        const angle = ((index + 1) / (lowerTeeth.length + 1)) * Math.PI;
        drawTooth(number, centerX + radiusX * Math.cos(angle), centerY + radiusY * Math.sin(angle) + ROW_OFFSET);
    });

    setTimeout(() => addConnectionDots(), 100);

    document.addEventListener('pointermove', handleDragMove);
    document.addEventListener('pointerup', handleDragEnd);
}

// ============= خدمة العملاء =============

function showCustomerService() {
    const patientName = document.getElementById('patientName').value.trim();
    if (!patientName) {
        alert("⚠️ الرجاء إدخال اسم المريض أولاً قبل الاتصال بخدمة العملاء!");
        return;
    }
    if (!currentCaseId && !isReadOnly) {
        if (confirm("⚠️ لم يتم حفظ هذه الحالة بعد.\n\nهل تريد حفظ الحالة أولاً قبل التواصل مع خدمة العملاء؟")) {
            saveCaseToFirebase().then(success => { if (success) showCustomerServiceCard(patientName); });
        } else {
            showCustomerServiceCard(patientName);
        }
    } else {
        showCustomerServiceCard(patientName);
    }
}

function showCustomerServiceCard(patientName) {
    const overlay = document.getElementById('csOverlay');
    if (!overlay) return;

    // Update bot text with patient name
    const botText = document.getElementById('csBotText');
    if (botText) {
        botText.innerHTML = `أقدر أساعد حضرتك إزاي يا دكتور في حالة المريض <span class="cs-patient-name">"${escapeHtml(patientName)}"</span><br><br>هل هتحتاج تعدل كروس؟ ولا تضيف ملحوظة؟ ولا تغير حاجة معينة؟ ولا تكنسل الحالة؟`;
    }

    // Reset input section
    const inputSection = document.getElementById('csInputSection');
    if (inputSection) inputSection.classList.remove('show');
    const successMsg = document.getElementById('csSuccessMsg');
    if (successMsg) { successMsg.classList.remove('show'); successMsg.textContent = ''; }
    const inputContent = document.getElementById('csInputContent');
    if (inputContent) inputContent.innerHTML = '';

    overlay.style.display = 'flex';
    overlay._currentAction = null;
    overlay._patientName   = patientName;
}

function showInputForm(action, container, patientName) {
    let html = '';
    switch(action) {
        case 'edit': html = `<div class="cs-input-group"><label>✏️ تعديل الكروس</label><input type="text" id="cs_cross_value" placeholder="أدخل قيمة الكروس الجديدة"></div><div class="cs-input-group"><label>📝 ملاحظات إضافية</label><textarea id="cs_edit_note" rows="2" placeholder="أضف أي تفاصيل إضافية..."></textarea></div>`; break;
        case 'note': html = `<div class="cs-input-group"><label>📝 إضافة ملحوظة جديدة</label><textarea id="cs_note_text" rows="4" placeholder="اكتب الملحوظة هنا..."></textarea></div>`; break;
        case 'change': html = `<div class="cs-input-group"><label>🔄 ماذا تريد تغيير؟</label><select id="cs_change_type"><option value="treatment">نوع العلاج</option><option value="tooth">السن</option><option value="date">التاريخ</option><option value="notes">الملاحظات</option></select></div><div class="cs-input-group"><label>✏️ القيمة الجديدة</label><input type="text" id="cs_change_value" placeholder="أدخل القيمة الجديدة"></div>`; break;
        case 'cancel': html = `<div class="cs-input-group"><label>❌ سبب إلغاء الحالة</label><select id="cs_cancel_reason"><option value="patient_request">طلب من المريض</option><option value="technical_issue">مشكلة تقنية</option><option value="wrong_data">بيانات خاطئة</option><option value="duplicate">حالة مكررة</option><option value="other">سبب آخر</option></select></div><div class="cs-input-group"><label>📝 تفاصيل إضافية</label><textarea id="cs_cancel_details" rows="3" placeholder="أضف أي تفاصيل إضافية..."></textarea></div>`; break;
    }
    container.innerHTML = html;
}

async function handleEditCross(crossValue, patientName) {
    if (!crossValue) { alert("⚠️ الرجاء إدخال قيمة الكروس الجديدة"); return false; }
    if (!currentCaseId) { alert("⚠️ لا توجد حالة نشطة"); return false; }
    try {
        const casePath = currentCasePath || `${getDatabasePath()}/${currentCaseId}`;
        const caseRef = database.ref(casePath);
        const currentNotes = document.getElementById('notes').value;
        const newNote = `[تعديل كروس - ${new Date().toLocaleString('ar-EG')}] تم تعديل الكروس إلى: ${crossValue}\n${currentNotes}`;
        await caseRef.update({ crossValue: crossValue, notes: newNote, lastModified: Date.now(), lastModifiedBy: 'customer_service' });
        document.getElementById('notes').value = newNote;
        return true;
    } catch (error) { console.error(error); return false; }
}

async function handleAddNote(noteText, patientName) {
    if (!noteText) { alert("⚠️ الرجاء إدخال الملحوظة"); return false; }
    if (!currentCaseId) { alert("⚠️ لا توجد حالة نشطة"); return false; }
    try {
        const casePath = currentCasePath || `${getDatabasePath()}/${currentCaseId}`;
        const caseRef = database.ref(casePath);
        const currentNotes = document.getElementById('notes').value;
        const newNote = `[ملحوظة جديدة - ${new Date().toLocaleString('ar-EG')}] ${noteText}\n${currentNotes}`;
        await caseRef.update({ notes: newNote, lastModified: Date.now(), lastModifiedBy: 'customer_service' });
        document.getElementById('notes').value = newNote;
        return true;
    } catch (error) { console.error(error); return false; }
}

async function handleChangeSomething(changeType, changeValue, patientName) {
    if (!changeValue) { alert("⚠️ الرجاء إدخال القيمة الجديدة"); return false; }
    if (!currentCaseId) { alert("⚠️ لا توجد حالة نشطة"); return false; }
    try {
        const casePath = currentCasePath || `${getDatabasePath()}/${currentCaseId}`;
        const caseRef = database.ref(casePath);
        const updateData = { lastModified: Date.now(), lastModifiedBy: 'customer_service' };
        switch(changeType) {
            case 'date': updateData.date = changeValue; break;
            case 'notes':
                const currentNotes = document.getElementById('notes').value;
                updateData.notes = `[تعديل - ${new Date().toLocaleString('ar-EG')}] ${changeValue}\n${currentNotes}`;
                document.getElementById('notes').value = updateData.notes;
                break;
        }
        await caseRef.update(updateData);
        return true;
    } catch (error) { console.error(error); return false; }
}

async function handleCancelCase(reason, patientName) {
    if (!currentCaseId) { alert("⚠️ لا توجد حالة نشطة"); return false; }
    if (!confirm(`⚠️ هل أنت متأكد من إلغاء حالة المريض "${patientName}"؟\n\nهذا الإجراء لا يمكن التراجع عنه!`)) return false;
    try {
        const casePath = currentCasePath || `${getDatabasePath()}/${currentCaseId}`;
        const caseRef = database.ref(casePath);
        await caseRef.update({ status: 'cancelled', cancelledAt: Date.now(), cancelReason: reason, cancelledBy: 'customer_service' });
        return true;
    } catch (error) { console.error(error); return false; }
}

async function handleLogout() {
    await auth.signOut();
    localStorage.removeItem('currentUser');
    window.location.href = 'index.html';
}

// تهيئة الصفحة
document.addEventListener('DOMContentLoaded', () => {
    if (!loadUserData()) return;
    initAdvancedDentalSystem();
    setupStatusSteps();
    // تحميل وعرض الفاتورة الإجمالية للطبيب من قاعدة البيانات
    loadDoctorInvoice(false);
    updateTreatmentsSummary();
    // المساعد الذكي مقفول حتى يتم حفظ الحالة
    updateAiBarVisibility();

    document.getElementById('uploadScannerBtn').addEventListener('click', uploadScannerFile);
    const scannerChangeBtn = document.getElementById('scannerChangeBtn');
    if (scannerChangeBtn) scannerChangeBtn.addEventListener('click', uploadScannerFile);
    document.getElementById('saveBtnDashboard').addEventListener('click', saveCaseToFirebase);
    document.getElementById('newBtnDashboard').addEventListener('click', resetForm);
    document.getElementById('recordBtnDashboard').addEventListener('click', showTabbedRecords);
    updateWaitingBadge();
    document.getElementById('logoutBtn').addEventListener('click', handleLogout);

    // Treatment sidebar
    const tpDeselectBtn = document.getElementById('tpDeselectBtn');
    if (tpDeselectBtn) {
        tpDeselectBtn.addEventListener('click', () => {
            document.querySelectorAll('.tooth-button').forEach(b => b.classList.remove('selected'));
            selectedTooth = null;
            resetTreatmentPanel();
        });
    }
    const tpChangeBtn = document.getElementById('tpChangeBtn');
    if (tpChangeBtn) {
        tpChangeBtn.addEventListener('click', () => { if (selectedTooth) showTreatmentPanel(selectedTooth); });
    }
    const tpDefaultTooth = document.getElementById('tpDefaultTooth');
    if (tpDefaultTooth) {
        tpDefaultTooth.addEventListener('pointerdown', (e) => { if (!isReadOnly) startClearDrag(e); });
    }

    // ===== AI Chat =====
    const aiChatBtn = document.getElementById('aiChatBtn');
    if (aiChatBtn) {
        aiChatBtn.addEventListener('click', () => {
            const input = document.getElementById('aiChatInput');
            const text  = input ? input.value.trim() : '';
            if (input) input.value = '';
            showAiChat(text || null);
        });
    }
    const aiChatInput = document.getElementById('aiChatInput');
    if (aiChatInput) {
        aiChatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const text = aiChatInput.value.trim();
                aiChatInput.value = '';
                showAiChat(text || null);
            }
        });
    }
    const aiBackBtn = document.getElementById('aiBackBtn');
    if (aiBackBtn) aiBackBtn.addEventListener('click', hideAiChat);
    const aiBackdrop = document.getElementById('aiBackdrop');
    if (aiBackdrop) aiBackdrop.addEventListener('click', hideAiChat);
    const aiSendBtn = document.getElementById('aiSendBtn');
    if (aiSendBtn) aiSendBtn.addEventListener('click', sendAiMessage);
    const aiSendInput = document.getElementById('aiSendInput');
    if (aiSendInput) {
        aiSendInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAiMessage(); });
    }

    // ===== Customer Service Overlay (pre-built HTML) =====
    const csOverlay = document.getElementById('csOverlay');
    if (csOverlay) {
        document.getElementById('csCloseBtn').addEventListener('click', () => { csOverlay.style.display = 'none'; });
        csOverlay.addEventListener('click', (e) => { if (e.target === csOverlay) csOverlay.style.display = 'none'; });

        csOverlay.querySelectorAll('.cs-option-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                csOverlay._currentAction = btn.dataset.action;
                const inputContent = document.getElementById('csInputContent');
                showInputForm(csOverlay._currentAction, inputContent, csOverlay._patientName);
                document.getElementById('csInputSection').classList.add('show');
                const successMsg = document.getElementById('csSuccessMsg');
                if (successMsg) { successMsg.classList.remove('show'); successMsg.textContent = ''; }
            });
        });

        document.getElementById('csBackBtn').addEventListener('click', () => {
            document.getElementById('csInputSection').classList.remove('show');
            csOverlay._currentAction = null;
            const successMsg = document.getElementById('csSuccessMsg');
            if (successMsg) { successMsg.classList.remove('show'); successMsg.textContent = ''; }
        });

        document.getElementById('csSubmitBtn').addEventListener('click', async () => {
            const action      = csOverlay._currentAction;
            const patientName = csOverlay._patientName;
            if (!action) return;
            let result = false, message = '';
            switch (action) {
                case 'edit':
                    result  = await handleEditCross(document.getElementById('cs_cross_value')?.value, patientName);
                    message = result ? '✅ تم تعديل الكروس بنجاح' : '❌ حدث خطأ';
                    break;
                case 'note':
                    result  = await handleAddNote(document.getElementById('cs_note_text')?.value, patientName);
                    message = result ? '✅ تم إضافة الملحوظة بنجاح' : '❌ حدث خطأ';
                    break;
                case 'change':
                    result  = await handleChangeSomething(document.getElementById('cs_change_type')?.value, document.getElementById('cs_change_value')?.value, patientName);
                    message = result ? '✅ تم التغيير بنجاح' : '❌ حدث خطأ';
                    break;
                case 'cancel':
                    result  = await handleCancelCase(document.getElementById('cs_cancel_reason')?.value, patientName);
                    message = result ? '✅ تم إلغاء الحالة بنجاح' : '❌ حدث خطأ';
                    break;
            }
            const successMsg = document.getElementById('csSuccessMsg');
            if (result && successMsg) {
                successMsg.textContent = message;
                successMsg.classList.add('show');
                setTimeout(() => {
                    if (action === 'cancel') { csOverlay.style.display = 'none'; resetForm(); }
                    else {
                        document.getElementById('csInputSection').classList.remove('show');
                        successMsg.classList.remove('show');
                        csOverlay._currentAction = null;
                    }
                }, 2000);
            } else if (!result) { alert(message); }
        });
    }
});
// ============================================================================
// 📥 قائمة الانتظار + السجل — نافذة واحدة بتبويبين
// ============================================================================

// تحديث شارة عدد حالات الانتظار على زر السجل
async function updateWaitingBadge() {
    try {
        const doctorKey = getDoctorKey();
        if (!doctorKey || doctorKey === 'unknown') return;
        const snap = await database.ref(`dental lap/users/doctors/data/${doctorKey}/waiting`).once('value');
        const count = snap.exists() ? Object.keys(snap.val() || {}).length : 0;
        const badge = document.getElementById('waitingBadge');
        if (!badge) return;
        if (count > 0) {
            badge.textContent = count;
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    } catch (e) { console.error('badge error:', e); }
}

// نافذة سجل واحدة بتبويبين: 📋 السجل العادي / ⏳ قائمة الانتظار
async function showTabbedRecords() {
    const doctorKey = getDoctorKey();
    if (!doctorKey || doctorKey === 'unknown') { alert('⚠️ لم يتم التعرف على الطبيب الحالي'); return; }

    const overlay = document.createElement('div');
    overlay.className = 'records-overlay';
    const card = document.createElement('div');
    card.className = 'records-card';
    card.style.maxWidth = '780px';

    card.innerHTML = `
      <button class="close-records close-records-floating" title="إغلاق" aria-label="إغلاق">✕</button>
      <h3 style="color:#ffb74d; text-align:center; margin-bottom:12px;">📋 سجل الحالات</h3>
      <div id="recordsTabs" style="display:flex; gap:0; margin-bottom:16px; border-radius:14px; overflow:hidden; border:1px solid #444;">
        <button id="tabNormal" class="recTab recTabActive" style="flex:1; padding:12px; font-size:15px; border:none; cursor:pointer; background:#ffb74d; color:#1a1a2a; font-weight:bold; transition:all .2s;">📋 السجل العادي</button>
        <button id="tabWaiting" class="recTab" style="flex:1; padding:12px; font-size:15px; border:none; cursor:pointer; background:#2a2a38; color:#bbb; font-weight:bold; transition:all .2s; position:relative;">⏳ قائمة الانتظار <span id="tabWaitingCount" style="display:none; background:#f44336; color:white; border-radius:50%; min-width:18px; height:18px; font-size:10px; line-height:18px; text-align:center; padding:0 4px; position:absolute; top:4px; right:8px;"></span></button>
      </div>
      <div id="tabContentNormal" style="display:block;"><p style="color:#888; text-align:center; padding:20px;">⏳ جاري التحميل...</p></div>
      <div id="tabContentWaiting" style="display:none;"><p style="color:#888; text-align:center; padding:20px;">⏳ جاري التحميل...</p></div>
    `;
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    card.querySelector('.close-records').addEventListener('click', () => closeOverlayAnimated(overlay));

    const tabNormal  = card.querySelector('#tabNormal');
    const tabWaiting = card.querySelector('#tabWaiting');
    const cNormal    = card.querySelector('#tabContentNormal');
    const cWaiting   = card.querySelector('#tabContentWaiting');

    function switchTab(tab) {
        if (tab === 'normal') {
            tabNormal.style.background = '#ffb74d'; tabNormal.style.color = '#1a1a2a';
            tabWaiting.style.background = '#2a2a38'; tabWaiting.style.color = '#bbb';
            cNormal.style.display = 'block'; cWaiting.style.display = 'none';
        } else {
            tabWaiting.style.background = '#ff9800'; tabWaiting.style.color = '#1a1a2a';
            tabNormal.style.background = '#2a2a38'; tabNormal.style.color = '#bbb';
            cWaiting.style.display = 'block'; cNormal.style.display = 'none';
        }
    }
    tabNormal.addEventListener('click', () => switchTab('normal'));
    tabWaiting.addEventListener('click', () => switchTab('waiting'));

    // ── تحميل التبويبين بالتوازي ──
    loadNormalTab(cNormal, doctorKey, overlay);
    loadWaitingTab(cWaiting, doctorKey, overlay, card);
}

// تبويب السجل العادي
async function loadNormalTab(container, doctorKey, overlay) {
    try {
        const snapshot = await database.ref(`dental lap/users/doctors/data/${doctorKey}/cases`).once('value');
        const pointers = snapshot.val();
        if (!pointers || Object.keys(pointers).length === 0) {
            container.innerHTML = '<p style="color:#888; text-align:center; padding:20px;">📭 لا توجد حالات مسجلة حتى الآن</p>';
            return;
        }
        const pointerArr = Object.values(pointers);
        const fetched = await Promise.all(pointerArr.map(async p => {
            try {
                const path = `dental lap/case data/${p.year}/${p.month}/${p.day}/${p.doctorName}/${p.caseId}`;
                const snap = await database.ref(path).once('value');
                const data = snap.val();
                if (!data) return null;
                return Object.assign({}, data, { _year: p.year, _month: p.month, _day: p.day, _datePath: `${p.year}/${p.month}/${p.day}` });
            } catch (e) { return null; }
        }));
        const cases = fetched.filter(c => c && c.caseId);
        if (cases.length === 0) { container.innerHTML = '<p style="color:#888; text-align:center; padding:20px;">📭 لا توجد بيانات حالات</p>'; return; }

        const getCaseTime = (c) => c.createdAt || c.scannerUploadedAt || c.lastStatusUpdate || (c.statusHistory && c.statusHistory[1]) || 0;
        cases.sort((a, b) => { const d = getCaseTime(b) - getCaseTime(a); return d !== 0 ? d : (b.caseId || '').localeCompare(a.caseId || ''); });

        const statusNames = {1: '📥 قائمة الانتظار', 2: '📦 وصول الطلب', 3: '🛵 وصول المندوب', 4: '🏭 المعمل', 5: '🏥 الشحن للعيادة'};
        container.innerHTML = `
            <div style="background:#1a1a2a; padding:10px; border-radius:16px; margin-bottom:15px; text-align:center;">
                <span style="color:#ffb74d;">📚 كل الحالات المحفوظة (${cases.length} حالة)</span><br>
                <span style="color:#ffb74d;">🔒 للقراءة فقط</span>
            </div>
            <div id="normalCasesList"></div>`;
        const listDiv = container.querySelector('#normalCasesList');

        cases.forEach(caseData => {
            const caseDiv = document.createElement('div');
            caseDiv.className = 'case-item' + (caseData.newNews ? ' new-news-glow' : '');
            const progressPercentage = Math.max(0, Math.min(100, ((caseData.orderStatus - 1) / 4) * 100));
            const { hasZircon, hasPorcelain } = getTreatmentTypeFromCase(caseData.toothTreatments || {});
            let treatmentBadge = '';
            if (hasZircon && hasPorcelain) treatmentBadge = '<span style="background:#c2185b; color:white; padding:2px 8px; border-radius:12px; font-size:11px; margin-right:5px;">✨ زيركون</span><span style="background:#2e7d32; color:white; padding:2px 8px; border-radius:12px; font-size:11px;">🏺 بورسلين</span>';
            else if (hasZircon) treatmentBadge = '<span style="background:#c2185b; color:white; padding:2px 8px; border-radius:12px; font-size:11px;">✨ زيركونيوم</span>';
            else if (hasPorcelain) treatmentBadge = '<span style="background:#2e7d32; color:white; padding:2px 8px; border-radius:12px; font-size:11px;">🏺 بورسلين</span>';
            const newsBadge = caseData.newNews ? '<span class="new-news-badge">رسالة جديدة من الإدارة</span>' : '';
            const pay = buildPaymentBadge(caseData);
            caseDiv.innerHTML = `${newsBadge}
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
                    <div style="flex:2;">
                        <p><strong>👤 المريض:</strong> ${escapeHtml(caseData.patientName)}</p>
                        <p><strong>🔐 الرقم التأكيدي:</strong> <span style="font-family:monospace; font-size:16px; color:#ffd700;">${escapeHtml(caseData.randomCode || 'غير متوفر')}</span></p>
                        <p><strong>📅 التاريخ:</strong> ${escapeHtml(caseData._datePath || '')}</p>
                        <p><strong>📊 الحالة:</strong> ${statusNames[caseData.orderStatus] || 'جديد'}</p>
                        <p><strong>💳 الدفع:</strong> ${pay.badge}</p>
                        ${pay.line}
                        <p>${treatmentBadge}</p>
                        ${caseData.scannerFile ? `<p><strong>📎 ملف:</strong> ${escapeHtml(caseData.scannerFile)}</p>` : ''}
                    </div>
                    <div style="flex:1; min-width:120px;">
                        <div style="background:#2a2a38; border-radius:20px; overflow:hidden; height:8px;">
                            <div style="width:${progressPercentage}%; height:100%; background:linear-gradient(90deg,#4caf50,#ffd700,#ff9800,#ff5722); border-radius:20px 0 0 20px;"></div>
                        </div>
                        <p style="text-align:center; margin-top:5px; font-size:11px;">${Math.round(progressPercentage)}%</p>
                    </div>
                </div>
                <div style="display:flex; gap:8px; margin-top:12px;">
                    <button class="view-case-btn" style="background:#2e7d32; border:none; color:white; padding:6px 12px; border-radius:20px; cursor:pointer;">🔍 عرض التفاصيل</button>
                    <button class="load-case-btn" style="background:#ff8f00; border:none; color:white; padding:6px 12px; border-radius:20px; cursor:pointer;">📂 تحميل للواجهة</button>
                </div>`;
            listDiv.appendChild(caseDiv);
            caseDiv.querySelector('.view-case-btn').addEventListener('click', (e) => { e.stopPropagation(); showCaseDetails(caseData); });
            caseDiv.querySelector('.load-case-btn').addEventListener('click', (e) => { e.stopPropagation(); loadCaseToDashboard(caseData); closeOverlayAnimated(overlay); });
        });
    } catch (e) {
        console.error('loadNormalTab error:', e);
        container.innerHTML = '<p style="color:#f44336; text-align:center; padding:20px;">❌ خطأ في تحميل السجل</p>';
    }
}

// تبويب قائمة الانتظار
async function loadWaitingTab(container, doctorKey, overlay, card) {
    try {
        const [wSnap, pSnap] = await Promise.all([
            database.ref(`dental lap/users/doctors/data/${doctorKey}/waiting`).once('value'),
            database.ref(`dental lap/case data/pool/${doctorKey}`).once('value'),
        ]);
        const waitingPtrs    = wSnap.val() || {};
        const dispatchedRefs = pSnap.val() || {};

        const waitingItems = await Promise.all(Object.values(waitingPtrs).map(async p => {
            try {
                const path = `dental lap/case data/waiting/${p.year}/${p.month}/${p.day}/${doctorKey}/${p.caseId}`;
                const snap = await database.ref(path).once('value');
                const data = snap.val();
                if (!data) return null;
                return Object.assign({}, data, { _year: p.year, _month: p.month, _day: p.day });
            } catch (e) { return null; }
        }));
        const waiting = waitingItems.filter(x => x);
        waiting.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        const dispatched = Object.values(dispatchedRefs).sort((a, b) => (b.dispatchedAt || 0) - (a.dispatchedAt || 0));

        const totalWaiting = waiting.length;
        const sumWaiting   = waiting.reduce((s, c) => s + (Number(c.total) || 0), 0);

        // تحديث شارة التبويب
        const tabCount = card.querySelector('#tabWaitingCount');
        if (tabCount && totalWaiting > 0) { tabCount.textContent = totalWaiting; tabCount.style.display = 'inline-block'; }

        container.innerHTML = `
          <p style="text-align:center; color:#bbb; margin-bottom:12px;">
            المنتظرة: <strong style="color:#ffd700;">${totalWaiting}</strong> حالة •
            إجمالي: <strong style="color:#4caf50;">${sumWaiting.toLocaleString('en-US')} ج.م</strong>
          </p>
          <div style="text-align:center; margin-bottom:16px;">
            <button id="poolDispatchBtn" class="primary-btn" style="background:linear-gradient(135deg,#2e7d32,#1b5e20); padding:12px 28px; font-size:16px; border-radius:14px;" ${totalWaiting === 0 ? 'disabled style="opacity:0.4;cursor:not-allowed;"' : ''}>🛵 طلب مندوب (${totalWaiting} حالة)</button>
          </div>
          <h4 style="color:#ffd700; border-bottom:1px solid #444; padding-bottom:6px;">⏳ منتظرة الإرسال (قابلة للتعديل/الحذف)</h4>
          <div id="poolWaitingList" style="margin:10px 0 22px;"></div>
          <h4 style="color:#81c784; border-bottom:1px solid #444; padding-bottom:6px;">🚚 تم إرسالها (للقراءة فقط)</h4>
          <div id="poolDispatchedList" style="margin:10px 0;"></div>
        `;

        // قائمة المنتظرة
        const wList = container.querySelector('#poolWaitingList');
        if (waiting.length === 0) {
            wList.innerHTML = '<p style="color:#888; text-align:center; padding:14px;">📭 لا توجد حالات في قائمة الانتظار</p>';
        } else {
            waiting.forEach(c => {
                const row = document.createElement('div');
                row.className = 'case-item';
                row.style.cssText = 'padding:12px; margin-bottom:10px; background:#2a2a38; border-radius:12px; display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;';
                row.innerHTML = `
                  <div style="flex:1; min-width:200px;">
                    <strong style="color:#fff;">👤 ${escapeHtml(c.patientName || '')}</strong>
                    <span style="color:#aaa; margin-right:10px;">🆔 ${escapeHtml(c.caseId || '')}</span>
                    <br><small style="color:#888;">📅 ${c._year}/${c._month}/${c._day} • 💰 ${(Number(c.total) || 0).toLocaleString('en-US')} ج.م</small>
                  </div>
                  <div style="display:flex; gap:8px;">
                    <button class="poolEditBtn" style="background:#1976d2; color:white; border:none; padding:8px 14px; border-radius:10px; cursor:pointer;">✏️ تعديل</button>
                    <button class="poolDelBtn" style="background:#c62828; color:white; border:none; padding:8px 14px; border-radius:10px; cursor:pointer;">🗑 حذف</button>
                  </div>`;
                row.querySelector('.poolEditBtn').addEventListener('click', () => { loadCaseForPoolEdit(c); closeOverlayAnimated(overlay); });
                row.querySelector('.poolDelBtn').addEventListener('click', async () => {
                    if (!confirm(`هل أنت متأكد من حذف الحالة "${c.patientName}" (${c.caseId})؟`)) return;
                    await deleteWaitingCase(c.caseId, c._year, c._month, c._day, doctorKey);
                    closeOverlayAnimated(overlay);
                    showTabbedRecords();
                });
                wList.appendChild(row);
            });
        }

        // قائمة المرسلة
        const dList = container.querySelector('#poolDispatchedList');
        if (dispatched.length === 0) {
            dList.innerHTML = '<p style="color:#888; text-align:center; padding:14px;">لا يوجد سجل إرسال سابق</p>';
        } else {
            dispatched.forEach(r => {
                const dt = r.dispatchedAt ? new Date(r.dispatchedAt).toLocaleString('ar-EG') : '';
                const row = document.createElement('div');
                row.style.cssText = 'padding:10px 12px; margin-bottom:8px; background:#1f2630; border-radius:10px; border-right:3px solid #4caf50;';
                row.innerHTML = `
                  <strong style="color:#fff;">👤 ${escapeHtml(r.patientName || '')}</strong>
                  <span style="color:#aaa; margin-right:10px;">🆔 ${escapeHtml(r.caseId || '')}</span>
                  <br><small style="color:#888;">📅 ${r.year}/${r.month}/${r.day} • 💰 ${(Number(r.total) || 0).toLocaleString('en-US')} ج.م • 🛵 ${dt}</small>`;
                dList.appendChild(row);
            });
        }

        // زر طلب مندوب
        const dispatchBtn = container.querySelector('#poolDispatchBtn');
        if (totalWaiting > 0) {
            dispatchBtn.addEventListener('click', async () => {
                if (!confirm(`🛵 سيتم طلب مندوب لعدد ${totalWaiting} حالة وإرسالها للمسار الطبيعي.\n\nبعد الإرسال لن تكون قابلة للتعديل. هل تريد المتابعة؟`)) return;
                dispatchBtn.disabled = true;
                dispatchBtn.textContent = '⏳ جاري الإرسال...';
                const result = await dispatchAllWaitingCases();
                alert(`✅ تم إرسال ${result.success} حالة بنجاح${result.failed > 0 ? `\n❌ فشل ${result.failed} حالة` : ''}`);
                updateWaitingBadge();
                closeOverlayAnimated(overlay);
                showTabbedRecords();
            });
        }
    } catch (e) {
        console.error('loadWaitingTab error:', e);
        container.innerHTML = '<p style="color:#f44336; text-align:center; padding:20px;">❌ خطأ في تحميل قائمة الانتظار</p>';
    }
}

// حذف حالة من قائمة الانتظار (waiting + المؤشّر المسطّح)
async function deleteWaitingCase(caseId, year, month, day, doctorKey) {
    try {
        const updates = {};

        updates[`dental lap/case data/waiting/${year}/${month}/${day}/${doctorKey}/${caseId}`] = null;
        updates[`dental lap/users/doctors/data/${doctorKey}/waiting/${caseId}`] = null;
        await database.ref().update(updates);
        updateWaitingBadge();
    } catch (e) {
        console.error('فشل حذف الحالة:', e);
        alert('❌ فشل حذف الحالة: ' + e.message);
    }
}

// تحميل حالة من قائمة الانتظار إلى الواجهة في وضع التعديل
function loadCaseForPoolEdit(caseData) {
    loadCaseToDashboard(caseData);
    setReadOnlyMode(false);
    currentEditingPoolCase = {
        year:   caseData._year,
        month:  caseData._month,
        day:    caseData._day,
        caseId: caseData.caseId,
    };
    currentCasePath = `dental lap/case data/waiting/${caseData._year}/${caseData._month}/${caseData._day}/${getDoctorKey()}/${caseData.caseId}`;
}

// إرسال كل حالات قائمة الانتظار: نقل من waiting → المسار الطبيعي + كل الكتابات الجانبية
async function dispatchAllWaitingCases() {
    const doctorKey = getDoctorKey();
    const ptrSnap = await database.ref(`dental lap/users/doctors/data/${doctorKey}/waiting`).once('value');
    const pointers = ptrSnap.val() || {};
    const ids = Object.keys(pointers);
    const now = Date.now();
    let success = 0, failed = 0;

    // نجلب بيانات العيادة مرة واحدة
    let clinicData = null;
    try { clinicData = await getClinicData(currentClinicName); } catch (e) { console.error(e); }

    for (const cid of ids) {
        const p = pointers[cid];
        try {
            const waitingPath = `dental lap/case data/waiting/${p.year}/${p.month}/${p.day}/${doctorKey}/${cid}`;
            const snap = await database.ref(waitingPath).once('value');
            const data = snap.val();
            if (!data) { failed++; continue; }

            // تحديث الحالة: تخطّت مرحلة الـpool وأصبحت "وصول الطلب للمعمل"
            const sh = data.statusHistory || {};
            sh["الإضافة لقائمة الانتظار"] = true;
            sh["استلام الطلب"]          = true;
            // لو معاها سكان: نتخطّى المندوب ونعتبر الحالة وصلت للمعمل مباشرة
            if (data.scannerFile) {
                sh["ارسال مندوب للعياده"] = true;
                sh["استلام الحاله"]       = true;
            }
            data.statusHistory = sh;
            data.orderStatus   = data.scannerFile ? 4 : 2;
            data.dispatchedAt  = now;
            data.isReadOnly    = true;

            // استخدام التاريخ الأصلي لمسار النقل
            const datePath = { year: p.year, month: p.month, day: p.day, fullPath: `${p.year}/${p.month}/${p.day}` };
            const normalPath = `dental lap/case data/${datePath.fullPath}/${doctorKey}/${cid}`;

            // 1. كتابة المسار الرئيسي
            await database.ref(normalPath).set(data);

            // 2. الكتابات الجانبية (تأخّرت من وقت الحفظ الأول لما الحالة كانت في pool)
            try { if (data.randomCode) await saveToSecretCodeIndex(data.randomCode, cid, data.patientName, datePath, doctorKey); } catch (e) { console.error('secret index:', e); }
            try { if (clinicData) await saveOrderToWorkersPath(data, cid, clinicData, data.randomCode); } catch (e) { console.error('workers:', e); }
            try { await saveOrderToCareerLadder(data, cid); } catch (e) { console.error('career:', e); }
            try {
                const cats = collectCaseCategories(data.toothTreatments || {});
                const ptr  = { year: p.year, month: p.month, day: p.day, doctorName: doctorKey };
                const updates = {};
                cats.forEach(catKey => { updates[`dental lap/case data/case type/${catKey}/${cid}`] = ptr; });
                if (Object.keys(updates).length) await database.ref().update(updates);
            } catch (e) { console.error('case type:', e); }
            try { await saveCaseInvoice(data, cid); } catch (e) { console.error('invoice:', e); }

            // 3. مؤشر مسطّح لمسار العادي تحت الطبيب
            await database.ref(`dental lap/users/doctors/data/${doctorKey}/cases/${cid}`).set({
                year: p.year, month: p.month, day: p.day, doctorName: doctorKey, caseId: cid, patientName: data.patientName,
            });

            // 4. مرجع في مجلد "قائمة الانتظار" (للعرض فقط لاحقاً)
            await database.ref(`dental lap/case data/pool/${doctorKey}/${cid}`).set({
                caseId: cid, patientName: data.patientName,
                year: p.year, month: p.month, day: p.day,
                dispatchedAt: now, total: data.total || 0,
            });

            // 5. حذف من waiting + المؤشّر المسطّح للـwaiting
            const cleanup = {};
            cleanup[waitingPath] = null;
            cleanup[`dental lap/users/doctors/data/${doctorKey}/waiting/${cid}`] = null;
            await database.ref().update(cleanup);

            success++;
        } catch (err) {
            console.error('فشل إرسال حالة:', cid, err);
            failed++;
        }
    }
    return { success, failed };
}

// ============================================================================
// 🔔 نظام الإشعارات الفورية (Real-time Listeners)
// ============================================================================

// إشعار منبثق فوري (toast)
function showNotifToast(message, duration = 5000) {
    const existing = document.querySelector('.notif-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'notif-toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    toast.addEventListener('click', () => {
        toast.remove();
        const overlay = document.getElementById('aiChatOverlay');
        if (overlay && overlay.style.display !== 'none') return;
        if (currentCaseId) showAiChat();
    });
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, duration);
}

// تشغيل حالة "تنبيه" على زر المحادثة
function setAiButtonNotif(on) {
    const btn = document.getElementById('aiChatBtn');
    if (!btn) return;
    if (on) btn.classList.add('has-notif');
    else    btn.classList.remove('has-notif');
}

// ربط listener في الوقت الحقيقي على مسار الحالة المحمّلة
function attachCaseListener() {
    detachCaseListener();
    const path = currentCasePath;
    if (!path) return;
    _caseListenerPath = path;
    _caseListener = database.ref(path).on('value', snap => {
        const data = snap.val();
        if (!data) return;

        // 1) تحديث البروجريس بار فوراً لو الحالة تغيّرت من الإدارة
        if (data.orderStatus && data.orderStatus !== currentOrderStatus) {
            currentOrderStatus = data.orderStatus;
            applyStatusFromHistory(data.statusHistory);
            updateStepDates(data.statusHistory);
        }

        // 2) تحقق من رسائل جديدة في المحادثة (رسالة إدارة)
        let convo = data.conversation || [];
        if (convo && !Array.isArray(convo)) {
            convo = Object.keys(convo).sort((a,b) => Number(a)-Number(b)).map(k => convo[k]);
        }
        if (convo.length > _lastConversationLength) {
            const newMsgs = convo.slice(_lastConversationLength);
            const adminMsgs = newMsgs.filter(m => m.role === 'admin');
            if (adminMsgs.length > 0) {
                adminMsgs.forEach(m => addAiMessage('admin', m.content));
                currentConversation = convo;
                _lastConversationLength = convo.length;
                showNotifToast('🔴 رسالة جديدة من الإدارة: ' + adminMsgs[adminMsgs.length - 1].content);
                setAiButtonNotif(true);
                // تعيين newNews = true في فايربيز
                if (currentCasePath) {
                    database.ref(currentCasePath + '/newNews').set(true).catch(() => {});
                }
                const recBtn = document.getElementById('recordBtnDashboard');
                if (recBtn) { recBtn.style.boxShadow = '0 0 12px 4px rgba(244,67,54,0.5)'; setTimeout(() => recBtn.style.boxShadow = '', 4000); }
            } else {
                // رسائل عادية (bot) أضافها نظام آخر — نحدّث المحادثة فقط
                currentConversation = convo;
                _lastConversationLength = convo.length;
            }
        }

        // 3) تحديث الفاتورة الإجمالية لو تغيّرت
        if (data.total !== undefined) {
            loadDoctorInvoice(true);
        }
    });
}

// فصل الـ listener عند ريست أو تحميل حالة أخرى
function detachCaseListener() {
    if (_caseListener && _caseListenerPath) {
        database.ref(_caseListenerPath).off('value', _caseListener);
    }
    _caseListener = null;
    _caseListenerPath = null;
    setAiButtonNotif(false);
}
