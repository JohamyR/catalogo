/* =====================================================================
   CATÁLOGO EN LÍNEA — app.js (versión 2)
   0. Configuración  1. Datos  2. Pedido  3. Pantalla  4. WhatsApp  5. Arranque
   ===================================================================== */

/* ---------- 0. CONFIGURACIÓN ---------- */
const CONFIG = {
  // Enlaces CSV de la hoja nueva (Archivo → Compartir → Publicar en la web). CAMBIA los dos.
  urlHoja: "https://docs.google.com/spreadsheets/d/e/2PACX-1vSHZelMH812y1XOIAeyC3Y-bwtHAg8w4wIkDqqGxw0cvYja53_hFmf_4Wxt3ZqPjQ/pub?gid=630024380&single=true&output=csv",
  urlAnuncios: "https://docs.google.com/spreadsheets/d/e/2PACX-1vSHZelMH812y1XOIAeyC3Y-bwtHAg8w4wIkDqqGxw0cvYja53_hFmf_4Wxt3ZqPjQ/pub?gid=2076843561&single=true&output=csv",                    // pestaña Anuncios; si queda vacío, el carrusel no se muestra
  whatsapp: "50497646605",            // con código de país, sin signos ni espacios
  nombreTienda: "Mey Variedades",
  moneda: "L",
  carpetaFotos: "fotos/",
  productosPorPagina: 20,             // tarjetas por página en la portada
};

// Columnas obligatorias de la pestaña Catalogo ("etiqueta" es opcional)
const COLUMNAS = ["codigo", "subcodigo", "categoria", "subcategoria", "nombre", "estilo", "foto", "precio", "estado"];

const TODO = "Todo";
const TODAS = "Todas";
const CLAVE_GUARDADO = "catalogo-pedido-v1";

/* ---------- Estado de la página ---------- */
let productos = [];
let anuncios = [];
const indiceEstilos = new Map();     // subcodigo -> { producto, estilo }
const filtros = { categoria: TODO, subcategoria: TODAS, texto: "" };
const seleccion = {};                // codigo -> subcodigo del estilo que se está viendo
const tarjetas = new Map();          // codigo -> tarjeta dibujada (solo la página actual)
let carrito = {};                    // subcodigo -> cantidad
let nombreCliente = "";
let textoAviso = "";
let pagina = 1;
let scrollCatalogo = 0;
let vinoDelCatalogo = false;
let ultimoVisto = "";
const $ = (selector) => document.querySelector(selector);

/* ---------- 1. DATOS ---------- */

// Convierte el texto CSV en filas de celdas (entiende comillas, comas y saltos de línea)
function leerCSV(texto) {
  if (texto.charCodeAt(0) === 0xFEFF) texto = texto.slice(1);
  const filas = [];
  let fila = [];
  let celda = "";
  let entreComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (entreComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') { celda += '"'; i++; }
        else entreComillas = false;
      } else celda += c;
    } else if (c === '"') entreComillas = true;
    else if (c === ",") { fila.push(celda); celda = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      fila.push(celda); filas.push(fila); fila = []; celda = "";
    } else celda += c;
  }
  if (celda !== "" || fila.length > 0) { fila.push(celda); filas.push(fila); }
  return filas;
}

// Filas → objetos { codigo: "J-101", ... }. "obligatorias" es la lista de columnas que deben existir.
function filasAObjetos(filas, obligatorias) {
  if (filas.length === 0) throw new Error("La hoja está vacía.");
  const encabezados = filas[0].map((h) => h.trim().toLowerCase());
  const faltan = obligatorias.filter((c) => !encabezados.includes(c));
  if (faltan.length > 0) throw new Error("Faltan estas columnas en la hoja: " + faltan.join(", "));
  return filas.slice(1).map((fila) => Object.fromEntries(encabezados.map((h, i) => [h, (fila[i] ?? "").trim()])));
}

// "60", "60.00", "L 1,200.50" o "45,5" → número
function aNumero(texto) {
  let t = String(texto ?? "").replace(/[^\d.,-]/g, "");
  if (t === "") return NaN;
  const ultimaComa = t.lastIndexOf(",");
  const ultimoPunto = t.lastIndexOf(".");
  if (ultimaComa > ultimoPunto) {
    const decimales = t.length - ultimaComa - 1;
    const esMiles = ultimoPunto === -1 && decimales === 3;
    t = esMiles ? t.replace(/,/g, "") : t.replace(/\./g, "").replace(",", ".");
  } else t = t.replace(/,/g, "");
  return Number(t);
}

// Minúsculas y sin tildes: "Joyería" y "joyeria" se buscan igual
function normalizar(texto) {
  return String(texto ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

const mismoNumero = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));

// Junta las filas con el mismo "codigo" en un producto con varios estilos
function agruparProductos(filas) {
  const porCodigo = new Map();
  for (const f of filas.filter((o) => o.codigo && o.subcodigo)) {
    const precio = aNumero(f.precio);
    let producto = porCodigo.get(f.codigo);
    if (!producto) {
      producto = { codigo: f.codigo, categoria: f.categoria, subcategoria: f.subcategoria, nombre: f.nombre, precio, etiqueta: "", estilos: [] };
      porCodigo.set(f.codigo, producto);
    } else if (!mismoNumero(precio, producto.precio)) {
      console.warn("Precios distintos dentro del código " + f.codigo + " (fila " + f.subcodigo + "). Se usa el de la primera fila.");
    }
    if (!producto.etiqueta && f.etiqueta) producto.etiqueta = f.etiqueta;   // basta con ponerla en una fila del código
    producto.estilos.push({ subcodigo: f.subcodigo, nombre: f.estilo, foto: f.foto, disponible: normalizar(f.estado) === "disponible" });
  }
  return [...porCodigo.values()];
}

async function cargarCatalogo() {
  const respuesta = await fetch(CONFIG.urlHoja, { cache: "no-cache" });
  if (!respuesta.ok) throw new Error("La hoja respondió con el error " + respuesta.status);
  return agruparProductos(filasAObjetos(leerCSV(await respuesta.text()), COLUMNAS));
}

// Los anuncios son opcionales: si algo falla, el catálogo sigue funcionando sin carrusel
async function cargarAnuncios() {
  if (!/^https?:\/\//.test(CONFIG.urlAnuncios)) return [];
  try {
    const respuesta = await fetch(CONFIG.urlAnuncios, { cache: "no-cache" });
    if (!respuesta.ok) return [];
    const filas = filasAObjetos(leerCSV(await respuesta.text()), ["titulo", "activo"]);
    return filas.filter((a) => a.titulo && normalizar(a.activo) === "si");
  } catch (e) {
    console.warn("No se pudieron cargar los anuncios:", e);
    return [];
  }
}

/* ---------- 2. PEDIDO (un solo precio por producto) ---------- */

const unidadesDe = (p) => p.estilos.reduce((suma, e) => suma + (carrito[e.subcodigo] || 0), 0);

function lineasDelPedido() {
  const lineas = [];
  for (const [subcodigo, cantidad] of Object.entries(carrito)) {
    const dato = indiceEstilos.get(subcodigo);
    if (!dato) continue;
    const precio = dato.producto.precio;
    lineas.push({ producto: dato.producto, estilo: dato.estilo, cantidad, precio, subtotal: precio * cantidad });
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
  const producto = indiceEstilos.get(estilo.subcodigo).producto;
  if (productoDeRuta() === producto) refrescarDetalle(producto);
  else refrescarTarjeta(producto);
  dibujarPedido();
}

// El pedido se guarda en el navegador para que no se pierda al recargar
function guardar() {
  try { localStorage.setItem(CLAVE_GUARDADO, JSON.stringify({ carrito, nombre: nombreCliente })); } catch (e) { /* sigue funcionando */ }
}

function recuperar() {
  try {
    const datos = JSON.parse(localStorage.getItem(CLAVE_GUARDADO) || "{}");
    if (datos.carrito && typeof datos.carrito === "object") carrito = datos.carrito;
    if (typeof datos.nombre === "string") nombreCliente = datos.nombre;
  } catch (e) { carrito = {}; }
}

// Quita del pedido lo que ya no existe o se agotó desde la última visita
function limpiarPedido() {
  let quitados = 0;
  for (const subcodigo of Object.keys(carrito)) {
    const dato = indiceEstilos.get(subcodigo);
    const cantidadValida = Number.isInteger(carrito[subcodigo]) && carrito[subcodigo] > 0;
    if (!dato || !dato.estilo.disponible || !Number.isFinite(dato.producto.precio) || !cantidadValida) {
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

/* ---------- 3. PANTALLA ---------- */

// el("div", { class: "caja", texto: "Hola" }, hijo1, hijo2) → crea un elemento (usa textContent: el texto de la hoja nunca es código)
function el(etiqueta, propiedades = {}, ...hijos) {
  const nodo = document.createElement(etiqueta);
  for (const [clave, valor] of Object.entries(propiedades)) {
    if (valor === false || valor == null) continue;
    if (clave === "class") nodo.className = valor;
    else if (clave === "texto") nodo.textContent = valor;
    else if (clave.startsWith("on")) nodo.addEventListener(clave.slice(2), valor);
    else nodo.setAttribute(clave, valor === true ? "" : valor);
  }
  for (const hijo of hijos.flat()) if (hijo != null && hijo !== false) nodo.append(hijo);
  return nodo;
}

function dinero(numero) {
  return CONFIG.moneda + " " + numero.toLocaleString("es-HN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Enlace que abre WhatsApp con un mensaje ya escrito (para precios mayoristas, anuncios, etc.)
function enlaceWhatsApp(mensaje) {
  return "https://wa.me/" + CONFIG.whatsapp + "?text=" + encodeURIComponent(mensaje);
}

// Al redibujar una zona el teclado pierde el foco: esto lo devuelve al botón equivalente
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
  const img = el("img", { src: CONFIG.carpetaFotos + encodeURIComponent(estilo.foto), alt: textoAlternativo, loading: "lazy" });
  img.addEventListener("error", () => img.replaceWith(vacia()));
  return img;
}

// Botones  −  2  +
function crearContador(cantidad, alCambiar, etiqueta, idFoco) {
  return el("div", { class: "contador-cantidad", role: "group", "aria-label": "Cantidad de " + etiqueta },
    el("button", { type: "button", "aria-label": "Quitar uno", "data-foco": "menos" + idFoco, disabled: cantidad === 0, onclick: () => alCambiar(-1) }, "−"),
    el("span", { class: "contador-cantidad__numero", texto: String(cantidad) }),
    el("button", { type: "button", "aria-label": "Agregar uno", "data-foco": "mas" + idFoco, onclick: () => alCambiar(1) }, "+"),
  );
}

// ----- Carrusel de anuncios (pestaña Anuncios) -----
function crearAnuncio(a, i, total) {
  const producto = productos.find((p) => p.codigo === a.enlace);
  let boton = null;
  if (normalizar(a.enlace) === "whatsapp") {
    boton = el("a", { class: "anuncio__boton", href: enlaceWhatsApp("Hola, quiero información sobre precios mayoristas."), target: "_blank", rel: "noopener" }, a.boton || "Escribir por WhatsApp");
  } else if (producto) {
    boton = el("a", {
      class: "anuncio__boton", href: "#/producto/" + encodeURIComponent(producto.codigo),
      onclick: () => { scrollCatalogo = window.scrollY; vinoDelCatalogo = true; },
    }, a.boton || "Ver producto");
  }
  return el("article", { class: "anuncio", role: "group", "aria-roledescription": "diapositiva", "aria-label": (i + 1) + " de " + total },
    a.foto && el("div", { class: "anuncio__foto" }, crearFoto({ foto: a.foto }, "")),
    el("div", { class: "anuncio__texto" },
      a.etiqueta && el("span", { class: "anuncio__etiqueta", texto: a.etiqueta }),
      el("h2", { texto: a.titulo }),
      a.texto && el("p", { texto: a.texto }),
      boton,
    ),
  );
}

function dibujarAnuncios() {
  const seccion = $("#anuncios");
  seccion.hidden = anuncios.length === 0;
  if (anuncios.length === 0) return;

  const pista = el("div", { class: "carrusel__pista" }, anuncios.map((a, i) => crearAnuncio(a, i, anuncios.length)));
  const puntos = anuncios.map(() => el("span", { class: "carrusel__punto" }));
  const marcarPunto = () => {
    const ancho = pista.firstElementChild ? pista.firstElementChild.offsetWidth + 12 : 1;
    const actual = Math.min(puntos.length - 1, Math.round(pista.scrollLeft / ancho));
    puntos.forEach((p, i) => p.classList.toggle("carrusel__punto--activo", i === actual));
  };
  const mover = (sentido) => pista.scrollBy({ left: sentido * (pista.firstElementChild.offsetWidth + 12), behavior: "smooth" });

  pista.addEventListener("scroll", marcarPunto, { passive: true });
  seccion.replaceChildren(
    pista,
    anuncios.length > 1 && el("div", { class: "carrusel__controles" },
      el("div", { class: "carrusel__puntos", "aria-hidden": "true" }, puntos),
      el("div", { class: "carrusel__flechas" },
        el("button", { type: "button", "aria-label": "Anterior", onclick: () => mover(-1) }, "←"),
        el("button", { type: "button", "aria-label": "Siguiente", onclick: () => mover(1) }, "→"),
      ),
    ),
  );
  marcarPunto();
}

// ----- Tarjeta de producto (portada) -----
function estiloActual(p) {
  const elegido = p.estilos.find((e) => e.subcodigo === seleccion[p.codigo]);
  return elegido || p.estilos.find((e) => e.disponible) || p.estilos[0];
}

function crearTarjeta(p) {
  const estilo = estiloActual(p);
  const unidades = unidadesDe(p);
  const todosAgotados = p.estilos.every((e) => !e.disponible);
  return el("a", {
    class: "tarjeta",
    href: "#/producto/" + encodeURIComponent(p.codigo),
    onclick: () => { scrollCatalogo = window.scrollY; vinoDelCatalogo = true; },
  },
    el("div", { class: "tarjeta__foto" },
      crearFoto(estilo, p.nombre),
      todosAgotados && el("span", { class: "etiqueta etiqueta--agotado", texto: "Agotado" }),
      unidades > 0 && el("span", { class: "etiqueta etiqueta--pedido", texto: unidades + " en tu pedido" }),
    ),
    el("div", { class: "tarjeta__cuerpo" },
      p.etiqueta && el("p", { class: "tarjeta__etiqueta", texto: p.etiqueta }),
      el("h2", { texto: p.nombre }),
      el("p", { class: "tarjeta__precio", texto: Number.isFinite(p.precio) ? dinero(p.precio) : "Consultar precio" }),
      p.estilos.length > 1 && el("p", { class: "tarjeta__estilos", texto: p.estilos.length + " estilos" }),
    ),
  );
}

// Redibuja solo la tarjeta que cambió (si no está en la página actual, no hace nada)
function refrescarTarjeta(p) {
  const vieja = tarjetas.get(p.codigo);
  if (!vieja || !vieja.isConnected) return;
  const nueva = crearTarjeta(p);
  vieja.replaceWith(nueva);
  tarjetas.set(p.codigo, nueva);
}

// ----- Pantalla de detalle -----
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
    onclick: () => { seleccion[p.codigo] = estilo.subcodigo; refrescarDetalle(p); },
  },
    crearFoto(estilo, "", true),
    cantidad > 0 && el("span", { class: "miniatura__cantidad", texto: String(cantidad), "aria-hidden": "true" }),
  );
}

// Compartir: menú del teléfono si existe; si no, abre WhatsApp con el mensaje listo
async function compartirProducto(p) {
  const url = location.origin + location.pathname + "#/producto/" + encodeURIComponent(p.codigo);
  const texto = "Mira este producto de " + CONFIG.nombreTienda + ": " + p.nombre + (Number.isFinite(p.precio) ? ", " + dinero(p.precio) : "");
  if (navigator.share) {
    try { await navigator.share({ title: p.nombre, text: texto, url }); return; }
    catch (e) { if (e.name === "AbortError") return; }   // si la persona cancela, no hacemos nada
  }
  window.open("https://wa.me/?text=" + encodeURIComponent(texto + "\n" + url), "_blank", "noopener");
}

function crearDetalle(p) {
  const estilo = estiloActual(p);
  const cantidad = carrito[estilo.subcodigo] || 0;
  const todosAgotados = p.estilos.every((e) => !e.disponible);
  const precioValido = Number.isFinite(p.precio);

  let etiqueta = ["Disponible", "etiqueta--ok"];
  if (todosAgotados) etiqueta = ["Agotado", "etiqueta--agotado"];
  else if (!estilo.disponible) etiqueta = ["Este estilo está agotado", "etiqueta--agotado"];

  let accion;
  if (todosAgotados || !estilo.disponible) accion = el("button", { type: "button", class: "boton boton--agregar", disabled: true }, "No disponible");
  else if (!precioValido) accion = el("button", { type: "button", class: "boton boton--agregar", disabled: true }, "Consultar precio");
  else if (cantidad === 0) accion = el("button", { type: "button", class: "boton boton--agregar", "data-foco": "mas", onclick: () => cambiarCantidad(estilo, 1) }, "Agregar");
  else accion = crearContador(cantidad, (c) => cambiarCantidad(estilo, c), estilo.nombre || p.nombre, "");

  return el("div", { class: "detalle" },
    el("div", { class: "detalle__foto" },
      crearFoto(estilo, p.nombre + (estilo.nombre ? ", " + estilo.nombre : "")),
      el("span", { class: "etiqueta " + etiqueta[1], texto: etiqueta[0] }),
      p.etiqueta && el("span", { class: "etiqueta etiqueta--destacada", texto: p.etiqueta }),
    ),
    el("div", { class: "detalle__info" },
      el("p", { class: "tarjeta__categoria" }, [p.categoria, p.subcategoria, p.codigo].filter(Boolean).map((t) => el("span", { texto: t }))),
      el("div", { class: "detalle__titulo" },
        el("h1", { id: "detalle-titulo", tabindex: "-1", texto: p.nombre }),
        el("button", { type: "button", class: "boton-compartir", "aria-label": "Compartir producto", onclick: () => compartirProducto(p) }, "Compartir"),
      ),
      p.estilos.length === 1 && estilo.nombre && el("p", { class: "estilo-unico", texto: estilo.nombre }),
      el("div", { class: "precios" },
        el("div", { class: "precio-fila" },
          el("span", { class: "precio-etiqueta", texto: "Precio" }),
          el("span", { class: "precio-valor", texto: precioValido ? dinero(p.precio) : "Consultar" }),
        ),
      ),
      el("a", {
        class: "mayorista", target: "_blank", rel: "noopener",
        href: enlaceWhatsApp("Hola, quiero información de precio mayorista de: " + p.nombre + " (" + p.codigo + ")"),
      }, "¿Precio mayorista o especial? ", el("strong", { texto: "Escríbenos por WhatsApp" })),
      p.estilos.length > 1 && el("div", { class: "estilos" },
        el("span", { class: "estilos__titulo", texto: "Estilos" }),
        el("div", { class: "estilos__lista" }, p.estilos.map((e) => crearMiniatura(p, e, estilo))),
        el("span", { class: "estilos__nombre", texto: estilo.nombre }),
      ),
      el("div", { class: "detalle__acciones" }, accion),
    ),
  );
}

function dibujarDetalle(p) {
  $("#vista-detalle").replaceChildren(
    el("a", {
      class: "volver", href: "#/",
      onclick: (e) => { if (vinoDelCatalogo) { e.preventDefault(); history.back(); } },   // así la portada queda como estaba
    }, "← Volver al catálogo"),
    crearDetalle(p),
  );
}

function refrescarDetalle(p) {
  if (productoDeRuta() !== p) return;
  conservarFoco($("#vista-detalle"), () => dibujarDetalle(p));
}

// ----- Qué pantalla mostrar: portada (#/) o detalle (#/producto/J-101) -----
function productoDeRuta() {
  const coincide = location.hash.match(/^#\/producto\/(.+)$/);
  if (!coincide) return null;
  let codigo;
  try { codigo = decodeURIComponent(coincide[1]); } catch (e) { return null; }
  return productos.find((p) => p.codigo === codigo) || null;
}

function mostrarRuta() {
  const p = productoDeRuta();
  $("#vista-catalogo").hidden = Boolean(p);
  $("#vista-detalle").hidden = !p;
  if (p) {
    ultimoVisto = p.codigo;
    dibujarDetalle(p);
    document.title = p.nombre + " · " + CONFIG.nombreTienda;
    window.scrollTo(0, 0);
    $("#detalle-titulo").focus({ preventScroll: true });
  } else {
    vinoDelCatalogo = false;
    dibujarProductos();
    document.title = "Catálogo · " + CONFIG.nombreTienda;
    window.scrollTo(0, scrollCatalogo);
    const activo = document.activeElement;
    const sinFoco = activo === document.body || $("#vista-detalle").contains(activo);
    const tarjeta = tarjetas.get(ultimoVisto);
    if (sinFoco && tarjeta) tarjeta.focus({ preventScroll: true });
    ultimoVisto = "";
  }
}

// ----- Filtros, lista de productos y páginas -----
function productosVisibles() {
  const palabras = normalizar(filtros.texto).split(/\s+/).filter(Boolean);
  return productos.filter((p) => {
    if (filtros.categoria !== TODO && p.categoria !== filtros.categoria) return false;
    if (filtros.subcategoria !== TODAS && p.subcategoria !== filtros.subcategoria) return false;
    if (palabras.length === 0) return true;
    const texto = normalizar([p.codigo, p.nombre, p.categoria, p.subcategoria, p.etiqueta, ...p.estilos.map((e) => e.nombre + " " + e.subcodigo)].join(" "));
    return palabras.every((palabra) => texto.includes(palabra));   // buscar "navideño" también encuentra esa etiqueta
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
      filtros.categoria = c; filtros.subcategoria = TODAS; pagina = 1;
      dibujarFiltros(); dibujarProductos();
    })));

  navSub.hidden = subcategorias.length === 0;
  navSub.replaceChildren(...(subcategorias.length ? [TODAS, ...subcategorias] : []).map((s) =>
    crearChip(s, s === filtros.subcategoria, () => {
      filtros.subcategoria = s; pagina = 1;
      dibujarFiltros(); dibujarProductos();
    })));

  if (id) {
    const destino = [...document.querySelectorAll("#categorias [data-foco], #subcategorias [data-foco]")].find((n) => n.dataset.foco === id);
    if (destino) destino.focus();
  }
}

// Dibuja solo los productos de la página actual (CONFIG.productosPorPagina por página)
function dibujarProductos() {
  const visibles = productosVisibles();
  const totalPaginas = Math.max(1, Math.ceil(visibles.length / CONFIG.productosPorPagina));
  pagina = Math.min(Math.max(pagina, 1), totalPaginas);
  const inicio = (pagina - 1) * CONFIG.productosPorPagina;

  const contenedor = $("#productos");
  tarjetas.clear();
  contenedor.replaceChildren();
  for (const p of visibles.slice(inicio, inicio + CONFIG.productosPorPagina)) {
    const tarjeta = crearTarjeta(p);
    tarjetas.set(p.codigo, tarjeta);
    contenedor.append(tarjeta);
  }
  if (visibles.length === 0) contenedor.append(el("p", { class: "vacio", texto: "No encontramos productos con esa búsqueda." }));
  $("#resumen").textContent = visibles.length === 1 ? "1 producto" : visibles.length + " productos";
  dibujarPaginas(totalPaginas);
}

// ← Anterior · Página 2 de 5 · Siguiente →  (se ocultan si todo cabe en una página)
function dibujarPaginas(total) {
  const nav = $("#paginas");
  nav.hidden = total <= 1;
  if (total <= 1) return;
  const ir = (n) => { pagina = n; dibujarProductos(); $("#resumen").scrollIntoView(); };
  nav.replaceChildren(
    el("button", { type: "button", disabled: pagina === 1, onclick: () => ir(pagina - 1) }, "← Anterior"),
    el("span", { class: "paginas__estado", texto: "Página " + pagina + " de " + total, "aria-live": "polite" }),
    el("button", { type: "button", disabled: pagina === total, onclick: () => ir(pagina + 1) }, "Siguiente →"),
  );
}

// ----- Panel del pedido -----
function crearLinea(l) {
  const nombreEstilo = [l.estilo.nombre, l.estilo.subcodigo].filter(Boolean).join(" · ");
  return el("li", { class: "linea" },
    el("div", { class: "linea__datos" },
      el("strong", { texto: l.producto.nombre }),
      el("span", { class: "linea__estilo", texto: nombreEstilo }),
      el("span", { class: "linea__precio", texto: l.cantidad + " × " + dinero(l.precio) }),
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

/* ---------- 4. WHATSAPP ---------- */
function armarMensaje() {
  const lineas = lineasDelPedido();
  const grupos = new Map();                       // un grupo por producto, en el orden en que se agregaron
  for (const l of lineas) {
    if (!grupos.has(l.producto.codigo)) grupos.set(l.producto.codigo, []);
    grupos.get(l.producto.codigo).push(l);
  }
  // En WhatsApp, *así* es negrita y _así_ es cursiva
  const bloques = [...grupos.values()].map((items, i) => {
    const p = items[0].producto;
    const unidades = items.reduce((suma, l) => suma + l.cantidad, 0);
    const subtotal = items.reduce((suma, l) => suma + l.subtotal, 0);
    return [
      (i + 1) + ". *" + p.codigo + "* · " + p.nombre,
      "   " + unidades + " u. a " + dinero(p.precio),
      ...items.map((l) => "   • " + [l.estilo.nombre, "(" + l.estilo.subcodigo + ")"].filter(Boolean).join(" ") + " × " + l.cantidad),
      "   Subtotal: *" + dinero(subtotal) + "*",
    ].join("\n");
  });
  return [
    "*PEDIDO DE COTIZACIÓN*",
    "Nombre: " + nombreCliente,
    "",
    bloques.join("\n\n"),
    "",
    "*Total estimado: " + dinero(totalDelPedido(lineas)) + "*",
    "_Precios y disponibilidad por confirmar._",
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
  window.open(enlaceWhatsApp(armarMensaje()), "_blank", "noopener");
}

/* ---------- 5. ARRANQUE ---------- */
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

  $("#form-buscar").addEventListener("submit", (e) => e.preventDefault());
  $("#buscador").addEventListener("input", (e) => {
    filtros.texto = e.target.value;
    pagina = 1;                                          // buscar siempre empieza en la página 1
    if (productoDeRuta()) location.hash = "#/";          // buscar desde un detalle vuelve a la portada
    else dibujarProductos();
  });

  $("#abrir-pedido").addEventListener("click", () => {
    dibujarPedido();
    mostrarVista("lista");
    $("#nombre").value = nombreCliente;
    dialogo.showModal();
  });
  $("#cerrar-pedido").addEventListener("click", () => dialogo.close());
  dialogo.addEventListener("click", (e) => { if (e.target === dialogo) dialogo.close(); });

  $("#nombre").addEventListener("input", (e) => {
    nombreCliente = e.target.value.trim();
    $("#error-nombre").hidden = true;
    guardar();
  });

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
    const abierto = productoDeRuta();
    if (abierto) refrescarDetalle(abierto);
    dibujarPedido();
  });

  window.addEventListener("hashchange", () => { if (productos.length > 0) mostrarRuta(); });
}

async function cargarYMostrar() {
  mostrarMensaje("Cargando catálogo…", "", false);
  try {
    const promesaAnuncios = cargarAnuncios();          // se piden a la vez que los productos
    productos = await cargarCatalogo();
    anuncios = await promesaAnuncios;
    indiceEstilos.clear();
    for (const p of productos) for (const e of p.estilos) indiceEstilos.set(e.subcodigo, { producto: p, estilo: e });
    limpiarPedido();
    $("#mensaje").hidden = true;
    dibujarAnuncios();
    dibujarFiltros();
    mostrarRuta();
    dibujarPedido();
    if (productos.length === 0) mostrarMensaje("Todavía no hay productos en el catálogo.", "", false);
  } catch (error) {
    console.error(error);
    mostrarMensaje("No pudimos cargar el catálogo. Revisa tu conexión e inténtalo de nuevo.", error.message, true);
  }
}

function iniciar() {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  document.title = "Catálogo · " + CONFIG.nombreTienda;
  $("#enlace-mayorista").href = enlaceWhatsApp("Hola, quiero información sobre precios mayoristas.");
  recuperar();
  conectarEventos();
  dibujarPedido();
  cargarYMostrar();
}

iniciar();
