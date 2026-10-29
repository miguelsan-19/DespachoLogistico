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
    if (status === 'en_ruta') return '<span class="badge bg-success">en ruta</span>';
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
        li.className = 'list-group-item px-0';
        li.innerHTML = `<b>${e.id}</b> · cliente ${e.clienteId} · ${e.origen} → ${e.destino}${vBadge} · <span class="badge bg-secondary">${e.estado}</span>`;
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
const btnClientGps = document.getElementById('btnClientGps');

let clientMap = null;
let originMarker = null;
let destMarker = null;
let originZoneCircle = null;
let originCoords = null;
const clientVehicleMarkers = {};
let selectedClientVehicleId = null;

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

// Icono personalizado para el Origen (🟢 Verde)
const originPinIcon = L.divIcon({
    className: 'custom-map-pin',
    html: `
        <div style="filter: drop-shadow(0 3px 5px rgba(0,0,0,0.4));">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 46" width="36" height="46">
                <path d="M18 0C8.06 0 0 8.06 0 18c0 13.5 18 28 18 28s18-14.5 18-28c0-9.94-8.06-18-18-18z" fill="#198754" stroke="#ffffff" stroke-width="2"/>
                <circle cx="18" cy="17" r="10" fill="#ffffff"/>
                <text x="18" y="17" font-size="11" font-weight="800" fill="#198754" text-anchor="middle" dominant-baseline="central">A</text>
            </svg>
        </div>
    `,
    iconSize: [36, 46],
    iconAnchor: [18, 46],
    popupAnchor: [0, -44]
});

// Icono personalizado para el Destino (🔴 Rojo)
const destPinIcon = L.divIcon({
    className: 'custom-map-pin',
    html: `
        <div style="filter: drop-shadow(0 3px 5px rgba(0,0,0,0.4));">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 46" width="36" height="46">
                <path d="M18 0C8.06 0 0 8.06 0 18c0 13.5 18 28 18 28s18-14.5 18-28c0-9.94-8.06-18-18-18z" fill="#dc3545" stroke="#ffffff" stroke-width="2"/>
                <circle cx="18" cy="17" r="10" fill="#ffffff"/>
                <text x="18" y="17" font-size="11" font-weight="800" fill="#dc3545" text-anchor="middle" dominant-baseline="central">B</text>
            </svg>
        </div>
    `,
    iconSize: [36, 46],
    iconAnchor: [18, 46],
    popupAnchor: [0, -44]
});

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

    if (btnClientGps) {
        btnClientGps.addEventListener('click', () => {
            if (!navigator.geolocation) {
                alert('La geolocalización no está soportada en tu navegador.');
                return;
            }
            btnClientGps.textContent = 'Buscando...';
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    btnClientGps.textContent = '🎯 Mi GPS';
                    const { latitude, longitude } = pos.coords;
                    clientMap.setView([latitude, longitude], 14);
                    handleClientMapClick(latitude, longitude);
                },
                (err) => {
                    btnClientGps.textContent = '🎯 Mi GPS';
                    alert('No se pudo obtener tu ubicación actual: ' + err.message);
                },
                { timeout: 8000 }
            );
        });
    }
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
    const targetType = document.querySelector('input[name="mapTarget"]:checked')?.value || 'origen';

    if (targetType === 'origen') {
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
        originMarker.bindPopup('<b>🟢 Origen (Punto de recogida)</b><br>Buscando vehículos cercanos...').openPopup();

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

    } else {
        // Destino
        if (!destMarker) {
            destMarker = L.marker([lat, lng], { icon: destPinIcon, draggable: true }).addTo(clientMap);
            destMarker.on('dragend', (ev) => {
                const pos = ev.target.getLatLng();
                updateAddressFromCoords(pos.lat, pos.lng, 'envioDestino');
            });
        } else {
            destMarker.setLatLng([lat, lng]);
        }
        destMarker.bindPopup('<b>🔴 Destino (Punto de entrega)</b>').openPopup();

        if (clientCoordsLabel) {
            clientCoordsLabel.textContent = `Destino: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
        }

        updateAddressFromCoords(lat, lng, 'envioDestino');
    }
}

// Actualizar vehículos cercanos y mostrarlos en el mini mapa
function updateNearbyVehicles() {
    if (!originCoords || !clientMap) return;

    const vehicleList = Object.values(vehicles).map((v) => {
        const dist = calculateDistanceKm(originCoords.lat, originCoords.lng, v.lat, v.lng);
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
                if (!getDriverForVehicle(v.vehicleId)) {
                    alert(`⚠ El vehículo ${v.vehicleId} no puede ser seleccionado porque no tiene chofer asignado.`);
                    return;
                }
                toggleVehicleSelection(v.vehicleId);
            });
        } else {
            clientVehicleMarkers[v.vehicleId].setLatLng([v.lat, v.lng]);
        }

        let popupBtnHtml = '';
        let popupLockBadge = '';
        if (!hasDriver) {
            popupLockBadge = '<span class="badge bg-secondary ms-auto" style="font-size:0.7rem;">⚠️ Sin chofer</span>';
            popupBtnHtml = `
                <div class="small text-muted mt-1">No disponible (sin chofer asignado)</div>
                <button type="button" class="btn btn-sm btn-secondary mt-2 w-100 py-0" style="font-size:0.75rem;" disabled>
                    Sin chofer asignado
                </button>
            `;
        } else if (isLockedByOther) {
            popupLockBadge = '<span class="badge bg-danger ms-auto" style="font-size:0.7rem;">🔒 Bloqueado</span>';
            popupBtnHtml = `
                <div class="small text-danger mt-1">Ocupado por otro cliente</div>
                <button type="button" class="btn btn-sm btn-secondary mt-2 w-100 py-0" style="font-size:0.75rem;" disabled>
                    No disponible
                </button>
            `;
        } else if (isLockedByMe || selectedClientVehicleId === v.vehicleId) {
            popupLockBadge = '<span class="badge bg-success ms-auto" style="font-size:0.7rem;">✓ Reservado por ti</span>';
            popupBtnHtml = `
                <button type="button" class="btn btn-sm btn-outline-danger mt-2 w-100 py-0" style="font-size:0.75rem;" onclick="toggleVehicleSelection('${v.vehicleId}')">
                    Desmarcar vehículo
                </button>
            `;
        } else {
            popupBtnHtml = `
                <button type="button" class="btn btn-sm btn-primary mt-2 w-100 py-0" style="font-size:0.75rem;" onclick="toggleVehicleSelection('${v.vehicleId}')">
                    Bloquear y seleccionar
                </button>
            `;
        }

        clientVehicleMarkers[v.vehicleId].bindPopup(`
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
        `);
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
            lockBadge = '<span class="badge bg-primary" style="font-size: 0.7rem;">✓ Reservado</span>';
            statusText = '<div class="text-success small fw-bold mt-1" style="font-size:0.72rem;">✓ Bloqueado por ti (clic para desmarcar)</div>';
        } else {
            lockBadge = `<span class="badge ${v.distance <= 12 ? 'bg-success' : 'bg-secondary'}" style="font-size: 0.72rem;">${v.distance} km</span>`;
            statusText = '<div class="text-muted small mt-1" style="font-size:0.72rem;">Clic para bloquear y seleccionar</div>';
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
            if (!hasDriver) {
                alert(`⚠ El vehículo ${v.vehicleId} no puede ser seleccionado porque aún no tiene un chofer asignado.`);
                return;
            }
            toggleVehicleSelection(v.vehicleId);
        });

        container.appendChild(card);
    });
}

// Bloquear / desmarcar un vehículo en tiempo real vía WebSockets
window.toggleVehicleSelection = function(vehicleId) {
    const driver = getDriverForVehicle(vehicleId);
    if (!driver) {
        alert(`⚠ El vehículo ${vehicleId} no puede ser seleccionado porque no tiene un chofer asignado.`);
        return;
    }

    const lock = lockedVehicles[vehicleId];
    const isLockedByOther = lock && lock.socketId !== socket.id;

    if (isLockedByOther) {
        alert(`⚠ El vehículo ${vehicleId} ya está bloqueado por otro cliente en tiempo real.`);
        return;
    }

    // Si ya lo tiene seleccionado: DESMARCAR y DESBLOQUEAR
    if (selectedClientVehicleId === vehicleId) {
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
        socket.emit('vehiculo:desbloquear', { vehicleId: selectedClientVehicleId });
    }

    // Bloquear y seleccionar el nuevo vehículo
    selectedClientVehicleId = vehicleId;
    const clienteId = clienteIdInput.value.trim() || 'cliente';
    socket.emit('vehiculo:bloquear', { vehicleId, clienteId });

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

    if (clientVehicleMarkers[vehicleId]) {
        clientVehicleMarkers[vehicleId].openPopup();
    }
};

window.selectNearbyVehicle = window.toggleVehicleSelection;

function resetClientMap() {
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

    // Regresar radio a origen
    const radioOrigen = document.getElementById('targetOrigen');
    if (radioOrigen) radioOrigen.checked = true;
}

function renderEnviosCliente() {
    const myId = clienteIdInput.value.trim();
    envioListClienteEl.innerHTML = '';
    Object.values(envios)
        .filter((e) => e.clienteId === myId)
        .forEach((e) => {
            const vBadge = e.vehicleId
                ? ` · <span class="badge text-white" style="background-color: ${getVehicleColor(e.vehicleId)};">${e.vehicleId}</span>`
                : '';
            const li = document.createElement('li');
            li.className = 'list-group-item';
            li.innerHTML = `${e.descripcion} · ${e.origen} → ${e.destino}${vBadge} · <span class="badge bg-secondary">${e.estado}</span>`;
            envioListClienteEl.appendChild(li);
        });
}

clienteIdInput.addEventListener('input', renderEnviosCliente);

envioForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const clienteId = clienteIdInput.value.trim();
    if (!clienteId) {
        alert('Primero escribe tu ID de cliente (te lo da el administrador).');
        return;
    }
    const vehicleId = document.getElementById('envioVehiculo')?.value || selectedClientVehicleId || null;
    socket.emit('envio:crear', {
        clienteId,
        descripcion: document.getElementById('envioDescripcion').value.trim(),
        origen: document.getElementById('envioOrigen').value.trim(),
        destino: document.getElementById('envioDestino').value.trim(),
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
    incidentCount = (data.incidents || []).length;

    Object.values(vehicles).forEach(upsertMarker);
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
    if (originCoords && clientMap) updateNearbyVehicles();
    renderVehicleList();
});

socket.on('vehiculo:bloqueo_rechazado', (data) => {
    alert(`⚠ ${data.message || 'El vehículo está bloqueado por otro cliente.'}`);
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
    }
    if (originCoords && clientMap) updateNearbyVehicles();
});

socket.on('telemetry', (v) => {
    vehicles[v.vehicleId] = v;
    upsertMarker(v);
    renderVehicleList();
    renderMetrics();
    renderChoferInfo();
    if (originCoords && clientMap) {
        updateNearbyVehicles();
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
socket.on('envio:creado', (e) => { envios[e.id] = e; renderEnviosAdmin(); renderEnviosCliente(); });
