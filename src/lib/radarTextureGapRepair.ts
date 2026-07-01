const rgbaStride = 4;

function textureOffset(radialIndex: number, rangeIndex: number, radialCellCount: number) {
  return (rangeIndex * radialCellCount + radialIndex) * rgbaStride;
}

function alphaAt(
  texture: Uint8Array,
  radialIndex: number,
  rangeIndex: number,
  radialCellCount: number
) {
  return texture[textureOffset(radialIndex, rangeIndex, radialCellCount) + 3];
}

export function repairIsolatedPolarTextureRadialGaps(
  texture: Uint8Array,
  radialCellCount: number,
  rangeCellCount: number
) {
  if (radialCellCount < 3 || rangeCellCount < 1 || texture.length < radialCellCount * rangeCellCount * rgbaStride) {
    return 0;
  }

  const source = texture.slice();
  let repairedCellCount = 0;

  for (let rangeIndex = 0; rangeIndex < rangeCellCount; rangeIndex += 1) {
    for (let radialIndex = 0; radialIndex < radialCellCount; radialIndex += 1) {
      const currentOffset = textureOffset(radialIndex, rangeIndex, radialCellCount);

      if (source[currentOffset + 3] > 0) {
        continue;
      }

      const leftRadialIndex = (radialIndex - 1 + radialCellCount) % radialCellCount;
      const rightRadialIndex = (radialIndex + 1) % radialCellCount;

      if (
        alphaAt(source, leftRadialIndex, rangeIndex, radialCellCount) <= 0 ||
        alphaAt(source, rightRadialIndex, rangeIndex, radialCellCount) <= 0
      ) {
        continue;
      }

      const leftOffset = textureOffset(leftRadialIndex, rangeIndex, radialCellCount);
      const rightOffset = textureOffset(rightRadialIndex, rangeIndex, radialCellCount);
      const leftAlpha = source[leftOffset + 3];
      const rightAlpha = source[rightOffset + 3];

      texture[currentOffset] = Math.round((source[leftOffset] + source[rightOffset]) / 2);
      texture[currentOffset + 1] = Math.round((source[leftOffset + 1] + source[rightOffset + 1]) / 2);
      texture[currentOffset + 2] = Math.round((source[leftOffset + 2] + source[rightOffset + 2]) / 2);
      texture[currentOffset + 3] = Math.round(Math.min(leftAlpha, rightAlpha) * 0.85);
      repairedCellCount += 1;
    }
  }

  return repairedCellCount;
}
