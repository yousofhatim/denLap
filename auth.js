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

// موقع الطبيب (يُعبَّأ من إدخال يدوي)
let clinicLocationData = null;

// تحليل إحداثيات يدخلها المستخدم بصيغ متعددة:
// "30.0444, 31.2357" أو "30.0444 31.2357" أو رابط جوجل ماب يحوي @lat,lng أو ?q=lat,lng
function parseCoordinatesInput(raw) {
    if (!raw) return null;
    const text = raw.trim();
    // محاولة استخراج زوج أرقام عشرية من أي نص (يدعم لصق روابط جوجل ماب)
    const match = text.match(/(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)/);
    if (!match) return null;
    const lat = parseFloat(match[1]);
    const lng = parseFloat(match[2]);
    if (isNaN(lat) || isNaN(lng))         return null;
    if (lat < -90  || lat > 90)           return null;
    if (lng < -180 || lng > 180)          return null;
    return { lat, lng };
}

// عناصر DOM
const loginFormDiv  = document.getElementById('loginForm');
const signupFormDiv = document.getElementById('signupForm');
const tabBtns       = document.querySelectorAll('.tab-btn');
const loginErrorDiv = document.getElementById('loginError');
const signupErrorDiv= document.getElementById('signupError');

// ===== دوال قاعدة البيانات =====

async function getNextClinicId() {
    const counterRef = database.ref('dental lap/users/doctors/data/_counters/clinicId');
    const result = await counterRef.transaction(current => (current || 0) + 1);
    return result.snapshot.val();
}

async function saveDoctorData(doctorName, clinicName, phoneNumber, email, governorate, area, userId) {
    const doctorRef = database.ref(`dental lap/users/doctors/data/${doctorName}`);
    try {
        const clinicId    = await getNextClinicId();
        // الموقع أصبح "لينك اللوكيشن" (نص حر يدخله الطبيب)
        const locationStr = (clinicLocationData?.raw || '').trim();

        await doctorRef.set({
            clinicId:     clinicId,
            doctorName:   doctorName,
            clinicName:   clinicName || '',
            phoneNumber:  phoneNumber,
            clinicNumber: phoneNumber,
            email:        email,
            governorate:  governorate,
            area:         area,
            userId:       userId,
            location:     locationStr   // لينك اللوكيشن (نص حر)
        });
        return true;
    } catch (error) {
        console.error("خطأ:", error);
        return false;
    }
}

async function saveUserLoginData(email, password, doctorName) {
    const emailKey = email.replace(/\./g, ',');
    const userRef  = database.ref(`dental lap/users/doctors/logIn-info/${emailKey}`);
    try {
        await userRef.set({
            email:      email,
            password:   password,
            doctorName: doctorName
        });
        return true;
    } catch (error) {
        console.error("خطأ:", error);
        return false;
    }
}

async function getDoctorNameByEmail(email) {
    const emailKey  = email.replace(/\./g, ',');
    const snapshot  = await database.ref(`dental lap/users/doctors/logIn-info/${emailKey}/doctorName`).once('value');
    return snapshot.val();
}

async function getDoctorData(doctorName) {
    const snapshot = await database.ref(`dental lap/users/doctors/data/${doctorName}`).once('value');
    return snapshot.val();
}

// ===== تسجيل الدخول =====

async function handleLogin(email, password) {
    loginErrorDiv.style.display = 'none';
    try {
        const userCredential = await auth.signInWithEmailAndPassword(email, password);
        const user           = userCredential.user;
        const doctorName     = await getDoctorNameByEmail(email);
        if (!doctorName) throw new Error("لم يتم العثور على بيانات الطبيب");
        const doctorData = await getDoctorData(doctorName);
        if (!doctorData) throw new Error("بيانات الطبيب غير مكتملة");

        localStorage.setItem('currentUser', JSON.stringify({
            uid:         user.uid,
            email:       email,
            doctorName:  doctorName,
            phoneNumber: doctorData.phoneNumber || doctorData.clinicNumber || '',
            governorate: doctorData.governorate || '',
            area:        doctorData.area || ''
        }));
        window.location.href = 'dashboard.html';
    } catch (error) {
        loginErrorDiv.textContent   = error.message;
        loginErrorDiv.style.display = 'block';
    }
}

// ===== تسجيل طبيب جديد =====

async function handleSignup(doctorName, clinicName, phoneNumber, email, password, governorate, area) {
    signupErrorDiv.style.display = 'none';
    const doctorExists = await database.ref(`dental lap/users/doctors/data/${doctorName}`).once('value');
    if (doctorExists.exists()) {
        signupErrorDiv.textContent   = "اسم الطبيب موجود بالفعل";
        signupErrorDiv.style.display = 'block';
        return;
    }
    try {
        const userCredential = await auth.createUserWithEmailAndPassword(email, password);
        const user = userCredential.user;
        await saveDoctorData(doctorName, clinicName, phoneNumber, email, governorate, area, user.uid);
        await saveUserLoginData(email, password, doctorName);
        await handleLogin(email, password);
    } catch (error) {
        signupErrorDiv.textContent   = error.message;
        signupErrorDiv.style.display = 'block';
    }
}

// ===== أحداث واجهة المستخدم =====

tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tab = btn.dataset.tab;
        if (tab === 'login') {
            loginFormDiv.classList.remove('hidden');
            signupFormDiv.classList.add('hidden');
        } else {
            loginFormDiv.classList.add('hidden');
            signupFormDiv.classList.remove('hidden');
        }
        loginErrorDiv.style.display  = 'none';
        signupErrorDiv.style.display = 'none';
    });
});

document.getElementById('doLoginBtn').addEventListener('click', async () => {
    const email    = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    if (!email || !password) {
        loginErrorDiv.textContent   = "الرجاء ملء البريد الإلكتروني وكلمة المرور";
        loginErrorDiv.style.display = 'block';
        return;
    }
    await handleLogin(email, password);
});

document.getElementById('doSignupBtn').addEventListener('click', async () => {
    const doctorName     = document.getElementById('doctorName').value.trim();
    const clinicName     = document.getElementById('clinicName').value.trim();
    const phoneNumber    = document.getElementById('clinicNumber').value.trim();
    const email          = document.getElementById('signupEmail').value.trim();
    const password       = document.getElementById('signupPassword').value;
    const confirmVal     = document.getElementById('confirmPassword').value;
    const governorate    = document.getElementById('governorate').value.trim();
    const area           = document.getElementById('area').value.trim();
    const locationManual = document.getElementById('locationManual').value.trim();

    if (!doctorName || !phoneNumber || !email || !password || !governorate || !area || !locationManual) {
        signupErrorDiv.textContent   = "جميع الحقول المطلوبة ضرورية";
        signupErrorDiv.style.display = 'block';
        return;
    }
    if (password !== confirmVal) {
        signupErrorDiv.textContent   = "كلمة المرور وتأكيدها غير متطابقين";
        signupErrorDiv.style.display = 'block';
        return;
    }
    if (password.length < 6) {
        signupErrorDiv.textContent   = "كلمة المرور يجب أن تكون 6 أحرف على الأقل";
        signupErrorDiv.style.display = 'block';
        return;
    }
    // الموقع نص حر = "لينك اللوكيشن" يدخله المستخدم كما هو (رابط جوجل ماب أو إحداثيات)
    clinicLocationData = { raw: locationManual };
    await handleSignup(doctorName, clinicName, phoneNumber, email, password, governorate, area);
});

// ===== مراقبة حالة المصادقة =====

auth.onAuthStateChanged(async (user) => {
    if (user) {
        const email      = user.email;
        const doctorName = await getDoctorNameByEmail(email);
        if (doctorName) {
            const doctorData = await getDoctorData(doctorName);
            if (doctorData) {
                localStorage.setItem('currentUser', JSON.stringify({
                    uid:         user.uid,
                    email:       email,
                    doctorName:  doctorName,
                    phoneNumber: doctorData.phoneNumber || doctorData.clinicNumber || '',
                    governorate: doctorData.governorate || '',
                    area:        doctorData.area || ''
                }));
                window.location.href = 'dashboard.html';
            }
        }
    }
});
