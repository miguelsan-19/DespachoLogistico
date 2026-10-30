// Cliente del dashboard: WebSockets (Socket.io) en tiempo real + mapa Leaflet
// + modulos de Clientes/Choferes/Rutas/Envios segun el rol activo.
// La seleccion de vehiculo/chofer funciona como elegir un asiento en el
// Lab2: una cuadricula de cajitas clickeables (.pick-box) que se pintan
// de azul al seleccionarlas.
// No hay login real en esta fase: el rol se elige con los botones de arriba.

const socket = io();

const statusEl = document.getElementById('connectionStatus');

// --- Estado local (espejo de lo que manda el servidor) ---
const vehicles = {};
const clientes = {};
const choferes = {};
const rutas = {};
const envios = {};
const lockedVehicles = {}; // vehicleId -> { vehicleId, clienteId, socketId }
let incidentCount = 0;

const VEHICLE_IDS = ['V001', 'V002', 'V003'];

// =======================================================================
// Selector de rol
// =======================================================================
const roleButtons = document.querySelectorAll('.role-btn');
const panels = {
    admin: document.getElementById('panel-admin'),
    cliente: document.getElementById('panel-cliente'),
    chofer: document.getElementById('panel-chofer')
};

roleButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
        roleButtons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        Object.values(panels).forEach((p) => p.classList.add('d-none'));
        panels[btn.dataset.role].classList.remove('d-none');
        if (btn.dataset.role === 'admin') {
            setTimeout(() => map.invalidateSize(), 50);
        }
        if (btn.dataset.role === 'cliente') {
            setTimeout(() => {
                initClientMap();
                if (clientMap) clientMap.invalidateSize();
            }, 80);
        }
    });
});

// =======================================================================
// Navegación por Sidebar de Módulos (Panel Administrador)
// =======================================================================
const adminNavLinks = document.querySelectorAll('.admin-nav-link');
const adminModules = {
    monitoreo: document.getElementById('module-monitoreo'),
    clientes: document.getElementById('module-clientes'),
    choferes: document.getElementById('module-choferes'),
    rutas: document.getElementById('module-rutas'),
    envios: document.getElementById('module-envios')
};

adminNavLinks.forEach((link) => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        const targetModule = link.dataset.module;
        adminNavLinks.forEach((l) => l.classList.remove('active'));
        link.classList.add('active');

        Object.values(adminModules).forEach((mod) => {
            if (mod) mod.classList.add('d-none');
        });
        if (adminModules[targetModule]) {
            adminModules[targetModule].classList.remove('d-none');
        }
        setTimeout(() => map.invalidateSize(), 60);
    });
});

// =======================================================================
// Mapa (panel Administrador)
// =======================================================================
const map = L.map('map').setView([-0.25, -78.50], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// Paleta de colores distintivos para la ubicación de cada vehículo
const VEHICLE_COLORS = {
    'V001': '#e63946', // Rojo
    'V002': '#0d6efd', // Azul
    'V003': '#198754', // Verde
    'V004': '#fd7e14', // Naranja
    'V005': '#6f42c1', // Morado
    'V006': '#0dcaf0', // Cian
    'V007': '#d63384', // Rosa
    'V008': '#20c997'  // Turquesa
};

const PALETTE = ['#e63946', '#0d6efd', '#198754', '#fd7e14', '#6f42c1', '#0dcaf0', '#d63384', '#20c997'];

function getVehicleColor(vehicleId) {
    if (!vehicleId) return '#6c757d';
    if (VEHICLE_COLORS[vehicleId]) return VEHICLE_COLORS[vehicleId];
    let hash = 0;
    for (let i = 0; i < vehicleId.length; i++) {
        hash = vehicleId.charCodeAt(i) + ((hash << 5) - hash);
    }
    return PALETTE[Math.abs(hash) % PALETTE.length];
}

function createVehicleIcon(vehicleId) {
    const color = getVehicleColor(vehicleId);
    const fontSize = vehicleId.length <= 4 ? 9 : (vehicleId.length <= 6 ? 7.5 : 6);
    const svg = `
        <div class="vehicle-pin" title="${vehicleId}">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 46" width="36" height="46">
                <path d="M18 0C8.06 0 0 8.06 0 18c0 13.5 18 28 18 28s18-14.5 18-28c0-9.94-8.06-18-18-18z" fill="${color}" stroke="#ffffff" stroke-width="2"/>
                <circle cx="18" cy="17" r="11" fill="#ffffff"/>
                <text x="18" y="17" font-size="${fontSize}" font-weight="800" fill="${color}" text-anchor="middle" dominant-baseline="central" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif">${vehicleId}</text>
            </svg>
        </div>
    `;
    return L.divIcon({
        className: 'vehicle-marker',
        html: svg,
        iconSize: [36, 46],
        iconAnchor: [18, 46],
        popupAnchor: [0, -44]
    });
}

function getStatusBadge(status) {
    if (status === 'hacia_pedido') return '<span class="badge bg-primary">🚗 Hacia el pedido</span>';
    if (status === 'recogiendo_pedido') return '<span class="badge bg-warning text-dark">📦 Recogiendo pedido</span>';
    if (status === 'hacia_origen') return '<span class="badge bg-info text-dark">🚚 Hacia el origen</span>';
    if (status === 'entregado') return '<span class="badge bg-success">✓ Entregado</span>';
    if (status === 'en_ruta') return '<span class="badge bg-success">En ruta</span>';
    if (status === 'detenido' || status === 'estacionado') return `<span class="badge bg-secondary">${status}</span>`;
    return `<span class="badge bg-danger">${(status || '').replace(/_/g, ' ')}</span>`;
}

function getPopupContent(v) {
    const color = getVehicleColor(v.vehicleId);

    return `
        <div style="min-width: 140px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px; border-bottom: 1px solid #e9ecef; padding-bottom: 4px;">
                <span class="vehicle-color-dot" style="background-color: ${color};"></span>
                <strong style="color: ${color}; font-size: 1.05rem;">${v.vehicleId}</strong>
            </div>
            <div style="font-size: 0.85rem; line-height: 1.5;">
                <div><b>Velocidad:</b> ${v.speed} km/h</div>
                <div><b>Estado:</b> ${getStatusBadge(v.status)}</div>
                <div class="text-muted" style="font-size: 0.75rem; margin-top: 4px;">
                    Lat: ${Number(v.lat).toFixed(4)}, Lng: ${Number(v.lng).toFixed(4)}
                </div>
            </div>
        </div>
    `;
}

const markers = {};
const vehicleTrails = {};

function upsertMarker(v) {
    const color = getVehicleColor(v.vehicleId);

    if (!markers[v.vehicleId]) {
        markers[v.vehicleId] = L.marker([v.lat, v.lng], {
            icon: createVehicleIcon(v.vehicleId)
        }).addTo(map).bindPopup(getPopupContent(v));
    } else {
        markers[v.vehicleId].setLatLng([v.lat, v.lng]);
    }
    markers[v.vehicleId].setPopupContent(getPopupContent(v));

    // Trazo de la ruta/historial de ubicaciones de cada vehiculo en su color distintivo
    if (!vehicleTrails[v.vehicleId]) {
        vehicleTrails[v.vehicleId] = L.polyline([[v.lat, v.lng]], {
            color: color,
            weight: 3,
            opacity: 0.7,
            dashArray: '5, 5'
        }).addTo(map);
    } else {
        const latlngs = vehicleTrails[v.vehicleId].getLatLngs();
        const lastPt = latlngs[latlngs.length - 1];
        if (lastPt) {
            const dist = Math.hypot(v.lat - lastPt.lat, v.lng - lastPt.lng);
            // Si el simulador salta al reiniciar el recorrido, limpiar el trazo previo
            if (dist > 0.05) {
                latlngs.length = 0;
                latlngs.push([v.lat, v.lng]);
            } else if (dist > 0.0001) {
                // Solo agregar puntos si el vehiculo se movio
                latlngs.push([v.lat, v.lng]);
                if (latlngs.length > 50) latlngs.shift();
            }
        } else {
            latlngs.push([v.lat, v.lng]);
        }
        vehicleTrails[v.vehicleId].setLatLngs(latlngs);
    }
}

// =======================================================================
// Selector tipo "asiento de cine" (vehiculos y choferes)
// =======================================================================

// vehiculos ocupados = ya asignados a algun chofer
function vehiclesOcupados() {
    return new Set(Object.values(choferes).map((c) => c.vehicleId).filter(Boolean));
}

function renderVehiclePicker(containerId, hiddenInputId) {
    const container = document.getElementById(containerId);
    const hidden = document.getElementById(hiddenInputId);
    const ocupados = vehiclesOcupados();
    const selected = hidden.value;

    container.innerHTML = '';
    VEHICLE_IDS.forEach((vid) => {
        const color = getVehicleColor(vid);
        const box = document.createElement('div');
        box.className = 'pick-box';
        if (ocupados.has(vid)) box.classList.add('ocupado');
        if (vid === selected) box.classList.add('selected');
        box.innerHTML = `
            <span class="vehicle-color-dot" style="width: 8px; height: 8px; background-color: ${color}; margin-bottom: 2px;"></span>
            ${vid}
            <span class="pick-sub">${ocupados.has(vid) ? 'ocupado' : 'libre'}</span>
        `;
        box.addEventListener('click', () => {
            hidden.value = hidden.value === vid ? '' : vid;
            renderVehiclePicker(containerId, hiddenInputId);
        });
        container.appendChild(box);
    });
}

function renderDriverPicker(containerId, hiddenInputId) {
    const container = document.getElementById(containerId);
    const hidden = document.getElementById(hiddenInputId);
    const asignados = new Set(Object.values(rutas).map((r) => r.choferId).filter(Boolean));
    const selected = hidden.value;

    container.innerHTML = '';
    if (Object.keys(choferes).length === 0) {
        container.innerHTML = '<span class="text-muted small">Primero agrega un chofer arriba.</span>';
        return;
    }
    Object.values(choferes).forEach((ch) => {
        const box = document.createElement('div');
        box.className = 'pick-box';
        if (asignados.has(ch.id)) box.classList.add('ocupado');
        if (ch.id === selected) box.classList.add('selected');
        box.innerHTML = `${ch.nombre.split(' ')[0]}<span class="pick-sub">${ch.vehicleId || 'sin veh.'}</span>`;
        box.addEventListener('click', () => {
            hidden.value = hidden.value === ch.id ? '' : ch.id;
            renderDriverPicker(containerId, hiddenInputId);
        });
        container.appendChild(box);
    });
}

// =======================================================================
// Render helpers - Panel Administrador
// =======================================================================
const vehicleListEl = document.getElementById('vehicleList');
const alertListEl = document.getElementById('alertList');
const activeCountEl = document.getElementById('activeCount');
const avgSpeedEl = document.getElementById('avgSpeed');
const incidentCountEl = document.getElementById('incidentCount');
const clienteListEl = document.getElementById('clienteList');
const choferListEl = document.getElementById('choferList');
const rutaListEl = document.getElementById('rutaList');
const envioListAdminEl = document.getElementById('envioListAdmin');

function renderVehicleList() {
    vehicleListEl.innerHTML = '';
    Object.values(vehicles).forEach((v) => {
        const color = getVehicleColor(v.vehicleId);
        const li = document.createElement('li');
        li.className = 'list-group-item d-flex justify-content-between align-items-center px-0';
        const isLocked = !!lockedVehicles[v.vehicleId];
        const badgeClass = v.status === 'en_ruta'
            ? 'bg-success'
            : (v.status === 'detenido' || v.status === 'estacionado' ? 'bg-secondary' : 'bg-warning text-dark');
        li.innerHTML = `
            <div class="d-flex align-items-center gap-2" style="cursor: pointer;" title="Centrar en el mapa">
                <span class="vehicle-color-dot" style="background-color: ${color};"></span>
                <strong style="color: ${color};">${v.vehicleId}</strong>
                ${isLocked ? '<span class="badge bg-danger ms-1" style="font-size:0.68rem;" title="Bloqueado por un cliente">🔒 Bloqueado</span>' : ''}
            </div>
            <span class="badge ${badgeClass}">${v.speed} km/h · ${v.status}</span>
        `;
        li.querySelector('div').addEventListener('click', () => {
            if (markers[v.vehicleId]) {
                map.setView([v.lat, v.lng], 14);
                markers[v.vehicleId].openPopup();
            }
        });
        vehicleListEl.appendChild(li);
    });
}

function renderMetrics() {
    const list = Object.values(vehicles);
    activeCountEl.textContent = list.length;
    const avg = list.length ? Math.round(list.reduce((s, v) => s + v.speed, 0) / list.length) : 0;
    avgSpeedEl.textContent = avg;
    incidentCountEl.textContent = incidentCount;

    const b = document.getElementById('sidebarBadgeUnidades');
    if (b) b.textContent = list.length;
}

function pushAlert(text) {
    const li = document.createElement('li');
    li.className = 'list-group-item px-0 border-start border-danger border-3 small';
    li.textContent = text;
    alertListEl.prepend(li);
    while (alertListEl.children.length > 8) alertListEl.removeChild(alertListEl.lastChild);
}

function renderClientes() {
    clienteListEl.innerHTML = '';
    const list = Object.values(clientes);
    list.forEach((c) => {
        const li = document.createElement('li');
        li.className = 'list-group-item px-0';
        li.innerHTML = `<b>${c.id}</b> · ${c.nombre}${c.telefono ? ' · ' + c.telefono : ''}`;
        clienteListEl.appendChild(li);
    });
    const b = document.getElementById('sidebarBadgeClientes');
    if (b) b.textContent = list.length;
}

function renderChoferes() {
    choferListEl.innerHTML = '';
    const choferIdSelect = document.getElementById('choferIdInput');
    choferIdSelect.innerHTML = '<option value="">-- elige tu usuario --</option>';

    const list = Object.values(choferes);
    list.forEach((ch) => {
        const li = document.createElement('li');
        li.className = 'list-group-item px-0';
        const vBadge = ch.vehicleId
            ? ` · <span class="badge text-white" style="background-color: ${getVehicleColor(ch.vehicleId)};">${ch.vehicleId}</span>`
            : '';
        li.innerHTML = `<b>${ch.id}</b> · ${ch.nombre}${vBadge}`;
        choferListEl.appendChild(li);

        const opt = document.createElement('option');
        opt.value = ch.id;
        opt.textContent = `${ch.id} - ${ch.nombre}`;
        choferIdSelect.appendChild(opt);
    });

    renderVehiclePicker('choferVehiculoPicker', 'choferVehiculo');
    renderDriverPicker('rutaChoferPicker', 'rutaChofer');

    const b = document.getElementById('sidebarBadgeChoferes');
    if (b) b.textContent = list.length;
}

function renderRutas() {
    rutaListEl.innerHTML = '';
    const list = Object.values(rutas);
    list.forEach((r) => {
        const li = document.createElement('li');
        li.className = 'list-group-item px-0';
        li.innerHTML = `<b>${r.id}</b> · ${r.nombre} (${r.origen} → ${r.destino}) · chofer: ${r.choferId || '-'}`;
        rutaListEl.appendChild(li);
    });
    renderDriverPicker('rutaChoferPicker', 'rutaChofer');

    const b = document.getElementById('sidebarBadgeRutas');
    if (b) b.textContent = list.length;
}

function renderEnviosAdmin() {
    envioListAdminEl.innerHTML = '';
    const list = Object.values(envios);
    list.forEach((e) => {
        const vBadge = e.vehicleId
            ? ` · <span class="badge text-white" style="background-color: ${getVehicleColor(e.vehicleId)};">${e.vehicleId}</span>`
            : '';
        const li = document.createElement('li');
        li.className = 'list-group-item px-0 d-flex justify-content-between align-items-center flex-wrap gap-1';
        li.innerHTML = `
            <div>
                <b>${e.id}</b> · cliente ${e.clienteId} · ${e.descripcion || 'Paquete'}
                <div class="text-muted small">${e.destino} ➔ ${e.origen}${vBadge}</div>
            </div>
            <div class="d-flex align-items-center gap-1">
                ${getStatusBadge(e.estado)}
                <button type="button" class="btn btn-sm btn-outline-secondary py-0" style="font-size:0.7rem;" onclick="seleccionarPedido('${e.id}')" title="Ver/Activar ruta en el mapa">
                    🗺️
                </button>
            </div>
        `;
        envioListAdminEl.appendChild(li);
    });

    const b = document.getElementById('sidebarBadgeEnvios');
    if (b) b.textContent = list.length;
}

// =======================================================================
// Panel Cliente & Mini Mapa con detección de vehículos por zona
// =======================================================================
const clienteIdInput = document.getElementById('clienteIdInput');
const envioForm = document.getElementById('envioForm');
const envioListClienteEl = document.getElementById('envioListCliente');
const clientCoordsLabel = document.getElementById('clientCoordsLabel');

let clientMap = null;
let originMarker = null;
let destMarker = null;
let originZoneCircle = null;
let originCoords = null;
let destCoords = null;
const clientVehicleMarkers = {};
let selectedClientVehicleId = null;

// Rutas dinámicas
const activeDynamicRoutes = {};
const adminRouteLayers = {};
const clientRouteLayers = {};
let activeSelectedEnvioId = null;

// Temporizador de selección: 15 segundos para confirmar el pedido
let vehicleSelectionTimer = null;
let vehicleSelectionSecondsLeft = 0;

function startVehicleSelectionTimer(vehicleId) {
    stopVehicleSelectionTimer();
    vehicleSelectionSecondsLeft = 15;
    updateTimerBadgeUI(vehicleSelectionSecondsLeft);

    vehicleSelectionTimer = setInterval(() => {
        vehicleSelectionSecondsLeft--;
        if (vehicleSelectionSecondsLeft <= 0) {
            stopVehicleSelectionTimer();
            deseleccionarVehiculoPorTiempo(vehicleId);
        } else {
            updateTimerBadgeUI(vehicleSelectionSecondsLeft);
        }
    }, 1000);
}

function stopVehicleSelectionTimer() {
    if (vehicleSelectionTimer) {
        clearInterval(vehicleSelectionTimer);
        vehicleSelectionTimer = null;
    }
    vehicleSelectionSecondsLeft = 0;
    const badge = document.getElementById('selectionCountdownBadge');
    if (badge) {
        badge.classList.add('d-none');
    }
    document.querySelectorAll('.card-timer-text').forEach(el => {
        el.textContent = '';
    });
}

function updateTimerBadgeUI(seconds) {
    const badge = document.getElementById('selectionCountdownBadge');
    if (badge) {
        badge.classList.remove('d-none');
        badge.textContent = `⏱️ ${seconds}s`;
        badge.className = 'badge bg-light text-dark border'; // Neutro sin colores
    }

    document.querySelectorAll('.card-timer-text').forEach(el => {
        el.textContent = `(${seconds}s)`;
    });
}

function deseleccionarVehiculoPorTiempo(vehicleId) {
    const vId = vehicleId || selectedClientVehicleId;
    if (!vId) return;

    console.warn(`[Temporizador] Tiempo agotado (15s): Deseleccionando vehículo ${vId}`);
    socket.emit('vehiculo:desbloquear', { vehicleId: vId });

    selectedClientVehicleId = null;

    const hidden = document.getElementById('envioVehiculo');
    if (hidden) hidden.value = '';

    const badge = document.getElementById('selectedVehicleBadge');
    if (badge) {
        badge.style.backgroundColor = '';
        badge.className = 'badge bg-secondary';
        badge.textContent = 'Ninguno seleccionado';
    }

    if (originCoords) updateNearbyVehicles();
}

// Obtener chofer asignado a un vehículo
function getDriverForVehicle(vehicleId) {
    return Object.values(choferes).find((ch) => ch.vehicleId === vehicleId);
}

// Cálculo de distancia en km entre dos coordenadas (Haversine)
function calculateDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radio de la Tierra en km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Number((R * c).toFixed(1));
}

// Icono personalizado para el Origen / Entrega (🟢 Verde)
const originPinIcon = L.divIcon({
    className: 'custom-map-pin',
    html: `
        <div style="filter: drop-shadow(0 3px 5px rgba(0,0,0,0.4));">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 46" width="36" height="46">
                <path d="M18 0C8.06 0 0 8.06 0 18c0 13.5 18 28 18 28s18-14.5 18-28c0-9.94-8.06-18-18-18z" fill="#198754" stroke="#ffffff" stroke-width="2"/>
                <circle cx="18" cy="17" r="10" fill="#ffffff"/>
                <text x="18" y="17" font-size="11" font-weight="800" fill="#198754" text-anchor="middle" dominant-baseline="central">🏠</text>
            </svg>
        </div>
    `,
    iconSize: [36, 46],
    iconAnchor: [18, 46],
    popupAnchor: [0, -44]
});

// Icono personalizado para Dónde está el Pedido (📦 Azul)
const pedidoPinIcon = L.divIcon({
    className: 'custom-map-pin',
    html: `
        <div style="filter: drop-shadow(0 3px 5px rgba(0,0,0,0.4));">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 46" width="36" height="46">
                <path d="M18 0C8.06 0 0 8.06 0 18c0 13.5 18 28 18 28s18-14.5 18-28c0-9.94-8.06-18-18-18z" fill="#0d6efd" stroke="#ffffff" stroke-width="2"/>
                <circle cx="18" cy="17" r="10" fill="#ffffff"/>
                <text x="18" y="17" font-size="11" font-weight="800" fill="#0d6efd" text-anchor="middle" dominant-baseline="central">📦</text>
            </svg>
        </div>
    `,
    iconSize: [36, 46],
    iconAnchor: [18, 46],
    popupAnchor: [0, -44]
});

const destPinIcon = pedidoPinIcon;

function initClientMap() {
    if (clientMap) {
        clientMap.invalidateSize();
        return;
    }
    const container = document.getElementById('clientMap');
    if (!container) return;

    // Centro inicial en Quito
    clientMap = L.map('clientMap').setView([-0.2295, -78.5243], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(clientMap);

    clientMap.on('click', (e) => {
        handleClientMapClick(e.latlng.lat, e.latlng.lng);
    });
}

async function updateAddressFromCoords(lat, lng, targetInputId) {
    const input = document.getElementById(targetInputId);
    if (!input) return;

    // Asignar inmediatamente coordenadas numéricas
    input.value = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

    // Intentar obtener dirección legible vía Nominatim (OpenStreetMap)
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`);
        if (res.ok) {
            const data = await res.json();
            if (data && data.address) {
                const addr = data.address;
                const street = addr.road || addr.pedestrian || addr.suburb || addr.neighbourhood || '';
                const city = addr.city || addr.town || addr.village || 'Quito';
                if (street) {
                    input.value = `${street}, ${city} (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
                } else if (data.display_name) {
                    input.value = data.display_name.split(',').slice(0, 2).join(',') + ` (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
                }
            }
        }
    } catch (_) {
        // En caso de estar sin conexión externa, se conservan las coordenadas
    }
}

function handleClientMapClick(lat, lng) {
    const targetType = document.querySelector('input[name="mapTarget"]:checked')?.value || 'destino';

    if (targetType === 'destino') {
        // 1. Dónde está el pedido (Punto de recogida)
        destCoords = { lat, lng };

        if (!destMarker) {
            destMarker = L.marker([lat, lng], { icon: pedidoPinIcon, draggable: true }).addTo(clientMap);
            destMarker.on('dragend', (ev) => {
                const pos = ev.target.getLatLng();
                destCoords = { lat: pos.lat, lng: pos.lng };
                updateAddressFromCoords(pos.lat, pos.lng, 'envioDestino');
                updateNearbyVehicles();
            });
        } else {
            destMarker.setLatLng([lat, lng]);
        }
        destMarker.bindPopup('<b>📦 Dónde está el Pedido (Recogida)</b><br>Haz clic en "Al Origen" para fijar la entrega.').openPopup();

        if (clientCoordsLabel) {
            clientCoordsLabel.textContent = `Pedido: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
        }

        updateAddressFromCoords(lat, lng, 'envioDestino');
        updateNearbyVehicles();

    } else {
        // 2. Al Origen / Entrega (Cliente)
        originCoords = { lat, lng };

        if (!originMarker) {
            originMarker = L.marker([lat, lng], { icon: originPinIcon, draggable: true }).addTo(clientMap);
            originMarker.on('dragend', (ev) => {
                const pos = ev.target.getLatLng();
                originCoords = { lat: pos.lat, lng: pos.lng };
                if (originZoneCircle) originZoneCircle.setLatLng(pos);
                updateAddressFromCoords(pos.lat, pos.lng, 'envioOrigen');
                updateNearbyVehicles();
            });
        } else {
            originMarker.setLatLng([lat, lng]);
        }
        originMarker.bindPopup('<b>🟢 Al Origen / Entrega (Cliente)</b><br>Punto de destino del paquete').openPopup();

        // Círculo de cobertura/zona alrededor del origen (~12 km)
        if (!originZoneCircle) {
            originZoneCircle = L.circle([lat, lng], {
                radius: 12000,
                color: '#198754',
                fillColor: '#198754',
                fillOpacity: 0.08,
                weight: 1.5,
                dashArray: '5, 5'
            }).addTo(clientMap);
        } else {
            originZoneCircle.setLatLng([lat, lng]);
        }

        if (clientCoordsLabel) {
            clientCoordsLabel.textContent = `Origen: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
        }

        updateAddressFromCoords(lat, lng, 'envioOrigen');
        updateNearbyVehicles();
    }
}

// Actualizar vehículos cercanos y mostrarlos en el mini mapa
function updateNearbyVehicles() {
    if (!clientMap) return;
    const refPoint = originCoords || destCoords || { lat: -0.2295, lng: -78.5243 };

    const vehicleList = Object.values(vehicles).map((v) => {
        const dist = calculateDistanceKm(refPoint.lat, refPoint.lng, v.lat, v.lng);
        return { ...v, distance: dist };
    });

    // Ordenar de más cercano a más lejano
    vehicleList.sort((a, b) => a.distance - b.distance);

    // Colocar o actualizar los marcadores de los vehículos en el mini mapa
    vehicleList.forEach((v) => {
        const color = getVehicleColor(v.vehicleId);
        const driver = getDriverForVehicle(v.vehicleId);
        const hasDriver = !!driver;
        const lock = lockedVehicles[v.vehicleId];
        const isLockedByOther = lock && lock.socketId !== socket.id;
        const isLockedByMe = lock && lock.socketId === socket.id;

        if (!clientVehicleMarkers[v.vehicleId]) {
            clientVehicleMarkers[v.vehicleId] = L.marker([v.lat, v.lng], {
                icon: createVehicleIcon(v.vehicleId)
            }).addTo(clientMap);

            clientVehicleMarkers[v.vehicleId].on('click', () => {
                if (!getDriverForVehicle(v.vehicleId)) return;
                toggleVehicleSelection(v.vehicleId);
            });
        } else {
            clientVehicleMarkers[v.vehicleId].setLatLng([v.lat, v.lng]);
        }

        let popupBtnHtml = '';
        let popupLockBadge = '';
        if (!hasDriver) {
            popupLockBadge = '<span class="badge bg-secondary ms-auto" style="font-size:0.7rem;">⚠️ Sin chofer</span>';
            popupBtnHtml = '<div class="small text-muted mt-1">Sin chofer asignado</div>';
        } else if (isLockedByOther) {
            popupLockBadge = '<span class="badge bg-danger ms-auto" style="font-size:0.7rem;">🔒 Bloqueado</span>';
            popupBtnHtml = '<div class="small text-danger mt-1">Ocupado por otro cliente</div>';
        } else if (isLockedByMe || selectedClientVehicleId === v.vehicleId) {
            // Cuando se selecciona al conductor: NO mostrar botón de bloquear y seleccionar
            popupLockBadge = '<span class="badge bg-success ms-auto" style="font-size:0.7rem;">✓ Seleccionado</span>';
            popupBtnHtml = `
                <div class="small text-success fw-bold mt-1">✓ Conductor seleccionado</div>
                <button type="button" class="btn btn-sm btn-outline-danger mt-1 w-100 py-0" style="font-size:0.75rem;" onclick="toggleVehicleSelection('${v.vehicleId}')">
                    Desmarcar
                </button>
            `;
        } else if (selectedClientVehicleId) {
            popupBtnHtml = `
                <button type="button" class="btn btn-sm btn-outline-primary mt-2 w-100 py-0" style="font-size:0.75rem;" onclick="toggleVehicleSelection('${v.vehicleId}')">
                    Cambiar a este conductor
                </button>
            `;
        } else {
            popupBtnHtml = `
                <button type="button" class="btn btn-sm btn-primary mt-2 w-100 py-0" style="font-size:0.75rem;" onclick="toggleVehicleSelection('${v.vehicleId}')">
                    Seleccionar conductor
                </button>
            `;
        }

        const popupContent = `
            <div style="font-size:0.85rem; min-width: 140px;">
                <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px;">
                    <span class="vehicle-color-dot" style="background-color:${color}; width:10px; height:10px;"></span>
                    <strong style="color:${color}; font-size:1rem;">${v.vehicleId}</strong>
                    ${popupLockBadge}
                </div>
                <div>Distancia: <b>${v.distance} km</b></div>
                <div class="small text-muted">${driver ? `Chofer: ${driver.nombre}` : 'Sin chofer'} · ${v.speed} km/h</div>
                ${popupBtnHtml}
            </div>
        `;

        if (clientVehicleMarkers[v.vehicleId].getPopup()) {
            clientVehicleMarkers[v.vehicleId].setPopupContent(popupContent);
        } else {
            clientVehicleMarkers[v.vehicleId].bindPopup(popupContent);
        }
    });

    renderNearbyVehiclesUI(vehicleList);
}

// Renderizar la lista de tarjetas de vehículos seleccionables con estado de bloqueo
function renderNearbyVehiclesUI(vehicleList) {
    const section = document.getElementById('nearbyVehiclesSection');
    const container = document.getElementById('nearbyVehiclesList');
    if (!section || !container) return;

    section.style.display = 'block';
    container.innerHTML = '';

    if (vehicleList.length === 0) {
        container.innerHTML = '<span class="text-muted small">No hay vehículos conectados en este momento.</span>';
        return;
    }

    vehicleList.forEach((v) => {
        const color = getVehicleColor(v.vehicleId);
        const driver = getDriverForVehicle(v.vehicleId);
        const hasDriver = !!driver;
        const lock = lockedVehicles[v.vehicleId];
        const isLockedByOther = lock && lock.socketId !== socket.id;
        const isSelected = selectedClientVehicleId === v.vehicleId;

        const card = document.createElement('div');
        let cardClass = 'client-vehicle-card';
        if (!hasDriver) cardClass += ' disabled-no-driver';
        else if (isLockedByOther) cardClass += ' locked';
        else if (isSelected) cardClass += ' selected';

        let statusText = '';
        let lockBadge = '';
        if (!hasDriver) {
            lockBadge = '<span class="badge bg-secondary" style="font-size: 0.7rem;">Sin chofer</span>';
            statusText = '<div class="text-muted small mt-1" style="font-size:0.72rem;">⚠️ No disponible (sin chofer asignado)</div>';
        } else if (isLockedByOther) {
            lockBadge = '<span class="badge bg-danger" style="font-size: 0.7rem;">🔒 Bloqueado</span>';
            statusText = '<div class="text-danger small mt-1" style="font-size:0.72rem;">Bloqueado por otro cliente</div>';
        } else if (isSelected) {
            lockBadge = '<span class="badge bg-primary" style="font-size: 0.7rem;">✓ Seleccionado</span>';
            statusText = '<div class="text-success small fw-bold mt-1" style="font-size:0.72rem;">✓ Conductor asignado (clic para desmarcar)</div>';
        } else {
            lockBadge = `<span class="badge ${v.distance <= 12 ? 'bg-success' : 'bg-secondary'}" style="font-size: 0.72rem;">${v.distance} km</span>`;
            statusText = '<div class="text-muted small mt-1" style="font-size:0.72rem;">Clic para seleccionar conductor</div>';
        }

        card.className = cardClass;
        card.innerHTML = `
            <div class="d-flex justify-content-between align-items-center mb-1">
                <div class="d-flex align-items-center gap-1">
                    <span class="vehicle-color-dot" style="background-color: ${color}; width: 10px; height: 10px;"></span>
                    <strong style="color: ${color}; font-size: 0.95rem;">${v.vehicleId}</strong>
                </div>
                ${lockBadge}
            </div>
            <div class="small text-muted" style="font-size: 0.75rem;">
                ${driver ? `🧑‍✈️ ${driver.nombre.split(' ')[0]}` : 'Sin chofer'}
                · ${v.distance} km
            </div>
            ${statusText}
        `;

        card.addEventListener('click', () => {
            if (!hasDriver) return;
            toggleVehicleSelection(v.vehicleId);
        });

        container.appendChild(card);
    });
}

// Bloquear / desmarcar un vehículo en tiempo real vía WebSockets
window.toggleVehicleSelection = function(vehicleId) {
    const driver = getDriverForVehicle(vehicleId);
    if (!driver) return;

    const lock = lockedVehicles[vehicleId];
    const isLockedByOther = lock && lock.socketId !== socket.id;
    if (isLockedByOther) return;

    // Si ya lo tiene seleccionado: DESMARCAR y DESBLOQUEAR
    if (selectedClientVehicleId === vehicleId) {
        stopVehicleSelectionTimer();
        socket.emit('vehiculo:desbloquear', { vehicleId });
        selectedClientVehicleId = null;

        const hidden = document.getElementById('envioVehiculo');
        if (hidden) hidden.value = '';

        const badge = document.getElementById('selectedVehicleBadge');
        if (badge) {
            badge.style.backgroundColor = '';
            badge.className = 'badge bg-secondary';
            badge.textContent = 'Ninguno seleccionado';
        }

        if (originCoords) updateNearbyVehicles();
        return;
    }

    // Si tenía otro vehículo bloqueado previamente, desbloquear el anterior
    if (selectedClientVehicleId && selectedClientVehicleId !== vehicleId) {
        stopVehicleSelectionTimer();
        socket.emit('vehiculo:desbloquear', { vehicleId: selectedClientVehicleId });
    }

    // Bloquear y seleccionar el nuevo vehículo
    selectedClientVehicleId = vehicleId;
    const clienteId = clienteIdInput.value.trim() || 'cliente';
    socket.emit('vehiculo:bloquear', { vehicleId, clienteId });
    startVehicleSelectionTimer(vehicleId);

    const hidden = document.getElementById('envioVehiculo');
    if (hidden) hidden.value = vehicleId;

    const badge = document.getElementById('selectedVehicleBadge');
    if (badge) {
        const color = getVehicleColor(vehicleId);
        badge.style.backgroundColor = color;
        badge.className = 'badge text-white';
        badge.textContent = `Vehículo: ${vehicleId} (Bloqueado por ti)`;
    }

    if (originCoords) updateNearbyVehicles();

    // Cerrar cualquier popup para no mostrar el botón
    if (clientMap) {
        clientMap.closePopup();
    }
};

window.selectNearbyVehicle = window.toggleVehicleSelection;

function resetClientMap() {
    stopVehicleSelectionTimer();
    if (selectedClientVehicleId) {
        socket.emit('vehiculo:desbloquear', { vehicleId: selectedClientVehicleId });
        selectedClientVehicleId = null;
    }

    if (originMarker && clientMap) { clientMap.removeLayer(originMarker); originMarker = null; }
    if (destMarker && clientMap) { clientMap.removeLayer(destMarker); destMarker = null; }
    if (originZoneCircle && clientMap) { clientMap.removeLayer(originZoneCircle); originZoneCircle = null; }

    Object.values(clientVehicleMarkers).forEach((m) => {
        if (clientMap) clientMap.removeLayer(m);
    });
    for (const key in clientVehicleMarkers) delete clientVehicleMarkers[key];

    originCoords = null;
    destCoords = null;

    const hidden = document.getElementById('envioVehiculo');
    if (hidden) hidden.value = '';

    const badge = document.getElementById('selectedVehicleBadge');
    if (badge) {
        badge.style.backgroundColor = '';
        badge.className = 'badge bg-secondary';
        badge.textContent = 'Ninguno seleccionado';
    }

    const section = document.getElementById('nearbyVehiclesSection');
    if (section) section.style.display = 'none';

    if (clientCoordsLabel) {
        clientCoordsLabel.textContent = 'Haz clic en el mapa';
    }

    // Regresar radio a destino (Dónde está el pedido)
    const radioDestino = document.getElementById('targetDestino');
    if (radioDestino) radioDestino.checked = true;
}

// Pintar la ruta dinámica en cualquiera de los mapas Leaflet (Admin o Cliente)
function renderDynamicRouteOnMap(routeData, targetMap, layerMap) {
    if (!targetMap || !routeData) return;
    const { vehicleId, waypoints, status, envioId } = routeData;
    if (!waypoints || waypoints.length < 2) return;

    const color = getVehicleColor(vehicleId);

    // Limpiar capa previa de este vehículo en este mapa
    if (layerMap[vehicleId]) {
        targetMap.removeLayer(layerMap[vehicleId]);
    }

    const group = L.layerGroup();

    // 1. Línea polilínea dinámica conectando: Auto -> Pedido -> Origen
    const latlngs = waypoints.map(w => [w.lat, w.lng]);
    const routePolyline = L.polyline(latlngs, {
        color: color,
        weight: 4,
        opacity: 0.85,
        dashArray: '8, 8'
    }).addTo(group);

    // 2. Marcador para "Dónde está el pedido" (waypoints[1])
    if (waypoints[1]) {
        L.marker([waypoints[1].lat, waypoints[1].lng], {
            icon: pedidoPinIcon
        }).bindPopup(`
            <div style="font-size:0.85rem;">
                <div class="fw-bold text-primary">📦 Dónde está el Pedido (Recogida)</div>
                <div class="small text-muted">Envío: ${envioId || ''} · Asignado a: ${vehicleId}</div>
                <div class="mt-1">Lat: ${waypoints[1].lat.toFixed(4)}, Lng: ${waypoints[1].lng.toFixed(4)}</div>
            </div>
        `).addTo(group);
    }

    // 3. Marcador para "Al Origen / Entrega" (waypoints[2])
    if (waypoints[2]) {
        L.marker([waypoints[2].lat, waypoints[2].lng], {
            icon: originPinIcon
        }).bindPopup(`
            <div style="font-size:0.85rem;">
                <div class="fw-bold text-success">🟢 Al Origen / Entrega (Cliente)</div>
                <div class="small text-muted">Envío: ${envioId || ''} · Asignado a: ${vehicleId}</div>
                <div class="mt-1">Lat: ${waypoints[2].lat.toFixed(4)}, Lng: ${waypoints[2].lng.toFixed(4)}</div>
            </div>
        `).addTo(group);
    }

    group.addTo(targetMap);
    layerMap[vehicleId] = group;
}

// Actualizar banner de estado de la ruta dinámica en el portal cliente
function updateDynamicRouteStatusBox(routeData) {
    const box = document.getElementById('dynamicRouteStatusBox');
    if (!box) return;

    if (!routeData) {
        box.classList.add('d-none');
        return;
    }

    box.classList.remove('d-none');

    const titleEl = document.getElementById('dynRouteVehicleTitle');
    const badgeEl = document.getElementById('dynRouteStatusBadge');
    const descEl = document.getElementById('dynRouteStepDesc');
    const progEl = document.getElementById('dynRouteProgressBar');

    const vId = routeData.vehicleId;
    const status = routeData.status;
    const color = getVehicleColor(vId);

    if (titleEl) {
        titleEl.innerHTML = `<span class="vehicle-color-dot" style="background-color:${color}; width:10px; height:10px;"></span> 🚗 Vehículo ${vId} (Envío ${routeData.envioId || ''})`;
    }

    let badgeText = 'En camino';
    let badgeClass = 'bg-primary';
    let descText = 'El vehículo se desplaza en su ruta dinámica.';
    let pct = 30;

    if (status === 'hacia_pedido') {
        badgeText = '🚗 1/2 Hacia el pedido';
        badgeClass = 'bg-primary';
        descText = 'El vehículo está en camino a recoger el pedido en el punto indicado.';
        pct = 35;
    } else if (status === 'recogiendo_pedido') {
        badgeText = '📦 Recogiendo paquete';
        badgeClass = 'bg-warning text-dark';
        descText = 'El vehículo llegó al sitio del pedido y está cargando el paquete.';
        pct = 50;
    } else if (status === 'hacia_origen') {
        badgeText = '🚚 2/2 Hacia el origen';
        badgeClass = 'bg-info text-dark';
        descText = 'Paquete a bordo. El vehículo se dirige a entregarlo al origen del cliente.';
        pct = 80;
    } else if (status === 'entregado') {
        badgeText = '✓ Entregado en origen';
        badgeClass = 'bg-success';
        descText = '¡Ruta completada! El pedido ha llegado a su destino en el origen.';
        pct = 100;
    }

    if (badgeEl) {
        badgeEl.className = `badge ${badgeClass}`;
        badgeEl.textContent = badgeText;
    }
    if (descEl) {
        descEl.textContent = descText;
    }
    if (progEl) {
        progEl.style.width = `${pct}%`;
        if (pct === 100) {
            progEl.className = 'progress-bar bg-success';
        } else {
            progEl.className = 'progress-bar progress-bar-striped progress-bar-animated bg-primary';
        }
    }
}

// Seleccionar un pedido (desde "Mis envíos" o al crearlo)
window.seleccionarPedido = function(envioId) {
    if (!envioId || !envios[envioId]) return;
    activeSelectedEnvioId = envioId;
    const envio = envios[envioId];

    socket.emit('envio:seleccionar', { envioId });

    if (envio.vehicleId && activeDynamicRoutes[envio.vehicleId]) {
        const rData = activeDynamicRoutes[envio.vehicleId];
        updateDynamicRouteStatusBox(rData);

        if (clientMap) {
            renderDynamicRouteOnMap(rData, clientMap, clientRouteLayers);
            if (rData.waypoints && rData.waypoints.length > 0) {
                const bounds = L.latLngBounds(rData.waypoints.map(w => [w.lat, w.lng]));
                clientMap.fitBounds(bounds, { padding: [25, 25] });
            }
        }
        if (map) {
            renderDynamicRouteOnMap(rData, map, adminRouteLayers);
            if (rData.waypoints && rData.waypoints.length > 0) {
                const bounds = L.latLngBounds(rData.waypoints.map(w => [w.lat, w.lng]));
                map.fitBounds(bounds, { padding: [40, 40] });
            }
        }
    }

    renderEnviosCliente();
    renderEnviosAdmin();
};

function renderEnviosCliente() {
    const myId = clienteIdInput.value.trim() || 'C1';
    envioListClienteEl.innerHTML = '';
    const myEnvios = Object.values(envios).filter((e) => e.clienteId === myId || !e.clienteId);

    if (myEnvios.length === 0) {
        envioListClienteEl.innerHTML = '<li class="list-group-item text-muted small text-center py-3">No tienes pedidos creados aún. Llena el formulario arriba y haz clic en "Crear envío".</li>';
        return;
    }

    myEnvios.forEach((e) => {
        const isSelected = activeSelectedEnvioId === e.id;
        const color = e.vehicleId ? getVehicleColor(e.vehicleId) : '#6c757d';
        const vBadge = e.vehicleId
            ? `<span class="badge text-white" style="background-color: ${color};"><span class="vehicle-color-dot" style="width:7px;height:7px;background:#fff;margin-right:3px;"></span>${e.vehicleId}</span>`
            : '<span class="badge bg-secondary">Sin vehículo</span>';

        const card = document.createElement('div');
        card.className = `client-order-item ${isSelected ? 'active' : ''}`;
        card.innerHTML = `
            <div class="d-flex justify-content-between align-items-center mb-1">
                <span class="fw-bold text-dark" style="font-size:0.95rem;">📦 ${e.descripcion}</span>
                ${getStatusBadge(e.estado)}
            </div>
            <div class="small text-muted" style="font-size:0.78rem; line-height: 1.4;">
                <div><b>Dónde está el pedido (recogida):</b> ${e.destino}</div>
                <div><b>Al origen (entrega):</b> ${e.origen}</div>
            </div>
            <div class="d-flex justify-content-between align-items-center mt-2 pt-1 border-top">
                <span class="small">${vBadge} <span class="text-muted ms-1">(${e.id})</span></span>
                <button type="button" class="btn btn-sm ${isSelected ? 'btn-primary' : 'btn-outline-primary'} py-0" style="font-size:0.75rem;">
                    ${isSelected ? '✓ Rastreando' : '🎯 Seleccionar pedido'}
                </button>
            </div>
        `;

        card.addEventListener('click', () => {
            seleccionarPedido(e.id);
        });

        envioListClienteEl.appendChild(card);
    });
}

clienteIdInput.addEventListener('input', renderEnviosCliente);

envioForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const clienteId = clienteIdInput.value.trim() || 'C1';
    const vehicleId = document.getElementById('envioVehiculo')?.value || selectedClientVehicleId || null;

    if (!vehicleId) {
        const badge = document.getElementById('selectedVehicleBadge');
        if (badge) {
            badge.textContent = 'Selecciona un vehículo disponible';
        }
        return;
    }

    // El pedido ha sido confirmado: detener y limpiar el temporizador de 15 segundos
    stopVehicleSelectionTimer();

    const oCoords = originCoords || { lat: -0.2295, lng: -78.5243 };
    const pCoords = destCoords || { lat: -0.1950, lng: -78.4850 };

    socket.emit('envio:crear', {
        clienteId,
        descripcion: document.getElementById('envioDescripcion').value.trim(),
        origen: document.getElementById('envioOrigen').value.trim() || 'Quito Centro (Origen)',
        destino: document.getElementById('envioDestino').value.trim() || 'Norte de Quito (Pedido)',
        origenCoords: oCoords,
        pedidoCoords: pCoords,
        vehicleId
    });

    envioForm.reset();
    resetClientMap();
});

// =======================================================================
// Panel Chofer
// =======================================================================
const choferIdInput = document.getElementById('choferIdInput');
const choferInfoEl = document.getElementById('choferInfo');
const incidentForm = document.getElementById('incidentForm');

function renderChoferInfo() {
    const myId = choferIdInput.value;
    if (!myId || !choferes[myId]) {
        choferInfoEl.textContent = 'Selecciona tu usuario para ver tu información.';
        return;
    }
    const ch = choferes[myId];
    const rutaAsignada = Object.values(rutas).find((r) => r.choferId === myId);
    const v = ch.vehicleId ? vehicles[ch.vehicleId] : null;
    const vBadge = ch.vehicleId
        ? `<span class="badge text-white" style="background-color: ${getVehicleColor(ch.vehicleId)};">${ch.vehicleId}</span>`
        : 'sin asignar';

    let html = `<b>${ch.nombre}</b><br>Vehículo: ${vBadge}`;
    if (v) html += `<br>Velocidad actual: ${v.speed} km/h · Estado: ${v.status}`;
    if (rutaAsignada) {
        html += `<br>Ruta: ${rutaAsignada.nombre} (${rutaAsignada.origen} → ${rutaAsignada.destino})`;
    } else {
        html += '<br>Sin ruta asignada todavía.';
    }
    choferInfoEl.innerHTML = html;
}

choferIdInput.addEventListener('change', renderChoferInfo);

incidentForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const choferId = choferIdInput.value;
    const chofer = choferes[choferId];
    socket.emit('reportIncident', {
        vehicleId: chofer ? chofer.vehicleId : null,
        choferId: choferId || null,
        description: document.getElementById('incidentDesc').value.trim()
    });
    incidentForm.reset();
});

// =======================================================================
// Formularios del panel Administrador
// =======================================================================
document.getElementById('clienteForm').addEventListener('submit', (e) => {
    e.preventDefault();
    socket.emit('cliente:crear', {
        nombre: document.getElementById('clienteNombre').value.trim(),
        telefono: document.getElementById('clienteTelefono').value.trim()
    });
    e.target.reset();
});

document.getElementById('choferForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const vehicleId = document.getElementById('choferVehiculo').value || null;
    socket.emit('chofer:crear', {
        nombre: document.getElementById('choferNombre').value.trim(),
        cedula: document.getElementById('choferCedula').value.trim(),
        vehicleId
    });
    e.target.reset();
    document.getElementById('choferVehiculo').value = '';
});

document.getElementById('rutaForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const choferId = document.getElementById('rutaChofer').value || null;
    const chofer = choferId ? choferes[choferId] : null;
    socket.emit('ruta:crear', {
        nombre: document.getElementById('rutaNombre').value.trim(),
        origen: document.getElementById('rutaOrigen').value.trim(),
        destino: document.getElementById('rutaDestino').value.trim(),
        choferId,
        vehicleId: chofer ? chofer.vehicleId : null
    });
    e.target.reset();
    document.getElementById('rutaChofer').value = '';
});

// =======================================================================
// Eventos Socket.io
// =======================================================================
socket.on('connect', () => {
    statusEl.textContent = 'Conectado';
    statusEl.className = 'badge bg-success';
});

socket.on('disconnect', () => {
    statusEl.textContent = 'Desconectado';
    statusEl.className = 'badge bg-danger';
});

socket.on('init', (data) => {
    Object.assign(vehicles, data.vehicles);
    Object.assign(clientes, data.clientes || {});
    Object.assign(choferes, data.choferes || {});
    Object.assign(rutas, data.rutas || {});
    Object.assign(envios, data.envios || {});
    Object.assign(lockedVehicles, data.lockedVehicles || {});
    Object.assign(activeDynamicRoutes, data.activeDynamicRoutes || {});
    incidentCount = (data.incidents || []).length;

    Object.values(vehicles).forEach(upsertMarker);

    // Pintar rutas dinámicas activas si existen
    Object.values(activeDynamicRoutes).forEach((rData) => {
        if (map) renderDynamicRouteOnMap(rData, map, adminRouteLayers);
        if (clientMap) renderDynamicRouteOnMap(rData, clientMap, clientRouteLayers);
    });

    renderVehicleList();
    renderMetrics();
    renderClientes();
    renderChoferes();
    renderRutas();
    renderEnviosAdmin();
    renderEnviosCliente();
    renderChoferInfo();
});

socket.on('vehiculo:bloqueado', (data) => {
    lockedVehicles[data.vehicleId] = data;
    // Si otro cliente bloqueó el vehículo que yo tenía seleccionado
    if (selectedClientVehicleId === data.vehicleId && data.socketId !== socket.id) {
        stopVehicleSelectionTimer();
        selectedClientVehicleId = null;
        const hidden = document.getElementById('envioVehiculo');
        if (hidden) hidden.value = '';
        const badge = document.getElementById('selectedVehicleBadge');
        if (badge) {
            badge.style.backgroundColor = '';
            badge.className = 'badge bg-secondary';
            badge.textContent = 'Ninguno seleccionado';
        }
    }
    if (originCoords && clientMap) updateNearbyVehicles();
    renderVehicleList();
});

socket.on('vehiculo:desbloqueado', (data) => {
    delete lockedVehicles[data.vehicleId];
    if (selectedClientVehicleId === data.vehicleId) {
        stopVehicleSelectionTimer();
        selectedClientVehicleId = null;
        const hidden = document.getElementById('envioVehiculo');
        if (hidden) hidden.value = '';
        const badge = document.getElementById('selectedVehicleBadge');
        if (badge) {
            badge.style.backgroundColor = '';
            badge.className = 'badge bg-secondary';
            badge.textContent = 'Ninguno seleccionado';
        }
    }
    if (originCoords && clientMap) updateNearbyVehicles();
    renderVehicleList();
});

socket.on('vehiculo:bloqueo_rechazado', (data) => {
    if (selectedClientVehicleId === data.vehicleId) {
        stopVehicleSelectionTimer();
        selectedClientVehicleId = null;
        const hidden = document.getElementById('envioVehiculo');
        if (hidden) hidden.value = '';
        const badge = document.getElementById('selectedVehicleBadge');
        if (badge) {
            badge.style.backgroundColor = '';
            badge.className = 'badge bg-secondary';
            badge.textContent = 'Ninguno seleccionado';
        }
    }
    if (originCoords && clientMap) updateNearbyVehicles();
});

socket.on('vehiculo:tiempo_agotado', (data) => {
    stopVehicleSelectionTimer();
    if (selectedClientVehicleId === data.vehicleId) {
        selectedClientVehicleId = null;
        const hidden = document.getElementById('envioVehiculo');
        if (hidden) hidden.value = '';
        const badge = document.getElementById('selectedVehicleBadge');
        if (badge) {
            badge.style.backgroundColor = '';
            badge.className = 'badge bg-secondary';
            badge.textContent = 'Ninguno seleccionado';
        }
        if (originCoords && clientMap) updateNearbyVehicles();
    }
});

socket.on('telemetry', (v) => {
    vehicles[v.vehicleId] = v;
    upsertMarker(v);
    renderVehicleList();
    renderMetrics();
    renderChoferInfo();

    // Actualizar estado de ruta dinámica si este vehículo tiene una
    if (activeDynamicRoutes[v.vehicleId]) {
        activeDynamicRoutes[v.vehicleId].status = v.status;
        if (activeSelectedEnvioId === activeDynamicRoutes[v.vehicleId].envioId) {
            updateDynamicRouteStatusBox(activeDynamicRoutes[v.vehicleId]);
        }
    }

    if (originCoords && clientMap) {
        updateNearbyVehicles();
    }
});

socket.on('ruta:dinamica', (routeData) => {
    activeDynamicRoutes[routeData.vehicleId] = routeData;
    if (routeData.envioId) {
        activeSelectedEnvioId = routeData.envioId;
    }

    if (map) renderDynamicRouteOnMap(routeData, map, adminRouteLayers);
    if (clientMap) renderDynamicRouteOnMap(routeData, clientMap, clientRouteLayers);

    updateDynamicRouteStatusBox(routeData);
    renderEnviosCliente();
    renderEnviosAdmin();
});

socket.on('envio:actualizado', (e) => {
    envios[e.id] = e;
    renderEnviosAdmin();
    renderEnviosCliente();

    if (e.vehicleId && activeDynamicRoutes[e.vehicleId]) {
        activeDynamicRoutes[e.vehicleId].status = e.estado;
        if (activeSelectedEnvioId === e.id) {
            updateDynamicRouteStatusBox(activeDynamicRoutes[e.vehicleId]);
        }
    }
});

socket.on('alert', (alert) => pushAlert(`⚠ ${alert.message}`));

socket.on('incident', (incident) => {
    incidentCount += 1;
    renderMetrics();
    pushAlert(`📝 Incidencia (${incident.choferId || incident.vehicleId}): ${incident.description}`);
});

socket.on('cliente:creado', (c) => { clientes[c.id] = c; renderClientes(); });
socket.on('chofer:creado', (ch) => {
    choferes[ch.id] = ch;
    renderChoferes();
    renderChoferInfo();
    if (originCoords && clientMap) updateNearbyVehicles();
});
socket.on('ruta:creada', (r) => { rutas[r.id] = r; renderRutas(); renderChoferInfo(); });
socket.on('envio:creado', (e) => {
    envios[e.id] = e;
    activeSelectedEnvioId = e.id;
    renderEnviosAdmin();
    renderEnviosCliente();
});
