// AMO - Login
const usuarioInput = document.getElementById('loginUsuario');
const passwordInput = document.getElementById('loginPassword');
const errorBox = document.getElementById('loginError');
const btnIngresar = document.getElementById('btnIngresar');

document.getElementById('togglePassword').addEventListener('click', () => {
    const show = passwordInput.type === 'password';
    passwordInput.type = show ? 'text' : 'password';
    document.querySelector('#togglePassword i').className = show ? 'bi bi-eye-slash' : 'bi bi-eye';
});

document.querySelectorAll('.amo-demo-row').forEach(row => {
    row.addEventListener('click', () => {
        usuarioInput.value = row.dataset.u;
        passwordInput.value = row.dataset.p;
        usuarioInput.focus();
    });
});

async function ingresar() {
    const username = usuarioInput.value.trim();
    const password = passwordInput.value;
    errorBox.classList.add('d-none');
    if (!username || !password) {
        errorBox.textContent = 'Ingresa tu usuario y contraseña.';
        errorBox.classList.remove('d-none');
        return;
    }
    btnIngresar.disabled = true;
    btnIngresar.textContent = 'Ingresando...';
    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'No se pudo iniciar sesión.');
        window.location.href = '/dashboard';
    } catch (err) {
        errorBox.textContent = err.message;
        errorBox.classList.remove('d-none');
        btnIngresar.disabled = false;
        btnIngresar.textContent = 'Ingresar';
    }
}

btnIngresar.addEventListener('click', ingresar);
passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') ingresar(); });
usuarioInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') passwordInput.focus(); });
