import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Loads the browser backup helper in a minimal VM context. Only the pure
// prepare/encode/decode paths are exercised; DOM and IndexedDB access happens
// inside functions the tests never call.
function loadBackup() {
  const context = {
    Buffer,
    Blob,
    File,
    URL,
    atob,
    btoa,
    TextEncoder,
    document: { getElementById: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    indexedDB: {},
    Aetheris: {
      httpUrl: (value) =>
        typeof value === "string" && /^https?:\/\//.test(value) ? value : null,
      readList: () => [],
    },
  };
  context.window = context;
  context.window.addEventListener = () => {};
  vm.runInNewContext(
    fs.readFileSync(
      new URL("../public/js/data-transfer.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  return context;
}

test("backup import rejects unknown formats and absurd database versions", () => {
  const backup = loadBackup().AetherisBackup;

  assert.throws(
    () => backup.prepare({ format: "not-aetheris", localStorage: {} }),
    /not an Aetheris backup/,
  );

  assert.throws(
    () =>
      backup.prepare({
        format: "aetheris-backup",
        version: 2,
        indexedDB: {
          game: { version: Number.MAX_SAFE_INTEGER, stores: {} },
        },
      }),
    /unreasonably high/,
  );

  const prepared = backup.prepare({
    format: "aetheris-backup",
    version: 2,
    localStorage: { "aetheris-theme": "dark" },
    indexedDB: { game: { version: 3, stores: {} } },
  });
  assert.equal(prepared.databases.game.version, 3);
  assert.equal(prepared.settings["aetheris-theme"], "dark");
});

test("backup values round-trip supported structured types", async () => {
  const context = loadBackup();
  // Values are built inside the VM realm so `instanceof` checks match the
  // helper's own constructors (cross-realm Dates/Maps would not).
  vm.runInNewContext(
    '__value = { date: new Date("2026-01-02T03:04:05.000Z"),' +
      ' map: new Map([["a", 1]]), bytes: new Uint8Array([1, 2, 3]), big: 10n };',
    context,
  );
  const encoded = await context.AetherisBackup.encode(context.__value);
  const decoded = context.AetherisBackup.decode(encoded);
  assert.equal(decoded.date.toISOString(), "2026-01-02T03:04:05.000Z");
  assert.equal(decoded.map.get("a"), 1);
  assert.deepEqual(Array.from(decoded.bytes), [1, 2, 3]);
  assert.equal(decoded.big, 10n);
});
