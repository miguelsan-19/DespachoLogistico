const form = document.querySelector('#loginForm');
fetch('/api/me').then(r => { if (r.ok) location.replace('/dashboard'); });
form.addEventListener('submit', async event => {
    event.preventDefault();
    const boton = form.querySelector('button');
    boton.disabled = true;
    document.querySelector('#error').textContent = '';
    try {
        const respuesta = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: document.querySelector('#username').value.trim(), password: document.querySelector('#password').value })
        });
        const data = await respuesta.json();
        if (!respuesta.ok) throw new Error(data.error);
        location.replace('/dashboard');
    } catch (error) {
        document.querySelector('#error').textContent = error.message || 'No se pudo conectar.';
        boton.disabled = false;
    }
});
