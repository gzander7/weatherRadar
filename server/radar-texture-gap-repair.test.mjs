import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

async function loadGapRepairModule() {
  const sourcePath = resolve("src/lib/radarTextureGapRepair.ts");
  const source = await readFile(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  });
  const encoded = Buffer.from(transpiled.outputText, "utf8").toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

function writeCell(texture, radialIndex, value, alpha) {
  const offset = radialIndex * 4;
  texture[offset] = value;
  texture[offset + 1] = value;
  texture[offset + 2] = value;
  texture[offset + 3] = alpha;
}

test("isolated polar texture radial gap repair fills a single transparent column", async () => {
  const { repairIsolatedPolarTextureRadialGaps } = await loadGapRepairModule();
  const texture = new Uint8Array(3 * 1 * 4);
  writeCell(texture, 0, 80, 255);
  writeCell(texture, 2, 120, 200);

  const repaired = repairIsolatedPolarTextureRadialGaps(texture, 3, 1);

  assert.equal(repaired, 1);
  assert.equal(texture[4], 100);
  assert.equal(texture[7], 170);
});

test("isolated polar texture radial gap repair leaves adjacent transparent columns untouched", async () => {
  const { repairIsolatedPolarTextureRadialGaps } = await loadGapRepairModule();
  const texture = new Uint8Array(4 * 1 * 4);
  writeCell(texture, 0, 80, 255);
  writeCell(texture, 3, 120, 255);

  const repaired = repairIsolatedPolarTextureRadialGaps(texture, 4, 1);

  assert.equal(repaired, 0);
  assert.equal(texture[7], 0);
  assert.equal(texture[11], 0);
});

test("isolated polar texture radial gap repair wraps across first and last radial columns", async () => {
  const { repairIsolatedPolarTextureRadialGaps } = await loadGapRepairModule();
  const texture = new Uint8Array(3 * 1 * 4);
  writeCell(texture, 1, 40, 180);
  writeCell(texture, 2, 100, 240);

  const repaired = repairIsolatedPolarTextureRadialGaps(texture, 3, 1);

  assert.equal(repaired, 1);
  assert.equal(texture[0], 70);
  assert.equal(texture[3], 153);
});
