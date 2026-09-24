import assert from "node:assert/strict";
import test from "node:test";

import { groupStoragePathsByBucket, signedMediaKey } from "./media-signing.ts";

test("agrupa por bucket, con el de respaldo para las filas sin bucket", () => {
  const groups = groupStoragePathsByBucket(
    [
      { path: "hotel-a/img1.jpg", bucket: null },
      { path: "hotel-a/img2.jpg", bucket: "" },
      { path: "hotel-a/doc.pdf", bucket: "whatsapp-docs" },
      { path: "hotel-a/img3.jpg" },
    ],
    "hotel-media"
  );
  assert.deepEqual(
    [...groups].sort(([a], [b]) => a.localeCompare(b)),
    [
      ["hotel-media", ["hotel-a/img1.jpg", "hotel-a/img2.jpg", "hotel-a/img3.jpg"]],
      ["whatsapp-docs", ["hotel-a/doc.pdf"]],
    ]
  );
});

test("una path repetida se firma una sola vez", () => {
  const groups = groupStoragePathsByBucket(
    [
      { path: "x/a.jpg", bucket: "hotel-media" },
      { path: " x/a.jpg ", bucket: "hotel-media" },
      { path: "x/a.jpg" },
    ],
    "hotel-media"
  );
  assert.deepEqual([...groups], [["hotel-media", ["x/a.jpg"]]]);
});

test("sin path no hay nada que firmar", () => {
  const groups = groupStoragePathsByBucket(
    [{ path: null }, { path: "   " }, { path: undefined, bucket: "hotel-media" }],
    "hotel-media"
  );
  assert.equal(groups.size, 0);
});

test("un bucket con nombre inválido no llega a Storage", () => {
  const groups = groupStoragePathsByBucket(
    [
      { path: "x/a.jpg", bucket: "../otro" },
      { path: "x/b.jpg", bucket: "hotel media" },
      { path: "x/c.jpg", bucket: "hotel-media" },
    ],
    "hotel-media"
  );
  assert.deepEqual([...groups], [["hotel-media", ["x/c.jpg"]]]);
});

test("la clave de firma distingue la misma path en dos buckets", () => {
  assert.notEqual(signedMediaKey("a", "x/1.jpg"), signedMediaKey("b", "x/1.jpg"));
});
