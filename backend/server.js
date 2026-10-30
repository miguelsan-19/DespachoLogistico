// Servidor del Centro de Despacho Logístico - Fase 1 (Primer Parcial)
// Combina: WebSockets (Socket.io) para el dashboard en vivo + socket UDP
// crudo para recibir la telemetría del simulador de flota y enviar comandos de ruta dinámica.
//
// Flujo:
// 1. Telemetría: Simulador (UDP -> 41234) -> Gateway UDP -> Socket.io -> Dashboard Web
// 2. Control Dinámico: Dashboard Web -> Socket.io -> Servidor (UDP -> 41235) -> Simulador

const express = require('express');
const http = require('http');
const path = require('path');
const socketIO = require('socket.io');
const dgram = require('dgram'); // Módulo nativo de Node.js para sockets UDP

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------
// Estado en memoria de los vehículos y módulos
// ---------------------------------------------------------------------
const vehicles = {
    V001: { vehicleId: 'V001', lat: -0.2295, lng: -78.5243, speed: 0, status: 'detenido', lastUpdate: Date.now() },
    V002: { vehicleId: 'V002', lat: -0.1807, lng: -78.4678, speed: 0, status: 'detenido', lastUpdate: Date.now() },
    V003: { vehicleId: 'V003', lat: -0.3000, lng: -78.4600, speed: 0, status: 'detenido', lastUpdate: Date.now() },
};

const incidents = []; // Lista de incidencias reportadas

// Datos iniciales para que el sistema esté listo para evaluar sin configuración manual previa:
const clientes = {
    'C1': { id: 'C1', nombre: 'Juan Pérez (Cliente)', telefono: '0991234567' }
};

const choferes = {
    'CH1': { id: 'CH1', nombre: 'Carlos Mendoza', cedula: '1712345678', vehicleId: 'V001' },
    'CH2': { id: 'CH2', nombre: 'María López', cedula: '1723456789', vehicleId: 'V002' },
    'CH3': { id: 'CH3', nombre: 'Pedro Gómez', cedula: '1734567890', vehicleId: 'V003' }
};

const rutas = {};          // rutaId -> { id, nombre, origen, destino, vehicleId, choferId, estado }
const envios = {};         // envioId -> { id, clienteId, descripcion, origen, destino, origenCoords, pedidoCoords, vehicleId, estado }
const lockedVehicles = {}; // vehicleId -> { vehicleId, clienteId, socketId, lockedAt }
const activeDynamicRoutes = {}; // vehicleId -> { vehicleId, envioId, waypoints, status }

let nextClienteId = 2;
let nextChoferId = 4;
let nextRutaId = 1;
let nextEnvioId = 1;

// ---------------------------------------------------------------------
// GATEWAY UDP (Lab 1: Sockets Datagrama crudos)
// ---------------------------------------------------------------------
const UDP_PORT = 41234;             // Puerto donde este backend escucha telemetría
const SIMULATOR_UDP_PORT = 41235;    // Puerto donde el simulador escucha comandos
const SIMULATOR_HOST = process.env.SIMULATOR_HOST || 'localhost';

const udpServer = dgram.createSocket('udp4');

udpServer.on('message', (msg, rinfo) => {
    let payload;
    try {
        payload = JSON.parse(msg.toString());
    } catch (err) {
        console.warn(`[UDP] Paquete inválido de ${rinfo.address}:${rinfo.port} - no es JSON`);
        return;
    }

    const { vehicleId, lat, lng, speed, timestamp, status, envioId } = payload;
    if (!vehicleId || typeof lat !== 'number' || typeof lng !== 'number') {
        console.warn('[UDP] Payload de telemetría incompleto, se descarta:', payload);
        return;
    }

    vehicles[vehicleId] = {
        vehicleId,
        lat,
        lng,
        speed: speed || 0,
        status: status || 'detenido',
        envioId: envioId || null,
        lastUpdate: timestamp || Date.now()
    };

    // Sincronizar estado en tiempo real del pedido asignado
    if (envioId && envios[envioId]) {
        if (envios[envioId].estado !== status) {
            envios[envioId].estado = status;
            io.emit('envio:actualizado', envios[envioId]);
            console.log(`[Estado Pedido] ${envioId} actualizado a: ${status}`);
        }
    }

    if (activeDynamicRoutes[vehicleId]) {
        activeDynamicRoutes[vehicleId].status = status;
    }

    // Reemitir por WebSockets a todos los dashboards conectados
    io.emit('telemetry', vehicles[vehicleId]);

    // Detección de anomalías
    if (status === 'parada_no_programada' || status === 'desconexion') {
        io.emit('alert', {
            vehicleId,
            type: status,
            message: `Vehículo ${vehicleId}: ${status.replace(/_/g, ' ')}`,
            timestamp: Date.now()
        });
    }
});

udpServer.on('error', (err) => {
    console.error('[UDP] Error en el gateway:', err);
});

udpServer.bind(UDP_PORT, () => {
    console.log(`Gateway UDP escuchando telemetría en el puerto ${UDP_PORT}`);
});

// ---------------------------------------------------------------------
// DESPACHO COORDINADOR DISTRIBUIDO: Iniciar Ruta Dinámica
// Envía un datagrama UDP crudo al simulador de flota (puerto 41235)
// ---------------------------------------------------------------------
function iniciarRutaDinamica(envioId, vehicleId) {
    const envio = envios[envioId];
    if (!envio) return;
    const vId = vehicleId || envio.vehicleId;
    if (!vId) return;

    // 1. Posición inicial del auto (donde está detenido actualmente)
    const currentPos = vehicles[vId] || { lat: -0.2295, lng: -78.5243 };

    // 2. Dónde está el pedido (punto de recogida seleccionado por el cliente)
    const pedidoCoords = envio.pedidoCoords || { lat: -0.1950, lng: -78.4850 };

    // 3. Al origen (punto de entrega / retorno al origen del cliente)
    const origenCoords = envio.origenCoords || { lat: currentPos.lat, lng: currentPos.lng };

    const waypoints = [
        { lat: Number(currentPos.lat), lng: Number(currentPos.lng), label: 'vehiculo' },
        { lat: Number(pedidoCoords.lat), lng: Number(pedidoCoords.lng), label: 'pedido' },
        { lat: Number(origenCoords.lat), lng: Number(origenCoords.lng), label: 'origen' }
    ];

    activeDynamicRoutes[vId] = {
        vehicleId: vId,
        envioId,
        waypoints,
        status: 'hacia_pedido'
    };

    envio.estado = 'hacia_pedido';
    envio.vehicleId = vId;

    // Enviar datagrama UDP al simulador de flota
    const udpPayload = {
        type: 'assign_route',
        vehicleId: vId,
        envioId,
        waypoints
    };

    const messageBuffer = Buffer.from(JSON.stringify(udpPayload));
    udpServer.send(messageBuffer, SIMULATOR_UDP_PORT, SIMULATOR_HOST, (err) => {
        if (err) {
            console.error(`[UDP out -> Simulador] Error al enviar comando de ruta para ${vId}:`, err);
        } else {
            console.log(`[UDP out -> Simulador] 🚀 Comando de ruta dinámica enviado para ${vId} (Envío ${envioId}) a ${SIMULATOR_HOST}:${SIMULATOR_UDP_PORT}`);
        }
    });

    // Notificar a todos los dashboards vía WebSockets
    io.emit('ruta:dinamica', activeDynamicRoutes[vId]);
    io.emit('envio:actualizado', envio);
}

// ---------------------------------------------------------------------
// WEBSOCKETS (Socket.io): Gestión de clientes, choferes y eventos
// ---------------------------------------------------------------------
io.on('connection', (socket) => {
    console.log(`[Socket.io] Cliente conectado: ${socket.id}`);

    // Estado inicial: snapshot de todo lo que existe hasta ahora
    socket.emit('init', {
        vehicles,
        incidents,
        clientes,
        choferes,
        rutas,
        envios,
        lockedVehicles,
        activeDynamicRoutes
    });

    // ---------------- Bloqueo / Reserva de Vehículo (Exclusión Mutua) ----------------
    socket.on('vehiculo:bloquear', (data) => {
        const { vehicleId, clienteId } = data || {};
        if (!vehicleId) return;

        // Validar que el vehículo tenga un chofer asignado
        const hasDriver = Object.values(choferes).some((ch) => ch.vehicleId === vehicleId);
        if (!hasDriver) {
            socket.emit('vehiculo:bloqueo_rechazado', {
                vehicleId,
                message: `El vehículo ${vehicleId} no puede ser seleccionado porque no tiene chofer asignado.`
            });
            return;
        }

        const currentLock = lockedVehicles[vehicleId];
        // Si ya está bloqueado por otro socket, rechazar
        if (currentLock && currentLock.socketId !== socket.id) {
            socket.emit('vehiculo:bloqueo_rechazado', {
                vehicleId,
                clienteId: currentLock.clienteId,
                message: `El vehículo ${vehicleId} ya está bloqueado por otro cliente.`
            });
            return;
        }

        // Si este socket tenía otro vehículo bloqueado previamente, liberarlo
        for (const [vId, lock] of Object.entries(lockedVehicles)) {
            if (lock.socketId === socket.id && vId !== vehicleId) {
                delete lockedVehicles[vId];
                io.emit('vehiculo:desbloqueado', { vehicleId: vId });
            }
        }

        lockedVehicles[vehicleId] = {
            vehicleId,
            clienteId: clienteId || 'cliente',
            socketId: socket.id,
            lockedAt: Date.now()
        };

        io.emit('vehiculo:bloqueado', lockedVehicles[vehicleId]);
        console.log(`[Socket.io] Vehículo ${vehicleId} bloqueado por cliente ${clienteId} (${socket.id})`);
    });

    socket.on('vehiculo:desbloquear', (data) => {
        const { vehicleId } = data || {};
        if (!vehicleId) return;

        const currentLock = lockedVehicles[vehicleId];
        if (currentLock && currentLock.socketId === socket.id) {
            delete lockedVehicles[vehicleId];
            io.emit('vehiculo:desbloqueado', { vehicleId });
            console.log(`[Socket.io] Vehículo ${vehicleId} desbloqueado/desmarcado por ${socket.id}`);
        }
    });

    // ---------------- Rol Administrador ----------------
    socket.on('cliente:crear', (data) => {
        const id = `C${nextClienteId++}`;
        clientes[id] = { id, nombre: data.nombre || 'Sin nombre', telefono: data.telefono || '' };
        io.emit('cliente:creado', clientes[id]);
    });

    socket.on('chofer:crear', (data) => {
        const id = `CH${nextChoferId++}`;
        choferes[id] = {
            id,
            nombre: data.nombre || 'Sin nombre',
            cedula: data.cedula || '',
            vehicleId: data.vehicleId || null
        };
        io.emit('chofer:creado', choferes[id]);
    });

    socket.on('ruta:crear', (data) => {
        const id = `R${nextRutaId++}`;
        rutas[id] = {
            id,
            nombre: data.nombre || `Ruta ${id}`,
            origen: data.origen || '',
            destino: data.destino || '',
            vehicleId: data.vehicleId || null,
            choferId: data.choferId || null,
            estado: 'planificada'
        };
        io.emit('ruta:creada', rutas[id]);
    });

    // ---------------- Rol Cliente & Rutas Dinámicas ----------------
    socket.on('envio:crear', (data) => {
        let assignedVehicleId = data.vehicleId || null;
        if (assignedVehicleId) {
            const hasDriver = Object.values(choferes).some((ch) => ch.vehicleId === assignedVehicleId);
            if (!hasDriver) {
                assignedVehicleId = null; // No permitir vehículo sin chofer
            }
        }

        const id = `E${nextEnvioId++}`;
        envios[id] = {
            id,
            clienteId: data.clienteId || 'desconocido',
            descripcion: data.descripcion || '',
            origen: data.origen || '',
            destino: data.destino || '',
            origenCoords: data.origenCoords || { lat: -0.2295, lng: -78.5243 },
            pedidoCoords: data.pedidoCoords || { lat: -0.1950, lng: -78.4850 },
            vehicleId: assignedVehicleId,
            estado: 'pendiente'
        };

        // Si el vehículo estaba bloqueado temporalmente por este cliente, liberarlo del mutex de UI
        if (assignedVehicleId && lockedVehicles[assignedVehicleId]) {
            delete lockedVehicles[assignedVehicleId];
            io.emit('vehiculo:desbloqueado', { vehicleId: assignedVehicleId });
        }

        io.emit('envio:creado', envios[id]);

        // Si tiene vehículo asignado, iniciar automáticamente la ruta dinámica
        if (assignedVehicleId) {
            iniciarRutaDinamica(id, assignedVehicleId);
        }
    });

    // Cuando un cliente o administrador selecciona un pedido para activar/rastrear su ruta dinámica
    socket.on('envio:seleccionar', (data) => {
        const { envioId } = data || {};
        if (!envioId || !envios[envioId]) return;

        const envio = envios[envioId];
        console.log(`[Socket.io] Pedido ${envioId} seleccionado por ${socket.id}`);

        if (envio.vehicleId) {
            iniciarRutaDinamica(envioId, envio.vehicleId);
        } else {
            // Si el pedido no tenía vehículo, asignar el primer vehículo libre con chofer
            const freeVehicle = Object.values(choferes).map(c => c.vehicleId).find(v => v && (!activeDynamicRoutes[v] || activeDynamicRoutes[v].status === 'entregado'));
            if (freeVehicle) {
                envio.vehicleId = freeVehicle;
                iniciarRutaDinamica(envioId, freeVehicle);
            }
        }
    });

    // ---------------- Rol Chofer ----------------
    socket.on('reportIncident', (data) => {
        const incident = {
            id: incidents.length + 1,
            vehicleId: data.vehicleId || 'desconocido',
            choferId: data.choferId || null,
            description: data.description || 'Sin descripcion',
            timestamp: Date.now()
        };
        incidents.push(incident);
        io.emit('incident', incident);
    });

    socket.on('disconnect', () => {
        console.log(`[Socket.io] Cliente desconectado: ${socket.id}`);
        // Liberar cualquier vehículo que este cliente haya dejado bloqueado al desconectarse
        for (const [vehicleId, lock] of Object.entries(lockedVehicles)) {
            if (lock.socketId === socket.id) {
                delete lockedVehicles[vehicleId];
                io.emit('vehiculo:desbloqueado', { vehicleId });
                console.log(`[Socket.io] Vehículo ${vehicleId} liberado por desconexión`);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor escuchando en http://localhost:${PORT}`);
    console.log(`Gateway UDP en puerto ${UDP_PORT} | Coordinando con simulador en puerto ${SIMULATOR_UDP_PORT}`);
});
