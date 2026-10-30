// AMO - Centro de Despacho Logístico - Fase 1 (Primer Parcial)
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
const session = require('express-session');
const dgram = require('dgram'); // Módulo nativo de Node.js para sockets UDP

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// ---------------------------------------------------------------------
// LOGIN (datos quemados, sin JWT ni base de datos: sesiones en memoria)
// ---------------------------------------------------------------------
let nextUsuarioId = 1;
const usuarios = []; // { id, username, password, rol, nombre, activo, clienteId?, choferId? }
function crearCuenta({ username, password, rol, nombre, clienteId, choferId }) {
    const cuenta = {
        id: `U${nextUsuarioId++}`,
        username,
        password,
        rol,
        nombre,
        activo: true,
        clienteId: clienteId || null,
        choferId: choferId || null
    };
    usuarios.push(cuenta);
    return cuenta;
}
function publicoUsuario(u) {
    const { password, ...resto } = u;
    return resto;
}

const sesiones = session({
    secret: process.env.SESSION_SECRET || 'clave-demostracion-academica-cambiar',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 }
});
app.use(express.json());
app.use(sesiones);
app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    const cuenta = usuarios.find(c => c.username === username && c.password === password);
    if (!cuenta) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    if (cuenta.activo === false) return res.status(403).json({ error: 'Esta cuenta está desactivada. Contacta al administrador.' });
    req.session.regenerate(err => {
        if (err) return res.status(500).json({ error: 'No se pudo iniciar sesión.' });
        req.session.usuario = publicoUsuario(cuenta);
        req.session.save(error => error ? res.status(500).json({ error: 'No se guardó la sesión.' }) : res.json({ usuario: req.session.usuario }));
    });
});
app.get('/api/me', (req, res) => {
    if (!req.session.usuario) return res.status(401).json({ error: 'Inicia sesión.' });
    res.json({ usuario: req.session.usuario });
});
app.post('/api/logout', (req, res) => {
    const sessionId = req.sessionID;
    req.session.destroy(err => {
        if (err) return res.status(500).json({ error: 'No se pudo cerrar sesión.' });
        res.clearCookie('connect.sid');
        for (const s of io.sockets.sockets.values()) {
            if (s.request.sessionID === sessionId) s.disconnect(true);
        }
        res.json({ ok: true });
    });
});
app.get('/', (req, res) => res.redirect(req.session.usuario ? '/dashboard' : '/login.html'));
app.get('/dashboard', (req, res) => {
    if (!req.session.usuario) return res.redirect('/login.html');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use((req, res, next) => {
    if (req.path === '/index.html') return res.redirect('/dashboard');
    next();
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
io.engine.use(sesiones);
io.use((socket, next) => socket.request.session?.usuario ? next() : next(new Error('Inicia sesión para conectarte.')));

// ---------------------------------------------------------------------
// Estado en memoria de los vehículos y módulos
// ---------------------------------------------------------------------
const vehicles = {}; // telemetría en vivo: vehicleId -> { lat, lng, speed, status, envioId, lastUpdate }

// Información administrable del vehículo (ficha técnica, no telemetría)
const vehiculosInfo = {}; // vehicleId -> { id, placa, marca, modelo, tipo, capacidadKg, baseLat, baseLng }
function seedVehiculo(id, datos) {
    vehiculosInfo[id] = { id, ...datos };
    vehicles[id] = { vehicleId: id, lat: datos.baseLat, lng: datos.baseLng, speed: 0, status: 'detenido', lastUpdate: Date.now() };
}
seedVehiculo('V001', { placa: 'PBA-1234', marca: 'Chevrolet', modelo: 'NHR', tipo: 'Camioneta', capacidadKg: 1200, baseLat: -0.2295, baseLng: -78.5243 });
seedVehiculo('V002', { placa: 'PCD-5678', marca: 'Hino', modelo: '300', tipo: 'Furgoneta', capacidadKg: 2500, baseLat: -0.1807, baseLng: -78.4678 });
seedVehiculo('V003', { placa: 'PEF-9012', marca: 'Kia', modelo: 'K2700', tipo: 'Camión', capacidadKg: 3000, baseLat: -0.3000, baseLng: -78.4600 });
let nextVehiculoId = 4;

const novedades = []; // Lista de novedades/incidencias reportadas por choferes

// Datos iniciales para que el sistema esté listo para evaluar sin configuración manual previa:
const clientes = {
    'C1': { id: 'C1', nombre: 'Juan Pérez (Cliente)', telefono: '0991234567', empresa: 'Distribuidora Andina S.A.' }
};

const choferes = {
    'CH1': { id: 'CH1', nombre: 'Carlos Mendoza', cedula: '1712345678', telefono: '0981111111', vehicleId: 'V001' },
    'CH2': { id: 'CH2', nombre: 'María López', cedula: '1723456789', telefono: '0982222222', vehicleId: 'V002' },
    'CH3': { id: 'CH3', nombre: 'Pedro Gómez', cedula: '1734567890', telefono: '0983333333', vehicleId: 'V003' }
};

// Cuentas de acceso "quemadas" (demo) - admin + una por cada chofer/cliente semilla
crearCuenta({ username: 'admin', password: 'admin123', rol: 'admin', nombre: 'Administrador AMO' });
crearCuenta({ username: 'juan', password: '1234', rol: 'cliente', nombre: 'Juan Pérez', clienteId: 'C1' });
crearCuenta({ username: 'carlos', password: '1234', rol: 'chofer', nombre: 'Carlos Mendoza', choferId: 'CH1' });
crearCuenta({ username: 'maria', password: '1234', rol: 'chofer', nombre: 'María López', choferId: 'CH2' });
crearCuenta({ username: 'pedro', password: '1234', rol: 'chofer', nombre: 'Pedro Gómez', choferId: 'CH3' });

const rutas = {};          // rutaId -> { id, nombre, origen, destino, vehicleId, choferId, estado }
const envios = {};         // envioId -> { id, clienteId, descripcion, origen, destino, origenCoords, pedidoCoords, vehicleId, estado }
const lockedVehicles = {}; // vehicleId -> { vehicleId, clienteId, socketId, lockedAt }
const lockTimeouts = {};   // vehicleId -> timeoutId (temporizador de 15 segundos para confirmar pedido)
const activeDynamicRoutes = {}; // vehicleId -> { vehicleId, envioId, waypoints, status }
const vehicleAssignments = {}; // Permanecen ocupados hasta que el administrador los libere.

// Estado visible de cada vehículo
const vehicleStatuses = {};

let nextClienteId = 2;
let nextChoferId = 4;
let nextRutaId = 1;
let nextEnvioId = 1;
let nextNovedadId = 1;

// ---------------------------------------------------------------------
// NOTIFICACIONES (tiempo real + historial)
// ---------------------------------------------------------------------
const notificaciones = []; // historial completo: { id, para: 'rol:admin'|'cliente:C1'|'chofer:CH1', tipo, nivel, titulo, mensaje, data, leida, timestamp }
let nextNotifId = 1;

function notificar({ para, tipo, nivel, titulo, mensaje, data }) {
    const n = {
        id: `N${nextNotifId++}`,
        para,
        tipo,
        nivel: nivel || 'info', // info | exito | advertencia | peligro
        titulo,
        mensaje,
        data: data || null,
        leida: false,
        timestamp: Date.now()
    };
    notificaciones.push(n);
    io.to(para).emit('notificacion', n);
    return n;
}

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
            if (status === 'entregado') {
                const envio = envios[envioId];
                notificar({
                    para: `cliente:${envio.clienteId}`,
                    tipo: 'envio',
                    nivel: 'exito',
                    titulo: 'Entrega completada',
                    mensaje: `Tu envío ${envioId} fue entregado con éxito.`,
                    data: { envioId }
                });
            }
            // Actualizar el estado del vehículo en tiempo real
            if (vehicleAssignments[vehicleId] === envioId) {
                actualizarEstadoVehiculo(vehicleId);
            }
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
// ---------------------------------------------------------------------
function iniciarRutaDinamica(envioId, vehicleId) {
    const envio = envios[envioId];
    if (!envio) return;
    const vId = vehicleId || envio.vehicleId;
    if (!vId) return;

    const currentPos = vehicles[vId] || { lat: -0.2295, lng: -78.5243 };
    const pedidoCoords = envio.pedidoCoords || { lat: -0.1950, lng: -78.4850 };
    const origenCoords = envio.origenCoords || { lat: currentPos.lat, lng: currentPos.lng };

    const waypoints = [
        { lat: Number(currentPos.lat), lng: Number(currentPos.lng), label: 'vehiculo' },
        { lat: Number(pedidoCoords.lat), lng: Number(pedidoCoords.lng), label: 'pedido' },
        { lat: Number(origenCoords.lat), lng: Number(origenCoords.lng), label: 'origen' }
    ];

    activeDynamicRoutes[vId] = { vehicleId: vId, envioId, waypoints, status: 'hacia_pedido' };
    envio.estado = 'hacia_pedido';
    envio.vehicleId = vId;

    const udpPayload = { type: 'assign_route', vehicleId: vId, envioId, waypoints };
    const messageBuffer = Buffer.from(JSON.stringify(udpPayload));
    udpServer.send(messageBuffer, SIMULATOR_UDP_PORT, SIMULATOR_HOST, (err) => {
        if (err) console.error(`[UDP out -> Simulador] Error al enviar comando de ruta para ${vId}:`, err);
        else console.log(`[UDP out -> Simulador] Comando de ruta dinámica enviado para ${vId} (Envío ${envioId})`);
    });

    io.emit('ruta:dinamica', activeDynamicRoutes[vId]);
    io.emit('envio:actualizado', envio);

    const chofer = Object.values(choferes).find(c => c.vehicleId === vId);
    if (chofer) {
        const cuenta = usuarios.find(u => u.choferId === chofer.id);
        if (cuenta) {
            notificar({
                para: `chofer:${chofer.id}`,
                tipo: 'envio',
                nivel: 'info',
                titulo: 'Nuevo envío asignado',
                mensaje: `Se te asignó el envío ${envioId}. Revisa la ruta en tu mapa.`,
                data: { envioId }
            });
        }
    }
}

function obtenerEstadoVehiculo(vehicleId) {
    const envioId = vehicleAssignments[vehicleId];
    if (envioId) {
        const envio = envios[envioId];
        if (envio && envio.estado === 'entregado') return { estado: 'entregado', envioId };
        return { estado: 'en_ruta', envioId };
    }
    if (lockedVehicles[vehicleId]) return { estado: 'reservado', envioId: null };
    return { estado: 'disponible', envioId: null };
}

function actualizarEstadoVehiculo(vehicleId) {
    vehicleStatuses[vehicleId] = obtenerEstadoVehiculo(vehicleId);
    io.emit('vehiculo:estado', { vehicleId, ...vehicleStatuses[vehicleId] });
}

function vehiculoEstaOcupado(vehicleId) {
    return Boolean(vehicleAssignments[vehicleId] || lockedVehicles[vehicleId]);
}

// ---------------------------------------------------------------------
// WEBSOCKETS (Socket.io): Gestión de clientes, choferes y eventos
// ---------------------------------------------------------------------
io.on('connection', (socket) => {
    const usuario = socket.request.session.usuario;
    const esRol = rol => usuario.rol === rol;
    const denegar = (msg) => socket.emit('operacion:rechazada', { message: msg || 'No tienes permisos para realizar esta acción.' });
    console.log(`[Socket.io] Cliente conectado: ${socket.id} (${usuario.username}, ${usuario.rol})`);

    socket.join(`rol:${usuario.rol}`);
    if (usuario.clienteId) socket.join(`cliente:${usuario.clienteId}`);
    if (usuario.choferId) socket.join(`chofer:${usuario.choferId}`);

    const misNotificaciones = notificaciones.filter(n =>
        n.para === `rol:${usuario.rol}` ||
        (usuario.clienteId && n.para === `cliente:${usuario.clienteId}`) ||
        (usuario.choferId && n.para === `chofer:${usuario.choferId}`)
    ).slice(-50);

    // Estado inicial: snapshot de todo lo que existe hasta ahora
    socket.emit('init', {
        vehicles,
        vehiculosInfo,
        novedades,
        clientes,
        choferes,
        rutas,
        envios,
        lockedVehicles,
        vehicleStatuses,
        activeDynamicRoutes,
        notificaciones: misNotificaciones,
        usuarios: esRol('admin') ? usuarios.map(publicoUsuario) : undefined,
        usuario
    });

    // ---------------- Notificaciones ----------------
    socket.on('notificacion:leer', (data) => {
        const n = notificaciones.find(x => x.id === data?.id);
        if (n) n.leida = true;
    });
    socket.on('notificaciones:leer_todas', () => {
        for (const n of notificaciones) {
            if (n.para === `rol:${usuario.rol}` ||
                (usuario.clienteId && n.para === `cliente:${usuario.clienteId}`) ||
                (usuario.choferId && n.para === `chofer:${usuario.choferId}`)) {
                n.leida = true;
            }
        }
    });

    // LIBERAR VEHÍCULO - SOLO ADMINISTRADOR
    socket.on('vehiculo:liberar', (data) => {
        if (!esRol('admin')) return denegar('Solo el administrador puede liberar vehículos.');
        const { vehicleId } = data || {};
        const envioId = vehicleAssignments[vehicleId];
        if (!envioId) return;
        const envio = envios[envioId];
        if (!envio || envio.estado !== 'entregado') {
            socket.emit('operacion:rechazada', { message: 'El vehículo todavía no ha terminado su recorrido.' });
            return;
        }
        delete vehicleAssignments[vehicleId];
        delete activeDynamicRoutes[vehicleId];
        const comando = Buffer.from(JSON.stringify({ type: 'cancel_route', vehicleId }));
        udpServer.send(comando, SIMULATOR_UDP_PORT, SIMULATOR_HOST);
        actualizarEstadoVehiculo(vehicleId);
        io.emit('vehiculo:liberado', { vehicleId, envioId });
        console.log(`Vehículo ${vehicleId} liberado por administrador`);
    });

    // ---------------- Bloqueo / Reserva de Vehículo (Exclusión Mutua) ----------------
    socket.on('vehiculo:bloquear', (data) => {
        if (!esRol('cliente')) return denegar();
        const { vehicleId, clienteId } = data || {};
        if (vehicleAssignments[vehicleId]) {
            socket.emit('vehiculo:bloqueo_rechazado', { vehicleId, message: `El vehículo ${vehicleId} está ocupado. Debes esperar hasta que sea liberado.` });
            return;
        }
        if (clienteId && clienteId !== usuario.clienteId) return denegar();
        if (!vehicleId) return;

        const hasDriver = Object.values(choferes).some((ch) => ch.vehicleId === vehicleId);
        if (!hasDriver) {
            socket.emit('vehiculo:bloqueo_rechazado', { vehicleId, message: `El vehículo ${vehicleId} no puede ser seleccionado porque no tiene chofer asignado.` });
            return;
        }

        const currentLock = lockedVehicles[vehicleId];
        if (currentLock && currentLock.socketId !== socket.id) {
            socket.emit('vehiculo:bloqueo_rechazado', { vehicleId, clienteId: currentLock.clienteId, message: `El vehículo ${vehicleId} ya está bloqueado por otro cliente.` });
            return;
        }

        for (const [vId, lock] of Object.entries(lockedVehicles)) {
            if (lock.socketId === socket.id && vId !== vehicleId) {
                if (lockTimeouts[vId]) { clearTimeout(lockTimeouts[vId]); delete lockTimeouts[vId]; }
                delete lockedVehicles[vId];
                io.emit('vehiculo:desbloqueado', { vehicleId: vId });
            }
        }
        if (lockTimeouts[vehicleId]) { clearTimeout(lockTimeouts[vehicleId]); delete lockTimeouts[vehicleId]; }

        const LOCK_TIMEOUT_MS = 15000;
        lockedVehicles[vehicleId] = { vehicleId, clienteId: usuario.clienteId, socketId: socket.id, lockedAt: Date.now(), expiresIn: LOCK_TIMEOUT_MS };

        lockTimeouts[vehicleId] = setTimeout(() => {
            if (lockedVehicles[vehicleId] && lockedVehicles[vehicleId].socketId === socket.id) {
                console.log(`[Temporizador 15s] Vehículo ${vehicleId} deseleccionado por no confirmar pedido a tiempo.`);
                delete lockedVehicles[vehicleId];
                delete lockTimeouts[vehicleId];
                io.emit('vehiculo:desbloqueado', { vehicleId });
                socket.emit('vehiculo:tiempo_agotado', { vehicleId, message: `Tiempo agotado (15 segundos): no confirmaste el pedido. El vehículo ${vehicleId} fue deseleccionado automáticamente.` });
            }
        }, LOCK_TIMEOUT_MS);

        io.emit('vehiculo:bloqueado', lockedVehicles[vehicleId]);
        actualizarEstadoVehiculo(vehicleId);
        console.log(`[Socket.io] Vehículo ${vehicleId} bloqueado por cliente ${clienteId} (${socket.id}) - expira en 15s`);
    });

    socket.on('vehiculo:desbloquear', (data) => {
        if (!esRol('cliente')) return denegar();
        const { vehicleId } = data || {};
        if (!vehicleId) return;
        const currentLock = lockedVehicles[vehicleId];
        if (currentLock && currentLock.socketId === socket.id) {
            if (lockTimeouts[vehicleId]) { clearTimeout(lockTimeouts[vehicleId]); delete lockTimeouts[vehicleId]; }
            delete lockedVehicles[vehicleId];
            io.emit('vehiculo:desbloqueado', { vehicleId });
            actualizarEstadoVehiculo(vehicleId);
            console.log(`[Socket.io] Vehículo ${vehicleId} desbloqueado/desmarcado por ${socket.id}`);
        }
    });

    // =================================================================
    // ROL ADMINISTRADOR - CRUD completo
    // =================================================================

    // ---- Vehículos ----
    socket.on('vehiculo:crear', (data, ack) => {
        if (!esRol('admin')) return denegar();
        const { placa, marca, modelo, tipo, capacidadKg, baseLat, baseLng } = data || {};
        if (!placa) return ack?.({ ok: false, error: 'La placa es obligatoria.' });
        if (Object.values(vehiculosInfo).some(v => v.placa.toUpperCase() === placa.toUpperCase())) {
            return ack?.({ ok: false, error: 'Ya existe un vehículo con esa placa.' });
        }
        const id = `V${String(nextVehiculoId++).padStart(3, '0')}`;
        seedVehiculo(id, {
            placa: placa.toUpperCase(),
            marca: marca || '',
            modelo: modelo || '',
            tipo: tipo || 'Camioneta',
            capacidadKg: Number(capacidadKg) || 500,
            baseLat: Number(baseLat) || -0.2295,
            baseLng: Number(baseLng) || -78.5243
        });
        vehicleStatuses[id] = obtenerEstadoVehiculo(id);
        io.emit('vehiculo:ficha_creada', vehiculosInfo[id]);
        io.emit('telemetry', vehicles[id]);
        ack?.({ ok: true, vehiculo: vehiculosInfo[id] });
    });

    socket.on('vehiculo:editar', (data, ack) => {
        if (!esRol('admin')) return denegar();
        const { id, placa, marca, modelo, tipo, capacidadKg } = data || {};
        const v = vehiculosInfo[id];
        if (!v) return ack?.({ ok: false, error: 'Vehículo no encontrado.' });
        if (placa && Object.values(vehiculosInfo).some(x => x.id !== id && x.placa.toUpperCase() === placa.toUpperCase())) {
            return ack?.({ ok: false, error: 'Ya existe otro vehículo con esa placa.' });
        }
        if (placa) v.placa = placa.toUpperCase();
        if (marca !== undefined) v.marca = marca;
        if (modelo !== undefined) v.modelo = modelo;
        if (tipo !== undefined) v.tipo = tipo;
        if (capacidadKg !== undefined) v.capacidadKg = Number(capacidadKg) || v.capacidadKg;
        io.emit('vehiculo:ficha_actualizada', v);
        ack?.({ ok: true, vehiculo: v });
    });

    socket.on('vehiculo:eliminar', (data, ack) => {
        if (!esRol('admin')) return denegar();
        const { id } = data || {};
        if (!vehiculosInfo[id]) return ack?.({ ok: false, error: 'Vehículo no encontrado.' });
        if (Object.values(choferes).some(ch => ch.vehicleId === id)) {
            return ack?.({ ok: false, error: 'No se puede eliminar: tiene un chofer asignado. Reasígnalo primero.' });
        }
        if (vehiculoEstaOcupado(id)) {
            return ack?.({ ok: false, error: 'No se puede eliminar: el vehículo está reservado o tiene un envío activo.' });
        }
        delete vehiculosInfo[id];
        delete vehicles[id];
        delete vehicleStatuses[id];
        io.emit('vehiculo:ficha_eliminada', { id });
        ack?.({ ok: true });
    });

    // ---- Clientes ----
    socket.on('cliente:crear', (data, ack) => {
        if (!esRol('admin')) return denegar();
        const { nombre, telefono, empresa, username, password } = data || {};
        if (!nombre) return ack?.({ ok: false, error: 'El nombre es obligatorio.' });
        if (username && usuarios.some(u => u.username === username)) {
            return ack?.({ ok: false, error: 'Ese usuario de acceso ya existe.' });
        }
        const id = `C${nextClienteId++}`;
        clientes[id] = { id, nombre, telefono: telefono || '', empresa: empresa || '' };
        if (username && password) crearCuenta({ username, password, rol: 'cliente', nombre, clienteId: id });
        io.emit('cliente:creado', clientes[id]);
        ack?.({ ok: true, cliente: clientes[id] });
    });

    socket.on('cliente:editar', (data, ack) => {
        if (!esRol('admin')) return denegar();
        const { id, nombre, telefono, empresa } = data || {};
        const c = clientes[id];
        if (!c) return ack?.({ ok: false, error: 'Cliente no encontrado.' });
        if (nombre !== undefined) c.nombre = nombre;
        if (telefono !== undefined) c.telefono = telefono;
        if (empresa !== undefined) c.empresa = empresa;
        const cuenta = usuarios.find(u => u.clienteId === id);
        if (cuenta && nombre) cuenta.nombre = nombre;
        io.emit('cliente:actualizado', c);
        ack?.({ ok: true, cliente: c });
    });

    socket.on('cliente:eliminar', (data, ack) => {
        if (!esRol('admin')) return denegar();
        const { id } = data || {};
        if (!clientes[id]) return ack?.({ ok: false, error: 'Cliente no encontrado.' });
        const tieneEnviosActivos = Object.values(envios).some(e => e.clienteId === id && !['entregado', 'cancelado'].includes(e.estado));
        if (tieneEnviosActivos) return ack?.({ ok: false, error: 'No se puede eliminar: tiene envíos activos.' });
        delete clientes[id];
        const idx = usuarios.findIndex(u => u.clienteId === id);
        if (idx >= 0) usuarios.splice(idx, 1);
        io.emit('cliente:eliminado', { id });
        ack?.({ ok: true });
    });

    // ---- Choferes ----
    socket.on('chofer:crear', (data, ack) => {
        if (!esRol('admin')) return denegar();
        const { nombre, cedula, telefono, vehicleId, username, password } = data || {};
        if (!nombre) return ack?.({ ok: false, error: 'El nombre es obligatorio.' });
        if (vehicleId && Object.values(choferes).some(ch => ch.vehicleId === vehicleId)) {
            return ack?.({ ok: false, error: 'Ese vehículo ya tiene un chofer asignado.' });
        }
        if (username && usuarios.some(u => u.username === username)) {
            return ack?.({ ok: false, error: 'Ese usuario de acceso ya existe.' });
        }
        const id = `CH${nextChoferId++}`;
        choferes[id] = { id, nombre, cedula: cedula || '', telefono: telefono || '', vehicleId: vehicleId || null };
        if (username && password) crearCuenta({ username, password, rol: 'chofer', nombre, choferId: id });
        io.emit('chofer:creado', choferes[id]);
        ack?.({ ok: true, chofer: choferes[id] });
    });

    socket.on('chofer:editar', (data, ack) => {
        if (!esRol('admin')) return denegar();
        const { id, nombre, cedula, telefono, vehicleId } = data || {};
        const ch = choferes[id];
        if (!ch) return ack?.({ ok: false, error: 'Chofer no encontrado.' });
        if (vehicleId && vehicleId !== ch.vehicleId && Object.values(choferes).some(x => x.id !== id && x.vehicleId === vehicleId)) {
            return ack?.({ ok: false, error: 'Ese vehículo ya tiene otro chofer asignado.' });
        }
        if (nombre !== undefined) ch.nombre = nombre;
        if (cedula !== undefined) ch.cedula = cedula;
        if (telefono !== undefined) ch.telefono = telefono;
        if (vehicleId !== undefined) ch.vehicleId = vehicleId || null;
        const cuenta = usuarios.find(u => u.choferId === id);
        if (cuenta && nombre) cuenta.nombre = nombre;
        io.emit('chofer:actualizado', ch);
        ack?.({ ok: true, chofer: ch });
    });

    socket.on('chofer:eliminar', (data, ack) => {
        if (!esRol('admin')) return denegar();
        const { id } = data || {};
        const ch = choferes[id];
        if (!ch) return ack?.({ ok: false, error: 'Chofer no encontrado.' });
        if (ch.vehicleId && vehiculoEstaOcupado(ch.vehicleId)) {
            return ack?.({ ok: false, error: 'No se puede eliminar: su vehículo tiene un envío activo o está reservado.' });
        }
        delete choferes[id];
        const idx = usuarios.findIndex(u => u.choferId === id);
        if (idx >= 0) usuarios.splice(idx, 1);
        io.emit('chofer:eliminado', { id });
        ack?.({ ok: true });
    });

    // ---- Rutas planificadas ----
    socket.on('ruta:crear', (data, ack) => {
        if (!esRol('admin')) return denegar();
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
        ack?.({ ok: true, ruta: rutas[id] });
    });

    // ---- Incidencias / novedades: gestión del admin ----
    socket.on('incidencia:responder', (data, ack) => {
        if (!esRol('admin')) return denegar();
        const { id, estado, respuesta } = data || {};
        const nov = novedades.find(n => n.id === id);
        if (!nov) return ack?.({ ok: false, error: 'Novedad no encontrada.' });
        nov.estado = estado || 'resuelta';
        nov.respuesta = respuesta || '';
        nov.respondidaEn = Date.now();
        io.emit('novedad:actualizada', nov);
        notificar({
            para: `chofer:${nov.choferId}`,
            tipo: 'novedad',
            nivel: nov.estado === 'resuelta' ? 'exito' : 'info',
            titulo: nov.estado === 'resuelta' ? 'Tu novedad fue resuelta' : 'El centro respondió tu novedad',
            mensaje: respuesta || 'Revisa el detalle en tu historial de novedades.',
            data: { novedadId: id }
        });
        ack?.({ ok: true, novedad: nov });
    });

    // =================================================================
    // ROL CLIENTE & Rutas dinámicas
    // =================================================================
    socket.on('envio:crear', (data, ack) => {
        if (!esRol('cliente')) return denegar();
        if (data?.clienteId && data.clienteId !== usuario.clienteId) return denegar();
        let assignedVehicleId = data.vehicleId || null;
        if (assignedVehicleId) {
            const lock = lockedVehicles[assignedVehicleId];
            if (!lock || lock.socketId !== socket.id) {
                const msg = 'Debes seleccionar y bloquear el vehículo antes de confirmar.';
                socket.emit('operacion:rechazada', { message: msg });
                return ack?.({ ok: false, error: msg });
            }
            if (Object.values(envios).some(e => e.vehicleId === assignedVehicleId && !['entregado', 'cancelado'].includes(e.estado))) {
                const msg = 'El vehículo ya tiene un envío activo.';
                socket.emit('operacion:rechazada', { message: msg });
                return ack?.({ ok: false, error: msg });
            }
            const hasDriver = Object.values(choferes).some((ch) => ch.vehicleId === assignedVehicleId);
            if (!hasDriver) assignedVehicleId = null;
        }

        const id = `E${nextEnvioId++}`;
        envios[id] = {
            id,
            clienteId: usuario.clienteId,
            descripcion: data.descripcion || '',
            pesoKg: Number(data.pesoKg) || null,
            origen: data.origen || '',
            destino: data.destino || '',
            origenCoords: data.origenCoords || { lat: -0.2295, lng: -78.5243 },
            pedidoCoords: data.pedidoCoords || { lat: -0.1950, lng: -78.4850 },
            vehicleId: assignedVehicleId,
            estado: 'pendiente',
            creadoEn: Date.now()
        };

        if (assignedVehicleId) {
            if (lockTimeouts[assignedVehicleId]) { clearTimeout(lockTimeouts[assignedVehicleId]); delete lockTimeouts[assignedVehicleId]; }
            if (lockedVehicles[assignedVehicleId]) { delete lockedVehicles[assignedVehicleId]; io.emit('vehiculo:desbloqueado', { vehicleId: assignedVehicleId }); }
            if (vehicleAssignments[assignedVehicleId]) {
                const msg = 'Este vehículo ya tiene un envío asignado.';
                socket.emit('operacion:rechazada', { message: msg });
                delete envios[id];
                return ack?.({ ok: false, error: msg });
            }
            vehicleAssignments[assignedVehicleId] = id;
        }

        io.emit('envio:creado', envios[id]);
        if (assignedVehicleId) {
            actualizarEstadoVehiculo(assignedVehicleId);
            iniciarRutaDinamica(id, assignedVehicleId);
        }
        notificar({
            para: 'rol:admin',
            tipo: 'envio',
            nivel: 'info',
            titulo: 'Nuevo envío solicitado',
            mensaje: `${clientes[usuario.clienteId]?.nombre || 'Un cliente'} solicitó el envío ${id}.`,
            data: { envioId: id }
        });
        ack?.({ ok: true, envio: envios[id] });
    });

    socket.on('envio:seleccionar', (data) => {
        if (!esRol('admin') && !esRol('cliente')) return denegar();
        const { envioId } = data || {};
        if (!envioId || !envios[envioId]) return;
        const envio = envios[envioId];
        if (esRol('cliente') && envio.clienteId !== usuario.clienteId) return denegar();
        console.log(`[Socket.io] Pedido ${envioId} seleccionado por ${socket.id}`);
        if (envio.vehicleId) {
            iniciarRutaDinamica(envioId, envio.vehicleId);
        } else {
            const freeVehicle = Object.values(choferes).map(c => c.vehicleId).find(v => v && (!activeDynamicRoutes[v] || activeDynamicRoutes[v].status === 'entregado'));
            if (freeVehicle) {
                envio.vehicleId = freeVehicle;
                iniciarRutaDinamica(envioId, freeVehicle);
            }
        }
    });

    // =================================================================
    // ROL CHOFER - Reportar novedad
    // =================================================================
    const TIPOS_NOVEDAD = ['accidente', 'falla_mecanica', 'trafico', 'retraso', 'paquete', 'cliente_ausente', 'otro'];
    const AFECTAN_ENTREGA = ['accidente', 'falla_mecanica', 'trafico', 'retraso'];
    socket.on('novedad:reportar', (data, ack) => {
        if (!esRol('chofer')) return denegar();
        const { tipo, prioridad, descripcion } = data || {};
        if (!TIPOS_NOVEDAD.includes(tipo)) return ack?.({ ok: false, error: 'Tipo de novedad inválido.' });
        if (!descripcion || !descripcion.trim()) return ack?.({ ok: false, error: 'Describe brevemente lo ocurrido.' });

        const chofer = choferes[usuario.choferId];
        const vehicleId = chofer?.vehicleId || null;
        const envioId = vehicleId ? vehicleAssignments[vehicleId] || null : null;
        const ubicacion = vehicleId && vehicles[vehicleId] ? { lat: vehicles[vehicleId].lat, lng: vehicles[vehicleId].lng } : null;

        const nov = {
            id: `NV${nextNovedadId++}`,
            choferId: usuario.choferId,
            choferNombre: chofer?.nombre || usuario.nombre,
            vehicleId,
            envioId,
            tipo,
            prioridad: ['baja', 'media', 'alta', 'critica'].includes(prioridad) ? prioridad : 'media',
            descripcion: descripcion.trim(),
            ubicacion,
            estado: 'abierta',
            respuesta: null,
            timestamp: Date.now()
        };
        novedades.push(nov);
        io.emit('novedad:nueva', nov);

        const nivelMap = { baja: 'info', media: 'info', alta: 'advertencia', critica: 'peligro' };
        notificar({
            para: 'rol:admin',
            tipo: 'novedad',
            nivel: nivelMap[nov.prioridad] || 'info',
            titulo: `Novedad reportada por ${nov.choferNombre}`,
            mensaje: nov.descripcion,
            data: { novedadId: nov.id, vehicleId, prioridad: nov.prioridad }
        });

        if (envioId && AFECTAN_ENTREGA.includes(tipo)) {
            const envio = envios[envioId];
            if (envio) {
                notificar({
                    para: `cliente:${envio.clienteId}`,
                    tipo: 'novedad',
                    nivel: 'advertencia',
                    titulo: 'Novedad en tu envío',
                    mensaje: `Tu envío ${envioId} presentó un inconveniente: ${nov.descripcion}`,
                    data: { envioId, novedadId: nov.id }
                });
            }
        }
        ack?.({ ok: true, novedad: nov });
    });

    socket.on('disconnect', () => {
        console.log(`[Socket.io] Cliente desconectado: ${socket.id}`);
        for (const [vehicleId, lock] of Object.entries(lockedVehicles)) {
            if (lock.socketId === socket.id) {
                if (lockTimeouts[vehicleId]) { clearTimeout(lockTimeouts[vehicleId]); delete lockTimeouts[vehicleId]; }
                delete lockedVehicles[vehicleId];
                io.emit('vehiculo:desbloqueado', { vehicleId });
                console.log(`[Socket.io] Vehículo ${vehicleId} liberado por desconexión`);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`AMO - Servidor escuchando en http://localhost:${PORT}`);
    console.log(`Gateway UDP en puerto ${UDP_PORT} | Coordinando con simulador en puerto ${SIMULATOR_UDP_PORT}`);
});
