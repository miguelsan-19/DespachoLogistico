// Servidor del Centro de Despacho Logistico - Fase 1 (Primer Parcial)
// Combina: WebSockets (Socket.io) para el dashboard en vivo + socket UDP
// crudo para recibir la telemetria del simulador de flota.
//
// Flujo: simulator (UDP) -> gateway UDP de este servidor -> Socket.io -> frontend

const express = require('express');
const http = require('http');
const path = require('path');
const socketIO = require('socket.io');
const dgram = require('dgram'); // modulo nativo de Node para sockets UDP

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------
// Estado en memoria de los vehiculos (para el primer parcial no hace
// falta base de datos: basta con tener el estado actual compartido y
// que se sincronice en tiempo real entre todos los clientes conectados)
// ---------------------------------------------------------------------
const vehicles = {}; // vehicleId -> { lat, lng, speed, status, lastUpdate }
const incidents = []; // lista simple de incidencias reportadas

// ---------------------------------------------------------------------
// Modulos por rol: Administrador / Cliente / Chofer
// Todo en memoria (igual que vehicles/incidents) para esta fase. No hay
// login real: el frontend deja elegir un rol y, para Cliente/Chofer, se
// identifica con su id (sin password) solo para filtrar su propia vista.
// ---------------------------------------------------------------------
const clientes = {};  // clienteId -> { id, nombre, telefono }
const choferes = {};  // choferId -> { id, nombre, cedula, vehicleId }
const rutas = {};     // rutaId -> { id, nombre, origen, destino, vehicleId, choferId, estado }
const envios = {};    // envioId -> { id, clienteId, descripcion, origen, destino, vehicleId, estado }
const lockedVehicles = {}; // vehicleId -> { vehicleId, clienteId, socketId, lockedAt }

let nextClienteId = 1;
let nextChoferId = 1;
let nextRutaId = 1;
let nextEnvioId = 1;

// ---------------------------------------------------------------------
// GATEWAY UDP: aqui se cubre el requisito de "sockets" (Lab1) del silabo.
// El simulador de flota NO manda sus coordenadas directo por Socket.io;
// las manda por un datagrama UDP crudo a este puerto. Este gateway las
// recibe, valida y recien ahi las reemite por WebSockets al dashboard.
// ---------------------------------------------------------------------
const UDP_PORT = 41234;
const udpServer = dgram.createSocket('udp4');

udpServer.on('message', (msg, rinfo) => {
    let payload;
    try {
        payload = JSON.parse(msg.toString());
    } catch (err) {
        console.warn(`[UDP] Paquete invalido de ${rinfo.address}:${rinfo.port} - no es JSON`);
        return;
    }

    // Validacion minima de esquema antes de aceptar el dato
    const { vehicleId, lat, lng, speed, timestamp, status } = payload;
    if (!vehicleId || typeof lat !== 'number' || typeof lng !== 'number') {
        console.warn('[UDP] Payload de telemetria incompleto, se descarta:', payload);
        return;
    }

    vehicles[vehicleId] = {
        vehicleId,
        lat,
        lng,
        speed: speed || 0,
        status: status || 'en_ruta',
        lastUpdate: timestamp || Date.now()
    };

    // Reemitir por WebSockets a todos los dashboards conectados
    io.emit('telemetry', vehicles[vehicleId]);

    // Deteccion simple de anomalia (parada no programada) para mostrar
    // algo de logica de negocio ademas de solo retransmitir datos
    if (status === 'parada_no_programada' || status === 'desconexion') {
        io.emit('alert', {
            vehicleId,
            type: status,
            message: `Vehiculo ${vehicleId}: ${status.replace(/_/g, ' ')}`,
            timestamp: Date.now()
        });
    }
});

udpServer.on('error', (err) => {
    console.error('[UDP] Error en el gateway:', err);
});

udpServer.bind(UDP_PORT, () => {
    console.log(`Gateway UDP escuchando telemetria en el puerto ${UDP_PORT}`);
});

// ---------------------------------------------------------------------
// WEBSOCKETS (Socket.io): lo que ven los despachadores en el dashboard
// ---------------------------------------------------------------------
io.on('connection', (socket) => {
    console.log(`[Socket.io] Cliente conectado: ${socket.id}`);

    // Estado inicial: snapshot de todo lo que existe hasta ahora
    socket.emit('init', { vehicles, incidents, clientes, choferes, rutas, envios, lockedVehicles });

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
    // Alta de clientes, choferes y rutas; asignacion de chofer+vehiculo a ruta
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

    // ---------------- Rol Cliente ----------------
    // Crear un envio y consultar sus propios envios (filtrado en el frontend
    // por clienteId, ya que no hay login real en esta fase)
    socket.on('envio:crear', (data) => {
        let assignedVehicleId = data.vehicleId || null;
        if (assignedVehicleId) {
            const hasDriver = Object.values(choferes).some((ch) => ch.vehicleId === assignedVehicleId);
            if (!hasDriver) {
                assignedVehicleId = null; // No permitir guardar envio con vehiculo sin chofer
            }
        }

        const id = `E${nextEnvioId++}`;
        envios[id] = {
            id,
            clienteId: data.clienteId || 'desconocido',
            descripcion: data.descripcion || '',
            origen: data.origen || '',
            destino: data.destino || '',
            vehicleId: assignedVehicleId,
            estado: 'pendiente'
        };

        // Si el vehículo estaba bloqueado temporalmente por este cliente, liberarlo
        if (assignedVehicleId && lockedVehicles[assignedVehicleId]) {
            delete lockedVehicles[assignedVehicleId];
            io.emit('vehiculo:desbloqueado', { vehicleId: assignedVehicleId });
        }

        io.emit('envio:creado', envios[id]);
    });

    // ---------------- Rol Chofer ----------------
    // Reporta una incidencia asociada a su ruta/vehiculo
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
});
