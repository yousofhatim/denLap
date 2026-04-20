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

// عناصر DOM
const loginFormDiv = document.getElementById('loginForm');
const signupFormDiv = document.getElementById('signupForm');
const tabBtns = document.querySelectorAll('.tab-btn');
const loginErrorDiv = document.getElementById('loginError');
const signupErrorDiv = document.getElementById('signupError');

// دوال قاعدة البيانات
async function saveClinicData(clinicName, clinicNumber, doctorName, email, userId) {
    const clinicDataRef = database.ref(`dental lap/data/${clinicName}`);
    try {
        await clinicDataRef.set({
            clinicNumber: clinicNumber,
            doctorName: doctorName,
            email: email,
            createdAt: firebase.database.ServerValue.TIMESTAMP,
            userId: userId
        });
        return true;
    } catch (error) {
        console.error("خطأ:", error);
        return false;
    }
}

async function saveUserLoginData(email, password, clinicName) {
    const emailKey = email.replace(/\./g, ',');
    const userRef = database.ref(`dental lap/users/${emailKey}`);
    try {
        await userRef.set({
            email: email,
            password: password,
            clinicName: clinicName,
            createdAt: firebase.database.ServerValue.TIMESTAMP
        });
        return true;
    } catch (error) {
        console.error("خطأ:", error);
        return false;
    }
}

async function getClinicNameByEmail(email) {
    const emailKey = email.replace(/\./g, ',');
    const snapshot = await database.ref(`dental lap/users/${emailKey}/clinicName`).once('value');
    return snapshot.val();
}

async function getClinicData(clinicName) {
    const snapshot = await database.ref(`dental lap/data/${clinicName}`).once('value');
    return snapshot.val();
}

async function handleLogin(email, password) {
    loginErrorDiv.style.display = 'none';
    try {
        const userCredential = await auth.signInWithEmailAndPassword(email, password);
        const user = userCredential.user;
        const clinicName = await getClinicNameByEmail(email);
        if (!clinicName) throw new Error("لم يتم العثور على عيادة");
        const clinicData = await getClinicData(clinicName);
        if (!clinicData) throw new Error("بيانات العيادة غير مكتملة");
        
        // تخزين البيانات في localStorage للاستخدام في الصفحة الرئيسية
        localStorage.setItem('currentUser', JSON.stringify({
            uid: user.uid,
            email: email,
            clinicName: clinicName,
            doctorName: clinicData.doctorName
        }));
        
        // التوجيه إلى لوحة التحكم
        window.location.href = 'dashboard.html';
    } catch (error) {
        loginErrorDiv.textContent = error.message;
        loginErrorDiv.style.display = 'block';
    }
}

async function handleSignup(clinicName, clinicNumber, doctorName, email, password) {
    signupErrorDiv.style.display = 'none';
    const clinicExists = await database.ref(`dental lap/data/${clinicName}`).once('value');
    if (clinicExists.exists()) {
        signupErrorDiv.textContent = "اسم العيادة موجود بالفعل";
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
        signupErrorDiv.textContent = error.message;
        signupErrorDiv.style.display = 'block';
    }
}

// أحداث واجهة المستخدم
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
        loginErrorDiv.style.display = 'none';
        signupErrorDiv.style.display = 'none';
    });
});

document.getElementById('doLoginBtn').addEventListener('click', async () => {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    if (!email || !password) {
        loginErrorDiv.textContent = "الرجاء ملء البريد الإلكتروني وكلمة المرور";
        loginErrorDiv.style.display = 'block';
        return;
    }
    await handleLogin(email, password);
});

document.getElementById('doSignupBtn').addEventListener('click', async () => {
    const clinicName = document.getElementById('clinicName').value.trim();
    const clinicNumber = document.getElementById('clinicNumber').value.trim();
    const doctorName = document.getElementById('doctorName').value.trim();
    const email = document.getElementById('signupEmail').value.trim();
    const password = document.getElementById('signupPassword').value;
    const confirm = document.getElementById('confirmPassword').value;
    
    if (!clinicName || !clinicNumber || !doctorName || !email || !password) {
        signupErrorDiv.textContent = "جميع الحقول المطلوبة ضرورية";
        signupErrorDiv.style.display = 'block';
        return;
    }
    if (password !== confirm) {
        signupErrorDiv.textContent = "كلمة المرور وتأكيدها غير متطابقين";
        signupErrorDiv.style.display = 'block';
        return;
    }
    if (password.length < 6) {
        signupErrorDiv.textContent = "كلمة المرور يجب أن تكون 6 أحرف على الأقل";
        signupErrorDiv.style.display = 'block';
        return;
    }
    await handleSignup(clinicName, clinicNumber, doctorName, email, password);
});

// التحقق من حالة المصادقة
auth.onAuthStateChanged(async (user) => {
    if (user) {
        const email = user.email;
        const clinicName = await getClinicNameByEmail(email);
        if (clinicName) {
            const clinicData = await getClinicData(clinicName);
            if (clinicData) {
                localStorage.setItem('currentUser', JSON.stringify({
                    uid: user.uid,
                    email: email,
                    clinicName: clinicName,
                    doctorName: clinicData.doctorName
                }));
                window.location.href = 'dashboard.html';
            }
        }
    }
});