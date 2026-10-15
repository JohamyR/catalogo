/* =====================================================================
   CATÁLOGO EN LÍNEA — app.js

   Cómo está organizado este archivo (de arriba hacia abajo):
     0. Configuración  → lo único que normalmente tendrás que editar
     1. Datos          → leer la hoja de Google y convertirla en productos
     2. Pedido         → cantidades, precio de mayoreo y totales
     3. Pantalla       → dibujar tarjetas, filtros y el pedido
     4. WhatsApp       → armar el mensaje y abrir el chat
     5. Arranque       → poner todo en marcha
   ===================================================================== */


/* ---------------------------------------------------------------------
   0. CONFIGURACIÓN
   --------------------------------------------------------------------- */
const CONFIG = {
  // Enlace de la hoja publicada como CSV
  urlHoja: "https://docs.google.com/spreadsheets/d/e/2PACX-1vRgDsUuVRfdhf0qjU92uOapjrKFwNTMpoPP-gvQ8LRu_2Xiresl7nkNyx5qGoZTRA/pub?gid=1860917639&single=true&output=csv",

  // Número de WhatsApp de la tienda, con código de país y sin signos ni espacios.
  // Ejemplo de Honduras: "50499999999". Mientras tenga letras, el botón avisa que falta.
  whatsapp: "504XXXXXXXX",

  nombreTienda: "[Nombre de tu tienda]",
  moneda: "L",
  carpetaFotos: "fotos/",
};

// Columnas que la hoja debe tener (la columna "referencia" no se usa en la página)
const COLUMNAS = [
  "codigo", "subcodigo", "categoria", "subcategoria", "nombre", "estilo",
  "foto", "precio_detalle", "precio_mayoreo", "minimo_mayoreo", "estado",
];

const TODO = "Todo";
const TODAS = "Todas";
const CLAVE_GUARDADO = "catalogo-pedido-v1";


/* ---------------------------------------------------------------------
   Estado de la página: aquí vive todo lo que cambia mientras se usa
   --------------------------------------------------------------------- */
let productos = [];                  // lista de productos (uno por código)
const indiceEstilos = new Map();     // subcodigo -> { producto, estilo }, para buscar rápido
const filtros = { categoria: TODO, subcategoria: TODAS, texto: "" };
const seleccion = {};                // codigo -> subcodigo del estilo que se está viendo
const tarjetas = new Map();          // codigo -> tarjeta dibujada en pantalla
let carrito = {};                    // subcodigo -> cantidad
let nombreCliente = "";
let textoAviso = "";                 // aviso dentro del pedido (por ejemplo, estilos que se agotaron)

const $ = (selector) => document.querySelector(selector);


/* ---------------------------------------------------------------------
   1. DATOS: de la hoja de Google a una lista de productos
   --------------------------------------------------------------------- */

// Convierte el texto CSV en una lista de filas (cada fila es una lista de celdas).
// Entiende comillas, comas dentro de un texto y saltos de línea.
function leerCSV(texto) {
  if (texto.charCodeAt(0) === 0xFEFF) texto = texto.slice(1);   // quita una marca invisible del inicio
  const filas = [];
  let fila = [];
  let celda = "";
  let entreComillas = false;

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (entreComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { celda += '"'; i++; }   // dos comillas seguidas = una comilla de verdad
        else entreComillas = false;
      } else {
        celda += c;
      }
    } else if (c === '"') {
      entreComillas = true;
    } else if (c === ",") {
      fila.push(celda); celda = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      fila.push(celda); filas.push(fila);
      fila = []; celda = "";
    } else {
      celda += c;
    }
  }
  if (celda !== "" || fila.length > 0) { fila.push(celda); filas.push(fila); }
  return filas;
}

// Convierte las filas en objetos: { codigo: "J-101", estilo: "Perlas rojas", ... }
function filasAObjetos(filas) {
  if (filas.length === 0) throw new Error("La hoja está vacía.");
  const encabezados = filas[0].map((h) => h.trim().toLowerCase());
  const faltan = COLUMNAS.filter((c) => !encabezados.includes(c));
  if (faltan.length > 0) throw new Error("Faltan estas columnas en la hoja: " + faltan.join(", "));

  return filas
    .slice(1)
    .map((fila) => Object.fromEntries(encabezados.map((h, i) => [h, (fila[i] ?? "").trim()])))
    .filter((o) => o.codigo && o.subcodigo);        // ignora las filas vacías
}

// Convierte "60", "60.00", "L 1,200.50" o "45,5" en un número
function aNumero(texto) {
  let t = String(texto ?? "").replace(/[^\d.,-]/g, "");
  if (t === "") return NaN;
  const ultimaComa = t.lastIndexOf(",");
  const ultimoPunto = t.lastIndexOf(".");
  if (ultimaComa > ultimoPunto) {
    const decimales = t.length - ultimaComa - 1;
    const esMiles = ultimoPunto === -1 && decimales === 3;   // "1,200" = mil doscientos
    t = esMiles ? t.replace(/,/g, "") : t.replace(/\./g, "").replace(",", ".");
  } else {
    t = t.replace(/,/g, "");
  }
  return Number(t);
}

// Minúsculas y sin tildes, para que "Joyería" y "joyeria" se busquen igual
function normalizar(texto) {
  return String(texto ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

// Junta las filas que tienen el mismo "codigo" en un solo producto con varios estilos
function agruparProductos(filas) {
  const porCodigo = new Map();

  for (const f of filas) {
    const detalle = aNumero(f.precio_detalle);
    const mayoreo = aNumero(f.precio_mayoreo);
    const minimo = aNumero(f.minimo_mayoreo);

    let producto = porCodigo.get(f.codigo);
    if (!producto) {
      producto = {
        codigo: f.codigo,
        categoria: f.categoria,
        subcategoria: f.subcategoria,
        nombre: f.nombre,
        precioDetalle: detalle,
        precioMayoreo: mayoreo,
        minimoMayoreo: minimo,
        estilos: [],
      };
      porCodigo.set(f.codigo, producto);
    } else if (detalle !== producto.precioDetalle || mayoreo !== producto.precioMayoreo || minimo !== producto.minimoMayoreo) {
      // Los precios deben ser iguales en todas las filas del mismo código. Si no, se usan los de la primera.
      console.warn("Precios distintos dentro del código " + f.codigo + " (fila " + f.subcodigo + "). Se usan los de la primera fila.");
    }

    producto.estilos.push({
      subcodigo: f.subcodigo,
      nombre: f.estilo,
      foto: f.foto,
      disponible: normalizar(f.estado) === "disponible",   // cualquier otra cosa cuenta como agotado
    });
  }
  return [...porCodigo.values()];
}

async function cargarCatalogo() {
  const respuesta = await fetch(CONFIG.urlHoja, { cache: "no-cache" });
  if (!respuesta.ok) throw new Error("La hoja respondió con el error " + respuesta.status);
  const texto = await respuesta.text();
  return agruparProductos(filasAObjetos(leerCSV(texto)));
}


/* ---------------------------------------------------------------------
   2. PEDIDO: cantidades, mayoreo y totales
   --------------------------------------------------------------------- */

function tieneMayoreo(p) {
  return Number.isFinite(p.precioMayoreo) && Number.isFinite(p.minimoMayoreo) && p.minimoMayoreo >= 1;
}

// Unidades del producto en el pedido, SUMANDO todos sus estilos
function unidadesDe(p) {
  return p.estilos.reduce((suma, e) => suma + (carrito[e.subcodigo] || 0), 0);
}

// La regla del mayoreo: desde el mínimo, se aplica a todas las unidades del código
function aplicaMayoreo(p) {
  return tieneMayoreo(p) && unidadesDe(p) >= p.minimoMayoreo;
}

function precioUnitario(p) {
  return aplicaMayoreo(p) ? p.precioMayoreo : p.precioDetalle;
}

// Cada línea del pedido: un estilo con su cantidad y su precio
function lineasDelPedido() {
  const lineas = [];
  for (const [subcodigo, cantidad] of Object.entries(carrito)) {
    const dato = indiceEstilos.get(subcodigo);
    if (!dato) continue;
    const precio = precioUnitario(dato.producto);
    lineas.push({
      producto: dato.producto,
      estilo: dato.estilo,
      cantidad,
      precio,
      subtotal: precio * cantidad,
      mayoreo: aplicaMayoreo(dato.producto),
    });
  }
  return lineas;
}

const totalDelPedido = (lineas) => lineas.reduce((suma, l) => suma + l.subtotal, 0);
const totalUnidades = () => Object.values(carrito).reduce((suma, n) => suma + n, 0);

function cambiarCantidad(estilo, cambio) {
  const nueva = Math.min(999, Math.max(0, (carrito[estilo.subcodigo] || 0) + cambio));
  if (nueva === 0) delete carrito[estilo.subcodigo];
  else carrito[estilo.subcodigo] = nueva;

  guardar();
  refrescarTarjeta(indiceEstilos.get(estilo.subcodigo).producto);
  dibujarPedido();
}

// El pedido se guarda en el navegador para que no se pierda si recargan la página
function guardar() {
  try {
    localStorage.setItem(CLAVE_GUARDADO, JSON.stringify({ carrito, nombre: nombreCliente }));
  } catch (e) { /* si el navegador no deja guardar, la página sigue funcionando */ }
}

function recuperar() {
  try {
    const datos = JSON.parse(localStorage.getItem(CLAVE_GUARDADO) || "{}");
    if (datos.carrito && typeof datos.carrito === "object") carrito = datos.carrito;
    if (typeof datos.nombre === "string") nombreCliente = datos.nombre;
  } catch (e) { carrito = {}; }
}

// Quita del pedido lo que ya no existe en la hoja o se agotó desde la última visita
function limpiarPedido() {
  let quitados = 0;
  for (const subcodigo of Object.keys(carrito)) {
    const dato = indiceEstilos.get(subcodigo);
    const cantidadValida = Number.isInteger(carrito[subcodigo]) && carrito[subcodigo] > 0;
    if (!dato || !dato.estilo.disponible || !Number.isFinite(dato.producto.precioDetalle) || !cantidadValida) {
      delete carrito[subcodigo];
      quitados++;
    }
  }
  if (quitados > 0) {
    guardar();
    textoAviso = quitados === 1
      ? "Quitamos 1 estilo de tu pedido porque ya no está disponible."
      : "Quitamos " + quitados + " estilos de tu pedido porque ya no están disponibles.";
  }
}


/* ---------------------------------------------------------------------
   3. PANTALLA: dibujar tarjetas, filtros y pedido
   --------------------------------------------------------------------- */

// el("div", { class: "caja", texto: "Hola" }, hijo1, hijo2)
// Crea un elemento HTML. Usa textContent, así el texto de la hoja nunca se interpreta como código.
function el(etiqueta, propiedades = {}, ...hijos) {
  const nodo = document.createElement(etiqueta);
  for (const [clave, valor] of Object.entries(propiedades)) {
    if (valor === false || valor == null) continue;
    if (clave === "class") nodo.className = valor;
    else if (clave === "texto") nodo.textContent = valor;
    else if (clave.startsWith("on")) nodo.addEventListener(clave.slice(2), valor);
    else nodo.setAttribute(clave, valor === true ? "" : valor);
  }
  for (const hijo of hijos.flat()) {
    if (hijo != null && hijo !== false) nodo.append(hijo);
  }
  return nodo;
}

function dinero(numero) {
  return CONFIG.moneda + " " + numero.toLocaleString("es-HN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Al redibujar una zona, el teclado pierde el foco. Esto lo devuelve al botón equivalente.
function restaurarFoco(contenedor, id) {
  if (!id) return;
  const destino =
    contenedor.querySelector('[data-foco="' + CSS.escape(id) + '"]:not([disabled])') ||
    contenedor.querySelector('[data-foco^="mas"]:not([disabled])');
  if (destino) destino.focus();
}

function conservarFoco(contenedor, redibujar) {
  const activo = document.activeElement;
  const id = contenedor.contains(activo) ? activo.dataset.foco : null;
  redibujar();
  restaurarFoco(contenedor, id);
}

function crearFoto(estilo, textoAlternativo, esMiniatura = false) {
  const vacia = () => el("span", { class: "foto-vacia", texto: esMiniatura ? "" : "Sin foto" });
  if (!estilo.foto) return vacia();
  const img = el("img", {
    src: CONFIG.carpetaFotos + encodeURIComponent(estilo.foto),
    alt: textoAlternativo,
    loading: "lazy",
  });
  img.addEventListener("error", () => img.replaceWith(vacia()));   // si la foto no existe, muestra un recuadro
  return img;
}

// Botones  −  2  +  (se usan en las tarjetas y en el pedido)
function crearContador(cantidad, alCambiar, etiqueta, idFoco) {
  return el("div", { class: "contador-cantidad", role: "group", "aria-label": "Cantidad de " + etiqueta },
    el("button", { type: "button", "aria-label": "Quitar uno", "data-foco": "menos" + idFoco, disabled: cantidad === 0, onclick: () => alCambiar(-1) }, "−"),
    el("span", { class: "contador-cantidad__numero", texto: String(cantidad) }),
    el("button", { type: "button", "aria-label": "Agregar uno", "data-foco": "mas" + idFoco, onclick: () => alCambiar(1) }, "+"),
  );
}

// ----- Tarjeta de producto -----

function estiloActual(p) {
  const elegido = p.estilos.find((e) => e.subcodigo === seleccion[p.codigo]);
  return elegido || p.estilos.find((e) => e.disponible) || p.estilos[0];
}

function crearMiniatura(p, estilo, actual) {
  const cantidad = carrito[estilo.subcodigo] || 0;
  const elegida = estilo.subcodigo === actual.subcodigo;
  const descripcion = (estilo.nombre || estilo.subcodigo) + (estilo.disponible ? "" : ", agotado") + (cantidad ? ", " + cantidad + " en tu pedido" : "");
  return el("button", {
    type: "button",
    class: "miniatura" + (elegida ? " miniatura--activa" : "") + (estilo.disponible ? "" : " miniatura--agotada"),
    "aria-label": descripcion,
    "aria-pressed": String(elegida),
    "data-foco": "estilo-" + estilo.subcodigo,
    onclick: () => { seleccion[p.codigo] = estilo.subcodigo; refrescarTarjeta(p); },
  },
    crearFoto(estilo, "", true),
    cantidad > 0 && el("span", { class: "miniatura__cantidad", texto: String(cantidad), "aria-hidden": "true" }),
  );
}

function crearTarjeta(p) {
  const estilo = estiloActual(p);
  const cantidad = carrito[estilo.subcodigo] || 0;
  const unidades = unidadesDe(p);
  const todosAgotados = p.estilos.every((e) => !e.disponible);
  const precioValido = Number.isFinite(p.precioDetalle);

  // Etiqueta sobre la foto
  let etiqueta = ["Disponible", "etiqueta--ok"];
  if (todosAgotados) etiqueta = ["Agotado", "etiqueta--agotado"];
  else if (!estilo.disponible) etiqueta = ["Este estilo está agotado", "etiqueta--agotado"];

  // Aviso del mayoreo (suma todos los estilos del mismo código)
  let aviso = null;
  if (tieneMayoreo(p)) {
    if (aplicaMayoreo(p)) {
      aviso = el("p", { class: "aviso-mayoreo aviso-mayoreo--ok", texto: unidades + " u. en total · mayoreo aplicado" });
    } else if (unidades > 0) {
      aviso = el("p", { class: "aviso-mayoreo", texto: unidades + " u. en total · agrega " + (p.minimoMayoreo - unidades) + " más para mayoreo" });
    } else if (p.estilos.length > 1) {
      aviso = el("p", { class: "aviso-mayoreo", texto: "El mayoreo suma todos los estilos" });
    }
  }

  // Botón "Agregar" o contador, según haya algo en el pedido
  let accion;
  if (todosAgotados || !estilo.disponible) {
    accion = el("button", { type: "button", class: "boton boton--agregar", disabled: true }, "No disponible");
  } else if (!precioValido) {
    accion = el("button", { type: "button", class: "boton boton--agregar", disabled: true }, "Consultar precio");
  } else if (cantidad === 0) {
    accion = el("button", { type: "button", class: "boton boton--agregar", "data-foco": "mas", onclick: () => cambiarCantidad(estilo, 1) }, "Agregar");
  } else {
    accion = crearContador(cantidad, (c) => cambiarCantidad(estilo, c), estilo.nombre || p.nombre, "");
  }

  return el("article", { class: "tarjeta" },
    el("div", { class: "tarjeta__foto" },
      crearFoto(estilo, p.nombre + (estilo.nombre ? ", " + estilo.nombre : "")),
      el("span", { class: "etiqueta " + etiqueta[1], texto: etiqueta[0] }),
    ),
    el("div", { class: "tarjeta__cuerpo" },
      el("p", { class: "tarjeta__categoria" }, [p.categoria, p.subcategoria, p.codigo].filter(Boolean).map((t) => el("span", { texto: t }))),
      el("h2", { texto: p.nombre }),
      p.estilos.length === 1 && estilo.nombre && el("p", { class: "estilo-unico", texto: estilo.nombre }),
      el("div", { class: "precios" },
        el("div", { class: "precio-fila" },
          el("span", { class: "precio-etiqueta", texto: "Detalle" }),
          el("span", { class: "precio-valor", texto: precioValido ? dinero(p.precioDetalle) : "Consultar" }),
        ),
        tieneMayoreo(p) && el("div", { class: "mayoreo" + (aplicaMayoreo(p) ? " mayoreo--activo" : "") },
          el("span", { texto: "Mayoreo desde " + p.minimoMayoreo + " u." }),
          el("strong", { texto: dinero(p.precioMayoreo) }),
        ),
      ),
      p.estilos.length > 1 && el("div", { class: "estilos" },
        el("span", { class: "estilos__titulo", texto: "Estilos" }),
        el("div", { class: "estilos__lista" }, p.estilos.map((e) => crearMiniatura(p, e, estilo))),
        el("span", { class: "estilos__nombre", texto: estilo.nombre }),
      ),
      aviso,
      el("div", { class: "tarjeta__acciones" }, accion),
    ),
  );
}

// Redibuja solo la tarjeta que cambió (no toda la lista)
function refrescarTarjeta(p) {
  const vieja = tarjetas.get(p.codigo);
  if (!vieja || !vieja.isConnected) return;
  const id = vieja.contains(document.activeElement) ? document.activeElement.dataset.foco : null;
  const nueva = crearTarjeta(p);
  vieja.replaceWith(nueva);
  tarjetas.set(p.codigo, nueva);
  restaurarFoco(nueva, id);
}

// ----- Filtros y lista de productos -----

function productosVisibles() {
  const palabras = normalizar(filtros.texto).split(/\s+/).filter(Boolean);
  return productos.filter((p) => {
    if (filtros.categoria !== TODO && p.categoria !== filtros.categoria) return false;
    if (filtros.subcategoria !== TODAS && p.subcategoria !== filtros.subcategoria) return false;
    if (palabras.length === 0) return true;
    const texto = normalizar([p.codigo, p.nombre, p.categoria, p.subcategoria, ...p.estilos.map((e) => e.nombre + " " + e.subcodigo)].join(" "));
    return palabras.every((palabra) => texto.includes(palabra));   // deben aparecer todas las palabras
  });
}

function crearChip(texto, activo, alTocar) {
  return el("button", { type: "button", class: "chip", "aria-pressed": String(activo), "data-foco": "chip-" + texto, onclick: alTocar }, texto);
}

function dibujarFiltros() {
  const categorias = [...new Set(productos.map((p) => p.categoria).filter(Boolean))];
  const navCategorias = $("#categorias");
  const navSub = $("#subcategorias");

  const subcategorias = filtros.categoria === TODO
    ? []
    : [...new Set(productos.filter((p) => p.categoria === filtros.categoria).map((p) => p.subcategoria).filter(Boolean))];

  const id = (navCategorias.contains(document.activeElement) || navSub.contains(document.activeElement))
    ? document.activeElement.dataset.foco : null;

  navCategorias.replaceChildren(...[TODO, ...categorias].map((c) =>
    crearChip(c, c === filtros.categoria, () => {
      filtros.categoria = c;
      filtros.subcategoria = TODAS;
      dibujarFiltros();
      dibujarProductos();
    })));

  navSub.hidden = subcategorias.length === 0;
  navSub.replaceChildren(...(subcategorias.length ? [TODAS, ...subcategorias] : []).map((s) =>
    crearChip(s, s === filtros.subcategoria, () => {
      filtros.subcategoria = s;
      dibujarFiltros();
      dibujarProductos();
    })));

  if (id) {
    const destino = [...document.querySelectorAll("#categorias [data-foco], #subcategorias [data-foco]")].find((n) => n.dataset.foco === id);
    if (destino) destino.focus();
  }
}

function dibujarProductos() {
  const visibles = productosVisibles();
  const contenedor = $("#productos");
  tarjetas.clear();
  contenedor.replaceChildren();

  for (const p of visibles) {
    const tarjeta = crearTarjeta(p);
    tarjetas.set(p.codigo, tarjeta);
    contenedor.append(tarjeta);
  }
  if (visibles.length === 0) {
    contenedor.append(el("p", { class: "vacio", texto: "No encontramos productos con esa búsqueda." }));
  }
  $("#resumen").textContent = visibles.length === 1 ? "1 producto" : visibles.length + " productos";
}

// ----- Panel del pedido -----

function crearLinea(l) {
  const nombreEstilo = [l.estilo.nombre, l.estilo.subcodigo].filter(Boolean).join(" · ");
  return el("li", { class: "linea" },
    el("div", { class: "linea__datos" },
      el("strong", { texto: l.producto.nombre }),
      el("span", { class: "linea__estilo", texto: nombreEstilo }),
      el("span", { class: "linea__precio", texto: l.cantidad + " × " + dinero(l.precio) }),
      el("span", { class: "etiqueta-mini" + (l.mayoreo ? " etiqueta-mini--mayoreo" : ""), texto: l.mayoreo ? "Precio de mayoreo" : "Precio al detalle" }),
    ),
    el("div", { class: "linea__acciones" },
      el("strong", { texto: dinero(l.subtotal) }),
      crearContador(l.cantidad, (c) => cambiarCantidad(l.estilo, c), l.estilo.nombre || l.producto.nombre, "-" + l.estilo.subcodigo),
    ),
  );
}

function dibujarPedido() {
  const lineas = lineasDelPedido();
  const unidades = totalUnidades();

  $("#contador").textContent = String(unidades);
  $("#abrir-pedido").setAttribute("aria-label", "Mi pedido, " + unidades + (unidades === 1 ? " unidad" : " unidades"));

  const lista = $("#lineas");
  conservarFoco(lista, () => {
    lista.replaceChildren(...(lineas.length
      ? lineas.map(crearLinea)
      : [el("li", { class: "lineas__vacio", texto: "Todavía no has agregado productos." })]));
  });

  $("#total").textContent = dinero(totalDelPedido(lineas));
  $("#revisar").disabled = lineas.length === 0;
  $("#vaciar").hidden = lineas.length === 0;

  const aviso = $("#aviso-pedido");
  aviso.textContent = textoAviso;
  aviso.hidden = textoAviso === "";
}

function dibujarConfirmacion() {
  const lineas = lineasDelPedido();
  $("#lineas-confirmar").replaceChildren(...lineas.map((l) =>
    el("li", { class: "linea" },
      el("div", { class: "linea__datos" },
        el("strong", { texto: l.producto.nombre }),
        el("span", { class: "linea__estilo", texto: [l.estilo.nombre, l.estilo.subcodigo].filter(Boolean).join(" · ") }),
        el("span", { class: "linea__precio", texto: l.cantidad + " × " + dinero(l.precio) }),
      ),
      el("strong", { texto: dinero(l.subtotal) }),
    )));
  $("#total-confirmar").textContent = dinero(totalDelPedido(lineas));
}

function mostrarVista(vista) {
  const enLista = vista === "lista";
  $("#vista-lista").hidden = !enLista;
  $("#vista-confirmar").hidden = enLista;
  $("#pedido-titulo").textContent = enLista ? "Tu pedido" : "Confirma tu pedido";
}


/* ---------------------------------------------------------------------
   4. WHATSAPP: armar el mensaje y abrir el chat
   --------------------------------------------------------------------- */

function armarMensaje() {
  const lineas = lineasDelPedido();
  const detalle = lineas.map((l) => {
    const estilo = [l.estilo.nombre, "(" + l.estilo.subcodigo + ")"].filter(Boolean).join(" ");
    return "• " + l.producto.codigo + " · " + l.producto.nombre + " — " + estilo +
      " × " + l.cantidad + " a " + dinero(l.precio) + " = " + dinero(l.subtotal) +
      (l.mayoreo ? " (mayoreo)" : "");
  });
  return [
    "Hola, quiero hacer este pedido:",
    "",
    "Nombre: " + nombreCliente,
    "",
    ...detalle,
    "",
    "Total estimado: " + dinero(totalDelPedido(lineas)),
    "(Precios y disponibilidad por confirmar.)",
  ].join("\n");
}

function enviarPorWhatsApp() {
  const aviso = $("#aviso-whatsapp");
  if (!/^\d{8,15}$/.test(CONFIG.whatsapp)) {
    aviso.textContent = "Falta configurar el número de WhatsApp de la tienda (CONFIG.whatsapp en app.js).";
    aviso.hidden = false;
    return;
  }
  aviso.hidden = true;
  const url = "https://wa.me/" + CONFIG.whatsapp + "?text=" + encodeURIComponent(armarMensaje());
  window.open(url, "_blank", "noopener");
}


/* ---------------------------------------------------------------------
   5. ARRANQUE: conectar los botones y cargar el catálogo
   --------------------------------------------------------------------- */

function mostrarMensaje(texto, detalle, conReintento) {
  const caja = $("#mensaje");
  caja.replaceChildren(
    el("p", { texto }),
    detalle && el("small", { texto: detalle }),
    conReintento && el("div", {}, el("button", { type: "button", class: "boton boton--agregar", onclick: cargarYMostrar }, "Reintentar")),
  );
  caja.hidden = false;
}

function conectarEventos() {
  const dialogo = $("#pedido");

  // Buscador
  $("#form-buscar").addEventListener("submit", (e) => e.preventDefault());
  $("#buscador").addEventListener("input", (e) => {
    filtros.texto = e.target.value;
    dibujarProductos();
  });

  // Abrir y cerrar el panel del pedido
  $("#abrir-pedido").addEventListener("click", () => {
    dibujarPedido();
    mostrarVista("lista");
    $("#nombre").value = nombreCliente;
    dialogo.showModal();
  });
  $("#cerrar-pedido").addEventListener("click", () => dialogo.close());
  dialogo.addEventListener("click", (e) => { if (e.target === dialogo) dialogo.close(); });   // clic fuera del panel

  // Nombre del cliente
  $("#nombre").addEventListener("input", (e) => {
    nombreCliente = e.target.value.trim();
    $("#error-nombre").hidden = true;
    guardar();
  });

  // Pasar a la confirmación
  $("#revisar").addEventListener("click", () => {
    const nombre = $("#nombre").value.trim();
    if (nombre === "") {
      $("#error-nombre").hidden = false;
      $("#nombre").focus();
      return;
    }
    nombreCliente = nombre;
    guardar();
    textoAviso = "";
    dibujarConfirmacion();
    $("#aviso-whatsapp").hidden = true;
    mostrarVista("confirmar");
  });

  $("#volver").addEventListener("click", () => { dibujarPedido(); mostrarVista("lista"); });
  $("#enviar").addEventListener("click", enviarPorWhatsApp);

  $("#vaciar").addEventListener("click", () => {
    if (!confirm("¿Quieres vaciar todo tu pedido?")) return;
    carrito = {};
    textoAviso = "";
    guardar();
    dibujarProductos();
    dibujarPedido();
  });
}

async function cargarYMostrar() {
  mostrarMensaje("Cargando catálogo…", "", false);
  try {
    productos = await cargarCatalogo();
    indiceEstilos.clear();
    for (const p of productos) for (const e of p.estilos) indiceEstilos.set(e.subcodigo, { producto: p, estilo: e });

    limpiarPedido();
    $("#mensaje").hidden = true;
    dibujarFiltros();
    dibujarProductos();
    dibujarPedido();
    if (productos.length === 0) mostrarMensaje("Todavía no hay productos en el catálogo.", "", false);
  } catch (error) {
    console.error(error);
    mostrarMensaje("No pudimos cargar el catálogo. Revisa tu conexión e inténtalo de nuevo.", error.message, true);
  }
}

function iniciar() {
  document.title = "Catálogo · " + CONFIG.nombreTienda;
  $("#marca").textContent = CONFIG.nombreTienda;
  recuperar();
  conectarEventos();
  dibujarPedido();
  cargarYMostrar();
}

iniciar();
