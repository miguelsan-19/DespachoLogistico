// Cliente del dashboard: WebSockets (Socket.io) en tiempo real + mapa Leaflet

const socket = io();

const statusEl = document.getElementById('connectionStatus');
const vehicleListEl = document.getElementById('vehicleList');
const alertListEl = document.getElementById('alertList');
const activeCountEl = document.getElementById('activeCount');
const avgSpeedEl = document.getElementById('avgSpeed');
const incidentCountEl = document.getElementById('incidentCount');
const incidentForm = document.getElementById('incidentForm');

// --- Mapa ---
const map = L.map('map').setView([-0.25, -78.50], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const markers = {}; // vehicleId -> L.marker
const vehicles = {}; // vehicleId -> ultimo estado conocido
let incidentCount = 0;

function upsertMarker(v) {
    if (!markers[v.vehicleId]) {
        markers[v.vehicleId] = L.marker([v.lat, v.lng]).addTo(map)
            .bindPopup(`<b>${v.vehicleId}</b>`);
    } else {
        markers[v.vehicleId].setLatLng([v.lat, v.lng]);
    }
    markers[v.vehicleId].setPopupContent(
        `<b>${v.vehicleId}</b><br>Velocidad: ${v.speed} km/h<br>Estado: ${v.status}`
    );
}

function renderVehicleList() {
    vehicleListEl.innerHTML = '';
    Object.values(vehicles).forEach((v) => {
        const li = document.createElement('li');
        li.textContent = `${v.vehicleId} · ${v.speed} km/h · ${v.status}`;
        vehicleListEl.appendChild(li);
    });
}

function renderMetrics() {
    const list = Object.values(vehicles);
    activeCountEl.textContent = list.length;
    const avg = list.length
        ? Math.round(list.reduce((sum, v) => sum + v.speed, 0) / list.length)
        : 0;
    avgSpeedEl.textContent = avg;
    incidentCountEl.textContent = incidentCount;
}

function pushAlert(text) {
    const li = document.createElement('li');
    li.textContent = text;
    alertListEl.prepend(li);
    // mantener la lista corta
    while (alertListEl.children.length > 8) {
        alertListEl.removeChild(alertListEl.lastChild);
    }
}

// --- Eventos Socket.io ---
socket.on('connect', () => {
    statusEl.textContent = 'Conectado';
    statusEl.className = 'status connected';
});

socket.on('disconnect', () => {
    statusEl.textContent = 'Desconectado';
    statusEl.className = 'status disconnected';
});

socket.on('init', (data) => {
    Object.values(data.vehicles).forEach((v) => {
        vehicles[v.vehicleId] = v;
        upsertMarker(v);
    });
    incidentCount = data.incidents.length;
    renderVehicleList();
    renderMetrics();
});

socket.on('telemetry', (v) => {
    vehicles[v.vehicleId] = v;
    upsertMarker(v);
    renderVehicleList();
    renderMetrics();
});

socket.on('alert', (alert) => {
    pushAlert(`⚠ ${alert.message}`);
});

socket.on('incident', (incident) => {
    incidentCount += 1;
    renderMetrics();
    pushAlert(`📝 Incidencia en ${incident.vehicleId}: ${incident.description}`);
});

// --- Formulario de incidencias ---
incidentForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const vehicleId = document.getElementById('incidentVehicle').value.trim();
    const description = document.getElementById('incidentDesc').value.trim();
    if (!vehicleId || !description) return;
    socket.emit('reportIncident', { vehicleId, description });
    incidentForm.reset();
});
