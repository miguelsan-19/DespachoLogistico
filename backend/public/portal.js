// =====================================================================
// AMO - portal.js
// Portal del cliente (nuevo envío + rastreo) y portal del chofer
// (mi jornada + reportar novedades). (Parte: Naomi)
// =====================================================================
(function () {
    const esCliente = () => AMO.state.usuario && AMO.state.usuario.rol === 'cliente';
    const esChofer = () => AMO.state.usuario && AMO.state.usuario.rol === 'chofer';

    // =================================================================
    // PORTAL CLIENTE
    // =================================================================
    let clientMap = null, originMarker = null, destMarker = null, originZoneCircle = null;
    let clientVehicleMarkers = {}, clientRouteLayers = {};
    let originCoords = null, destCoords = null, selectedClientVehicleId = null, activeSelectedEnvioId = null;
    let vehicleSelectionTimer = null, vehicleSelectionSecondsLeft = 0;

    const originPinIcon = L.divIcon({
        className: '', html: `<div style="filter:drop-shadow(0 3px 5px rgba(0,0,0,.4))"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 46" width="32" height="40"><path d="M18 0C8.06 0 0 8.06 0 18c0 13.5 18 28 18 28s18-14.5 18-28c0-9.94-8.06-18-18-18z" fill="#16a34a" stroke="#fff" stroke-width="2"/><circle cx="18" cy="17" r="10" fill="#fff"/></svg></div>`,
        iconSize: [32, 40], iconAnchor: [16, 40]
    });
    const pedidoPinIcon = L.divIcon({
        className: '', html: `<div style="filter:drop-shadow(0 3px 5px rgba(0,0,0,.4))"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 46" width="32" height="40"><path d="M18 0C8.06 0 0 8.06 0 18c0 13.5 18 28 18 28s18-14.5 18-28c0-9.94-8.06-18-18-18z" fill="#2563eb" stroke="#fff" stroke-width="2"/><circle cx="18" cy="17" r="10" fill="#fff"/></svg></div>`,
        iconSize: [32, 40], iconAnchor: [16, 40]
    });

    function distanciaKm(lat1, lon1, lat2, lon2) {
        const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        return Number((R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(1));
    }

    function choferDe(vehicleId) { return Object.values(AMO.state.choferes).find(ch => ch.vehicleId === vehicleId); }

    function iniciarClientMap() {
        if (clientMap || !document.getElementById('clientMap')) return;
        clientMap = L.map('clientMap').setView([-0.2295, -78.5243], 13);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap' }).addTo(clientMap);
        clientMap.on('click', (e) => manejarClickMapa(e.latlng.lat, e.latlng.lng));
    }

    function manejarClickMapa(lat, lng) {
        const target = document.querySelector('input[name="mapTarget"]:checked')?.value || 'destino';
        const label = document.getElementById('clientCoordsLabel');
        if (target === 'destino') {
            destCoords = { lat, lng };
            if (!destMarker) destMarker = L.marker([lat, lng], { icon: pedidoPinIcon, draggable: true }).addTo(clientMap).on('dragend', (ev) => { const p = ev.target.getLatLng(); destCoords = { lat: p.lat, lng: p.lng }; actualizarVehiculosCercanos(); });
            else destMarker.setLatLng([lat, lng]);
            document.getElementById('envioDestino').value = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
            if (label) label.textContent = `Recogida: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
        } else {
            originCoords = { lat, lng };
            if (!originMarker) originMarker = L.marker([lat, lng], { icon: originPinIcon, draggable: true }).addTo(clientMap).on('dragend', (ev) => { const p = ev.target.getLatLng(); originCoords = { lat: p.lat, lng: p.lng }; if (originZoneCircle) originZoneCircle.setLatLng(p); actualizarVehiculosCercanos(); });
            else originMarker.setLatLng([lat, lng]);
            if (!originZoneCircle) originZoneCircle = L.circle([lat, lng], { radius: 12000, color: '#16a34a', fillOpacity: .06, weight: 1, dashArray: '5,5' }).addTo(clientMap);
            else originZoneCircle.setLatLng([lat, lng]);
            document.getElementById('envioOrigen').value = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
            if (label) label.textContent = `Entrega: ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
        }
        actualizarVehiculosCercanos();
    }

    function actualizarVehiculosCercanos() {
        if (!clientMap) return;
        const ref = originCoords || destCoords || { lat: -0.2295, lng: -78.5243 };
        const lista = Object.values(AMO.state.vehicles).map(v => ({ ...v, distancia: distanciaKm(ref.lat, ref.lng, v.lat, v.lng) })).sort((a, b) => a.distancia - b.distancia);

        lista.forEach(v => {
            if (!clientVehicleMarkers[v.vehicleId]) {
                clientVehicleMarkers[v.vehicleId] = L.marker([v.lat, v.lng], { icon: AMO.iconoVehiculo(v.vehicleId) }).addTo(clientMap)
                    .on('click', () => { if (choferDe(v.vehicleId)) alternarSeleccion(v.vehicleId); });
            } else {
                clientVehicleMarkers[v.vehicleId].setLatLng([v.lat, v.lng]);
            }
        });
        renderVehiculosCercanosUI(lista);
    }

    function estadoDeSeleccion(v) {
        const lock = AMO.state.lockedVehicles[v.vehicleId];
        const estado = (AMO.state.vehicleStatuses[v.vehicleId] || {}).estado || 'disponible';
        const hasDriver = !!choferDe(v.vehicleId);
        const bloqueadoPorOtro = (lock && lock.socketId !== AMO.socket.id) || estado === 'en_ruta' || estado === 'entregado';
        const esMio = selectedClientVehicleId === v.vehicleId && !bloqueadoPorOtro;
        return { hasDriver, bloqueadoPorOtro, esMio };
    }

    function renderVehiculosCercanosUI(lista) {
        const section = document.getElementById('nearbyVehiclesSection');
        const cont = document.getElementById('nearbyVehiclesList');
        section.style.display = 'block';
        if (!lista.length) { cont.innerHTML = '<span class="text-muted small">No hay vehículos conectados.</span>'; return; }
        cont.innerHTML = lista.map(v => {
            const { hasDriver, bloqueadoPorOtro, esMio } = estadoDeSeleccion(v);
            let cls = 'amo-pick'; if (!hasDriver || bloqueadoPorOtro) cls += ' disabled'; if (bloqueadoPorOtro) cls += ' taken'; if (esMio) cls += ' selected';
            const driver = choferDe(v.vehicleId);
            const texto = !hasDriver ? 'Sin chofer' : bloqueadoPorOtro ? 'Ocupado' : `${v.vehicleId} · ${v.distancia}km`;
            const tip = !hasDriver
                ? `Unidad ${v.vehicleId} sin chofer asignado.`
                : bloqueadoPorOtro
                    ? `Unidad ${v.vehicleId} ocupada. Espera su liberación.`
                    : `${driver.nombre} · ${v.distancia} km de distancia`;
            return `<button type="button" class="${cls}" data-veh="${v.vehicleId}" data-bs-toggle="tooltip" data-bs-placement="top" title="${AMO.esc(tip)}">${AMO.esc(texto)}</button>`;
        }).join('');
        cont.querySelectorAll('[data-veh]').forEach(btn => btn.addEventListener('click', () => {
            const v = lista.find(x => x.vehicleId === btn.dataset.veh);
            const { hasDriver, bloqueadoPorOtro } = estadoDeSeleccion(v);
            if (!hasDriver || bloqueadoPorOtro) return;
            alternarSeleccion(v.vehicleId);
        }));
        // Reinicia los tooltips de Bootstrap tras cada repintado (se pierden al reemplazar el HTML)
        cont.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(el => {
            const previo = bootstrap.Tooltip.getInstance(el);
            if (previo) previo.dispose();
            new bootstrap.Tooltip(el);
        });
    }

    function iniciarTemporizador(vehicleId) {
        detenerTemporizador();
        vehicleSelectionSecondsLeft = 15;
        actualizarBadgeTiempo(15);
        vehicleSelectionTimer = setInterval(() => {
            vehicleSelectionSecondsLeft--;
            if (vehicleSelectionSecondsLeft <= 0) { detenerTemporizador(); desmarcarPorTiempo(vehicleId); }
            else actualizarBadgeTiempo(vehicleSelectionSecondsLeft);
        }, 1000);
    }
    function detenerTemporizador() {
        if (vehicleSelectionTimer) clearInterval(vehicleSelectionTimer);
        vehicleSelectionTimer = null;
        document.getElementById('selectionCountdownBadge')?.classList.add('d-none');
    }
    function actualizarBadgeTiempo(s) {
        const b = document.getElementById('selectionCountdownBadge');
        if (b) { b.classList.remove('d-none'); b.textContent = `${s}s`; }
    }
    function desmarcarPorTiempo(vehicleId) {
        AMO.socket.emit('vehiculo:desbloquear', { vehicleId });
        selectedClientVehicleId = null;
        document.getElementById('envioVehiculo').value = '';
        actualizarBadgeSeleccion(null);
        AMO.toast({ titulo: 'Tiempo agotado', mensaje: `No confirmaste a tiempo. ${vehicleId} fue liberado.`, nivel: 'advertencia' });
        actualizarVehiculosCercanos();
    }
    function actualizarBadgeSeleccion(vehicleId) {
        const b = document.getElementById('selectedVehicleBadge');
        if (!b) return;
        if (vehicleId) { b.className = 'amo-badge b-blue'; b.textContent = `Vehículo ${vehicleId} reservado`; }
        else { b.className = 'amo-badge b-slate'; b.textContent = 'Ninguno seleccionado'; }
    }

    function alternarSeleccion(vehicleId) {
        const { bloqueadoPorOtro } = estadoDeSeleccion({ vehicleId });
        if (bloqueadoPorOtro) { AMO.toast({ titulo: 'No disponible', mensaje: `La unidad ${vehicleId} está ocupada.`, nivel: 'peligro' }); return; }
        if (selectedClientVehicleId === vehicleId) {
            detenerTemporizador();
            AMO.socket.emit('vehiculo:desbloquear', { vehicleId });
            selectedClientVehicleId = null;
            document.getElementById('envioVehiculo').value = '';
            actualizarBadgeSeleccion(null);
            actualizarVehiculosCercanos();
            return;
        }
        if (selectedClientVehicleId) { detenerTemporizador(); AMO.socket.emit('vehiculo:desbloquear', { vehicleId: selectedClientVehicleId }); }
        selectedClientVehicleId = vehicleId;
        AMO.socket.emit('vehiculo:bloquear', { vehicleId });
        iniciarTemporizador(vehicleId);
        document.getElementById('envioVehiculo').value = vehicleId;
        actualizarBadgeSeleccion(vehicleId);
        actualizarVehiculosCercanos();
    }

    function limpiarMapaCliente() {
        detenerTemporizador();
        if (selectedClientVehicleId) { AMO.socket.emit('vehiculo:desbloquear', { vehicleId: selectedClientVehicleId }); selectedClientVehicleId = null; }
        [originMarker, destMarker, originZoneCircle].forEach(l => l && clientMap && clientMap.removeLayer(l));
        originMarker = destMarker = originZoneCircle = null;
        Object.values(clientVehicleMarkers).forEach(m => clientMap && clientMap.removeLayer(m));
        clientVehicleMarkers = {};
        originCoords = destCoords = null;
        document.getElementById('envioVehiculo').value = '';
        actualizarBadgeSeleccion(null);
        document.getElementById('nearbyVehiclesSection').style.display = 'none';
        document.getElementById('clientCoordsLabel').textContent = 'Haz clic en el mapa';
        document.getElementById('targetDestino').checked = true;
    }

    function pintarRutaDinamica(routeData, targetMap, layerMap) {
        if (!targetMap || !routeData || !routeData.waypoints) return;
        const color = AMO.colorVehiculo(routeData.vehicleId);
        if (layerMap[routeData.vehicleId]) targetMap.removeLayer(layerMap[routeData.vehicleId]);
        const group = L.layerGroup();
        L.polyline(routeData.waypoints.map(w => [w.lat, w.lng]), { color, weight: 4, opacity: .85, dashArray: '8,8' }).addTo(group);
        if (routeData.waypoints[1]) L.marker([routeData.waypoints[1].lat, routeData.waypoints[1].lng], { icon: pedidoPinIcon }).bindPopup('Punto de recogida').addTo(group);
        if (routeData.waypoints[2]) L.marker([routeData.waypoints[2].lat, routeData.waypoints[2].lng], { icon: originPinIcon }).bindPopup('Punto de entrega').addTo(group);
        group.addTo(targetMap);
        layerMap[routeData.vehicleId] = group;
    }

    const ESTADO_INFO = {
        hacia_pedido: { texto: '1/2 Hacia la recogida', pct: 35, clase: 'b-blue' },
        recogiendo_pedido: { texto: 'Recogiendo el paquete', pct: 50, clase: 'b-amber' },
        hacia_origen: { texto: '2/2 Hacia la entrega', pct: 80, clase: 'b-blue' },
        entregado: { texto: 'Entregado', pct: 100, clase: 'b-green' }
    };
    function actualizarBannerRuta(routeData) {
        const box = document.getElementById('dynamicRouteStatusBox');
        if (!routeData) { box.classList.add('d-none'); return; }
        box.classList.remove('d-none');
        const info = ESTADO_INFO[routeData.status] || { texto: 'En camino', pct: 30, clase: 'b-blue' };
        document.getElementById('dynRouteVehicleTitle').textContent = `Vehículo ${routeData.vehicleId} · Envío ${routeData.envioId || ''}`;
        document.getElementById('dynRouteStatusBadge').className = `amo-badge ${info.clase}`;
        document.getElementById('dynRouteStatusBadge').textContent = info.texto;
        document.getElementById('dynRouteStepDesc').textContent = routeData.status === 'entregado' ? '¡Tu pedido llegó a su destino!' : 'Tu pedido está en camino, síguelo en el mapa.';
        document.getElementById('dynRouteProgressBar').style.width = `${info.pct}%`;
    }

    window.seleccionarPedido = function (envioId) {
        const envio = AMO.state.envios[envioId];
        if (!envio) return;
        activeSelectedEnvioId = envioId;
        AMO.socket.emit('envio:seleccionar', { envioId });
        const rData = envio.vehicleId && AMO.state.activeDynamicRoutes[envio.vehicleId];
        if (rData) {
            actualizarBannerRuta(rData);
            if (clientMap) { pintarRutaDinamica(rData, clientMap, clientRouteLayers); clientMap.fitBounds(L.latLngBounds(rData.waypoints.map(w => [w.lat, w.lng])), { padding: [25, 25] }); }
        }
        renderEnviosCliente();
    };

    function renderEnviosCliente() {
        const cont = document.getElementById('envioListCliente');
        const mios = Object.values(AMO.state.envios).filter(e => e.clienteId === AMO.state.usuario.clienteId).sort((a, b) => (b.creadoEn || 0) - (a.creadoEn || 0));
        if (!mios.length) { cont.innerHTML = '<div class="amo-empty">Aún no tienes envíos. Llena el formulario para crear el primero.</div>'; return; }
        cont.innerHTML = mios.map(e => `
            <div class="d-flex flex-column gap-1 px-3 py-3 border-bottom" style="cursor:pointer;${activeSelectedEnvioId === e.id ? 'background:#eff6ff' : ''}" data-envio="${e.id}">
                <div class="d-flex justify-content-between align-items-center"><b style="font-size:.88rem">${AMO.esc(e.descripcion)}</b><span class="amo-badge ${AMO.badgeEstado(e.estado)}">${AMO.esc(e.estado.replace(/_/g, ' '))}</span></div>
                <div class="text-muted" style="font-size:.76rem">${e.vehicleId ? `Vehículo ${AMO.esc(e.vehicleId)}` : 'Sin vehículo'} · ${e.id}</div>
            </div>`).join('');
        cont.querySelectorAll('[data-envio]').forEach(el => el.addEventListener('click', () => seleccionarPedido(el.dataset.envio)));
    }

    function renderAvisosCliente() {
        const cont = document.getElementById('avisosCliente');
        if (!cont) return;
        const items = [...AMO.state.novedades].sort((a, b) => b.timestamp - a.timestamp);
        if (!items.length) { cont.innerHTML = '<div class="amo-empty">Sin avisos por ahora.</div>'; return; }
        cont.innerHTML = items.map(n => `
            <div class="px-3 py-3 border-bottom">
                <div class="d-flex justify-content-between align-items-center mb-1"><b style="font-size:.84rem">${AMO.labelTipoNovedad(n.tipo)}</b><span class="amo-badge ${n.estado === 'resuelta' ? 'b-green' : 'b-amber'}">${n.estado.replace(/_/g, ' ')}</span></div>
                <div class="small text-muted mb-1">Envío ${AMO.esc(n.envioId || '')}: ${AMO.esc(n.descripcion)}</div>
                ${n.respuesta ? `<div class="small p-2 rounded-2" style="background:#eff6ff"><b>Centro de despacho:</b> ${AMO.esc(n.respuesta)}</div>` : ''}
                <div class="text-muted mt-1" style="font-size:.7rem">${AMO.hace(n.timestamp)}</div>
            </div>`).join('');
    }

    document.getElementById('envioForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const vehicleId = document.getElementById('envioVehiculo').value || selectedClientVehicleId;
        if (!vehicleId) { AMO.toast({ titulo: 'Falta seleccionar vehículo', mensaje: 'Elige un vehículo disponible antes de confirmar.', nivel: 'advertencia' }); return; }
        detenerTemporizador();
        try {
            await AMO.call('envio:crear', {
                descripcion: document.getElementById('envioDescripcion').value.trim(),
                pesoKg: document.getElementById('envioPeso').value,
                origen: document.getElementById('envioOrigen').value.trim(),
                destino: document.getElementById('envioDestino').value.trim(),
                origenCoords: originCoords || { lat: -0.2295, lng: -78.5243 },
                pedidoCoords: destCoords || { lat: -0.1950, lng: -78.4850 },
                vehicleId
            });
            AMO.toast({ titulo: 'Envío creado', mensaje: 'El vehículo fue despachado hacia el punto de recogida.', nivel: 'exito' });
            e.target.reset();
            limpiarMapaCliente();
        } catch (err) {
            AMO.toast({ titulo: 'No se pudo crear el envío', mensaje: err.message, nivel: 'peligro' });
        }
    });

    AMO.onInitAdd((data) => {
        if (!esCliente()) return;
        iniciarClientMap();
        renderEnviosCliente();
        renderAvisosCliente();
        AMO.socket.on('novedad:nueva', (n) => { AMO.state.novedades.push(n); renderAvisosCliente(); });
        AMO.socket.on('novedad:actualizada', (n) => {
            const i = AMO.state.novedades.findIndex(x => x.id === n.id);
            if (i >= 0) AMO.state.novedades[i] = n; else AMO.state.novedades.push(n);
            renderAvisosCliente();
        });
        AMO.socket.on('telemetry', (v) => { AMO.state.vehicles[v.vehicleId] = v; actualizarVehiculosCercanos(); });
        AMO.socket.on('vehiculo:bloqueado', () => actualizarVehiculosCercanos());
        AMO.socket.on('vehiculo:desbloqueado', () => actualizarVehiculosCercanos());
        AMO.socket.on('vehiculo:bloqueo_rechazado', (d) => AMO.toast({ titulo: 'Vehículo ocupado', mensaje: d.message, nivel: 'peligro' }));
        AMO.socket.on('vehiculo:tiempo_agotado', (d) => AMO.toast({ titulo: 'Tiempo agotado', mensaje: d.message, nivel: 'advertencia' }));
        AMO.socket.on('envio:creado', (e) => { AMO.state.envios[e.id] = e; renderEnviosCliente(); });
        AMO.socket.on('envio:actualizado', (e) => {
            AMO.state.envios[e.id] = e; renderEnviosCliente();
            if (e.id === activeSelectedEnvioId && e.vehicleId && AMO.state.activeDynamicRoutes[e.vehicleId]) actualizarBannerRuta(AMO.state.activeDynamicRoutes[e.vehicleId]);
        });
        AMO.socket.on('ruta:dinamica', (r) => {
            AMO.state.activeDynamicRoutes[r.vehicleId] = r;
            const envio = Object.values(AMO.state.envios).find(e => e.vehicleId === r.vehicleId && e.clienteId === AMO.state.usuario.clienteId);
            if (envio && (envio.id === activeSelectedEnvioId || !activeSelectedEnvioId)) { activeSelectedEnvioId = envio.id; actualizarBannerRuta(r); if (clientMap) pintarRutaDinamica(r, clientMap, clientRouteLayers); }
        });
    });

    AMO.onVistaAdd((view) => {
        if (!esCliente() || view !== 'nuevo-envio') return;
        iniciarClientMap();
        setTimeout(() => clientMap && clientMap.invalidateSize(), 50);
        renderEnviosCliente();
    });

    // =================================================================
    // PORTAL CHOFER
    // =================================================================
    let choferMap = null, choferMarker = null, choferRouteLayer = null;

    function iniciarMapaChofer() {
        if (choferMap || !document.getElementById('mapaChofer')) return;
        choferMap = L.map('mapaChofer').setView([-0.2295, -78.5243], 12);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap' }).addTo(choferMap);
    }

    function pintarMapaChofer() {
        if (!choferMap) return;
        const ch = AMO.state.choferes[AMO.state.usuario.choferId];
        const v = ch?.vehicleId ? AMO.state.vehicles[ch.vehicleId] : null;
        if (v) {
            if (!choferMarker) choferMarker = L.marker([v.lat, v.lng], { icon: AMO.iconoVehiculo(ch.vehicleId) }).addTo(choferMap);
            else choferMarker.setLatLng([v.lat, v.lng]);
            choferMap.panTo([v.lat, v.lng], { animate: true });
        }
        const ruta = ch?.vehicleId ? AMO.state.activeDynamicRoutes[ch.vehicleId] : null;
        if (ruta && ruta.waypoints) {
            if (choferRouteLayer) choferMap.removeLayer(choferRouteLayer);
            choferRouteLayer = L.polyline(ruta.waypoints.map(w => [w.lat, w.lng]), { color: AMO.colorVehiculo(ch.vehicleId), weight: 4, dashArray: '8,8' }).addTo(choferMap);
        }
    }

    function renderChoferInfo() {
        const el = document.getElementById('choferInfo');
        const ch = AMO.state.choferes[AMO.state.usuario.choferId];
        if (!ch) { el.textContent = 'No se encontró tu ficha de chofer.'; return; }
        const v = ch.vehicleId ? AMO.state.vehicles[ch.vehicleId] : null;
        const envioId = ch.vehicleId ? (AMO.state.vehicleStatuses[ch.vehicleId] || {}).envioId : null;
        const envio = envioId ? AMO.state.envios[envioId] : null;
        let html = `<div class="d-flex align-items-center gap-2 mb-2"><div class="amo-avatar">${ch.nombre.split(' ').map(p => p[0]).slice(0, 2).join('')}</div><div><b>${AMO.esc(ch.nombre)}</b><div class="text-muted" style="font-size:.78rem">${ch.vehicleId ? AMO.esc(ch.vehicleId) : 'Sin vehículo asignado'}</div></div></div>`;
        if (v) html += `<div class="small text-muted mb-2">Velocidad actual: ${(v.speed || 0).toFixed(0)} km/h · Estado: <span class="amo-badge ${AMO.badgeEstado(v.status)}">${AMO.esc((v.status || '').replace(/_/g, ' '))}</span></div>`;
        if (envio && !['entregado', 'cancelado'].includes(envio.estado)) {
            html += `<div class="p-2 rounded-3" style="background:#f8fafc"><b style="font-size:.84rem">Envío ${envio.id}</b><div class="small text-muted">${AMO.esc(envio.descripcion)}</div><div class="small text-muted mt-1">Recogida: ${AMO.esc(envio.destino)}<br>Entrega: ${AMO.esc(envio.origen)}</div>
                <button class="btn btn-success btn-sm w-100 mt-2" data-confirmar-entrega="${envio.id}"><i class="bi bi-check2-circle me-1"></i>Confirmar entrega y liberar vehículo</button>
            </div>`;
        } else {
            html += '<div class="amo-empty py-3">Sin envío asignado en este momento.</div>';
        }
        el.innerHTML = html;
        el.querySelector('[data-confirmar-entrega]')?.addEventListener('click', async (e) => {
            const id = e.target.closest('[data-confirmar-entrega]').dataset.confirmarEntrega;
            try {
                await AMO.call('envio:entregar', { envioId: id });
                AMO.toast({ titulo: 'Entrega confirmada', mensaje: 'El vehículo quedó libre para un nuevo envío.', nivel: 'exito' });
            } catch (err) {
                AMO.toast({ titulo: 'No se pudo confirmar', mensaje: err.message, nivel: 'peligro' });
            }
        });
    }

    function renderMisNovedades() {
        const cont = document.getElementById('misNovedades');
        const mias = AMO.state.novedades.filter(n => n.choferId === AMO.state.usuario.choferId).sort((a, b) => b.timestamp - a.timestamp);
        if (!mias.length) { cont.innerHTML = '<div class="amo-empty">No has reportado novedades.</div>'; return; }
        cont.innerHTML = mias.map(n => `
            <div class="px-3 py-3 border-bottom">
                <div class="d-flex justify-content-between align-items-center mb-1"><b style="font-size:.85rem">${AMO.labelTipoNovedad(n.tipo)}</b><span class="amo-badge ${n.estado === 'resuelta' ? 'b-green' : n.estado === 'en_revision' ? 'b-amber' : 'b-red'}">${n.estado.replace(/_/g, ' ')}</span></div>
                <div class="small text-muted mb-1">${AMO.esc(n.descripcion)}</div>
                ${n.respuesta ? `<div class="small p-2 rounded-2" style="background:#eff6ff"><b>Respuesta:</b> ${AMO.esc(n.respuesta)}</div>` : ''}
                <div class="text-muted mt-1" style="font-size:.7rem">${AMO.hace(n.timestamp)}</div>
            </div>`).join('');
    }

    document.getElementById('novedadForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            await AMO.call('novedad:reportar', {
                tipo: document.getElementById('novedadTipo').value,
                prioridad: document.getElementById('novedadPrioridad').value,
                descripcion: document.getElementById('novedadDescripcion').value.trim()
            });
            AMO.toast({ titulo: 'Novedad enviada', mensaje: 'El centro de despacho fue notificado.', nivel: 'exito' });
            e.target.reset();
        } catch (err) {
            AMO.toast({ titulo: 'No se pudo enviar', mensaje: err.message, nivel: 'peligro' });
        }
    });

    AMO.onInitAdd((data) => {
        if (!esChofer()) return;
        iniciarMapaChofer();
        renderChoferInfo();
        renderMisNovedades();
        pintarMapaChofer();
        AMO.socket.on('telemetry', (v) => {
            AMO.state.vehicles[v.vehicleId] = v;
            if (document.querySelector('[data-view="jornada"]').classList.contains('active')) { renderChoferInfo(); pintarMapaChofer(); }
        });
        AMO.socket.on('vehiculo:estado', ({ vehicleId }) => { if (AMO.state.choferes[AMO.state.usuario.choferId]?.vehicleId === vehicleId) renderChoferInfo(); });
        AMO.socket.on('ruta:dinamica', (r) => {
            AMO.state.activeDynamicRoutes[r.vehicleId] = r;
            if (AMO.state.choferes[AMO.state.usuario.choferId]?.vehicleId === r.vehicleId) pintarMapaChofer();
        });
        AMO.socket.on('envio:actualizado', () => renderChoferInfo());
        AMO.socket.on('novedad:actualizada', (n) => {
            const i = AMO.state.novedades.findIndex(x => x.id === n.id);
            if (i >= 0) AMO.state.novedades[i] = n; else AMO.state.novedades.push(n);
            renderMisNovedades();
        });
        AMO.socket.on('novedad:nueva', (n) => { AMO.state.novedades.push(n); renderMisNovedades(); });
    });

    AMO.onVistaAdd((view) => {
        if (!esChofer() || view !== 'jornada') return;
        iniciarMapaChofer();
        setTimeout(() => choferMap && choferMap.invalidateSize(), 50);
        renderChoferInfo(); renderMisNovedades(); pintarMapaChofer();
    });
})();
