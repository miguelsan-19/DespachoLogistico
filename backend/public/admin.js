// =====================================================================
// AMO - admin.js
// Panel de administración: monitoreo en vivo, CRUD de vehículos,
// choferes, clientes, rutas, envíos y gestión de novedades.
// (Parte: Alexis)
// =====================================================================
(function () {
    let map, markers = {}, dynLayers = {};

    function esAdmin() { return AMO.state.usuario && AMO.state.usuario.rol === 'admin'; }

    // ---------------- Mapa de monitoreo ----------------
    function iniciarMapa() {
        if (map || !document.getElementById('map')) return;
        map = L.map('map').setView([-0.22, -78.52], 12);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap' }).addTo(map);
    }

    function pintarMarcador(v) {
        if (!map) return;
        if (!markers[v.vehicleId]) {
            markers[v.vehicleId] = L.marker([v.lat, v.lng], { icon: AMO.iconoVehiculo(v.vehicleId) }).addTo(map);
        } else {
            markers[v.vehicleId].setLatLng([v.lat, v.lng]);
        }
        const ficha = AMO.state.vehiculosInfo[v.vehicleId];
        markers[v.vehicleId].bindPopup(`<b>${AMO.esc(v.vehicleId)}</b>${ficha ? ' · ' + AMO.esc(ficha.placa) : ''}<br>Velocidad: ${(v.speed || 0).toFixed(0)} km/h<br>Estado: ${AMO.esc(v.status)}`);
    }

    function pintarTodosLosVehiculos() {
        Object.values(AMO.state.vehicles).forEach(pintarMarcador);
    }

    // ---------------- KPIs + listas de monitoreo ----------------
    function renderMonitoreo() {
        const vs = Object.values(AMO.state.vehicles);
        document.getElementById('kpiUnidades').textContent = vs.length;
        const prom = vs.length ? (vs.reduce((a, v) => a + (v.speed || 0), 0) / vs.length) : 0;
        document.getElementById('kpiVelocidad').textContent = prom.toFixed(0);
        document.getElementById('kpiNovedades').textContent = AMO.state.novedades.filter(n => n.estado === 'abierta').length;
        document.getElementById('kpiEnvios').textContent = Object.values(AMO.state.envios).filter(e => !['entregado', 'cancelado'].includes(e.estado)).length;

        const lista = document.getElementById('vehicleList');
        if (!vs.length) { lista.innerHTML = '<div class="amo-empty">Sin unidades registradas</div>'; return; }
        lista.innerHTML = vs.map(v => {
            const ficha = AMO.state.vehiculosInfo[v.vehicleId] || {};
            const estadoReserva = AMO.state.vehicleStatuses[v.vehicleId]?.estado || (AMO.state.lockedVehicles[v.vehicleId] ? 'reservado' : 'disponible');
            const reservado = estadoReserva === 'reservado';
            const estadoVisible = reservado ? 'Reservado' : estadoReserva === 'en_ruta' ? 'En ruta' : estadoReserva === 'disponible' ? 'Disponible' : estadoReserva.replace(/_/g, ' ');
            const claseEstado = { disponible: 'b-green', reservado: 'b-amber', en_ruta: 'b-blue', entregado: 'b-slate' }[estadoReserva] || 'b-slate';
            const clienteReserva = AMO.state.clientes[AMO.state.lockedVehicles[v.vehicleId]?.clienteId]?.nombre;
            const detalle = reservado ? `Reservado${clienteReserva ? ' por ' + clienteReserva : ''}` : estadoVisible;
            return `<div class="d-flex align-items-center gap-2 px-3 py-2 border-bottom" style="font-size:.82rem">
                <span style="width:10px;height:10px;border-radius:50%;background:${AMO.colorVehiculo(v.vehicleId)};flex-shrink:0"></span>
                <div class="flex-grow-1"><b>${AMO.esc(v.vehicleId)}</b> ${ficha.placa ? '· ' + AMO.esc(ficha.placa) : ''}<div class="text-muted" style="font-size:.72rem">${(v.speed || 0).toFixed(0)} km/h</div></div>
                <span class="amo-badge ${claseEstado}" title="${AMO.esc(detalle)}">${AMO.esc(estadoVisible)}</span>
            </div>`;
        }).join('');
    }

    function pushAlert(text) {
        const list = document.getElementById('alertList');
        const item = document.createElement('div');
        item.className = 'px-3 py-2 border-bottom small';
        item.innerHTML = `<i class="bi bi-exclamation-triangle text-warning me-1"></i>${AMO.esc(text)} <span class="text-muted" style="font-size:.7rem">${new Date().toLocaleTimeString('es-EC')}</span>`;
        list.prepend(item);
        while (list.children.length > 15) list.removeChild(list.lastChild);
    }

    // ---------------- Vehículos ----------------
    function renderVehiculos() {
        const tbody = document.getElementById('tablaVehiculos');
        const items = Object.values(AMO.state.vehiculosInfo);
        if (!items.length) { tbody.innerHTML = '<tr><td colspan="6" class="amo-empty">Sin vehículos registrados</td></tr>'; return; }
        tbody.innerHTML = items.map(v => {
            const estado = (AMO.state.vehicleStatuses[v.id] || {}).estado || (AMO.state.lockedVehicles[v.id] ? 'reservado' : 'disponible');
            const badge = { disponible: 'b-green', reservado: 'b-amber', en_ruta: 'b-blue', entregado: 'b-slate' }[estado] || 'b-slate';
const puedeLiberar = estado === 'entregado';
            const clienteReserva = AMO.state.clientes[AMO.state.lockedVehicles[v.id]?.clienteId]?.nombre;
            const detalle = estado === 'reservado' ? `Reservado${clienteReserva ? ' por ' + clienteReserva : ''}` : estado.replace(/_/g, ' ');
            return `<tr>
                <td><b>${AMO.esc(v.placa)}</b></td><td>${AMO.esc(v.marca)} ${AMO.esc(v.modelo)}</td><td>${AMO.esc(v.tipo)}</td><td>${v.capacidadKg} kg</td>
                <td><span class="amo-badge ${badge}" title="${AMO.esc(detalle)}">${AMO.esc(detalle)}</span></td>
                <td class="text-end">
                   ${puedeLiberar ? `
    <button
        type="button"
        class="btn btn-sm btn-success me-1"
        data-liberar-vehiculo="${v.id}"
        title="Liberar vehículo entregado">

        <i class="bi bi-unlock me-1"></i>
        Liberar
    </button>
` : ''}  </td>
            </tr>`;
        }).join('');
        tbody.querySelectorAll('[data-editar-vehiculo]').forEach(b => b.addEventListener('click', () => abrirFormVehiculo(b.dataset.editarVehiculo)));
        tbody.querySelectorAll('[data-eliminar-vehiculo]').forEach(b => b.addEventListener('click', async () => {
            if (!AMO.confirmar('¿Eliminar este vehículo?')) return;
            try { await AMO.call('vehiculo:eliminar', { id: b.dataset.eliminarVehiculo }); AMO.toast({ titulo: 'Vehículo eliminado', mensaje: 'Se eliminó correctamente.', nivel: 'exito' }); }
            catch (e) { AMO.toast({ titulo: 'No se pudo eliminar', mensaje: e.message, nivel: 'peligro' }); }
        }));
        tbody.querySelectorAll('[data-liberar-vehiculo]').forEach(b => b.addEventListener('click', async () => {
            if (!AMO.confirmar('¿Liberar este vehículo a la fuerza? Si tenía un envío activo, se cancelará y se le avisará al cliente.')) return;
            try { await AMO.call('vehiculo:forzar_liberar', { vehicleId: b.dataset.liberarVehiculo }); AMO.toast({ titulo: 'Vehículo liberado', mensaje: '', nivel: 'exito' }); }
            catch (e) { AMO.toast({ titulo: 'No se pudo liberar', mensaje: e.message, nivel: 'peligro' }); }
        }));
    }

    function abrirFormVehiculo(id) {
        const v = id ? AMO.state.vehiculosInfo[id] : null;
        AMO.modalForm({
            titulo: v ? `Editar ${v.placa}` : 'Nuevo vehículo',
            textoOk: v ? 'Guardar cambios' : 'Crear vehículo',
            valores: v || { tipo: 'Camioneta', capacidadKg: 1000 },
            campos: [
                { id: 'placa', label: 'Placa', required: true, placeholder: 'Ej. PBA-1234' },
                { id: 'marca', label: 'Marca' },
                { id: 'modelo', label: 'Modelo' },
                { id: 'tipo', label: 'Tipo', type: 'select', opciones: ['Moto', 'Camioneta', 'Furgoneta', 'Camión'].map(t => ({ value: t, label: t })) },
                { id: 'capacidadKg', label: 'Capacidad (kg)', type: 'number' }
            ],
            onSubmit: async (datos) => {
                if (v) await AMO.call('vehiculo:editar', { id: v.id, ...datos });
                else await AMO.call('vehiculo:crear', datos);
                AMO.toast({ titulo: v ? 'Vehículo actualizado' : 'Vehículo creado', mensaje: datos.placa, nivel: 'exito' });
            }
        });
    }
    document.getElementById('btnNuevoVehiculo')?.addEventListener('click', () => abrirFormVehiculo(null));

    // ---------------- Choferes ----------------
    function renderChoferes() {
        const tbody = document.getElementById('tablaChoferes');
        const items = Object.values(AMO.state.choferes);
        if (!items.length) { tbody.innerHTML = '<tr><td colspan="5" class="amo-empty">Sin choferes registrados</td></tr>'; return; }
        tbody.innerHTML = items.map(c => `<tr>
            <td><b>${AMO.esc(c.nombre)}</b></td><td>${AMO.esc(c.cedula || '-')}</td><td>${AMO.esc(c.telefono || '-')}</td>
            <td>${c.vehicleId ? `<span class="amo-badge b-blue">${AMO.esc(c.vehicleId)}</span>` : '<span class="amo-badge b-slate">Sin asignar</span>'}</td>
            <td class="text-end"><button class="btn btn-sm btn-light border me-1" data-editar-chofer="${c.id}"><i class="bi bi-pencil"></i></button><button class="btn btn-sm btn-light border text-danger" data-eliminar-chofer="${c.id}"><i class="bi bi-trash"></i></button></td>
        </tr>`).join('');
        tbody.querySelectorAll('[data-editar-chofer]').forEach(b => b.addEventListener('click', () => abrirFormChofer(b.dataset.editarChofer)));
        tbody.querySelectorAll('[data-eliminar-chofer]').forEach(b => b.addEventListener('click', async () => {
            if (!AMO.confirmar('¿Eliminar este chofer?')) return;
            try { await AMO.call('chofer:eliminar', { id: b.dataset.eliminarChofer }); AMO.toast({ titulo: 'Chofer eliminado', mensaje: '', nivel: 'exito' }); }
            catch (e) { AMO.toast({ titulo: 'No se pudo eliminar', mensaje: e.message, nivel: 'peligro' }); }
        }));
    }

    function abrirFormChofer(id) {
        const c = id ? AMO.state.choferes[id] : null;
        const vehiculosLibres = Object.values(AMO.state.vehiculosInfo).filter(v => !Object.values(AMO.state.choferes).some(ch => ch.vehicleId === v.id && ch.id !== id));
        AMO.modalForm({
            titulo: c ? `Editar ${c.nombre}` : 'Nuevo chofer',
            textoOk: c ? 'Guardar cambios' : 'Crear chofer',
            valores: c || {},
            campos: [
                { id: 'nombre', label: 'Nombre completo', required: true },
                { id: 'cedula', label: 'Cédula' },
                { id: 'telefono', label: 'Teléfono' },
                { id: 'vehicleId', label: 'Vehículo asignado', type: 'select', placeholder: 'Sin asignar', opciones: vehiculosLibres.map(v => ({ value: v.id, label: `${v.id} · ${v.placa}` })) },
                ...(c ? [] : [
                    { id: 'username', label: 'Usuario de acceso (opcional)' },
                    { id: 'password', label: 'Contraseña', type: 'password' }
                ])
            ],
            onSubmit: async (datos) => {
                if (c) await AMO.call('chofer:editar', { id: c.id, ...datos });
                else await AMO.call('chofer:crear', datos);
                AMO.toast({ titulo: c ? 'Chofer actualizado' : 'Chofer creado', mensaje: datos.nombre, nivel: 'exito' });
            }
        });
    }
    document.getElementById('btnNuevoChofer')?.addEventListener('click', () => abrirFormChofer(null));

    // ---------------- Clientes ----------------
    function renderClientes() {
        const tbody = document.getElementById('tablaClientes');
        const items = Object.values(AMO.state.clientes);
        if (!items.length) { tbody.innerHTML = '<tr><td colspan="4" class="amo-empty">Sin clientes registrados</td></tr>'; return; }
        tbody.innerHTML = items.map(c => `<tr>
            <td><b>${AMO.esc(c.nombre)}</b></td><td>${AMO.esc(c.empresa || '-')}</td><td>${AMO.esc(c.telefono || '-')}</td>
            <td class="text-end"><button class="btn btn-sm btn-light border me-1" data-editar-cliente="${c.id}"><i class="bi bi-pencil"></i></button><button class="btn btn-sm btn-light border text-danger" data-eliminar-cliente="${c.id}"><i class="bi bi-trash"></i></button></td>
        </tr>`).join('');
        tbody.querySelectorAll('[data-editar-cliente]').forEach(b => b.addEventListener('click', () => abrirFormCliente(b.dataset.editarCliente)));
        tbody.querySelectorAll('[data-eliminar-cliente]').forEach(b => b.addEventListener('click', async () => {
            if (!AMO.confirmar('¿Eliminar este cliente?')) return;
            try { await AMO.call('cliente:eliminar', { id: b.dataset.eliminarCliente }); AMO.toast({ titulo: 'Cliente eliminado', mensaje: '', nivel: 'exito' }); }
            catch (e) { AMO.toast({ titulo: 'No se pudo eliminar', mensaje: e.message, nivel: 'peligro' }); }
        }));
    }

    function abrirFormCliente(id) {
        const c = id ? AMO.state.clientes[id] : null;
        AMO.modalForm({
            titulo: c ? `Editar ${c.nombre}` : 'Nuevo cliente',
            textoOk: c ? 'Guardar cambios' : 'Crear cliente',
            valores: c || {},
            campos: [
                { id: 'nombre', label: 'Nombre del contacto', required: true },
                { id: 'empresa', label: 'Empresa' },
                { id: 'telefono', label: 'Teléfono' },
                ...(c ? [] : [
                    { id: 'username', label: 'Usuario de acceso (opcional)' },
                    { id: 'password', label: 'Contraseña', type: 'password' }
                ])
            ],
            onSubmit: async (datos) => {
                if (c) await AMO.call('cliente:editar', { id: c.id, ...datos });
                else await AMO.call('cliente:crear', datos);
                AMO.toast({ titulo: c ? 'Cliente actualizado' : 'Cliente creado', mensaje: datos.nombre, nivel: 'exito' });
            }
        });
    }
    document.getElementById('btnNuevoCliente')?.addEventListener('click', () => abrirFormCliente(null));

    // ---------------- Rutas ----------------
    function renderRutas() {
        const tbody = document.getElementById('tablaRutas');
        const items = Object.values(AMO.state.rutas);
        if (!items.length) { tbody.innerHTML = '<tr><td colspan="5" class="amo-empty">Sin rutas planificadas</td></tr>'; return; }
        tbody.innerHTML = items.map(r => `<tr>
            <td><b>${AMO.esc(r.nombre)}</b></td><td>${AMO.esc(r.origen)} → ${AMO.esc(r.destino)}</td>
            <td>${r.vehicleId ? AMO.esc(r.vehicleId) : '-'}</td><td>${r.choferId ? AMO.esc(AMO.state.choferes[r.choferId]?.nombre || r.choferId) : '-'}</td>
            <td><span class="amo-badge b-blue">${AMO.esc(r.estado)}</span></td>
        </tr>`).join('');
    }

    document.getElementById('btnNuevaRuta')?.addEventListener('click', () => {
        AMO.modalForm({
            titulo: 'Nueva ruta',
            textoOk: 'Crear ruta',
            campos: [
                { id: 'nombre', label: 'Nombre de la ruta', required: true },
                { id: 'origen', label: 'Origen' },
                { id: 'destino', label: 'Destino' },
                { id: 'vehicleId', label: 'Vehículo', type: 'select', placeholder: 'Sin asignar', opciones: Object.values(AMO.state.vehiculosInfo).map(v => ({ value: v.id, label: `${v.id} · ${v.placa}` })) },
                { id: 'choferId', label: 'Chofer', type: 'select', placeholder: 'Sin asignar', opciones: Object.values(AMO.state.choferes).map(c => ({ value: c.id, label: c.nombre })) }
            ],
            onSubmit: async (datos) => { await AMO.call('ruta:crear', datos); AMO.toast({ titulo: 'Ruta creada', mensaje: datos.nombre, nivel: 'exito' }); }
        });
    });

    // ---------------- Envíos activos (admin) ----------------
    function renderEnviosAdmin() {
        const tbody = document.getElementById('tablaEnviosAdmin');
        const items = Object.values(AMO.state.envios).filter(e => !['entregado', 'cancelado'].includes(e.estado)).sort((a, b) => (b.creadoEn || 0) - (a.creadoEn || 0));
        if (!items.length) { tbody.innerHTML = '<tr><td colspan="6" class="amo-empty">No hay envíos activos en este momento</td></tr>'; return; }
        tbody.innerHTML = items.map(e => {
            const cliente = AMO.state.clientes[e.clienteId];
            return `<tr>
                <td><b>${AMO.esc(e.id)}</b></td><td>${AMO.esc(cliente?.nombre || e.clienteId)}</td><td>${AMO.esc(e.descripcion)}</td>
                <td>${e.vehicleId ? AMO.esc(e.vehicleId) : '-'}</td><td><span class="amo-badge ${AMO.badgeEstado(e.estado)}">${AMO.esc(e.estado.replace(/_/g, ' '))}</span></td>
                <td class="text-end">${e.vehicleId ? `<button class="btn btn-sm btn-outline-danger" data-liberar="${e.vehicleId}">Forzar liberación</button>` : ''}</td>
            </tr>`;
        }).join('');
        tbody.querySelectorAll('[data-liberar]').forEach(b => b.addEventListener('click', async () => {
            if (!AMO.confirmar('¿Forzar la liberación de este vehículo? El envío quedará cancelado.')) return;
            await AMO.call('vehiculo:forzar_liberar', { vehicleId: b.dataset.liberar });
        }));
    }

    // ---------------- Historial de entregas (admin) ----------------
    function renderHistorial() {
        const tbody = document.getElementById('tablaHistorial');
        const items = Object.values(AMO.state.envios).filter(e => ['entregado', 'cancelado'].includes(e.estado)).sort((a, b) => (b.creadoEn || 0) - (a.creadoEn || 0));
        if (!items.length) { tbody.innerHTML = '<tr><td colspan="7" class="amo-empty">Aún no hay entregas completadas</td></tr>'; return; }
        tbody.innerHTML = items.map(e => {
            const cliente = AMO.state.clientes[e.clienteId];
            return `<tr>
                <td><b>${AMO.esc(e.id)}</b></td><td>${AMO.esc(cliente?.nombre || e.clienteId)}</td><td>${AMO.esc(e.descripcion)}</td>
                <td>${e.vehicleId ? AMO.esc(e.vehicleId) : '-'}</td><td><span class="amo-badge ${AMO.badgeEstado(e.estado)}">${AMO.esc(e.estado.replace(/_/g, ' '))}</span></td>
                <td class="text-muted" style="font-size:.76rem">${AMO.fecha(e.creadoEn || Date.now())}</td>
                <td class="text-end">${e.waypoints ? `<button class="btn btn-sm btn-light border" data-ver-ruta="${e.id}"><i class="bi bi-map me-1"></i>Ver ruta</button>` : '<span class="text-muted small">Sin ruta</span>'}</td>
            </tr>`;
        }).join('');
        tbody.querySelectorAll('[data-ver-ruta]').forEach(b => b.addEventListener('click', () => verRutaHistorial(b.dataset.verRuta)));
    }

    function verRutaHistorial(envioId) {
        const envio = AMO.state.envios[envioId];
        if (!envio || !envio.waypoints) return;
        AMO.modalCustom({
            titulo: `Ruta del envío ${envio.id}`,
            size: 'lg',
            render: (body) => {
                body.innerHTML = `<div id="mapaHistorial" style="height:360px;border-radius:12px;overflow:hidden"></div>`;
                const m = L.map('mapaHistorial').setView([envio.waypoints[0].lat, envio.waypoints[0].lng], 12);
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap' }).addTo(m);
                const color = AMO.colorVehiculo(envio.vehicleId || 'V001');
                L.polyline(envio.waypoints.map(w => [w.lat, w.lng]), { color, weight: 4, dashArray: '8,8' }).addTo(m);
                envio.waypoints.forEach((w, i) => L.marker([w.lat, w.lng]).bindPopup(['Inicio', 'Recogida', 'Entrega'][i] || w.label).addTo(m));
                m.fitBounds(L.latLngBounds(envio.waypoints.map(w => [w.lat, w.lng])), { padding: [30, 30] });
                setTimeout(() => m.invalidateSize(), 80);
            }
        });
    }

    // ---------------- Novedades ----------------
    function renderNovedades() {
        const tbody = document.getElementById('tablaNovedades');
        const items = [...AMO.state.novedades].sort((a, b) => b.timestamp - a.timestamp);
        document.getElementById('novResumen').textContent = `${items.filter(n => n.estado === 'abierta').length} abiertas de ${items.length}`;
        if (!items.length) { tbody.innerHTML = '<tr><td colspan="7" class="amo-empty">Sin novedades reportadas</td></tr>'; return; }
        tbody.innerHTML = items.map(n => `<tr>
            <td><b>${AMO.esc(n.choferNombre)}</b>${n.vehicleId ? `<div class="text-muted" style="font-size:.72rem">${AMO.esc(n.vehicleId)}</div>` : ''}</td>
            <td>${AMO.labelTipoNovedad(n.tipo)}</td><td><span class="amo-badge ${AMO.badgePrioridad(n.prioridad)}">${n.prioridad}</span></td>
            <td style="max-width:260px">${AMO.esc(n.descripcion)}</td>
            <td><span class="amo-badge ${n.estado === 'resuelta' ? 'b-green' : n.estado === 'en_revision' ? 'b-amber' : 'b-red'}">${n.estado.replace(/_/g, ' ')}</span></td>
            <td class="text-muted" style="font-size:.76rem">${AMO.hace(n.timestamp)}</td>
            <td class="text-end">${n.estado !== 'resuelta' ? `<button class="btn btn-sm btn-primary" data-responder="${n.id}">Responder</button>` : ''}</td>
        </tr>`).join('');
        tbody.querySelectorAll('[data-responder]').forEach(b => b.addEventListener('click', () => abrirFormRespuesta(b.dataset.responder)));
    }

    function abrirFormRespuesta(id) {
        const n = AMO.state.novedades.find(x => x.id === id);
        AMO.modalForm({
            titulo: `Responder novedad de ${n.choferNombre}`,
            textoOk: 'Enviar respuesta',
            valores: { estado: 'en_revision' },
            campos: [
                { id: 'estado', label: 'Estado', type: 'select', opciones: [{ value: 'en_revision', label: 'En revisión' }, { value: 'resuelta', label: 'Resuelta' }] },
                { id: 'respuesta', label: 'Respuesta / instrucciones', type: 'textarea', required: true }
            ],
            onSubmit: async (datos) => { await AMO.call('incidencia:responder', { id, ...datos }); AMO.toast({ titulo: 'Respuesta enviada', mensaje: '', nivel: 'exito' }); }
        });
    }

    // ---------------- Eventos de socket en vivo ----------------
    AMO.onInitAdd((data) => {
        if (!esAdmin()) return;
        iniciarMapa();
        pintarTodosLosVehiculos();
        renderMonitoreo(); renderVehiculos(); renderChoferes(); renderClientes(); renderRutas(); renderEnviosAdmin(); renderHistorial(); renderNovedades();

        AMO.socket.on('telemetry', (v) => { AMO.state.vehicles[v.vehicleId] = v; pintarMarcador(v); renderMonitoreo(); });
        AMO.socket.on('alert', (a) => pushAlert(a.message));
        AMO.socket.on('vehiculo:ficha_creada', (v) => { AMO.state.vehiculosInfo[v.id] = v; renderVehiculos(); });
        AMO.socket.on('vehiculo:ficha_actualizada', (v) => { AMO.state.vehiculosInfo[v.id] = v; renderVehiculos(); });
        AMO.socket.on('vehiculo:ficha_eliminada', ({ id }) => { delete AMO.state.vehiculosInfo[id]; renderVehiculos(); });
        AMO.socket.on('vehiculo:estado', ({ vehicleId, estado, envioId }) => { AMO.state.vehicleStatuses[vehicleId] = { estado, envioId }; renderVehiculos(); renderMonitoreo(); });
        AMO.socket.on('vehiculo:bloqueado', (bloqueo) => {
            AMO.state.lockedVehicles[bloqueo.vehicleId] = bloqueo;
            AMO.state.vehicleStatuses[bloqueo.vehicleId] = { estado: 'reservado', envioId: null };
            renderVehiculos(); renderMonitoreo();
        });
        AMO.socket.on('vehiculo:desbloqueado', ({ vehicleId }) => {
            delete AMO.state.lockedVehicles[vehicleId];
            renderVehiculos(); renderMonitoreo();
        });
        AMO.socket.on('vehiculo:liberado', () => { renderEnviosAdmin(); });
        AMO.socket.on('cliente:creado', (c) => { AMO.state.clientes[c.id] = c; renderClientes(); });
        AMO.socket.on('cliente:actualizado', (c) => { AMO.state.clientes[c.id] = c; renderClientes(); });
        AMO.socket.on('cliente:eliminado', ({ id }) => { delete AMO.state.clientes[id]; renderClientes(); });
        AMO.socket.on('chofer:creado', (c) => { AMO.state.choferes[c.id] = c; renderChoferes(); });
        AMO.socket.on('chofer:actualizado', (c) => { AMO.state.choferes[c.id] = c; renderChoferes(); });
        AMO.socket.on('chofer:eliminado', ({ id }) => { delete AMO.state.choferes[id]; renderChoferes(); });
        AMO.socket.on('ruta:creada', (r) => { AMO.state.rutas[r.id] = r; renderRutas(); });
        AMO.socket.on('envio:creado', (e) => { AMO.state.envios[e.id] = e; renderEnviosAdmin(); renderMonitoreo(); });
        AMO.socket.on('envio:actualizado', (e) => { AMO.state.envios[e.id] = e; renderEnviosAdmin(); renderHistorial(); renderMonitoreo(); });
        AMO.socket.on('novedad:nueva', (n) => { AMO.state.novedades.push(n); renderNovedades(); actualizarBadgeNovedades(); pushAlert(`Novedad de ${n.choferNombre}: ${n.descripcion}`); });
        AMO.socket.on('novedad:actualizada', (n) => {
            const i = AMO.state.novedades.findIndex(x => x.id === n.id);
            if (i >= 0) AMO.state.novedades[i] = n; else AMO.state.novedades.push(n);
            renderNovedades(); actualizarBadgeNovedades();
        });
    });

    function actualizarBadgeNovedades() {
        const el = document.querySelector('[data-badge="novedades"]');
        if (!el) return;
        const n = AMO.state.novedades.filter(x => x.estado === 'abierta').length;
        el.textContent = n; el.classList.toggle('d-none', n === 0);
    }

    AMO.onVistaAdd((view) => {
        if (!esAdmin()) return;
        if (view === 'monitoreo') { iniciarMapa(); setTimeout(() => map && map.invalidateSize(), 50); pintarTodosLosVehiculos(); renderMonitoreo(); }
        if (view === 'vehiculos') renderVehiculos();
        if (view === 'choferes') renderChoferes();
        if (view === 'clientes') renderClientes();
        if (view === 'rutas') renderRutas();
        if (view === 'envios') renderEnviosAdmin();
        if (view === 'historial') renderHistorial();
        if (view === 'novedades') renderNovedades();
    });
})();
