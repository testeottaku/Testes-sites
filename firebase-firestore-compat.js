import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  onSnapshot,
  writeBatch,
  deleteField
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const SINGLETON_DOCS = new Set(["Manutencao", "Versao"]);
const DISCONNECT_WRITES = new Map();
let disconnectBound = false;

function normalizePath(path = "") {
  return String(path || "").replace(/^\/+|\/+$/g, "");
}

function splitPath(path = "") {
  const normalized = normalizePath(path);
  return normalized ? normalized.split("/").filter(Boolean) : [];
}

function appendPath(basePath, child) {
  const left = normalizePath(basePath);
  const right = normalizePath(child);
  if (!left) return right;
  if (!right) return left;
  return `${left}/${right}`;
}

function clone(value) {
  if (value === undefined) return null;
  return value === null ? null : JSON.parse(JSON.stringify(value));
}

function getNestedValue(obj, pathSegments) {
  let current = obj;
  for (const segment of pathSegments) {
    if (current == null || typeof current !== "object" || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function buildNestedObject(pathSegments, value) {
  return pathSegments.reduceRight((acc, segment) => ({ [segment]: acc }), value);
}

function mergeInto(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return target;
  for (const [key, value] of Object.entries(source)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      mergeInto(target[key], value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function assignNested(target, pathSegments, value) {
  let current = target;
  for (let i = 0; i < pathSegments.length - 1; i++) {
    const segment = pathSegments[i];
    if (!current[segment] || typeof current[segment] !== "object" || Array.isArray(current[segment])) {
      current[segment] = {};
    }
    current = current[segment];
  }
  current[pathSegments[pathSegments.length - 1]] = value;
  return target;
}

function lastSegment(path = "") {
  const segments = splitPath(path);
  return segments.length ? segments[segments.length - 1] : null;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function analyzePath(db, path) {
  const logicalPath = normalizePath(path);
  const segments = splitPath(logicalPath);

  if (!segments.length) {
    throw new Error("Caminho Firebase inválido.");
  }

  if (segments[0] === "Notificacoes") {
    if (segments.length < 2) {
      throw new Error("O caminho de Notificações precisa incluir o UID.");
    }
    if (segments.length === 2) {
      return {
        kind: "collection",
        logicalPath,
        fsRef: collection(db, "Notificacoes", segments[1], "items")
      };
    }
    if (segments.length === 3) {
      return {
        kind: "doc",
        logicalPath,
        fsRef: doc(db, "Notificacoes", segments[1], "items", segments[2])
      };
    }
    return {
      kind: "field",
      logicalPath,
      fsRef: doc(db, "Notificacoes", segments[1], "items", segments[2]),
      fieldPath: segments.slice(3)
    };
  }

  if (SINGLETON_DOCS.has(segments[0])) {
    if (segments.length === 1) {
      return {
        kind: "doc",
        logicalPath,
        fsRef: doc(db, "__config__", segments[0])
      };
    }
    return {
      kind: "field",
      logicalPath,
      fsRef: doc(db, "__config__", segments[0]),
      fieldPath: segments.slice(1)
    };
  }

  if (segments.length === 1) {
    return {
      kind: "collection",
      logicalPath,
      fsRef: collection(db, segments[0])
    };
  }

  if (segments.length === 2) {
    return {
      kind: "doc",
      logicalPath,
      fsRef: doc(db, segments[0], segments[1])
    };
  }

  return {
    kind: "field",
    logicalPath,
    fsRef: doc(db, segments[0], segments[1]),
    fieldPath: segments.slice(2)
  };
}

function makeBaseSnapshot(refObj, exists, value) {
  return {
    key: lastSegment(refObj.path),
    ref: refObj,
    exists() {
      return exists;
    },
    val() {
      return clone(value);
    },
    forEach() {
      return false;
    }
  };
}

function makeDocSnapshot(refObj, exists, data) {
  return makeBaseSnapshot(refObj, exists, data);
}

function makeFieldSnapshot(refObj, exists, value) {
  return makeBaseSnapshot(refObj, exists, value);
}

function makeCollectionSnapshot(refObj, docs) {
  const children = docs.map(({ id, data }) => {
    const childRef = ref(refObj.db, appendPath(refObj.path, id));
    return makeDocSnapshot(childRef, true, data);
  });

  return {
    key: lastSegment(refObj.path),
    ref: refObj,
    exists() {
      return children.length > 0;
    },
    val() {
      if (!children.length) return null;
      const result = {};
      children.forEach((child) => {
        result[child.key] = child.val();
      });
      return result;
    },
    forEach(callback) {
      children.forEach((child) => callback(child));
      return false;
    }
  };
}

function bindDisconnectFlush() {
  if (disconnectBound || typeof window === "undefined") return;
  disconnectBound = true;

  const flush = () => {
    DISCONNECT_WRITES.forEach(({ refObj, value }) => {
      set(refObj, value).catch(() => {});
    });
  };

  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}

export function getDatabase(app) {
  return getFirestore(app);
}

export function ref(db, path = "") {
  return { db, path: normalizePath(path) };
}

export async function get(refObj) {
  const info = analyzePath(refObj.db, refObj.path);

  if (info.kind === "collection") {
    const snapshot = await getDocs(info.fsRef);
    const docs = snapshot.docs.map((item) => ({ id: item.id, data: item.data() }));
    return makeCollectionSnapshot(refObj, docs);
  }

  const snapshot = await getDoc(info.fsRef);
  const data = snapshot.exists() ? snapshot.data() : null;

  if (info.kind === "doc") {
    return makeDocSnapshot(refObj, snapshot.exists(), data);
  }

  const fieldValue = snapshot.exists() ? getNestedValue(data, info.fieldPath) : undefined;
  return makeFieldSnapshot(refObj, fieldValue !== undefined && fieldValue !== null, fieldValue ?? null);
}

export async function set(refObj, value) {
  const info = analyzePath(refObj.db, refObj.path);

  if (info.kind === "collection") {
    const payload = isPlainObject(value) ? value : {};
    const batch = writeBatch(refObj.db);
    for (const [docId, docValue] of Object.entries(payload)) {
      const childInfo = analyzePath(refObj.db, appendPath(refObj.path, docId));
      batch.set(childInfo.fsRef, docValue);
    }
    return batch.commit();
  }

  if (info.kind === "doc") {
    return setDoc(info.fsRef, value);
  }

  return setDoc(info.fsRef, buildNestedObject(info.fieldPath, value), { merge: true });
}

export async function update(refObj, value) {
  const info = analyzePath(refObj.db, refObj.path);

  if (info.kind === "collection") {
    const updates = isPlainObject(value) ? value : {};
    const grouped = {};

    for (const [relativePath, relativeValue] of Object.entries(updates)) {
      const parts = splitPath(relativePath);
      if (!parts.length) continue;

      const docId = parts.shift();
      if (!grouped[docId]) grouped[docId] = {};

      if (!parts.length) {
        if (isPlainObject(relativeValue)) {
          mergeInto(grouped[docId], relativeValue);
        } else {
          grouped[docId] = relativeValue;
        }
      } else {
        assignNested(grouped[docId], parts, relativeValue);
      }
    }

    const batch = writeBatch(refObj.db);
    for (const [docId, payload] of Object.entries(grouped)) {
      const childInfo = analyzePath(refObj.db, appendPath(refObj.path, docId));
      batch.set(childInfo.fsRef, payload, { merge: true });
    }
    return batch.commit();
  }

  if (info.kind === "doc") {
    return setDoc(info.fsRef, value || {}, { merge: true });
  }

  const payload = isPlainObject(value)
    ? buildNestedObject(info.fieldPath, value)
    : buildNestedObject(info.fieldPath, value);
  return setDoc(info.fsRef, payload, { merge: true });
}

export async function remove(refObj) {
  const info = analyzePath(refObj.db, refObj.path);

  if (info.kind === "collection") {
    const snapshot = await getDocs(info.fsRef);
    const batch = writeBatch(refObj.db);
    snapshot.docs.forEach((item) => batch.delete(item.ref));
    return batch.commit();
  }

  if (info.kind === "doc") {
    return deleteDoc(info.fsRef);
  }

  return setDoc(info.fsRef, buildNestedObject(info.fieldPath, deleteField()), { merge: true });
}

export async function push(refObj, value) {
  const info = analyzePath(refObj.db, refObj.path);
  if (info.kind !== "collection") {
    throw new Error("push só pode ser usado em caminhos de coleção.");
  }

  const newDoc = doc(info.fsRef);
  const newPath = appendPath(refObj.path, newDoc.id);
  if (arguments.length > 1) {
    await setDoc(newDoc, value);
  }
  return ref(refObj.db, newPath);
}

export function onValue(refObj, callback, options = {}) {
  if (options && options.onlyOnce) {
    get(refObj).then(callback).catch((error) => console.error(error));
    return () => {};
  }

  const info = analyzePath(refObj.db, refObj.path);

  if (info.kind === "collection") {
    return onSnapshot(info.fsRef, (snapshot) => {
      const docs = snapshot.docs.map((item) => ({ id: item.id, data: item.data() }));
      callback(makeCollectionSnapshot(refObj, docs));
    }, (error) => console.error(error));
  }

  return onSnapshot(info.fsRef, (snapshot) => {
    const data = snapshot.exists() ? snapshot.data() : null;

    if (info.kind === "doc") {
      callback(makeDocSnapshot(refObj, snapshot.exists(), data));
      return;
    }

    const fieldValue = snapshot.exists() ? getNestedValue(data, info.fieldPath) : undefined;
    callback(makeFieldSnapshot(refObj, fieldValue !== undefined && fieldValue !== null, fieldValue ?? null));
  }, (error) => console.error(error));
}

export function onDisconnect(refObj) {
  bindDisconnectFlush();
  return {
    set(value) {
      DISCONNECT_WRITES.set(refObj.path, { refObj, value });
      return Promise.resolve();
    }
  };
}
