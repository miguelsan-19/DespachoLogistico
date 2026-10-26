# Centro de Despacho Logístico — Fase 1 (Primer Parcial)

Cubre lo que pide el sílabo para la UC1: sockets TCP/UDP (Lab1) + WebSockets (Lab2) + concurrencia.

## Arquitectura

```
simulator (UDP) --> backend: gateway UDP --> Socket.io --> frontend (dashboard + mapa)
```

- **simulator/fleet-simulator.js**: proceso independiente que simula 3 vehículos moviéndose por rutas predefinidas y emite su telemetría (lat, lng, velocidad, estado) por un socket UDP crudo. No usa Socket.io.
- **backend/server.js**: tiene dos servidores en paralelo:
  - Un **gateway UDP** (`dgram`) que recibe la telemetría del simulador, la valida y la guarda en memoria.
  - Un servidor **Socket.io** que reemite esa telemetría en tiempo real a todos los navegadores conectados, y maneja el reporte de incidencias.
- **backend/public/**: dashboard web (HTML/JS plano, sin framework) con mapa en vivo (Leaflet) y métricas.

## Cómo correrlo

Necesitas dos terminales abiertas al mismo tiempo (backend y simulador).

**Terminal 1 — Backend:**
```bash
cd backend
npm install
npm start
```
Esto levanta:
- El dashboard en http://localhost:3000
- El gateway UDP escuchando en el puerto 41234

**Terminal 2 — Simulador:**
```bash
cd simulator
node fleet-simulator.js
```
Empieza a emitir telemetría de 3 vehículos (V001, V002, V003) cada 2 segundos.

Abre http://localhost:3000 en el navegador — vas a ver los 3 vehículos moviéndose en el mapa en tiempo real, y si abres varias pestañas, todas se actualizan a la vez (eso es lo que demuestra la sincronización de estado vía WebSockets).

##prueba

## Qué queda para Fase 2 y 3 (no es parte de este parcial)

- Autenticación JWT para despachadores
- Persistencia real (PostgreSQL + Prisma) — por ahora el estado vive en memoria
- Message Broker para alertas de emergencia
- Separación en microservicios / clúster y balanceo de carga
