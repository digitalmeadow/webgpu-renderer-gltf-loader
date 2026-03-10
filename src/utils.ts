import { Primitive as GLTFPrimitive } from "@gltf-transform/core";

/**
 * Extracts raw vertex positions (x, y, z) sequentially from a GLTF Primitive.
 */
export function getPrimitivePositions(primitive: GLTFPrimitive): Float32Array {
  const positionAccessor = primitive.getAttribute("POSITION");
  if (!positionAccessor) {
    throw new Error("Primitive missing POSITION attribute");
  }

  const count = positionAccessor.getCount();
  const vertexPositions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const pos = positionAccessor.getElement(i, []) as number[];
    vertexPositions[i * 3] = pos[0];
    vertexPositions[i * 3 + 1] = pos[1];
    vertexPositions[i * 3 + 2] = pos[2];
  }

  return vertexPositions;
}

/**
 * Extracts raw vertex indices from a GLTF Primitive.
 * Fallbacks to generating sequential flat indices if an index buffer does not exist.
 */
export function getPrimitiveIndices(primitive: GLTFPrimitive): Uint32Array {
  const indicesAccessor = primitive.getIndices();

  if (indicesAccessor) {
    const count = indicesAccessor.getCount();
    const vertexIndices = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      vertexIndices[i] = indicesAccessor.getScalar(i);
    }
    return vertexIndices;
  }

  // If no indices are provided, assume flat triangles (non-indexed rendering)
  const positionAccessor = primitive.getAttribute("POSITION");
  if (!positionAccessor) {
    throw new Error("Primitive missing POSITION attribute");
  }

  const count = positionAccessor.getCount();
  const vertexIndices = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    vertexIndices[i] = i;
  }

  return vertexIndices;
}
