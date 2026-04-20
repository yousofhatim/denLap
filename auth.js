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

// موقع العيادة (يُعبَّأ بعد الضغط على زر التحديد)
let clinicLocationData = null;

// عناصر DOM
const loginFormDiv  = document.getElementById('loginForm');
const signupFormDiv = document.getElementById('signupForm');
const tabBtns       = document.querySelectorAll('.tab-btn');
const loginErrorDiv = document.getElementById('loginError');
const signupErrorDiv= document.getElementById('signupError');

// ===== دوال قاعدة البيانات =====

async function saveClinicData(clinicName, clinicNumber, doctorName, email, userId) {
    const clinicDataRef = database.ref(`dental lap/data/${clinicName}`);
    try {
        const locationStr = clinicLocationData
            ? `${clinicLocationData.lat},${clinicLocationData.lng}`
            : '';
        const mapsLink = clinicLocationData
            ? `https://www.google.com/maps?q=${clinicLocationData.lat},${clinicLocationData.lng}`
            : '';

        await clinicDataRef.set({
            clinicNumber:           clinicNumber,
            doctorName:             doctorName,
            email:                  email,
            createdAt:              firebase.database.ServerValue.TIMESTAMP,
            userId:                 userId,
            location:               locationStr,
            clinicLat:              clinicLocationData ? clinicLocationData.lat  : null,
            clinicLng:              clinicLocationData ? clinicLocationData.lng  : null,
            locationAccuracy:       clinicLocationData ? clinicLocationData.accuracy : null,
            mapsLink:               mapsLink
        });
        return true;
    } catch (error) {
        console.error("خطأ:", error);
        return false;
    }
}

async function saveUserLoginData(email, password, clinicName) {
    const emailKey = email.replace(/\./g, ',');
    const userRef  = database.ref(`dental lap/users/${emailKey}`);
    try {
        await userRef.set({
            email:     email,
            password:  password,
            clinicName:clinicName,
            createdAt: firebase.database.ServerValue.TIMESTAMP
        });
        return true;
    } catch (error) {
        console.error("خطأ:", error);
        return false;
    }
}

async function getClinicNameByEmail(email) {
    const emailKey  = email.replace(/\./g, ',');
    const snapshot  = await database.ref(`dental lap/users/${emailKey}/clinicName`).once('value');
    return snapshot.val();
}

async function getClinicData(clinicName) {
    const snapshot = await database.ref(`dental lap/data/${clinicName}`).once('value');
    return snapshot.val();
}

// ===== تسجيل الدخول =====

async function handleLogin(email, password) {
    loginErrorDiv.style.display = 'none';
    try {
        const userCredential = await auth.signInWithEmailAndPassword(email, password);
        const user            = userCredential.user;
        const clinicName      = await getClinicNameByEmail(email);
        if (!clinicName) throw new Error("لم يتم العثور على عيادة");
        const clinicData = await getClinicData(clinicName);
        if (!clinicData) throw new Error("بيانات العيادة غير مكتملة");

        localStorage.setItem('currentUser', JSON.stringify({
            uid:        user.uid,
            email:      email,
            clinicName: clinicName,
            doctorName: clinicData.doctorName
        }));
        window.location.href = 'dashboard.html';
    } catch (error) {
        loginErrorDiv.textContent   = error.message;
        loginErrorDiv.style.display = 'block';
    }
}

// ===== تسجيل عيادة جديدة =====

async function handleSignup(clinicName, clinicNumber, doctorName, email, password) {
    signupErrorDiv.style.display = 'none';
    const clinicExists = await database.ref(`dental lap/data/${clinicName}`).once('value');
    if (clinicExists.exists()) {
        signupErrorDiv.textContent   = "اسم العيادة موجود بالفعل";
        signupErrorDiv.style.display = 'block';
        return;
    }
    try {
        const userCredential = await auth.createUserWithEmailAndPassword(email, password);
        const user = userCredential.user;
        await saveClinicData(clinicName, clinicNumber, doctorName, email, user.uid);
        await saveUserLoginData(email, password, clinicName);
        await handleLogin(email, password);
    } catch (error) {
        signupErrorDiv.textContent   = error.message;
        signupErrorDiv.style.display = 'block';
    }
}

// ===== زر تحديد الموقع =====

const getLocationBtn = document.getElementById('getLocationBtn');
if (getLocationBtn) {
    getLocationBtn.addEventListener('click', () => {
        if (!navigator.geolocation) {
            alert("❌ المتصفح لا يدعم تحديد الموقع");
            return;
        }
        getLocationBtn.textContent = '⏳ جاري تحديد الموقع...';
        getLocationBtn.disabled    = true;

        navigator.geolocation.getCurrentPosition(
            (pos) => {
                clinicLocationData = {
                    lat:      pos.coords.latitude,
                    lng:      pos.coords.longitude,
                    accuracy: pos.coords.accuracy,
                    timestamp:Date.now()
                };

                const display = document.getElementById('locationDisplay');
                const text    = document.getElementById('locationText');
                const link    = document.getElementById('locationMapLink');
                const lat     = pos.coords.latitude.toFixed(5);
                const lng     = pos.coords.longitude.toFixed(5);

                text.textContent = `✅ الإحداثيات: ${lat}, ${lng}`;
                link.href        = `https://www.google.com/maps?q=${lat},${lng}`;
                display.classList.remove('hidden');

                getLocationBtn.textContent = '🔄 تحديث الموقع';
                getLocationBtn.disabled    = false;
            },
            (err) => {
                getLocationBtn.textContent = '📍 تحديد موقع العيادة';
                getLocationBtn.disabled    = false;
                alert(`❌ لم يتم تحديد الموقع:\n${err.message}`);
            },
            { enableHighAccuracy: true, timeout: 15000 }
        );
    });
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
    const clinicName   = document.getElementById('clinicName').value.trim();
    const clinicNumber = document.getElementById('clinicNumber').value.trim();
    const doctorName   = document.getElementById('doctorName').value.trim();
    const email        = document.getElementById('signupEmail').value.trim();
    const password     = document.getElementById('signupPassword').value;
    const confirm      = document.getElementById('confirmPassword').value;

    if (!clinicName || !clinicNumber || !doctorName || !email || !password) {
        signupErrorDiv.textContent   = "جميع الحقول المطلوبة ضرورية";
        signupErrorDiv.style.display = 'block';
        return;
    }
    if (password !== confirm) {
        signupErrorDiv.textContent   = "كلمة المرور وتأكيدها غير متطابقين";
        signupErrorDiv.style.display = 'block';
        return;
    }
    if (password.length < 6) {
        signupErrorDiv.textContent   = "كلمة المرور يجب أن تكون 6 أحرف على الأقل";
        signupErrorDiv.style.display = 'block';
        return;
    }
    await handleSignup(clinicName, clinicNumber, doctorName, email, password);
});

// ===== مراقبة حالة المصادقة =====

auth.onAuthStateChanged(async (user) => {
    if (user) {
        const email      = user.email;
        const clinicName = await getClinicNameByEmail(email);
        if (clinicName) {
            const clinicData = await getClinicData(clinicName);
            if (clinicData) {
                localStorage.setItem('currentUser', JSON.stringify({
                    uid:        user.uid,
                    email:      email,
                    clinicName: clinicName,
                    doctorName: clinicData.doctorName
                }));
                window.location.href = 'dashboard.html';
            }
        }
    }
});
