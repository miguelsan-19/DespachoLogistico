// Simulador de flota - Fase 1 (Primer Parcial)
// Subsistema INDEPENDIENTE que emite coordenadas GPS falsas por un
// socket UDP crudo (no usa Socket.io) hacia el gateway del backend.
//
// Uso: node fleet-simulator.js
// (el backend debe estar corriendo y escuchando UDP en el puerto 41234)

const dgram = require('dgram');

const client = dgram.createSocket('udp4');
const TARGET_HOST = process.env.GATEWAY_HOST || 'localhost';
const TARGET_PORT = process.env.GATEWAY_PORT || 41234;
const TICK_MS = 2000; // cada cuanto se emite telemetria

// =====================================================================
// MODO ESTÁTICO / QUIETO:
// STATIC_MODE = true hace que los vehículos permanezcan quietos en un punto fijo
// (velocidad 0, sin avanzar en la ruta).
// Si quieres que vuelvan a moverse por las rutas, cambia STATIC_MODE a false.
// =====================================================================
const STATIC_MODE = true;

// Si deseas que TODOS los vehículos estén exactamente en el mismo punto central:
// cambia a true. Si es false, cada vehículo se queda en su punto asignado abajo.
const TODOS_EN_EL_MISMO_PUNTO = false;
const PUNTO_UNICO = { lat: -0.2295, lng: -78.5243 }; // Quito centro / Bodega Central

// Puntos fijos de cada vehículo cuando STATIC_MODE es true y TODOS_EN_EL_MISMO_PUNTO es false:
const fixedPositions = {
    V001: { lat: -0.2295, lng: -78.5243 }, // Quito centro
    V002: { lat: -0.1807, lng: -78.4678 }, // Norte de Quito
    V003: { lat: -0.3000, lng: -78.4600 }, // Sangolquí
};

// Rutas ficticias: cada vehiculo tiene una lista de waypoints (origen,
// hitos intermedios, destino) sobre los que se interpola su posicion.
// Coordenadas de ejemplo alrededor de Quito/Sangolqui.
const routes = {
    V001: [
        { lat: -0.2295, lng: -78.5243 }, // Quito centro
        { lat: -0.2500, lng: -78.5100 },
        { lat: -0.3000, lng: -78.4600 }, // Sangolqui
    ],
    V002: [
        { lat: -0.1807, lng: -78.4678 }, // Norte de Quito
        { lat: -0.2100, lng: -78.4900 },
        { lat: -0.2295, lng: -78.5243 },
    ],
    V003: [
        { lat: -0.3000, lng: -78.4600 }, // Sangolqui
        { lat: -0.2700, lng: -78.4800 },
        { lat: -0.2295, lng: -78.5243 }, // Quito centro
    ],
};

// Estado de progreso de cada vehiculo a lo largo de su ruta (0 a 1 por tramo)
const state = {};
Object.keys(routes).forEach((id) => {
    state[id] = { segment: 0, progress: 0, status: 'en_ruta' };
});

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function nextPosition(vehicleId) {
    if (STATIC_MODE) {
        if (TODOS_EN_EL_MISMO_PUNTO) {
            return PUNTO_UNICO;
        }
        return fixedPositions[vehicleId] || routes[vehicleId][0];
    }

    const route = routes[vehicleId];
    const s = state[vehicleId];

    const from = route[s.segment];
    const to = route[s.segment + 1] || route[s.segment];

    const lat = lerp(from.lat, to.lat, s.progress);
    const lng = lerp(from.lng, to.lng, s.progress);

    // Avanzar el progreso; al llegar al siguiente hito, pasar de tramo
    s.progress += 0.08;
    if (s.progress >= 1) {
        s.progress = 0;
        s.segment = (s.segment + 1) % (route.length - 1);
    }

    return { lat, lng };
}

function randomSpeed() {
    return Math.round(30 + Math.random() * 50); // 30-80 km/h
}

function maybeInjectAnomaly(vehicleId) {
    // Pequena probabilidad de inyectar una anomalia para que el
    // dashboard tenga algo real que mostrar como alerta
    const roll = Math.random();
    if (roll < 0.03) return 'parada_no_programada';
    if (roll < 0.05) return 'desconexion';
    return 'en_ruta';
}

function tick() {
    Object.keys(routes).forEach((vehicleId) => {
        const { lat, lng } = nextPosition(vehicleId);
        const status = STATIC_MODE ? 'detenido' : maybeInjectAnomaly(vehicleId);
        const speed = STATIC_MODE ? 0 : (status === 'en_ruta' ? randomSpeed() : 0);

        const payload = {
            vehicleId,
            lat: Number(lat.toFixed(6)),
            lng: Number(lng.toFixed(6)),
            speed,
            status,
            timestamp: Date.now(),
        };

        const message = Buffer.from(JSON.stringify(payload));
        client.send(message, TARGET_PORT, TARGET_HOST, (err) => {
            if (err) console.error(`Error enviando telemetria de ${vehicleId}:`, err);
        });

        console.log(`[UDP out] ${vehicleId} -> lat:${payload.lat} lng:${payload.lng} speed:${payload.speed} status:${payload.status}`);
    });
}

console.log(`Simulador de flota emitiendo por UDP hacia ${TARGET_HOST}:${TARGET_PORT} cada ${TICK_MS}ms`);
console.log(`Modo estático (quietos): ${STATIC_MODE ? 'ACTIVO' : 'INACTIVO'}`);
console.log(`Vehiculos simulados: ${Object.keys(routes).join(', ')}`);

setInterval(tick, TICK_MS);
