// Simulador de flota - Fase 1 (Primer Parcial)
// Subsistema INDEPENDIENTE que emite coordenadas GPS falsas por un
// socket UDP crudo (no usa Socket.io) hacia el gateway del backend.
//
// Ahora soporta:
// 1. MODO ESTÁTICO: los vehículos se quedan quietos en su base hasta que se les asigne una tarea.
// 2. RUTAS DINÁMICAS (vía UDP): cuando un cliente selecciona un pedido, el servidor envía
//    por UDP un comando 'assign_route' a este simulador con los waypoints:
//    [ Posición inicial del auto -> Dónde está el pedido -> Origen / Entrega ].
//    El vehículo viaja hacia el pedido, se detiene para recogerlo y luego viaja al origen.

const dgram = require('dgram');

const client = dgram.createSocket('udp4');
const TARGET_HOST = process.env.GATEWAY_HOST || 'localhost';
const TARGET_PORT = process.env.GATEWAY_PORT || 41234;
const SIMULATOR_PORT = process.env.SIMULATOR_PORT || 41235;
const TICK_MS = 2000; // Cada 2 segundos se emite telemetría

// =====================================================================
// MODO ESTÁTICO / QUIETO:
// STATIC_MODE = true: Los vehículos sin ruta dinámica permanecen quietos
// =====================================================================
const STATIC_MODE = true;
const TODOS_EN_EL_MISMO_PUNTO = false;
const PUNTO_UNICO = { lat: -0.2295, lng: -78.5243 }; // Bodega Central

// Puntos fijos (base) de cada vehículo:
const fixedPositions = {
    V001: { lat: -0.2295, lng: -78.5243 }, // Quito centro
    V002: { lat: -0.1807, lng: -78.4678 }, // Norte de Quito
    V003: { lat: -0.3000, lng: -78.4600 }, // Sangolquí
};

// Rutas estáticas de respaldo (cuando STATIC_MODE es false y no hay ruta dinámica)
const fallbackRoutes = {
    V001: [
        { lat: -0.2295, lng: -78.5243 },
        { lat: -0.2500, lng: -78.5100 },
        { lat: -0.3000, lng: -78.4600 },
    ],
    V002: [
        { lat: -0.1807, lng: -78.4678 },
        { lat: -0.2100, lng: -78.4900 },
        { lat: -0.2295, lng: -78.5243 },
    ],
    V003: [
        { lat: -0.3000, lng: -78.4600 },
        { lat: -0.2700, lng: -78.4800 },
        { lat: -0.2295, lng: -78.5243 },
    ],
};

const fallbackState = {
    V001: { segment: 0, progress: 0 },
    V002: { segment: 0, progress: 0 },
    V003: { segment: 0, progress: 0 },
};

// =====================================================================
// RUTAS DINÁMICAS ASIGNADAS POR EL CLIENTE / BACKEND
// Estructura: dynamicRoutes[vehicleId] = {
//   envioId: 'E1',
//   waypoints: [ {lat, lng, label}, ... ], // [inicio, pedido, origen]
//   currentLeg: 0 (0: hacia_pedido, 1: hacia_origen, 2: entregado),
//   progress: 0 (de 0 a 1),
//   pauseTicks: 0 (pausa simulada al recoger el pedido),
//   status: 'hacia_pedido'
// }
// =====================================================================
const dynamicRoutes = {};

function lerp(a, b, t) {
    return a + (b - a) * t;
}

// ---------------------------------------------------------------------
// CANAL DE ENTRADA UDP: Recibe comandos de asignación de ruta dinámica
// desde el servidor backend (desacoplado y 100% sobre sockets UDP).
// ---------------------------------------------------------------------
client.on('message', (msg, rinfo) => {
    try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'assign_route') {
            const { vehicleId, envioId, waypoints } = data;
            if (vehicleId && Array.isArray(waypoints) && waypoints.length >= 2) {
                dynamicRoutes[vehicleId] = {
                    envioId: envioId || null,
                    waypoints,
                    currentLeg: 0,
                    progress: 0,
                    pauseTicks: 0,
                    status: 'hacia_pedido'
                };

                console.log(`\n======================================================`);
                console.log(`[UDP in] 🚀 RUTA DINÁMICA ASIGNADA A ${vehicleId} (Envío: ${envioId || 'N/A'})`);
                console.log(`  1. Origen vehículo: lat=${waypoints[0].lat.toFixed(4)}, lng=${waypoints[0].lng.toFixed(4)}`);
                console.log(`  2. Dónde está el pedido: lat=${waypoints[1].lat.toFixed(4)}, lng=${waypoints[1].lng.toFixed(4)}`);
                if (waypoints[2]) {
                    console.log(`  3. Destino / Origen del cliente: lat=${waypoints[2].lat.toFixed(4)}, lng=${waypoints[2].lng.toFixed(4)}`);
                }
                console.log(`======================================================\n`);
            }
        } else if (data.type === 'cancel_route') {
            const { vehicleId } = data;
            if (vehicleId && dynamicRoutes[vehicleId]) {
                delete dynamicRoutes[vehicleId];
                console.log(`[UDP in] Ruta dinámica cancelada para ${vehicleId}`);
            }
        }
    } catch (err) {
        console.warn('[UDP in] Error procesando comando del backend:', err.message);
    }
});

// Vincular socket para escuchar en SIMULATOR_PORT
client.bind(SIMULATOR_PORT, () => {
    console.log(`[UDP in] Simulador de flota escuchando comandos en el puerto ${SIMULATOR_PORT}`);
});

function calculateNextVehicleState(vehicleId) {
    // Caso 1: El vehículo tiene una ruta dinámica activa
    if (dynamicRoutes[vehicleId]) {
        const r = dynamicRoutes[vehicleId];
        const wp = r.waypoints;

        // Tramo 0: Posición actual del auto -> Dónde está el pedido
        if (r.currentLeg === 0) {
            const from = wp[0];
            const to = wp[1];

            const lat = lerp(from.lat, to.lat, r.progress);
            const lng = lerp(from.lng, to.lng, r.progress);
            const speed = 40 + Math.floor(Math.random() * 15); // 40-55 km/h
            const status = 'hacia_pedido';

            r.progress += 0.08;
            if (r.progress >= 1) {
                // Llegó a donde está el pedido!
                r.progress = 0;
                r.currentLeg = 1;
                r.pauseTicks = 2; // Pausa de 2 ticks (4 seg) simulando recogida
                return {
                    lat: to.lat,
                    lng: to.lng,
                    speed: 0,
                    status: 'recogiendo_pedido',
                    envioId: r.envioId
                };
            }

            return { lat, lng, speed, status, envioId: r.envioId };
        }

        // Pausa temporal en el punto del pedido (recogiendo el paquete)
        if (r.pauseTicks > 0) {
            r.pauseTicks--;
            const point = wp[1];
            return {
                lat: point.lat,
                lng: point.lng,
                speed: 0,
                status: 'recogiendo_pedido',
                envioId: r.envioId
            };
        }

        // Tramo 1: Dónde está el pedido -> Al origen del cliente / entrega
        if (r.currentLeg === 1) {
            const from = wp[1];
            const to = wp[2] || wp[0];

            const lat = lerp(from.lat, to.lat, r.progress);
            const lng = lerp(from.lng, to.lng, r.progress);
            const speed = 42 + Math.floor(Math.random() * 12); // 42-54 km/h
            const status = 'hacia_origen';

            r.progress += 0.08;
            if (r.progress >= 1) {
                // Llegó al origen final!
                r.progress = 1;
                r.currentLeg = 2;
                fixedPositions[vehicleId] = { lat: to.lat, lng: to.lng };
                return {
                    lat: to.lat,
                    lng: to.lng,
                    speed: 0,
                    status: 'entregado',
                    envioId: r.envioId
                };
            }

            return { lat, lng, speed, status, envioId: r.envioId };
        }

        // Tramo 2: Ya completó la ruta y permanece en el origen
        const finalPoint = wp[2] || wp[1];
        fixedPositions[vehicleId] = { lat: finalPoint.lat, lng: finalPoint.lng };
        return {
            lat: finalPoint.lat,
            lng: finalPoint.lng,
            speed: 0,
            status: 'entregado',
            envioId: r.envioId
        };
    }

    // Caso 2: Sin ruta dinámica y en MODO ESTÁTICO
    if (STATIC_MODE) {
        const pos = TODOS_EN_EL_MISMO_PUNTO
            ? PUNTO_UNICO
            : (fixedPositions[vehicleId] || PUNTO_UNICO);
        return {
            lat: pos.lat,
            lng: pos.lng,
            speed: 0,
            status: 'detenido',
            envioId: null
        };
    }

    // Caso 3: Sin ruta dinámica y STATIC_MODE = false (recorrido cíclico de respaldo)
    const route = fallbackRoutes[vehicleId] || fallbackRoutes.V001;
    const s = fallbackState[vehicleId] || fallbackState.V001;
    const from = route[s.segment];
    const to = route[s.segment + 1] || route[s.segment];

    const lat = lerp(from.lat, to.lat, s.progress);
    const lng = lerp(from.lng, to.lng, s.progress);

    s.progress += 0.08;
    if (s.progress >= 1) {
        s.progress = 0;
        s.segment = (s.segment + 1) % (route.length - 1);
    }

    return {
        lat,
        lng,
        speed: 45,
        status: 'en_ruta',
        envioId: null
    };
}

function tick() {
    const vehicleIds = Object.keys(fixedPositions);

    vehicleIds.forEach((vehicleId) => {
        const state = calculateNextVehicleState(vehicleId);

        // Guardar última posición
        fixedPositions[vehicleId] = { lat: state.lat, lng: state.lng };

        const payload = {
            vehicleId,
            lat: Number(state.lat.toFixed(6)),
            lng: Number(state.lng.toFixed(6)),
            speed: state.speed,
            status: state.status,
            envioId: state.envioId,
            timestamp: Date.now(),
        };

        const message = Buffer.from(JSON.stringify(payload));
        client.send(message, TARGET_PORT, TARGET_HOST, (err) => {
            if (err) console.error(`Error enviando telemetria de ${vehicleId}:`, err);
        });

        const extraInfo = payload.envioId ? ` [Envio ${payload.envioId}]` : '';
        console.log(`[UDP out] ${vehicleId} -> lat:${payload.lat} lng:${payload.lng} speed:${payload.speed}km/h status:${payload.status}${extraInfo}`);
    });
}

console.log(`Simulador de flota emitiendo por UDP hacia ${TARGET_HOST}:${TARGET_PORT} cada ${TICK_MS}ms`);
console.log(`Modo estático (quietos en base): ${STATIC_MODE ? 'ACTIVO' : 'INACTIVO'}`);
console.log(`Vehículos registrados: ${Object.keys(fixedPositions).join(', ')}`);

setInterval(tick, TICK_MS);
