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
    partido: partidoVacio()
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
  intentarAutoPartido();
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

// --- Fútbol 3 vs 3 (automático) ---
let colaJugadores = [];
let partidoInterval = null;

function partidoVacio() {
  return { activo: false, equipoA: null, equipoB: null, tiempoRestante: DURACION_PARTIDO, terminado: false };
}

function posAleatoria() {
  return { x: 10 + Math.random() * 80, y: 10 + Math.random() * 80 };
}

function armarEquipo(nombre, jugadores) {
  return {
    nombre,
    goles: 0,
    jugadores: jugadores.map(j => ({ ...j, ...posAleatoria() }))
  };
}

function intentarAutoPartido() {
  if (estado.partido.activo) return;
  if (colaJugadores.length < 6) return;

  const seis = colaJugadores.splice(0, 6);
  const equiposBarajados = [...EQUIPOS].sort(() => Math.random() - 0.5);
  const [nombreA, nombreB] = equiposBarajados;

  estado.partido = {
    activo: true,
    equipoA: armarEquipo(nombreA, seis.slice(0, 3)),
    equipoB: armarEquipo(nombreB, seis.slice(3, 6)),
    tiempoRestante: DURACION_PARTIDO,
    terminado: false,
    ultimoGol: null
  };
  agregarLog(`⚽ Arranca el partido: ${nombreA} vs ${nombreB}`, 'gol');
  guardarEstado();

  if (partidoInterval) clearInterval(partidoInterval);
  partidoInterval = setInterval(() => {
    const p = estado.partido;
    if (!p.activo) { clearInterval(partidoInterval); return; }

    // movimiento: cada jugador se mueve un poco solo, como regateando
    [...p.equipoA.jugadores, ...p.equipoB.jugadores].forEach(j => {
      j.x = Math.min(92, Math.max(8, j.x + (Math.random() * 20 - 10)));
      j.y = Math.min(92, Math.max(8, j.y + (Math.random() * 20 - 10)));
    });

    // chance de gol cada segundo (~10%)
    if (Math.random() < 0.10) {
      const equipoQueMete = Math.random() < 0.5 ? 'equipoA' : 'equipoB';
      const eq = p[equipoQueMete];
      const autor = eq.jugadores[Math.floor(Math.random() * eq.jugadores.length)];
      eq.goles++;
      p.ultimoGol = { equipo: equipoQueMete, autor: autor.nombre, t: Date.now() };
      agregarLog(`⚽ GOOOL de ${autor.nombre} para ${eq.nombre}! (${p.equipoA.goles}-${p.equipoB.goles})`, 'gol');
    }

    p.tiempoRestante--;
    if (p.tiempoRestante <= 0) {
      p.activo = false;
      p.terminado = true;
      clearInterval(partidoInterval);
      const ga = p.equipoA.goles, gb = p.equipoB.goles;
      if (ga === gb) {
        agregarLog(`🏁 Termina el partido: empate ${ga}-${gb} entre ${p.equipoA.nombre} y ${p.equipoB.nombre}`, 'campeon');
      } else {
        const ganador = ga > gb ? p.equipoA.nombre : p.equipoB.nombre;
        agregarLog(`🏁 Termina el partido: ganó ${ganador} (${ga}-${gb})`, 'campeon');
      }
      setTimeout(() => {
        estado.partido = partidoVacio();
        guardarEstado();
        intentarAutoPartido();
      }, 8000); // 8s mostrando el resultado final antes de arrancar el próximo
    }
    guardarEstado();
  }, 1000);
}

function conectar() {
  const opciones = {};
  if (process.env.EULERSTREAM_API_KEY) {
    opciones.signApiKey = process.env.EULERSTREAM_API_KEY;
  }
  conn = new TikTokLiveConnection(USERNAME, opciones);

  conn.on(WebcastEvent.CHAT, data => {
    const texto = data.content || data.comment;
    if (!texto) return;
    guardarComentario(texto, data.user || {});
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
