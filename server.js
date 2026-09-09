const express = require('express');
const fs = require('fs');
const path = require('path');
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');

const PORT = process.env.PORT || 8080;
const USERNAME = process.env.TIKTOK_USERNAME; // tu @usuario, SIN el @, ej: midiendausuario
const ESTADO_FILE = path.join(__dirname, 'estado.json');

if (!USERNAME) {
  console.error('Falta la variable de entorno TIKTOK_USERNAME');
  process.exit(1);
}

const EQUIPOS = [
  "Colo Colo","River Plate","Boca Juniors","Flamengo","Palmeiras",
  "Peñarol","Nacional","Racing","Independiente","Universitario",
  "Alianza Lima","Barcelona SC","LDU Quito","Emelec","Cerro Porteño",
  "Olimpia","Bolívar","The Strongest","Deportivo Táchira","Junior"
];

const DURACION_RONDA = 5 * 60;
const DURACION_DESEMPATE = 10;
const DURACION_PARTIDO = 90;
const ARCO_Y_MIN = 32;
const ARCO_Y_MAX = 68;

function estadoInicial() {
  const scores = {};
  EQUIPOS.forEach(e => scores[e] = 0);
  return {
    scores,
    historial: {},
    logs: [],
    fase: 'regular',
    equiposDesempate: [],
    tiempoRestante: DURACION_RONDA,
    liderActual: null,
    conectado: false,
    comentarios: [],
    pelea: peleaVacia(),
    partido: partidoVacio(),
    entrenamiento: null,
    votacion: null,
    penales: null
  };
}

function peleaVacia() {
  return {
    activo: false,
    j1: null, // { nombre, avatar, golpes }
    j2: null,
    ganador: null,
    ultimoGolpe: null // 'j1' | 'j2', para animar en el overlay
  };
}

function cargarEstado() {
  try {
    const raw = fs.readFileSync(ESTADO_FILE, 'utf8');
    const data = JSON.parse(raw);
    EQUIPOS.forEach(e => { if (!(e in data.scores)) data.scores[e] = 0; });
    data.conectado = false;
    if (!data.comentarios) data.comentarios = [];
    if (!data.pelea) data.pelea = peleaVacia();
    data.pelea.activo = false; // no arrancamos con una pelea "colgada" al reiniciar
    if (!data.partido) data.partido = partidoVacio();
    data.partido.activo = false; // no arrancamos con un partido "colgado" al reiniciar
    if (data.entrenamiento === undefined) data.entrenamiento = null;
    data.votacion = null; // nunca arrancamos con una votación "colgada"
    data.penales = null; // nunca arrancamos con penales "colgados"
    return data;
  } catch (e) {
    return estadoInicial();
  }
}

function guardarEstado() {
  fs.writeFileSync(ESTADO_FILE, JSON.stringify(estado));
}

let estado = cargarEstado();

function normalizar(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

function buscarEquipo(texto) {
  const t = normalizar(texto);
  if (!t) return null;
  let match = EQUIPOS.find(e => normalizar(e) === t);
  if (match) return match;
  // el comentario contiene el nombre completo del equipo (ej: "vamos river plate")
  match = EQUIPOS.find(e => t.includes(normalizar(e)));
  if (match) return match;
  // el comentario es una palabra corta contenida en el nombre del equipo (ej: "boca", "river")
  match = EQUIPOS.find(e => normalizar(e).includes(t) && t.length >= 4);
  return match || null;
}

function ordinalGanada(n) {
  if (n === 1) return 'gana la primera';
  return 'gana la ' + n + 'ª';
}

function agregarLog(msg, tipo) {
  estado.logs.push({ msg, tipo, t: Date.now() });
  estado.logs = estado.logs.slice(-80);
}

function sumarPunto(equipo) {
  if (estado.fase === 'desempate' && !estado.equiposDesempate.includes(equipo)) return;
  estado.scores[equipo] = (estado.scores[equipo] || 0) + 1;
  agregarLog(`${equipo} suma un punto · ahora tiene ${estado.scores[equipo]}`, 'gol');
}

function tabla(activos) {
  const ordenado = [...activos].sort((a, b) => estado.scores[b] - estado.scores[a]);
  const maxPts = ordenado.length ? estado.scores[ordenado[0]] : 0;
  const empatadosArriba = ordenado.filter(e => estado.scores[e] === maxPts).length;
  return { ordenado, maxPts, empatadosArriba };
}

function coronarCampeon(equipo) {
  estado.historial[equipo] = (estado.historial[equipo] || 0) + 1;
  const veces = estado.historial[equipo];
  agregarLog(`🏆 ${equipo} ${ordinalGanada(veces)} de la liga`, 'campeon');

  const scores = {};
  EQUIPOS.forEach(e => scores[e] = 0);
  estado.scores = scores;
  estado.fase = 'regular';
  estado.equiposDesempate = [];
  estado.liderActual = null;
  estado.tiempoRestante = DURACION_RONDA;
}

function finalizarPeriodo() {
  const activos = estado.fase === 'desempate' ? estado.equiposDesempate : EQUIPOS;
  const { ordenado, maxPts, empatadosArriba } = tabla(activos);

  if (estado.fase === 'regular') {
    if (empatadosArriba >= 2) {
      estado.equiposDesempate = ordenado.filter(e => estado.scores[e] === maxPts);
      estado.equiposDesempate.forEach(e => estado.scores[e] = 0);
      estado.fase = 'desempate';
      estado.tiempoRestante = DURACION_DESEMPATE;
      agregarLog(`Empate en ${maxPts} puntos entre ${estado.equiposDesempate.join(' y ')} — arranca el desempate de 10 segundos`, 'gol');
    } else {
      coronarCampeon(ordenado[0]);
    }
  } else {
    const ordenDesempate = [...estado.equiposDesempate].sort((a, b) => estado.scores[b] - estado.scores[a]);
    const topPts = estado.scores[ordenDesempate[0]];
    const empatados = ordenDesempate.filter(e => estado.scores[e] === topPts);
    if (empatados.length >= 2) {
      estado.equiposDesempate = empatados;
      estado.equiposDesempate.forEach(e => estado.scores[e] = 0);
      estado.tiempoRestante = DURACION_DESEMPATE;
      agregarLog(`Sigue el empate entre ${empatados.join(' y ')} — se repite el desempate`, 'gol');
    } else {
      coronarCampeon(ordenDesempate[0]);
    }
  }
}

// reloj de la liga: solo corre mientras hay live conectado
setInterval(() => {
  if (!estado.conectado) return;
  estado.tiempoRestante--;
  if (estado.tiempoRestante <= 0) {
    finalizarPeriodo();
  }
  guardarEstado();
}, 1000);

let contadorComentarios = 0;

function extraerAvatar(user) {
  try {
    return (user.avatarThumb && user.avatarThumb.urlList && user.avatarThumb.urlList[0])
      || (user.avatarMedium && user.avatarMedium.urlList && user.avatarMedium.urlList[0])
      || (user.avatarLarge && user.avatarLarge.urlList && user.avatarLarge.urlList[0])
      || '';
  } catch (e) { return ''; }
}

function extraerNombre(user) {
  return (user && (user.nickname || user.uniqueId)) || 'Espectador';
}

function guardarComentario(texto, user) {
  contadorComentarios++;
  const c = {
    id: contadorComentarios,
    texto,
    nombre: extraerNombre(user),
    avatar: extraerAvatar(user)
  };
  estado.comentarios.unshift(c);
  estado.comentarios = estado.comentarios.slice(0, 25);
  colaPelea.push(c.id);
  intentarAutoPelea();

  // cola de jugadores para el fútbol: solo nombres distintos, sin repetir mientras esperan
  if (!colaJugadores.some(j => j.nombre === c.nombre) &&
      !(estado.partido.activo && [...estado.partido.equipoA.jugadores, ...estado.partido.equipoB.jugadores].some(j => j.nombre === c.nombre))) {
    colaJugadores.push({ nombre: c.nombre, avatar: c.avatar });
  }
  intentarFlujoPartidos();
}

// --- Batalla de comentarios (automática) ---
let peleaInterval = null;
let colaPelea = [];

function intentarAutoPelea() {
  if (estado.pelea.activo) return; // ya hay una en curso, esperamos a que termine
  if (colaPelea.length < 2) return;
  const idJ1 = colaPelea.shift();
  const idJ2 = colaPelea.shift();
  iniciarPelea(idJ1, idJ2);
}

function iniciarPelea(idJ1, idJ2) {
  const c1 = estado.comentarios.find(c => c.id === idJ1);
  const c2 = estado.comentarios.find(c => c.id === idJ2);
  if (!c1 || !c2) return { ok: false, error: 'No encontré esos comentarios' };
  if (estado.pelea.activo) return { ok: false, error: 'Ya hay una pelea en curso' };

  estado.pelea = {
    activo: true,
    j1: { nombre: c1.nombre, avatar: c1.avatar, texto: c1.texto, golpes: 0 },
    j2: { nombre: c2.nombre, avatar: c2.avatar, texto: c2.texto, golpes: 0 },
    ganador: null,
    ultimoGolpe: null
  };
  guardarEstado();

  if (peleaInterval) clearInterval(peleaInterval);
  peleaInterval = setInterval(() => {
    const p = estado.pelea;
    if (!p.activo) { clearInterval(peleaInterval); return; }
    const gana = Math.random() < 0.5 ? 'j1' : 'j2';
    p[gana].golpes++;
    p.ultimoGolpe = gana;
    if (p[gana].golpes >= 10) {
      p.activo = false;
      p.ganador = gana;
      clearInterval(peleaInterval);
      setTimeout(intentarAutoPelea, 4000); // esperamos 4s mostrando al ganador y arranca la próxima
    }
    guardarEstado();
  }, 700);

  return { ok: true };
}

let conn = null;

// --- Fútbol automático: 1vs1, 2vs2 o 3vs3 según votación ---
let colaJugadores = [];
let partidoInterval = null;
let umbralPreguntado2 = 0; // si dijeron "no" a jugar 1v1, no volvemos a preguntar hasta que la cola crezca más que esto
let umbralPreguntado4 = 0; // lo mismo para 2v2

function partidoVacio() {
  return { activo: false, equipoA: null, equipoB: null, tiempoRestante: DURACION_PARTIDO, terminado: false };
}

function votacionVacia() {
  return null;
}

function posAleatoria() {
  return { x: 10 + Math.random() * 80, y: 10 + Math.random() * 80 };
}

function armarEquipo(nombre, jugadores, ladoGol) {
  const armados = jugadores.map(j => ({ ...j, ...posAleatoria() }));
  if (armados.length >= 2) {
    const arq = armados[armados.length - 1];
    arq.arquero = true;
    arq.x = ladoGol === 'izq' ? 8 : 92;
    arq.y = 50;
  }
  return { nombre, goles: 0, jugadores: armados, ladoGol };
}

function iniciarPartido(modo) {
  // modo: 1, 2 o 3 jugadores por equipo
  const necesarios = modo * 2;
  if (colaJugadores.length < necesarios) return;

  const grupo = colaJugadores.splice(0, necesarios);
  const equiposBarajados = [...EQUIPOS].sort(() => Math.random() - 0.5);
  const [nombreA, nombreB] = equiposBarajados;

  estado.partido = {
    activo: true,
    modo,
    id: Date.now(),
    equipoA: armarEquipo(nombreA, grupo.slice(0, modo), 'izq'),
    equipoB: armarEquipo(nombreB, grupo.slice(modo, necesarios), 'der'),
    tiempoRestante: DURACION_PARTIDO,
    terminado: false,
    ultimoGol: null,
    ultimoTiro: null,
    jugada: null,
    posesion: grupo[Math.floor(Math.random() * grupo.length)].nombre
  };
  estado.entrenamiento = null;
  const etiqueta = modo === 1 ? '1 vs 1' : (modo === 2 ? '2 vs 2' : '3 vs 3');
  agregarLog(`⚽ Arranca el partido (${etiqueta}): ${nombreA} vs ${nombreB}`, 'gol');
  guardarEstado();

  if (partidoInterval) clearInterval(partidoInterval);
  partidoInterval = setInterval(() => {
    const p = estado.partido;
    if (!p.activo) { clearInterval(partidoInterval); return; }

    [...p.equipoA.jugadores, ...p.equipoB.jugadores].forEach(j => {
      if (j.arquero) {
        // el arquero se queda pegado a su arco, solo se mueve un poco arriba/abajo, siempre dentro del cajón
        j.y = Math.min(ARCO_Y_MAX, Math.max(ARCO_Y_MIN, j.y + (Math.random() * 12 - 6)));
        return;
      }
    });

    if (!p.jugada) {
      // arranca una jugada nueva: se elige quién ataca
      const equipoAtacanteId = Math.random() < 0.5 ? 'equipoA' : 'equipoB';
      const equipoAtac = p[equipoAtacanteId];
      const campo = equipoAtac.jugadores.filter(j => !j.arquero);
      const atacante = campo.length > 0
        ? campo[Math.floor(Math.random() * campo.length)]
        : equipoAtac.jugadores[0]; // 1vs1: no hay arquero, juega el único jugador
      p.jugada = { atacanteNombre: atacante.nombre, equipoAtacanteId, ticks: 0 };
      p.posesion = atacante.nombre;
      p.ultimoTiro = null;
    }

    const j = p.jugada;
    const equipoAtac = p[j.equipoAtacanteId];
    const equipoDefId = j.equipoAtacanteId === 'equipoA' ? 'equipoB' : 'equipoA';
    const equipoDef = p[equipoDefId];
    const atacante = equipoAtac.jugadores.find(x => x.nombre === j.atacanteNombre);
    const metaX = equipoAtac.ladoGol === 'izq' ? 86 : 14; // avanza hacia el arco rival

    // jugadores de campo que no están llevando la pelota, se mueven libres
    [...p.equipoA.jugadores, ...p.equipoB.jugadores].forEach(x => {
      if (x.arquero || x.nombre === j.atacanteNombre) return;
      x.x = Math.min(90, Math.max(10, x.x + (Math.random() * 16 - 8)));
      x.y = Math.min(90, Math.max(10, x.y + (Math.random() * 16 - 8)));
    });

    j.ticks++;
    if (j.ticks < 3) {
      // el atacante se acerca de a poco al arco rival, llevando la pelota
      atacante.x += (metaX - atacante.x) * 0.45;
      atacante.y += (50 - atacante.y) * 0.25 + (Math.random() * 14 - 7);
      atacante.y = Math.min(88, Math.max(12, atacante.y));
      p.posesion = atacante.nombre;
    } else {
      // definición: remata al arco. Forzamos que el tiro apunte SIEMPRE adentro del cajón del arco,
      // así nunca se ve un gol "afuera" ni se pierde en cualquier otro lado del campo.
      const arqueroRival = equipoDef.jugadores.find(x => x.arquero);
      const yTiro = Math.min(ARCO_Y_MAX, Math.max(ARCO_Y_MIN, atacante.y));
      const golProbabilidad = arqueroRival ? 0.32 : 0.55; // sin arquero (1v1) cuesta menos
      const gol = Math.random() < golProbabilidad;

      atacante.x = metaX;
      atacante.y = yTiro;
      p.posesion = atacante.nombre;

      if (arqueroRival) {
        arqueroRival.y = gol
          ? (yTiro > 50 ? ARCO_Y_MIN + 4 : ARCO_Y_MAX - 4) // se tira para el lado contrario, no llega
          : yTiro; // se para justo en la línea del remate y la ataja
      }

      p.ultimoTiro = {
        gol, autor: atacante.nombre, equipo: j.equipoAtacanteId,
        x: metaX, y: yTiro, t: Date.now()
      };

      if (gol) {
        equipoAtac.goles++;
        p.ultimoGol = { equipo: j.equipoAtacanteId, autor: atacante.nombre, t: Date.now() };
        agregarLog(`⚽ GOOOL de ${atacante.nombre} para ${equipoAtac.nombre}! (${p.equipoA.goles}-${p.equipoB.goles})`, 'gol');
      } else {
        const nombreArquero = arqueroRival ? arqueroRival.nombre : 'el rival';
        const insultos = [
          '¡Anotate en un curso de fútbol!',
          '¡Esa nunca entraba, ni de casualidad!',
          '¡Volvé a la escuelita!',
          '¡La próxima ni te acerques al arco!',
          '¡Con esa puntería mejor jugá al truco!'
        ];
        const insulto = insultos[Math.floor(Math.random() * insultos.length)];
        agregarLog(`🧤 ${nombreArquero} atajó el remate de ${atacante.nombre} y le grita corriendo: "${insulto}"`, 'gol');

        // rarísima posibilidad: el arquero se va a insultar y deja el arco vacío... y se la meten
        if (arqueroRival && Math.random() < 0.015) {
          const equipoAtacId = j.equipoAtacanteId;
          setTimeout(() => {
            const pActual = estado.partido;
            if (!pActual || !pActual.activo) return;
            const eqAtac = pActual[equipoAtacId];
            eqAtac.goles++;
            pActual.ultimoGol = { equipo: equipoAtacId, autor: atacante.nombre, t: Date.now() };
            pActual.posesion = atacante.nombre;
            agregarLog(`😱 ¡Mientras ${nombreArquero} se fue a insultar dejó el arco VACÍO! ${atacante.nombre} la agarra de nuevo y... ¡GOOOL! (${pActual.equipoA.goles}-${pActual.equipoB.goles})`, 'campeon');
            guardarEstado();
          }, 1600);
        }
      }
      p.jugada = null; // la próxima jugada arranca sola en el siguiente segundo
    }

    p.tiempoRestante--;
    if (p.tiempoRestante <= 0) {
      p.activo = false;
      p.terminado = true;
      clearInterval(partidoInterval);
      const ga = p.equipoA.goles, gb = p.equipoB.goles;
      if (ga === gb) {
        agregarLog(`🏁 Empate ${ga}-${gb} entre ${p.equipoA.nombre} y ${p.equipoB.nombre}. ¡Vamos a los penales!`, 'campeon');
        guardarEstado();
        setTimeout(() => iniciarPenales(p), 3000);
        return;
      } else {
        const ganador = ga > gb ? p.equipoA.nombre : p.equipoB.nombre;
        agregarLog(`🏁 Termina el partido: ganó ${ganador} (${ga}-${gb})`, 'campeon');
      }
      umbralPreguntado2 = 0;
      umbralPreguntado4 = 0;
      setTimeout(() => {
        estado.partido = partidoVacio();
        guardarEstado();
        intentarFlujoPartidos();
      }, 8000);
    }
    guardarEstado();
  }, 1000);
}

function iniciarPenales(p) {
  estado.penales = {
    activo: true,
    equipoA: p.equipoA,
    equipoB: p.equipoB,
    marcadorA: 0,
    marcadorB: 0,
    turno: 'equipoA',
    idxA: 0,
    idxB: 0,
    tiro: null,
    terminado: false,
    ganador: null
  };
  guardarEstado();
  ejecutarPenalSiguiente();
}

function ejecutarPenalSiguiente() {
  const pe = estado.penales;
  if (!pe || !pe.activo) return;

  const equipoId = pe.turno;
  const equipo = pe[equipoId];
  const idxKey = equipoId === 'equipoA' ? 'idxA' : 'idxB';
  const jugadores = equipo.jugadores;
  const tomador = jugadores[pe[idxKey] % jugadores.length];
  pe[idxKey]++;

  const gol = Math.random() < 0.62; // en penal 1 vs 1 es más fácil convertir
  pe.tiro = { equipo: equipoId, tirador: tomador.nombre, avatar: tomador.avatar, gol, t: Date.now() };

  if (gol) {
    if (equipoId === 'equipoA') pe.marcadorA++; else pe.marcadorB++;
    agregarLog(`🎯 ${tomador.nombre} (${equipo.nombre}) convierte el penal (${pe.marcadorA}-${pe.marcadorB})`, 'gol');
  } else {
    agregarLog(`🧤 ${tomador.nombre} (${equipo.nombre}) remató y el arquero contuvo el penal (${pe.marcadorA}-${pe.marcadorB})`, 'gol');
  }
  guardarEstado();

  setTimeout(() => {
    if (pe.turno === 'equipoB') {
      // ya tiraron los dos en esta ronda: si van distintos, se define ahí mismo
      if (pe.marcadorA !== pe.marcadorB) {
        pe.activo = false;
        pe.terminado = true;
        pe.ganador = pe.marcadorA > pe.marcadorB ? 'equipoA' : 'equipoB';
        agregarLog(`🏆 ¡${pe[pe.ganador].nombre} gana la definición por penales ${pe.marcadorA}-${pe.marcadorB}!`, 'campeon');
        guardarEstado();
        setTimeout(() => {
          estado.partido = partidoVacio();
          estado.penales = null;
          umbralPreguntado2 = 0;
          umbralPreguntado4 = 0;
          guardarEstado();
          intentarFlujoPartidos();
        }, 6000);
        return;
      }
      pe.turno = 'equipoA';
    } else {
      pe.turno = 'equipoB';
    }
    guardarEstado();
    ejecutarPenalSiguiente();
  }, 3000);
}

function iniciarVotacion(modo) {
  estado.votacion = {
    activo: true,
    modo,
    si: 0,
    no: 0,
    votantes: {},
    finalizaEn: Date.now() + 15000
  };
  const etiqueta = modo === 1 ? '1 vs 1' : '2 vs 2';
  agregarLog(`🗳️ ¿Jugamos ${etiqueta} ya? Comenten SI o NO (15 segundos para votar)`, 'gol');
  guardarEstado();
  setTimeout(() => resolverVotacion(modo), 15000);
}

function resolverVotacion(modo) {
  const v = estado.votacion;
  if (!v || !v.activo || v.modo !== modo) return;
  v.activo = false;

  let seJuega;
  if (v.si === v.no) {
    seJuega = Math.random() < 0.5;
    agregarLog('🎲 Empate en la votación, se decide al azar...', 'gol');
  } else {
    seJuega = v.si > v.no;
  }

  const etiqueta = modo === 1 ? '1 vs 1' : '2 vs 2';
  if (seJuega) {
    agregarLog(`✅ ¡Se juega ${etiqueta}! (${v.si} SI - ${v.no} NO)`, 'gol');
    estado.votacion = null;
    guardarEstado();
    iniciarPartido(modo);
  } else {
    agregarLog(`❌ Se prefiere esperar más jugadores (${v.si} SI - ${v.no} NO)`, 'gol');
    if (modo === 1) umbralPreguntado2 = colaJugadores.length;
    else umbralPreguntado4 = colaJugadores.length;
    estado.votacion = null;
    guardarEstado();
    intentarFlujoPartidos();
  }
}

function registrarVoto(texto, user) {
  const v = estado.votacion;
  if (!v || !v.activo) return;
  const nombre = extraerNombre(user);
  if (v.votantes[nombre]) return; // una persona vota una sola vez por votación
  const t = normalizar(texto);
  if (t === 'si' || t === 's') { v.si++; v.votantes[nombre] = true; guardarEstado(); }
  else if (t === 'no' || t === 'n') { v.no++; v.votantes[nombre] = true; guardarEstado(); }
}

function intentarFlujoPartidos() {
  if (estado.partido.activo) return;
  if (estado.votacion && estado.votacion.activo) return;

  const n = colaJugadores.length;
  if (n >= 6) {
    iniciarPartido(3); // el máximo, arranca directo sin votar
  } else if (n >= 4 && n > umbralPreguntado4) {
    iniciarVotacion(2);
  } else if (n >= 2 && n > umbralPreguntado2) {
    iniciarVotacion(1);
  }
}

// entrenamiento: mientras se espera (sin partido ni votación activa), van pateando al arco de a uno
setInterval(() => {
  if (estado.partido.activo || (estado.votacion && estado.votacion.activo)) { estado.entrenamiento = null; return; }
  if (colaJugadores.length === 0) { estado.entrenamiento = null; guardarEstado(); return; }

  const tirador = colaJugadores[Math.floor(Math.random() * colaJugadores.length)];
  const convierte = Math.random() < 0.45;

  estado.entrenamiento = {
    jugadoresEnCampo: colaJugadores.map(j => ({ nombre: j.nombre, avatar: j.avatar })),
    tirador: tirador.nombre,
    avatarTirador: tirador.avatar,
    gol: convierte,
    t: Date.now()
  };
  agregarLog(convierte ? `⚽ ${tirador.nombre} pateó y... ¡GOL en el entrenamiento!` : `🧤 ${tirador.nombre} pateó pero el arquero la atajó`, 'gol');
  guardarEstado();
}, 3000);

function conectar() {
  const opciones = {};
  if (process.env.EULERSTREAM_API_KEY) {
    opciones.signApiKey = process.env.EULERSTREAM_API_KEY;
  }
  conn = new TikTokLiveConnection(USERNAME, opciones);

  conn.on(WebcastEvent.CHAT, data => {
    const texto = data.content || data.comment;
    if (!texto) return;
    const user = data.user || {};
    guardarComentario(texto, user);
    registrarVoto(texto, user);
    const equipo = buscarEquipo(texto);
    if (equipo) sumarPunto(equipo);
  });

  conn.on(ControlEvent.DISCONNECTED, () => {
    console.log('Se cortó la conexión con el live, reintentando...');
    estado.conectado = false;
    setTimeout(conectar, 15000);
  });

  conn.on(ControlEvent.ERROR, ({ info, exception }) => {
    console.error('Error de conexión:', info, exception && exception.message);
  });

  conn.connect()
    .then(state => {
      console.log('Conectado al live de TikTok, room id:', state.roomId);
      estado.conectado = true;
      agregarLog('Conectado al live de TikTok', 'gol');
    })
    .catch(err => {
      console.error('No se pudo conectar (¿estás en vivo ahora?):', err.message || err);
      estado.conectado = false;
      setTimeout(conectar, 15000); // reintenta en 15s
    });
}

conectar();

// servidor web: expone el estado y sirve la página
const app = express();
app.use(express.static(__dirname));

app.get('/api/estado', (req, res) => {
  res.json(estado);
});

app.use(express.json());

app.post('/api/pelea/reiniciar', (req, res) => {
  if (peleaInterval) clearInterval(peleaInterval);
  estado.pelea = peleaVacia();
  colaPelea = [];
  guardarEstado();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Liga infinita (TikTok) corriendo en el puerto ${PORT}`);
});
