/* Idea Shelf — no build, iPhone-friendly
   Storage: IndexedDB (Dexie)
   Canvas: Konva
*/

const db = new Dexie("idea_shelf_db");
db.version(1).stores({
  books: "id,updatedAt,createdAt",
  nodes: "id,bookId,updatedAt",
  settings: "key",
  snapshots: "++id,createdAt"
});

const COLORS = [
  "#f4d03f", "#58d68d", "#5dade2", "#af7ac5", "#f1948a",
  "#48c9b0", "#f5b041", "#ec7063", "#85929e", "#7dcea0"
];

const UI = {
  bookshelfScreen: document.getElementById("bookshelfScreen"),
  canvasScreen: document.getElementById("canvasScreen"),
  shelves: document.getElementById("shelves"),

  addBookBtn: document.getElementById("addBookBtn"),
  exportBtn: document.getElementById("exportBtn"),
  importFile: document.getElementById("importFile"),

  backBtn: document.getElementById("backBtn"),
  canvasTitle: document.getElementById("canvasTitle"),
  renameBookBtn: document.getElementById("renameBookBtn"),
  deleteBookBtn: document.getElementById("deleteBookBtn"),
  stageWrap: document.getElementById("stageWrap"),

  banner: document.getElementById("banner"),
  bannerSave: document.getElementById("bannerSave"),
  bannerDismiss: document.getElementById("bannerDismiss"),
};

const SETTINGS_KEYS = {
  lastChangedAt: "lastChangedAt",
  lastExternalBackupAt: "lastExternalBackupAt",
  lastNudgeDismissAt: "lastNudgeDismissAt",
  changeCount: "changeCount"
};

function now() { return Date.now(); }
function dayMs() { return 24 * 60 * 60 * 1000; }

async function getSetting(key, fallback = null) {
  const row = await db.settings.get(key);
  return row?.value ?? fallback;
}
async function setSetting(key, value) {
  await db.settings.put({ key, value });
}

async function markChanged() {
  await setSetting(SETTINGS_KEYS.lastChangedAt, now());
  const count = (await getSetting(SETTINGS_KEYS.changeCount, 0)) + 1;
  await setSetting(SETTINGS_KEYS.changeCount, count);

  // Auto-snapshot every 25 changes
  if (count % 25 === 0) {
    await createInternalSnapshot();
  }

  await maybeShowBackupNudge();
}

async function createInternalSnapshot() {
  const backup = await buildBackupObject();
  await db.snapshots.add({ createdAt: now(), backup });

  // keep last 10
  const all = await db.snapshots.orderBy("createdAt").toArray();
  if (all.length > 10) {
    const toDelete = all.slice(0, all.length - 10).map(x => x.id);
    await db.snapshots.bulkDelete(toDelete);
  }
}

async function maybeShowBackupNudge() {
  const lastChangedAt = await getSetting(SETTINGS_KEYS.lastChangedAt, 0);
  const lastExternal = await getSetting(SETTINGS_KEYS.lastExternalBackupAt, 0);
  const lastDismiss = await getSetting(SETTINGS_KEYS.lastNudgeDismissAt, 0);

  const changedSinceExternal = lastChangedAt > lastExternal;
  const beenADay = (now() - lastExternal) >= dayMs();
  const dismissedToday = (now() - lastDismiss) < dayMs();

  if (changedSinceExternal && beenADay && !dismissedToday) {
    UI.banner.classList.remove("hidden");
  } else {
    UI.banner.classList.add("hidden");
  }
}

// ---------- Bookshelf ----------

async function seedIfEmpty() {
  const count = await db.books.count();
  if (count === 0) {
    await db.books.add({
      id: crypto.randomUUID(),
      title: "New Book",
      color: COLORS[0],
      createdAt: now(),
      updatedAt: now()
    });
  }
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function renderBookshelf() {
  UI.shelves.innerHTML = "";

  const books = await db.books.orderBy("updatedAt").reverse().toArray();
  const shelves = chunk(books, 6);

  shelves.forEach((shelfBooks) => {
    const shelf = document.createElement("div");
    shelf.className = "shelf";

    const spines = document.createElement("div");
    spines.className = "spines";

    shelfBooks.forEach((book) => {
      const spine = document.createElement("div");
      spine.className = "spine";
      spine.style.background = `linear-gradient(180deg, ${book.color}, rgba(0,0,0,0.30))`;

      spine.innerHTML = `
        <div class="spine-menu">⋯</div>
        <div class="spine-title"></div>
      `;

      spine.querySelector(".spine-title").textContent = book.title;

      spine.addEventListener("click", (e) => {
        // If they tapped the menu, open actions
        const menuTap = e.target.classList.contains("spine-menu");
        if (menuTap) {
          openBookActions(book);
          e.stopPropagation();
          return;
        }
        openBook(book.id);
      });

      spines.appendChild(spine);
    });

    const plank = document.createElement("div");
    plank.className = "plank";

    shelf.appendChild(spines);
    shelf.appendChild(plank);
    UI.shelves.appendChild(shelf);
  });

  await maybeShowBackupNudge();
}

async function openBookActions(book) {
  const choice = prompt(
    `Actions for "${book.title}":\n` +
    `Type:\n` +
    `  r = rename\n` +
    `  d = delete\n` +
    `  (cancel = nothing)`
  );
  if (!choice) return;
  if (choice.toLowerCase() === "r") {
    await renameBook(book.id);
  } else if (choice.toLowerCase() === "d") {
    await deleteBook(book.id);
  }
}

async function addBook() {
  const title = prompt("Book title?");
  if (!title) return;

  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  await db.books.add({
    id: crypto.randomUUID(),
    title: title.trim(),
    color,
    createdAt: now(),
    updatedAt: now()
  });
  await markChanged();
  await renderBookshelf();
}

async function renameBook(bookId) {
  const book = await db.books.get(bookId);
  if (!book) return;

  const title = prompt("New title?", book.title);
  if (!title) return;

  await db.books.update(bookId, { title: title.trim(), updatedAt: now() });
  await markChanged();
  UI.canvasTitle.textContent = title.trim();
  await renderBookshelf();
}

async function deleteBook(bookId) {
  const book = await db.books.get(bookId);
  if (!book) return;

  const ok = confirm(`Delete "${book.title}" and all its nodes?`);
  if (!ok) return;

  await db.nodes.where("bookId").equals(bookId).delete();
  await db.books.delete(bookId);
  await markChanged();

  // If we were in that book, go back
  if (APP.currentBookId === bookId) {
    showBookshelf();
  }
  await renderBookshelf();
}

// ---------- Backup import/export ----------

async function buildBackupObject() {
  const books = await db.books.toArray();
  const nodes = await db.nodes.toArray();
  const settings = await db.settings.toArray();
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    data: { books, nodes, settings }
  };
}

function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportBackup() {
  const backup = await buildBackupObject();
  downloadJson(`idea-shelf-backup-${new Date().toISOString().slice(0,10)}.json`, backup);

  // best-effort: treat as successful external backup
  await setSetting(SETTINGS_KEYS.lastExternalBackupAt, now());
  await maybeShowBackupNudge();
}

async function importBackup(file) {
  const text = await file.text();
  const obj = JSON.parse(text);

  if (!obj || obj.version !== 1 || !obj.data) {
    alert("Backup format not recognized.");
    return;
  }

  const ok = confirm("Importing will overwrite your current local data. Continue?");
  if (!ok) return;

  await db.transaction("rw", db.books, db.nodes, db.settings, async () => {
    await db.books.clear();
    await db.nodes.clear();
    await db.settings.clear();

    await db.books.bulkAdd(obj.data.books || []);
    await db.nodes.bulkAdd(obj.data.nodes || []);
    // Preserve settings but reset nudge/dates if missing
    const settings = obj.data.settings || [];
    await db.settings.bulkAdd(settings);

    // Mark as changed so nudge logic stays sane
    await setSetting(SETTINGS_KEYS.lastChangedAt, now());
  });

  await renderBookshelf();
  alert("Imported.");
}

// ---------- Canvas (Konva) ----------

const APP = {
  currentBookId: null,
  stage: null,
  layer: null,
  world: {
    x: 0, y: 0, scale: 1
  },
  selectedNodeId: null,
  // Visual rules
  dotLineThickness: 2,
  dotRadius: 4, // slightly bigger than line thickness
  readableThreshold: 0.85,
  nearestColorRadiusWorld: 220
};

function showCanvas() {
  UI.bookshelfScreen.classList.add("hidden");
  UI.canvasScreen.classList.remove("hidden");
}

function showBookshelf() {
  APP.currentBookId = null;
  destroyStage();
  UI.canvasScreen.classList.add("hidden");
  UI.bookshelfScreen.classList.remove("hidden");
}

async function openBook(bookId) {
  APP.currentBookId = bookId;
  APP.selectedNodeId = null;

  const book = await db.books.get(bookId);
  UI.canvasTitle.textContent = book?.title ?? "Book";
  showCanvas();

  await initStage();
  await loadNodesToStage();
}

function destroyStage() {
  if (APP.stage) {
    APP.stage.destroy();
    APP.stage = null;
    APP.layer = null;
  }
  UI.stageWrap.innerHTML = "";
}

async function initStage() {
  destroyStage();

  const width = UI.stageWrap.clientWidth;
  const height = UI.stageWrap.clientHeight;

  const stage = new Konva.Stage({
    container: "stageWrap",
    width,
    height
  });

  const layer = new Konva.Layer();
  stage.add(layer);

  APP.stage = stage;
  APP.layer = layer;

  // prevent page scroll/zoom gestures interfering on iOS
  const content = stage.getContent();
  content.style.touchAction = "none";

  // background hit area to capture taps/drags
  const bg = new Konva.Rect({
    x: -100000,
    y: -100000,
    width: 200000,
    height: 200000,
    fill: "rgba(0,0,0,0.001)"
  });
  layer.add(bg);

  // Gestures: pan (one finger), pinch zoom (two fingers), double-tap add
  wireCanvasGestures(stage, bg);

  // Resize handler (simple)
  window.addEventListener("resize", () => {
    if (!APP.stage) return;
    APP.stage.width(UI.stageWrap.clientWidth);
    APP.stage.height(UI.stageWrap.clientHeight);
  });

  layer.draw();
}

function screenToWorld(point) {
  const t = APP.stage.getAbsoluteTransform().copy().invert();
  return t.point(point);
}

function findNearestNodeColor(worldPoint) {
  // measure in world space
  let best = null;
  let bestD = Infinity;

  APP.layer.find(".ideaNode").forEach((g) => {
    const x = g.x();
    const y = g.y();
    const d = Math.hypot(x - worldPoint.x, y - worldPoint.y);
    if (d < APP.nearestColorRadiusWorld && d < bestD) {
      bestD = d;
      best = g.getAttr("ideaColor");
    }
  });

  return best;
}

async function addNodeAtWorld(worldPoint) {
  const inherited = findNearestNodeColor(worldPoint);
  const color = inherited || COLORS[Math.floor(Math.random() * COLORS.length)];

  const node = {
    id: crypto.randomUUID(),
    bookId: APP.currentBookId,
    x: worldPoint.x,
    y: worldPoint.y,
    color,
    updatedAt: now()
  };

  await db.nodes.add(node);
  await db.books.update(APP.currentBookId, { updatedAt: now() });
  await markChanged();

  drawNode(node);
  APP.layer.draw();
}

function drawNode(node) {
  const group = new Konva.Group({
    x: node.x,
    y: node.y,
    name: "ideaNode",
    draggable: false // only selected nodes drag
  });

  group.setAttr("nodeId", node.id);
  group.setAttr("ideaColor", node.color);

  const bubble = new Konva.Rect({
    x: -80, y: -50,
    width: 160, height: 100,
    cornerRadius: 14,
    fill: hexWithAlpha(node.color, 0.78),
    shadowBlur: 14,
    shadowOffset: { x: 0, y: 8 },
    shadowColor: "rgba(0,0,0,0.45)"
  });

  const outline = new Konva.Rect({
    x: -80, y: -50,
    width: 160, height: 100,
    cornerRadius: 14,
    stroke: "rgba(255,255,255,0.0)",
    strokeWidth: 2
  });

  const dot = new Konva.Circle({
    x: 0, y: 0,
    radius: APP.dotRadius,
    fill: node.color
  });

  const label = new Konva.Text({
    x: -70, y: -18,
    width: 140,
    text: "…",          // placeholder until text edit exists
    fontSize: 18,
    fontStyle: "700",
    fill: "rgba(255,255,255,0.92)",
    align: "center"
  });

  group.add(bubble, outline, dot, label);

  // hit handling
  group.on("tap", () => selectNode(node.id));
  group.on("click", () => selectNode(node.id));

  APP.layer.add(group);

  // initial render mode
  updateNodeRenderForScale(group, APP.layer.getStage().scaleX());

  return group;
}

function hexWithAlpha(hex, alpha) {
  // accepts #rrggbb
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function updateNodeRenderForScale(group, scale) {
  const bubble = group.children[0];
  const outline = group.children[1];
  const dot = group.children[2];
  const label = group.children[3];

  const isDot = scale < APP.readableThreshold;

  bubble.visible(!isDot);
  outline.visible(!isDot);
  label.visible(!isDot);

  dot.visible(isDot);

  // dot is slightly bigger than line thickness already (radius 4 vs thickness 2)
}

function selectNode(nodeId) {
  APP.selectedNodeId = nodeId;

  APP.layer.find(".ideaNode").forEach((g) => {
    const outline = g.children[1];
    const selected = g.getAttr("nodeId") === nodeId;
    outline.stroke(selected ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.0)");
    g.draggable(selected); // drag only selected
  });

  APP.layer.draw();
}

async function loadNodesToStage() {
  APP.layer.find(".ideaNode").destroy();

  const nodes = await db.nodes.where("bookId").equals(APP.currentBookId).toArray();
  nodes.forEach(drawNode);

  APP.layer.draw();
}

function wireCanvasGestures(stage, bgRect) {
  let lastCenter = null;
  let lastDist = 0;
  let isPinching = false;

  // Deselect on background tap
  bgRect.on("tap", () => {
    APP.selectedNodeId = null;
    APP.layer.find(".ideaNode").forEach((g) => {
      g.draggable(false);
      g.children[1].stroke("rgba(255,255,255,0.0)");
    });
    APP.layer.draw();
  });

  // Double tap to add node (but only if background)
  bgRect.on("dbltap", async () => {
    const pos = stage.getPointerPosition();
    if (!pos) return;
    const world = screenToWorld(pos);
    await addNodeAtWorld(world);
  });

  // touch pinch zoom + pan
  stage.getContent().addEventListener("touchmove", (e) => {
    e.preventDefault(); // IMPORTANT iOS
  }, { passive: false });

  stage.on("touchmove", (e) => {
    const evt = e.evt;
    const touches = evt.touches;
    if (!touches) return;

    if (touches.length === 2) {
      isPinching = true;

      const p1 = { x: touches[0].clientX, y: touches[0].clientY };
      const p2 = { x: touches[1].clientX, y: touches[1].clientY };

      const center = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);

      if (!lastCenter) {
        lastCenter = center;
        lastDist = dist;
        return;
      }

      const oldScale = stage.scaleX();
      let newScale = oldScale * (dist / lastDist);
      newScale = Math.max(0.25, Math.min(3.0, newScale));

      const pointTo = screenToWorld(center);

      stage.scale({ x: newScale, y: newScale });

      const newPos = {
        x: center.x - pointTo.x * newScale,
        y: center.y - pointTo.y * newScale
      };
      stage.position(newPos);
      stage.batchDraw();

      // update node render modes
      APP.layer.find(".ideaNode").forEach((g) => updateNodeRenderForScale(g, newScale));

      lastCenter = center;
      lastDist = dist;
    }
  });

  stage.on("touchend", () => {
    lastCenter = null;
    lastDist = 0;
    isPinching = false;
  });

  // mouse wheel zoom for desktop convenience
  stage.on("wheel", (e) => {
    e.evt.preventDefault();
    const scaleBy = 1.05;
    const oldScale = stage.scaleX();
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const mousePointTo = screenToWorld(pointer);

    const dir = e.evt.deltaY > 0 ? 1 : -1;
    let newScale = dir > 0 ? oldScale / scaleBy : oldScale * scaleBy;
    newScale = Math.max(0.25, Math.min(3.0, newScale));

    stage.scale({ x: newScale, y: newScale });

    const newPos = {
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale
    };
    stage.position(newPos);
    stage.batchDraw();

    APP.layer.find(".ideaNode").forEach((g) => updateNodeRenderForScale(g, newScale));
  });

  // pan on drag background (one finger) unless pinching
  let panStart = null;
  stage.on("touchstart mousedown", (e) => {
    // only start pan if background (rect) was hit
    if (e.target !== bgRect) return;
    if (isPinching) return;

    panStart = stage.getPointerPosition();
  });

  stage.on("touchmove mousemove", (e) => {
    if (!panStart) return;
    if (isPinching) return;

    // if a node is being dragged, don't pan
    if (APP.selectedNodeId && stage.findOne((n) => n.getAttr && n.getAttr("nodeId") === APP.selectedNodeId)?.isDragging()) {
      return;
    }

    const pos = stage.getPointerPosition();
    if (!pos) return;

    const dx = pos.x - panStart.x;
    const dy = pos.y - panStart.y;

    stage.position({
      x: stage.x() + dx,
      y: stage.y() + dy
    });

    panStart = pos;
    stage.batchDraw();
  });

  stage.on("touchend mouseup", () => {
    panStart = null;
  });

  // persist node moves
  stage.on("dragend", async (e) => {
    const g = e.target;
    if (!g || !g.getAttr) return;
    const nodeId = g.getAttr("nodeId");
    if (!nodeId) return;

    await db.nodes.update(nodeId, { x: g.x(), y: g.y(), updatedAt: now() });
    await db.books.update(APP.currentBookId, { updatedAt: now() });
    await markChanged();
  });
}

// ---------- UI wiring ----------

UI.addBookBtn.addEventListener("click", addBook);
UI.exportBtn.addEventListener("click", exportBackup);
UI.importFile.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  await importBackup(file);
  e.target.value = "";
});

UI.backBtn.addEventListener("click", async () => {
  showBookshelf();
  await renderBookshelf();
});

UI.renameBookBtn.addEventListener("click", async () => {
  if (!APP.currentBookId) return;
  await renameBook(APP.currentBookId);
});

UI.deleteBookBtn.addEventListener("click", async () => {
  if (!APP.currentBookId) return;
  await deleteBook(APP.currentBookId);
});

UI.bannerSave.addEventListener("click", exportBackup);
UI.bannerDismiss.addEventListener("click", async () => {
  await setSetting(SETTINGS_KEYS.lastNudgeDismissAt, now());
  UI.banner.classList.add("hidden");
});

// ---------- Boot ----------

(async function main() {
  await seedIfEmpty();
  await renderBookshelf();
})();
