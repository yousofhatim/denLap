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
let uploadedFileName = null;
let isReadOnly = false;
let currentSecretCode = null;
let pendingUploadFile = null; // الملف اللي اتختار قبل ما الحالة تتحفظ

// AI Chat
let currentConversation = [];
let openAiApiKey = null;
let aiSystemPrompt = null;

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
        addAiMessage(m.role === 'user' ? 'user' : 'bot', m.content);
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
    const statusNames = {1:'وصول الطلب للمعمل',2:'إرسال مندوب',3:'قيد العمل',4:'الشحن للعيادة'};
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
    div.className = sender === 'bot' ? 'ai-msg-bot' : 'ai-msg-user';
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
        const snap = await database.ref(`${getDatabasePath()}/${currentCaseId}`).once('value');
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
            const statusNames = {1:'وصول الطلب للمعمل',2:'إرسال مندوب',3:'قيد العمل',4:'الشحن للعيادة'};
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

        // Send only the last 10 messages from the conversation
        const recentMessages = currentConversation.slice(-10);

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
        await database.ref(`${getDatabasePath()}/${currentCaseId}/conversation`).set(currentConversation);
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
            { key: 'pfm_porcelain_crown_gum',     label: 'Porcelain Crown WITH GUM (P.F.M)',  price: 300, color: '#1565c0',
                followUp: { question: 'الزرعات مفتوحة أم مقفولة؟', options: [
                    { key: 'open_implants',   label: 'زرعات مفتوحة' },
                    { key: 'closed_implants', label: 'زرعات مقفولة' },
                ]}},
            { key: 'pfm_repair',                  label: 'Repair Porcelain Crown',            price: 150, color: '#0d47a1' },
            { key: 'pfm_casted_metal_crown',      label: 'Casted Metal Crown',                price: 150, color: '#37474f' },
            { key: 'pfm_casted_metal_post_core',  label: 'Casted Metal Post & Core',          price: 250, color: '#263238' },
            // البونتيك في فرع P.F.M بنفس سعر تركيبة البورسلين الأساسية (250)
            { key: 'pfm_pontic',                  label: 'Pontic (P.F.M)',                    price: 250, color: '#c62828', isPontic: true },
        ]
    },
    zirconium: {
        key: 'zirconium',
        label: 'Zirconium',
        color: '#c2185b',
        treatments: [
            { key: 'zir_full_anatomy',     label: 'Full Anatomy Zirconium Crown (multi layers)', price: 700,  color: '#c2185b' },
            { key: 'zir_full_anatomy_gum', label: 'Full Anatomy Zirconium Crown With gum',       price: 750,  color: '#ad1457',
                followUp: { question: 'الزرعات مفتوحة أم مقفولة؟', options: [
                    { key: 'open_implants',   label: 'زرعات مفتوحة' },
                    { key: 'closed_implants', label: 'زرعات مقفولة' },
                ]}},
            { key: 'zir_max',     label: 'Zirco Max Crown',         price: 800,  color: '#880e4f' },
            { key: 'zir_french',  label: 'French Crown',            price: 900,  color: '#7b1fa2' },
            { key: 'zir_german',  label: 'GERMAN Crown',            price: 1100, color: '#4a148c' },
            { key: 'zir_emax',    label: 'E MAX Full Crown (press)',price: 1300, color: '#311b92' },
            // البونتيك في فرع Zirconium بنفس سعر تركيبة الزيركون الأساسية (700)
            { key: 'zir_pontic',  label: 'Pontic (Zirconium)',      price: 700,  color: '#ad1457', isPontic: true },
        ]
    },
    temporary: {
        key: 'temporary',
        label: 'Temporary',
        color: '#f57c00',
        treatments: [
            { key: 'tmp_pmma',    label: 'temporary PMMA crown ( cad cam )', price: 100, color: '#f57c00' },
            { key: 'tmp_acrylic', label: 'temporary Acrylic Crown',          price: 100, color: '#ef6c00' },
            { key: 'tmp_waxup',   label: 'Wax-up digital crown ( mock-up )', price: 50,  color: '#e65100' },
        ]
    },
    ortho: {
        key: 'ortho',
        label: 'Ortho/Acrylic',
        color: '#2e7d32',
        treatments: [
            { key: 'ortho_space_band',   label: 'Space maintainer & band',         price: 350,  color: '#2e7d32' },
            { key: 'ortho_space_crown',  label: 'Space maintainer & crown',        price: 450,  color: '#1b5e20' },
            { key: 'ortho_night_guard',  label: 'Night guard hard & soft u or l',  price: 250,  color: '#33691e' },
            { key: 'ortho_vitalium',     label: 'VITALIUM WITH OUT ACRYLIC',       price: 1700, color: '#827717' },
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
    const priceTxt = td.price ? `<div style="color:#90caf9; font-size:0.72rem; margin-top:4px;">السعر: ${td.price} ج</div>` : '';
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
        btn.innerHTML = `<span class="ttb-label">${t.label}</span><span class="ttb-price">${t.price} ج</span>`;
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
function displaySecretCode(patientName, randomCode) {
    const teethContainer = document.getElementById('teethContainer');
    if (!teethContainer) return;
    // إخفاء زر رفع السكان وعرض شارة الرقم التأكيدي مكانه
    const uploadBtn = document.getElementById('uploadScannerBtn');
    if (uploadBtn) uploadBtn.style.display = 'none';

    let codeDisplay = document.getElementById('secretCodeDisplay');
    if (!codeDisplay) {
        codeDisplay = document.createElement('div');
        codeDisplay.id = 'secretCodeDisplay';
        codeDisplay.className = 'secret-code-badge';
        teethContainer.appendChild(codeDisplay);
    }
    codeDisplay.innerHTML = `
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
    const casesRef = database.ref(`dental lap/case data/${year}/${month}/${day}/${getDoctorKey()}`);
    const snapshot = await casesRef.once('value');
    const cases = snapshot.val();
    if (!cases) return false;
    for (const caseId in cases) {
        if (cases[caseId].patientName === patientName && cases[caseId].date === date) {
            return true;
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
                await database.ref(`${getDatabasePath()}/${currentCaseId}`).update({
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
            alert(`📎 تم اختيار الملف: ${file.name}\n💾 سيتم رفعه تلقائياً عند الضغط على "حفظ الحالة"`);
        }
    });
}

// تحديث شريط الحالة
function updateStatusBar(status) {
    currentOrderStatus = status;
    const steps    = document.querySelectorAll('.status-step');
    const fillLine = document.getElementById('progressLineFill');
    steps.forEach((step, index) => {
        const stepNum = index + 1;
        step.classList.remove('active', 'completed');
        if (stepNum < status)       step.classList.add('completed');
        else if (stepNum === status) step.classList.add('active');
    });
    // النسبة بين الخطوات الأربع: 0%، 33%، 66%، 100%
    if (fillLine) {
        const pct = status <= 1 ? 0 : ((status - 1) / 3) * 100;
        fillLine.style.width = `${pct}%`;
    }
}

function updateStepDates(statusHistory) {
    if (statusHistory) {
        for (let i = 1; i <= 4; i++) {
            const dateSpan = document.getElementById(`step${i}-date`);
            if (statusHistory[i] && dateSpan) {
                dateSpan.textContent = new Date(statusHistory[i]).toLocaleString('ar-EG');
            }
        }
    }
}

function setupStatusSteps() {
    document.querySelectorAll('.status-step').forEach(step => {
        step.addEventListener('click', async () => {
            if (isReadOnly) { alert("🔒 لا يمكن تغيير حالة الطلب في وضع القراءة فقط!"); return; }
            const stepNum = parseInt(step.dataset.step);
            if (!currentCaseId) { alert("⚠️ الرجاء حفظ الحالة أولاً!"); return; }
            if (stepNum > currentOrderStatus + 1) { alert(`⚠️ لا يمكن الانتقال للمرحلة ${stepNum} قبل إكمال المرحلة ${currentOrderStatus}`); return; }
            if (stepNum <= currentOrderStatus) { alert(`⚠️ المرحلة ${stepNum} تم إنجازها بالفعل`); return; }
            await updateOrderStatus(stepNum);
        });
    });
}

async function updateOrderStatus(newStatus) {
    if (isReadOnly || !currentCaseId) return;
    const caseRef = database.ref(`${getDatabasePath()}/${currentCaseId}`);
    const now = Date.now();
    try {
        const snapshot = await caseRef.once('value');
        const caseData = snapshot.val();
        if (caseData) {
            const statusHistory = caseData.statusHistory || {};
            statusHistory[newStatus] = now;
            await caseRef.update({ orderStatus: newStatus, statusHistory: statusHistory, lastStatusUpdate: now });
            currentOrderStatus = newStatus;
            updateStatusBar(newStatus);
            updateStepDates(statusHistory);
            const statusNames = {1: 'وصول الطلب للمعمل', 2: 'إرسال مندوب', 3: 'قيد العمل', 4: 'الشحن للعيادة'};
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

// حساب إجمالي سعر الحالة الحالية من toothTreatments
function calcCaseTotalPrice(treatmentsMap) {
    let total = 0;
    for (const t of Object.values(treatmentsMap || {})) {
        const td = getTreatmentData(t);
        if (typeof td.price === 'number') total += td.price;
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
    Object.entries(caseData.toothTreatments || {}).forEach(([tooth, t]) => {
        const td = getTreatmentData(t);
        items.push({
            tooth: parseInt(tooth),
            key:   td.key || '',
            label: td.label || '',
            category: td.category || null,
            subOption: td.subOptionLabel || null,
            isPontic: !!td.isPontic,
            price: td.price || 0,
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
        const data = snap.val() || { amount: 0, casesCount: 0 };
        updateDoctorInvoiceUI(data.amount || 0, data.casesCount || 0, animateBump);
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

    // تجميع حسب الفئة الرئيسية
    const grouped = {}; // catKey -> [{tooth, t}]
    let totalPrice = 0;
    Object.entries(toothTreatments).forEach(([tooth, treatment]) => {
        const t = getTreatmentData(treatment);
        const catKey = t.category || 'other';
        if (!grouped[catKey]) grouped[catKey] = { label: t.categoryLabel || 'أخرى', color: (TREATMENT_TREE[catKey]?.color) || '#546e7a', items: [] };
        grouped[catKey].items.push({ tooth: parseInt(tooth), t });
        if (typeof t.price === 'number') totalPrice += t.price;
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
        g.items.sort((a,b) => a.tooth - b.tooth).forEach(({tooth, t}) => {
            const row = document.createElement('div');
            row.className = 'ts-item';
            row.innerHTML = `
                <span class="ts-tooth" style="background:${t.color}">${tooth}</span>
                <span class="ts-label">${t.label}${t.subOptionLabel ? ` · <em>${t.subOptionLabel}</em>` : ''}</span>
                <span class="ts-price">${t.price || 0} ج</span>
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

    // التاريخ يتم حسابه تلقائياً من تاريخ اليوم
    const today = new Date();
    const date  = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    if (Object.keys(toothTreatments).length === 0) { alert("⚠️ الرجاء تحديد الأسنان والعلاجات أولاً!"); return false; }

    const doctorKey = getDoctorKey();

    const exists = await checkIfCaseExists(patientName, date);
    if (exists) { alert("⚠️ لا يمكن حفظ الحالة! يوجد حالة سابقة بنفس اسم المريض والتاريخ.\n\n🔒 تم تحويل هذه الحالة للقراءة فقط."); await loadExistingCase(patientName, date); return false; }

    // الحصول على العداد اليومي (تحت اسم الطبيب)
    const counter = await getDailyCounterAndReturn(doctorKey, date);

    // توليد الرقم التأكيدي الجديد (بدون أصفار)
    const secretCodeV2 = await generateSecretCodeV2(currentClinicName, date, counter);
    currentSecretCode = secretCodeV2;

    // توليد caseId بصيغة: اسم المريض-الرقم اليومي (مثال: يوسف-1)
    const caseId = `${patientName}-${counter}`;
    currentCaseId = caseId;
    // مسح أي محادثة سابقة كي تظهر الرسالة الترحيبية باسم المريض الجديد
    currentConversation = [];
    const aiMsgsResetEl = document.getElementById('aiMessages');
    if (aiMsgsResetEl) aiMsgsResetEl.innerHTML = '';
    updateAiBarVisibility();

    const now = Date.now();
    const statusHistory = { 1: now };
    let finalOrderStatus = uploadedFileName ? 3 : 1;
    if (uploadedFileName) statusHistory[3] = now;

    const datePath = getCurrentDatePath();

    // ✦ المسار الرئيسي: dental lap/case data/{year}/{month}/{day}/{doctorName}/{caseId}
    //   لا نكرر الحقول التي يمكن استخراجها من المسار نفسه
    //   (clinicName / createdAt / date / day / doctorName / month / secretCode / timestamp / year)
    const caseData = {
        caseId,
        randomCode: secretCodeV2,
        patientName,
        notes,
        toothTreatments,
        toothConnections,
        orderStatus: finalOrderStatus,
        statusHistory,
        isReadOnly: true,
    };
    if (uploadedFileName) { caseData.scannerFile = uploadedFileName; caseData.scannerUploadedAt = now; }

    try {
        // رفع الملف المعلّق (لو الطبيب اختار ملف قبل الحفظ) إلى Firebase Storage وربطه بالحالة
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

        // 1. حساب إجمالي الحالة (المبلغ المطلوب) ثم تضمين بيانات الدفع داخل الحالة الرئيسية
        const computedTotal = calcCaseTotalPrice(toothTreatments);
        caseData.total           = computedTotal;
        caseData.paidAmount      = 0;
        caseData.remainingAmount = computedTotal;
        caseData.isPaid          = computedTotal === 0;

        // 2. حفظ البيانات الأساسية تحت المسار الرئيسي:
        //    dental lap/case data/{year}/{month}/{day}/{doctorName}/{caseId}
        await database.ref(`${getDatabasePath()}/${caseId}`).set(caseData);

        // 3. حفظ الفهارس: العام (اسم المريض → الرقم التأكيدي) و المفصل
        await saveToSecretCodeIndex(secretCodeV2, caseId, patientName, datePath, doctorKey);

        // 4. جلب بيانات العيادة وحفظ الطلب في مسار المندوب
        const clinicData = await getClinicData(currentClinicName);
        await saveOrderToWorkersPath(caseData, caseId, clinicData, secretCodeV2);

        // 5. مؤشر الفئة (مرشد فقط — يدلّ على الموقع في المسار الرئيسي):
        //    dental lap/case data/case type/{categoryKey}/{caseId} = { year, month, day, doctorName }
        try {
            const cats    = collectCaseCategories(toothTreatments);
            const pointer = { year: datePath.year, month: datePath.month, day: datePath.day, doctorName: doctorKey };
            const updates = {};
            cats.forEach(catKey => {
                updates[`dental lap/case data/case type/${catKey}/${caseId}`] = pointer;
            });
            if (Object.keys(updates).length > 0) await database.ref().update(updates);
        } catch (catErr) {
            console.error('فشل حفظ مؤشر case type:', catErr);
        }

        // 6. حفظ فاتورة الحالة وتحديث الفاتورة الإجمالية للطبيب
        try {
            await saveCaseInvoice(caseData, caseId);
        } catch (invErr) {
            console.error('فشل تحديث الفاتورة:', invErr);
        }

        // 7. مؤشر مسطّح تحت الطبيب — مجرد بيانات إرشاد عن مكان الحالة في المسار الرئيسي
        //    dental lap/users/doctors/data/{doctorKey}/cases/{caseId} = { year, month, day, doctorName, caseId, patientName }
        try {
            const flatPointer = {
                year:        datePath.year,
                month:       datePath.month,
                day:         datePath.day,
                doctorName:  doctorKey,
                caseId,
                patientName,
            };
            await database.ref(`dental lap/users/doctors/data/${doctorKey}/cases/${caseId}`).set(flatPointer);
        } catch (flatErr) {
            console.error('فشل حفظ مؤشر الطبيب المسطّح:', flatErr);
        }

        currentOrderStatus = finalOrderStatus;
        updateStatusBar(finalOrderStatus);
        updateStepDates(statusHistory);

        // عرض اسم المريض + الرقم التأكيدي مكان زر الرفع (بدون أي إشعارات)
        displaySecretCode(patientName, secretCodeV2);

        setReadOnlyMode(true);
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

    document.getElementById('patientName').value = caseData.patientName || '';
    document.getElementById('notes').value = caseData.notes || '';

    // استرجاع محادثة الذكاء الاصطناعي الخاصة بهذه الحالة فقط
    let convo = caseData.conversation || [];
    if (convo && !Array.isArray(convo)) {
        // فايربيز قد يحوّل المصفوفة إلى كائن — نُعيدها لمصفوفة
        convo = Object.keys(convo).sort((a,b) => Number(a)-Number(b)).map(k => convo[k]);
    }
    currentConversation = convo;
    rebuildAiMessagesUI(currentConversation);

    toothTreatments = caseData.toothTreatments || {};
    toothConnections = caseData.toothConnections || {};

    resetTeethUI();
    for (const [tooth, treatment] of Object.entries(toothTreatments)) {
        applyTreatmentToToothUI(parseInt(tooth), treatment);
    }
    setTimeout(() => resetConnectionsUI(), 150);
    updateTreatmentsSummary();

    currentOrderStatus = caseData.orderStatus || 1;
    updateStatusBar(currentOrderStatus);
    updateStepDates(caseData.statusHistory);
    uploadedFileName = caseData.scannerFile || null;
    currentTreatment = null;
    selectedTooth = null;
    document.querySelectorAll('.tooth-button').forEach(btn => btn.classList.remove('selected'));
    resetTreatmentPanel();
    updateSelectedCount();

    if (currentSecretCode) {
        displaySecretCode(caseData.patientName || '', currentSecretCode);
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

    const statusNames = {1: '📦 وصول الطلب للمعمل', 2: '🚚 إرسال مندوب', 3: '⚙️ قيد العمل', 4: '🏥 الشحن للعيادة'};
    const progressPercentage = ((caseData.orderStatus - 1) / 3) * 100;

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

// عرض كل حالات الطبيب من قاعدة البيانات (بكل التواريخ) مع حالة الدفع
// يقرأ المؤشّرات المسطّحة تحت الطبيب ثم يستخرج البيانات الكاملة من المسار الرئيسي
async function showCasesRecords() {
    const doctorKey = getDoctorKey();
    if (!doctorKey || doctorKey === 'unknown') { alert('⚠️ لم يتم التعرف على الطبيب الحالي'); return; }

    const snapshot = await database.ref(`dental lap/users/doctors/data/${doctorKey}/cases`).once('value');
    const pointers = snapshot.val();
    if (!pointers || Object.keys(pointers).length === 0) {
        alert("📭 لا توجد حالات مسجلة لهذا الطبيب حتى الآن");
        return;
    }

    // استرجاع البيانات الكاملة من المسار الرئيسي لكل مؤشّر
    const pointerArr = Object.values(pointers);
    const fetched = await Promise.all(pointerArr.map(async p => {
        try {
            const path = `dental lap/case data/${p.year}/${p.month}/${p.day}/${p.doctorName}/${p.caseId}`;
            const snap = await database.ref(path).once('value');
            const data = snap.val();
            if (!data) return null;
            // ندمج المؤشر داخل الكائن لكي تظل سنة/شهر/يوم متاحة للعرض
            return Object.assign({}, data, {
                _year: p.year, _month: p.month, _day: p.day,
                _datePath: `${p.year}/${p.month}/${p.day}`,
            });
        } catch (e) { console.error('فشل قراءة الحالة:', p, e); return null; }
    }));
    const cases = fetched.filter(c => c && c.caseId);
    if (cases.length === 0) {
        alert("📭 لا توجد بيانات حالات قابلة للعرض");
        return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'records-overlay';
    const card = document.createElement('div');
    card.className = 'records-card';
    card.innerHTML = `
        <h3 style="color:#ffb74d; text-align:center;">📋 سجل كل الحالات - د. ${escapeHtml(currentUser?.doctorName || '')}</h3>
        <div style="background:#1a1a2a; padding:10px; border-radius:16px; margin-bottom:15px; text-align:center;">
            <span style="color:#ffb74d;">📚 يعرض كل الحالات المحفوظة في قاعدة البيانات (كل التواريخ)</span><br>
            <span style="color:#ffb74d;">🔒 جميع الحالات المسجلة للقراءة فقط ولا يمكن تعديلها</span>
        </div>
        <div id="casesList"></div>
        <button class="close-records" style="background:#e53935; margin-top:20px; padding:8px 20px; border-radius:40px; border:none; color:white; cursor:pointer;">إغلاق</button>
    `;

    const listDiv = card.querySelector('#casesList');
    // ترتيب من الأحدث للأقدم بناءً على أول تسجيل لحالة الطلب (statusHistory[1]) ثم على رقم الحالة
    const sortedCases = cases.slice().sort((a, b) => {
        const ta = (a.statusHistory && a.statusHistory[1]) || 0;
        const tb = (b.statusHistory && b.statusHistory[1]) || 0;
        if (tb !== ta) return tb - ta;
        return (b.caseId || '').localeCompare(a.caseId || '');
    });
    const statusNames = {1: '📦 وصول الطلب', 2: '🚚 إرسال مندوب', 3: '⚙️ قيد العمل', 4: '🏥 الشحن للعيادة'};

    sortedCases.forEach(caseData => {
        const caseDiv = document.createElement('div');
        caseDiv.className = 'case-item';
        const progressPercentage = ((caseData.orderStatus - 1) / 3) * 100;
        const { hasZircon, hasPorcelain } = getTreatmentTypeFromCase(caseData.toothTreatments || {});
        let treatmentBadge = '';
        if (hasZircon && hasPorcelain) treatmentBadge = '<span style="background:#c2185b; color:white; padding:2px 8px; border-radius:12px; font-size:11px; margin-right:5px;">✨ زيركون</span><span style="background:#2e7d32; color:white; padding:2px 8px; border-radius:12px; font-size:11px;">🏺 بورسلين</span>';
        else if (hasZircon) treatmentBadge = '<span style="background:#c2185b; color:white; padding:2px 8px; border-radius:12px; font-size:11px;">✨ زيركونيوم</span>';
        else if (hasPorcelain) treatmentBadge = '<span style="background:#2e7d32; color:white; padding:2px 8px; border-radius:12px; font-size:11px;">🏺 بورسلين</span>';

        const pay = buildPaymentBadge(caseData);

        caseDiv.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
                <div style="flex:2;">
                    <p><strong>👤 المريض:</strong> ${escapeHtml(caseData.patientName)}</p>
                    <p><strong>🔐 الرقم التأكيدي:</strong> <span style="font-family: monospace; font-size: 16px; color: #ffd700;">${escapeHtml(caseData.randomCode || 'غير متوفر')}</span></p>
                    <p><strong>🏥 اسم العيادة:</strong> ${escapeHtml(currentClinicName || '')}</p>
                    <p><strong>📅 التاريخ:</strong> ${escapeHtml(caseData._datePath || `${caseData._year || ''}/${caseData._month || ''}/${caseData._day || ''}`)}</p>
                    <p><strong>📊 الحالة:</strong> ${statusNames[caseData.orderStatus] || 'جديد'}</p>
                    <p><strong>💳 الدفع:</strong> ${pay.badge}</p>
                    ${pay.line}
                    <p>${treatmentBadge}</p>
                    ${caseData.scannerFile ? `<p><strong>📎 ملف:</strong> ${escapeHtml(caseData.scannerFile)}</p>` : ''}
                </div>
                <div style="flex:1; min-width:120px;">
                    <div style="background:#2a2a38; border-radius:20px; overflow:hidden; height:8px;">
                        <div style="width:${progressPercentage}%; height:100%; background:linear-gradient(90deg, #4caf50, #ffd700, #ff9800, #ff5722); border-radius:20px 0 0 20px;"></div>
                    </div>
                    <p style="text-align:center; margin-top:5px; font-size:11px;">${Math.round(progressPercentage)}%</p>
                </div>
            </div>
            <div style="display:flex; gap:8px; margin-top:12px;">
                <button class="view-case-btn" style="background:#2e7d32; border:none; color:white; padding:6px 12px; border-radius:20px; cursor:pointer;">🔍 عرض التفاصيل</button>
                <button class="load-case-btn" style="background:#ff8f00; border:none; color:white; padding:6px 12px; border-radius:20px; cursor:pointer;">📂 تحميل للواجهة</button>
            </div>
        `;
        listDiv.appendChild(caseDiv);
        caseDiv.querySelector('.view-case-btn').addEventListener('click', (e) => { e.stopPropagation(); showCaseDetails(caseData); });
        caseDiv.querySelector('.load-case-btn').addEventListener('click', (e) => { e.stopPropagation(); loadCaseToDashboard(caseData); closeOverlayAnimated(overlay); });
    });

    card.querySelector('.close-records').addEventListener('click', () => closeOverlayAnimated(overlay));
    overlay.appendChild(card);
    document.body.appendChild(overlay);
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
    uploadedFileName = null;
    pendingUploadFile = null;
    currentOrderStatus = 1;
    currentSecretCode = null;
    updateStatusBar(1);
    resetTreatmentPanel();
    updateSelectedCount();
    updateTreatmentsSummary();
    hideSecretCode();
    setReadOnlyMode(false);

    // Reset AI conversation
    currentConversation = [];
    const aiMessages = document.getElementById('aiMessages');
    if (aiMessages) aiMessages.innerHTML = '';
    updateAiBarVisibility();
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
            dot.addEventListener('click', (e) => { e.stopPropagation(); if (!isReadOnly) { dot.classList.toggle('connected'); toothConnections[pairKey] = dot.classList.contains('connected'); } });
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
        const caseRef = database.ref(`${getDatabasePath()}/${currentCaseId}`);
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
        const caseRef = database.ref(`${getDatabasePath()}/${currentCaseId}`);
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
        const caseRef = database.ref(`${getDatabasePath()}/${currentCaseId}`);
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
        const caseRef = database.ref(`${getDatabasePath()}/${currentCaseId}`);
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
    document.getElementById('saveBtnDashboard').addEventListener('click', saveCaseToFirebase);
    document.getElementById('newBtnDashboard').addEventListener('click', resetForm);
    document.getElementById('recordBtnDashboard').addEventListener('click', showCasesRecords);
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
