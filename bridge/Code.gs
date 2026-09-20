/**
 * VVCHS Question Paper bridge — Google Apps Script web app.
 *
 * Exposes the five "Question Papers" Drive folders (and nothing else) to the
 * pipeline as a JSON API. Deploy as a web app ("Execute as: Me", "Who has
 * access: Anyone"); the shared secret lives in the script property TOKEN.
 *
 * Request: POST with a JSON body
 *
 *   {"token": "<secret>", "action": "list|download|upload|move|ping", ...}
 *
 * Folder keys: inbox, formatted, needsfixes, archive (writable), template
 * (read only). For formatted, needsfixes and archive a key may carry a class
 * sub-folder: "formatted/Class-VII". The sub-folder is created on first use
 * and only names of the form Class-<Roman numeral I…XII> are accepted, so the
 * pipeline cannot create arbitrary folders.
 *
 *   list     {folder}                       -> {files: [{id, name, mimeType, size, modified, sub}]}
 *            lists the folder and, for the three class-aware folders, every
 *            Class-* sub-folder; "sub" is the sub-folder name or "".
 *   download {id}                           -> {id, name, mimeType, base64}
 *   upload   {folder, name, mimeType, base64} -> {id, name, folder}
 *            refuses a name that already exists in the destination.
 *   move     {id, folder, name?}            -> {id, name, folder}
 *            moves (and optionally renames) a file that is already inside
 *            the pipeline tree; refuses a name clash in the destination.
 *   ping     {}                             -> {ok: true, folders: [...]}
 *
 * Errors are returned as {"error": "<message>"}. The bridge never deletes.
 */

const FOLDER_IDS = {
  inbox: "1shJBYoGMDwdSvASOr6SvkK1AeuPM15pc",
  formatted: "1NZUs5rdAaHIXSvqnAO2tQCaYyx29ZLB_",
  needsfixes: "1GC96el5KVUeiqLyEnfImxvNw-wvv7382",
  archive: "1BcQSagE8IgPAtu3i_0cOsl-Y6RKw9M6L",
  template: "14JnqwVYWmr-CspuINVFmmXtvB6q3zYuL",
};
const WRITABLE = ["inbox", "formatted", "needsfixes", "archive"];
const CLASS_AWARE = ["formatted", "needsfixes", "archive"];
const CLASS_FOLDER = /^Class-(I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII)$/;

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return respond({ error: "request body is not JSON" });
  }
  const token = PropertiesService.getScriptProperties().getProperty("TOKEN");
  if (!token || body.token !== token) return respond({ error: "unauthorized" });
  try {
    switch (body.action) {
      case "ping": return respond({ ok: true, folders: Object.keys(FOLDER_IDS), classFolders: true });
      case "list": return respond(listFiles(body));
      case "download": return respond(downloadFile(body));
      case "upload": return respond(uploadFile(body));
      case "move": return respond(moveFile(body));
      default: return respond({ error: "unknown action: " + body.action });
    }
  } catch (err) {
    return respond({ error: String((err && err.message) || err) });
  }
}

function doGet() {
  return respond({ error: "POST a JSON body" });
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- folders

/** "formatted" or "formatted/Class-VII" -> {key, sub, folder}. Creates the class sub-folder when asked to. */
function resolveFolder(spec, create) {
  const parts = String(spec || "").split("/");
  const key = parts[0];
  const sub = parts.length > 1 ? parts.slice(1).join("/") : "";
  if (!FOLDER_IDS[key]) throw new Error("unknown folder: " + spec);
  const root = DriveApp.getFolderById(FOLDER_IDS[key]);
  if (!sub) return { key: key, sub: "", folder: root };
  if (CLASS_AWARE.indexOf(key) < 0) throw new Error("folder " + key + " has no sub-folders");
  if (!CLASS_FOLDER.test(sub)) throw new Error("sub-folder must be Class-<Roman numeral>, got " + sub);
  const found = root.getFoldersByName(sub);
  if (found.hasNext()) return { key: key, sub: sub, folder: found.next() };
  if (!create) throw new Error("no such class folder: " + spec);
  return { key: key, sub: sub, folder: root.createFolder(sub) };
}

function assertWritable(key) {
  if (WRITABLE.indexOf(key) < 0) throw new Error("folder " + key + " is read only");
}

/** True when the file sits directly in one of our folders or in a class sub-folder of one. */
function inPipelineTree(file) {
  const parents = file.getParents();
  while (parents.hasNext()) {
    const p = parents.next();
    if (isPipelineFolder(p)) return true;
    const grand = p.getParents();
    while (grand.hasNext()) if (isPipelineFolder(grand.next()) && CLASS_FOLDER.test(p.getName())) return true;
  }
  return false;
}

function isPipelineFolder(folder) {
  const id = folder.getId();
  return Object.keys(FOLDER_IDS).some(function (k) { return FOLDER_IDS[k] === id; });
}

function nameTaken(folder, name, exceptId) {
  const it = folder.getFilesByName(name);
  while (it.hasNext()) if (it.next().getId() !== exceptId) return true;
  return false;
}

// ---------------------------------------------------------------- actions

function fileInfo(file, sub) {
  return {
    id: file.getId(),
    name: file.getName(),
    mimeType: file.getMimeType(),
    size: file.getSize(),
    modified: file.getLastUpdated().toISOString(),
    sub: sub || "",
  };
}

function listFiles(body) {
  const target = resolveFolder(body.folder, false);
  const files = [];
  const it = target.folder.getFiles();
  while (it.hasNext()) files.push(fileInfo(it.next(), target.sub));
  // a class-aware root also reports its Class-* sub-folders, so the pipeline sees every name in one call
  if (!target.sub && CLASS_AWARE.indexOf(target.key) >= 0) {
    const subs = target.folder.getFolders();
    while (subs.hasNext()) {
      const sf = subs.next();
      if (!CLASS_FOLDER.test(sf.getName())) continue;
      const fit = sf.getFiles();
      while (fit.hasNext()) files.push(fileInfo(fit.next(), sf.getName()));
    }
  }
  files.sort(function (a, b) { return a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0; });
  return { files: files };
}

function downloadFile(body) {
  const file = DriveApp.getFileById(String(body.id));
  if (!inPipelineTree(file)) throw new Error("file is not in the pipeline folders");
  const blob = file.getBlob();
  return { id: file.getId(), name: file.getName(), mimeType: blob.getContentType(), base64: Utilities.base64Encode(blob.getBytes()) };
}

function uploadFile(body) {
  const target = resolveFolder(body.folder, true);
  assertWritable(target.key);
  const name = String(body.name || "").trim();
  if (!name) throw new Error("upload needs a name");
  if (nameTaken(target.folder, name, null)) throw new Error("a file named " + name + " already exists in " + body.folder + "; use a _v2 name");
  const bytes = Utilities.base64Decode(String(body.base64 || ""));
  const blob = Utilities.newBlob(bytes, String(body.mimeType || "application/octet-stream"), name);
  const file = target.folder.createFile(blob);
  return { id: file.getId(), name: file.getName(), folder: body.folder };
}

function moveFile(body) {
  const file = DriveApp.getFileById(String(body.id));
  if (!inPipelineTree(file)) throw new Error("file is not in the pipeline folders");
  const target = resolveFolder(body.folder, true);
  assertWritable(target.key);
  const newName = body.name ? String(body.name).trim() : file.getName();
  if (nameTaken(target.folder, newName, file.getId())) throw new Error("a file named " + newName + " already exists in " + body.folder + "; use a _v2 name");
  file.moveTo(target.folder);
  if (newName !== file.getName()) file.setName(newName);
  return { id: file.getId(), name: file.getName(), folder: body.folder };
}
