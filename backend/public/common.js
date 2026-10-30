// =====================================================================
// AMO - common.js
// Base compartida: sesión, socket, navegación, notificaciones, toasts,
// modal de formularios y helpers de mapa. (Parte: Alexis)
// =====================================================================
window.AMO = window.AMO || {};

AMO.state = {
    usuario: null,
    vehiculosInfo: {},
    vehicles: {},
    clientes: {},
    choferes: {},
    rutas: {},
    envios: {},
    novedades: [],
    notificaciones: [],
    lockedVehicles: {},
    vehicleStatuses: {},
    activeDynamicRoutes: {},
    usuarios: []
};

// ---------------- Formato ----------------
AMO.esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
AMO.hace = (ts) => {
    const seg = Math.floor((Date.now() - ts) / 1000);
    if (seg < 60) return 'hace instantes';
    if (seg < 3600) return `hace ${Math.floor(seg / 60)} min`;
    if (seg < 86400) return `hace ${Math.floor(seg / 3600)} h`;
    return new Date(ts).toLocaleDateString('es-EC');
};
AMO.fecha = (ts) => new Date(ts).toLocaleString('es-EC', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

const TIPOS_NOVEDAD_LABEL = { accidente: 'Accidente', falla_mecanica: 'Falla mecánica', trafico: 'Tráfico / vía cerrada', retraso: 'Retraso', paquete: 'Problema con el paquete', cliente_ausente: 'Cliente ausente', otro: 'Otro' };
const PRIORIDAD_BADGE = { baja: 'b-slate', media: 'b-blue', alta: 'b-amber', critica: 'b-red' };
AMO.labelTipoNovedad = (t) => TIPOS_NOVEDAD_LABEL[t] || t;
AMO.badgePrioridad = (p) => PRIORIDAD_BADGE[p] || 'b-slate';

// ---------------- Toasts ----------------
AMO.toast = ({ titulo, mensaje, nivel = 'info' }) => {
    const cont = document.getElementById('amoToasts');
    const el = document.createElement('div');
    el.className = `amo-toast ${nivel}`;
    el.innerHTML = `<div class="tt">${AMO.esc(titulo)}</div><div class="ms">${AMO.esc(mensaje)}</div>`;
    cont.appendChild(el);
    setTimeout(() => el.remove(), 6000);
};

// ---------------- Modal genérico de formulario ----------------
AMO.modalForm = ({ titulo, campos, valores = {}, textoOk = 'Guardar', onSubmit }) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'amo-modal-backdrop';
    const camposHtml = campos.map(c => {
        const val = AMO.esc(valores[c.id] ?? '');
        if (c.type === 'select') {
            const opts = c.opciones.map(o => `<option value="${AMO.esc(o.value)}" ${String(valores[c.id]) === String(o.value) ? 'selected' : ''}>${AMO.esc(o.label)}</option>`).join('');
            return `<div class="mb-3"><label class="form-label small fw-semibold">${c.label}</label><select class="form-select" name="${c.id}" ${c.required ? 'required' : ''}>${c.placeholder ? `<option value="">${AMO.esc(c.placeholder)}</option>` : ''}${opts}</select></div>`;
        }
        if (c.type === 'custom') return `<div class="mb-3" data-custom="${c.id}"><label class="form-label small fw-semibold">${c.label}</label><div class="amo-pick-grid" data-pick="${c.id}"></div><input type="hidden" name="${c.id}" value="${val}"></div>`;
        return `<div class="mb-3"><label class="form-label small fw-semibold">${c.label}</label><input type="${c.type || 'text'}" class="form-control" name="${c.id}" value="${val}" placeholder="${AMO.esc(c.placeholder || '')}" ${c.required ? 'required' : ''}></div>`;
    }).join('');
    backdrop.innerHTML = `
        <div class="amo-modal">
            <div class="amo-modal-head"><h3>${AMO.esc(titulo)}</h3><button type="button" class="btn-close ms-auto" data-cerrar></button></div>
            <form>
                <div class="amo-modal-body">${camposHtml}<div class="alert alert-danger py-2 small d-none" data-error></div></div>
                <div class="amo-modal-foot"><button type="button" class="btn btn-light border" data-cerrar>Cancelar</button><button type="submit" class="btn btn-primary">${AMO.esc(textoOk)}</button></div>
            </form>
        </div>`;
    document.body.appendChild(backdrop);
    const cerrar = () => backdrop.remove();
    backdrop.querySelectorAll('[data-cerrar]').forEach(b => b.addEventListener('click', cerrar));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cerrar(); });

    campos.filter(c => c.type === 'custom').forEach(c => {
        const grid = backdrop.querySelector(`[data-pick="${c.id}"]`);
        const hidden = backdrop.querySelector(`input[name="${c.id}"]`);
        c.opciones.forEach(o => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'amo-pick' + (o.disabled ? ' disabled' : '') + (String(valores[c.id]) === String(o.value) ? ' selected' : '');
            btn.textContent = o.label;
            if (!o.disabled) btn.addEventListener('click', () => {
                grid.querySelectorAll('.amo-pick').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                hidden.value = o.value;
            });
            grid.appendChild(btn);
        });
    });

    const form = backdrop.querySelector('form');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const datos = Object.fromEntries(fd.entries());
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        const errBox = form.querySelector('[data-error]');
        errBox.classList.add('d-none');
        try {
            await onSubmit(datos);
            cerrar();
        } catch (err) {
            errBox.textContent = err.message || 'Ocurrió un error.';
            errBox.classList.remove('d-none');
            btn.disabled = false;
        }
    });
};

AMO.confirmar = (mensaje) => window.confirm(mensaje);

// ---------------- Registro de hooks (admin.js / portal.js se enganchan aquí) ----------------
AMO._initHandlers = [];
AMO._vistaHandlers = [];
AMO.onInitAdd = (fn) => AMO._initHandlers.push(fn);
AMO.onVistaAdd = (fn) => AMO._vistaHandlers.push(fn);

// ---------------- Llamada a socket con promesa ----------------
AMO.call = (evento, datos) => new Promise((resolve, reject) => {
    AMO.socket.emit(evento, datos, (res) => {
        if (res && res.ok === false) reject(new Error(res.error || 'Operación rechazada.'));
        else resolve(res);
    });
});

// ---------------- Iconos de vehículo en el mapa ----------------
const VEHICLE_COLORS = ['#2563eb', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2'];
AMO.colorVehiculo = (id) => {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
    return VEHICLE_COLORS[Math.abs(hash) % VEHICLE_COLORS.length];
};
AMO.iconoVehiculo = (id) => L.divIcon({
    className: '',
    html: `<div style="background:${AMO.colorVehiculo(id)};color:#fff;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35)">${AMO.esc(id.replace('V', ''))}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
});
AMO.badgeEstado = (status) => {
    const map = { detenido: 'b-slate', en_movimiento: 'b-blue', hacia_pedido: 'b-blue', recogiendo_pedido: 'b-amber', hacia_origen: 'b-blue', entregado: 'b-green', parada_no_programada: 'b-red', desconexion: 'b-red' };
    return map[status] || 'b-slate';
};

// ---------------- Navegación ----------------
const MENUS = {
    admin: [
        { view: 'monitoreo', label: 'Monitoreo', icon: 'bi-speedometer2' },
        { view: 'vehiculos', label: 'Vehículos', icon: 'bi-truck' },
        { view: 'choferes', label: 'Choferes', icon: 'bi-person-badge' },
        { view: 'clientes', label: 'Clientes', icon: 'bi-building' },
        { view: 'rutas', label: 'Rutas', icon: 'bi-signpost-2' },
        { view: 'envios', label: 'Envíos', icon: 'bi-box-seam' },
        { view: 'novedades', label: 'Novedades', icon: 'bi-megaphone', badge: 'novedades' }
    ],
    cliente: [
        { view: 'nuevo-envio', label: 'Mis envíos', icon: 'bi-box-seam' }
    ],
    chofer: [
        { view: 'jornada', label: 'Mi jornada', icon: 'bi-truck' }
    ]
};
const TITULOS = {
    monitoreo: 'Monitoreo en vivo', vehiculos: 'Vehículos', choferes: 'Choferes', clientes: 'Clientes',
    rutas: 'Rutas planificadas', envios: 'Envíos', novedades: 'Novedades e incidencias',
    'nuevo-envio': 'Solicitar un envío', jornada: 'Mi jornada'
};

function irAVista(view) {
    document.querySelectorAll('.amo-section').forEach(s => s.classList.toggle('active', s.dataset.view === view));
    document.querySelectorAll('.amo-nav-link').forEach(a => a.classList.toggle('active', a.dataset.view === view));
    document.getElementById('topTitle').textContent = TITULOS[view] || 'AMO';
    document.getElementById('topSub').textContent = { admin: 'Panel de administración', cliente: 'Portal del cliente', chofer: 'Portal del chofer' }[AMO.state.usuario.rol] || '';
    AMO._vistaHandlers.forEach(fn => fn(view));
}

function construirMenu() {
    const nav = document.getElementById('amoNav');
    const items = MENUS[AMO.state.usuario.rol] || [];
    nav.innerHTML = items.map((it, i) => `
        <li class="nav-item">
            <a class="amo-nav-link${i === 0 ? ' active' : ''}" data-view="${it.view}">
                <i class="bi ${it.icon}"></i><span>${it.label}</span>
                ${it.badge ? `<span class="badge-count d-none" data-badge="${it.badge}">0</span>` : ''}
            </a>
        </li>`).join('');
    nav.querySelectorAll('.amo-nav-link').forEach(a => a.addEventListener('click', () => irAVista(a.dataset.view)));
    if (items.length) irAVista(items[0].view);
}

function actualizarBadge(key, count) {
    const el = document.querySelector(`[data-badge="${key}"]`);
    if (!el) return;
    el.textContent = count;
    el.classList.toggle('d-none', count === 0);
}

// ---------------- Notificaciones ----------------
const NIVEL_ICON = { info: ['bi-info-circle', '#2563eb'], exito: ['bi-check2', '#16a34a'], advertencia: ['bi-exclamation-triangle', '#d97706'], peligro: ['bi-exclamation-octagon', '#dc2626'] };
function renderNotificaciones() {
    const list = document.getElementById('notifList');
    const items = [...AMO.state.notificaciones].sort((a, b) => b.timestamp - a.timestamp);
    const noLeidas = items.filter(n => !n.leida).length;
    const badge = document.getElementById('notifBadge');
    badge.textContent = noLeidas > 9 ? '9+' : noLeidas;
    badge.classList.toggle('d-none', noLeidas === 0);
    if (!items.length) { list.innerHTML = `<div class="amo-notif-empty"><i class="bi bi-bell-slash d-block mb-2" style="font-size:1.4rem"></i>Sin notificaciones</div>`; return; }
    list.innerHTML = items.map(n => {
        const [icon, color] = NIVEL_ICON[n.nivel] || NIVEL_ICON.info;
        return `<div class="amo-notif-item${n.leida ? '' : ' unread'}" data-id="${n.id}">
            <div class="ic" style="background:${color}"><i class="bi ${icon}"></i></div>
            <div><div class="tt">${AMO.esc(n.titulo)}</div><div class="ms">${AMO.esc(n.mensaje)}</div><div class="tm">${AMO.hace(n.timestamp)}</div></div>
        </div>`;
    }).join('');
    list.querySelectorAll('.amo-notif-item').forEach(el => el.addEventListener('click', () => {
        AMO.socket.emit('notificacion:leer', { id: el.dataset.id });
        const n = AMO.state.notificaciones.find(x => x.id === el.dataset.id);
        if (n) n.leida = true;
        renderNotificaciones();
    }));
}

function iniciarAMO(usuario) {
    AMO.state.usuario = usuario;
    document.getElementById('userNombre').textContent = usuario.nombre;
    document.getElementById('userRol').textContent = { admin: 'Administrador', cliente: 'Cliente', chofer: 'Chofer' }[usuario.rol] || usuario.rol;
    document.getElementById('userAvatar').textContent = usuario.nombre.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
    construirMenu();

    AMO.socket = io({ withCredentials: true });
    const connEl = document.getElementById('connEstado');
    AMO.socket.on('connect', () => { connEl.className = 'amo-conn ok'; connEl.innerHTML = '<span class="dot"></span><span>En línea</span>'; });
    AMO.socket.on('disconnect', () => { connEl.className = 'amo-conn bad'; connEl.innerHTML = '<span class="dot"></span><span>Desconectado</span>'; });
    AMO.socket.on('connect_error', () => { connEl.className = 'amo-conn bad'; connEl.innerHTML = '<span class="dot"></span><span>Sin conexión</span>'; });
    AMO.socket.on('operacion:rechazada', (d) => AMO.toast({ titulo: 'Acción no permitida', mensaje: d.message, nivel: 'peligro' }));

    AMO.socket.on('init', (data) => {
        Object.assign(AMO.state, data);
        AMO.state.novedades = data.novedades || [];
        AMO.state.notificaciones = data.notificaciones || [];
        renderNotificaciones();
        actualizarBadge('novedades', AMO.state.novedades.filter(n => n.estado === 'abierta').length);
        AMO._initHandlers.forEach(fn => fn(data));
        const vistaActiva = document.querySelector('.amo-nav-link.active')?.dataset.view;
        if (vistaActiva) AMO._vistaHandlers.forEach(fn => fn(vistaActiva));
    });

    AMO.socket.on('notificacion', (n) => {
        AMO.state.notificaciones.push(n);
        renderNotificaciones();
        AMO.toast({ titulo: n.titulo, mensaje: n.mensaje, nivel: n.nivel });
        if (n.nivel === 'peligro' || n.nivel === 'advertencia') {
            try { new AudioContext(); } catch (e) { /* no-op */ }
        }
    });

    document.getElementById('btnNotif').addEventListener('click', () => {
        document.getElementById('notifPanel').classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
        const panel = document.getElementById('notifPanel');
        if (!panel.contains(e.target) && e.target.id !== 'btnNotif' && !document.getElementById('btnNotif').contains(e.target)) panel.classList.remove('open');
    });
    document.getElementById('btnMarcarTodas').addEventListener('click', (e) => {
        e.preventDefault();
        AMO.socket.emit('notificaciones:leer_todas');
        AMO.state.notificaciones.forEach(n => n.leida = true);
        renderNotificaciones();
    });

    document.getElementById('cerrarSesion').addEventListener('click', async () => {
        await fetch('/api/logout', { method: 'POST' });
        window.location.href = '/login.html';
    });
}

(async function arrancar() {
    try {
        const res = await fetch('/api/me');
        if (!res.ok) { window.location.href = '/login.html'; return; }
        const { usuario } = await res.json();
        iniciarAMO(usuario);
    } catch (e) {
        window.location.href = '/login.html';
    }
})();
