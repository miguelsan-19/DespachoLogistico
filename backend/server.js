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

    // Estado inicial: snapshot de todos los vehiculos conocidos
    socket.emit('init', { vehicles, incidents });

    // Un despachador/conductor reporta una incidencia (sin auth todavia,
    // eso se agrega en la Fase 2 junto con JWT)
    socket.on('reportIncident', (data) => {
        const incident = {
            id: incidents.length + 1,
            vehicleId: data.vehicleId || 'desconocido',
            description: data.description || 'Sin descripcion',
            timestamp: Date.now()
        };
        incidents.push(incident);
        io.emit('incident', incident);
    });

    socket.on('disconnect', () => {
        console.log(`[Socket.io] Cliente desconectado: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
