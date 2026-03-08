import {
  WebIO,
  Document,
  Node as GLTFNode,
  Material as GLTFMaterial,
  Texture as GLTFTexture,
} from "@gltf-transform/core";
import {
  Renderer,
  Scene,
  Entity,
  Mesh,
  Geometry,
  Vertex,
  MaterialPBR,
  MaterialBasic,
  Texture,
  MaterialBase,
  AnimationClip,
  AnimationCurve,
  AnimationPath,
  AnimationInterpolation,
} from "@digitalmeadow/webgpu-renderer";

export class GroupEntity extends Entity {
  constructor(name: string = "Group") {
    super(name);
  }
}

export type ProcessNodeHook = (gltfNode: GLTFNode, entity: Entity) => boolean;

export class GLTFSceneLoader {
  private renderer: Renderer;
  public onProcessNode: ProcessNodeHook | null = null;

  private parsedMaterials = new Map<GLTFMaterial, MaterialBase>();
  private parsedTextures = new Map<GLTFTexture, Texture>();
  private nodeToEntityMap = new Map<GLTFNode, Entity>();

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  public async load(
    url: string,
    scene: Scene,
  ): Promise<{ clips: AnimationClip[] }> {
    const io = new WebIO();

    // Fetch and load the document automatically via WebIO
    const document = await io.read(url);

    return await this.processDocument(document, scene);
  }

  public async loadFromBuffer(
    buffer: Uint8Array,
    scene: Scene,
  ): Promise<{ clips: AnimationClip[] }> {
    const io = new WebIO();
    const document = await io.readBinary(buffer);
    return await this.processDocument(document, scene);
  }

  private processDocument(
    document: Document,
    scene: Scene,
  ): Promise<{ clips: AnimationClip[] }> {
    this.nodeToEntityMap.clear();

    const root = document.getRoot();
    const defaultScene = root.getDefaultScene() || root.listScenes()[0];

    if (!defaultScene) return Promise.resolve({ clips: [] });

    for (const gltfNode of defaultScene.listChildren()) {
      this.processNode(gltfNode, scene);
    }

    const clips = this.processAnimations(document);

    return Promise.resolve({ clips });
  }

  private processAnimations(document: Document): AnimationClip[] {
    const root = document.getRoot();
    const gltfAnimations = root.listAnimations();
    const clips: AnimationClip[] = [];

    for (const gltfAnim of gltfAnimations) {
      const clip = new AnimationClip(gltfAnim.getName() || "Animation");

      for (const channel of gltfAnim.listChannels()) {
        const targetNode = channel.getTargetNode();
        if (!targetNode) continue;

        const path = channel.getTargetPath();
        if (path !== "translation" && path !== "rotation" && path !== "scale") {
          continue; // Currently only transform paths are supported
        }

        const entity = this.nodeToEntityMap.get(targetNode);
        if (!entity) continue;

        const sampler = channel.getSampler();
        if (!sampler) continue;

        const inputAccessor = sampler.getInput();
        const outputAccessor = sampler.getOutput();
        if (!inputAccessor || !outputAccessor) continue;

        const timestamps = inputAccessor.getArray();
        const keyframes = outputAccessor.getArray();

        if (
          !timestamps ||
          !keyframes ||
          !(timestamps instanceof Float32Array) ||
          !(keyframes instanceof Float32Array)
        ) {
          continue;
        }

        let interpolation: AnimationInterpolation = "LINEAR";
        const samplerInterpolation = sampler.getInterpolation();
        if (samplerInterpolation === "STEP") {
          interpolation = "STEP";
        } else if (samplerInterpolation === "CUBICSPLINE") {
          // Fallback to linear for now, but save as CUBICSPLINE when implemented
          interpolation = "LINEAR";
        }

        const curve = new AnimationCurve(
          entity.transform,
          path as AnimationPath,
          timestamps,
          keyframes,
          interpolation,
        );

        clip.addCurve(curve);
      }

      clips.push(clip);
    }

    return clips;
  }

  private processNode(gltfNode: GLTFNode, scene: Scene): Entity | null {
    const name = gltfNode.getName() || "Node";

    // Create base entity for this node (Group or Mesh)
    const gltfMesh = gltfNode.getMesh();
    let rootEntity: Entity;
    const entitiesCreated: Entity[] = [];

    if (gltfMesh) {
      const primitives = gltfMesh.listPrimitives();

      if (primitives.length === 1) {
        // Single primitive, we can just make this node a Mesh
        rootEntity = this.createMeshFromPrimitive(primitives[0], name);
        entitiesCreated.push(rootEntity);
      } else {
        // Multiple primitives, we need a Group entity with Mesh children
        rootEntity = new GroupEntity(name);
        entitiesCreated.push(rootEntity);
        for (let i = 0; i < primitives.length; i++) {
          const primEntity = this.createMeshFromPrimitive(
            primitives[i],
            `${name}_prim${i}`,
          );
          entitiesCreated.push(primEntity);
          rootEntity.transform.addChild(primEntity.transform);
        }
      }
    } else {
      rootEntity = new GroupEntity(name);
      entitiesCreated.push(rootEntity);
    }

    // Apply Transform
    const position = gltfNode.getTranslation();
    const rotation = gltfNode.getRotation();
    const scale = gltfNode.getScale();

    rootEntity.transform.setPosition(position[0], position[1], position[2]);
    rootEntity.transform.setRotationQuat(
      rotation[0],
      rotation[1],
      rotation[2],
      rotation[3],
    );
    rootEntity.transform.setScale(scale[0], scale[1], scale[2]);

    // Hook
    if (this.onProcessNode) {
      const shouldKeep = this.onProcessNode(gltfNode, rootEntity);
      if (!shouldKeep) {
        return null; // Consumer requested to discard this node
      }
    }

    // Now safely add them to the scene
    for (const ent of entitiesCreated) {
      scene.add(ent);
    }

    this.nodeToEntityMap.set(gltfNode, rootEntity);

    // Process children
    for (const childNode of gltfNode.listChildren()) {
      const childEntity = this.processNode(childNode, scene);
      if (childEntity) {
        rootEntity.transform.addChild(childEntity.transform);
      }
    }

    return rootEntity;
  }

  private createMeshFromPrimitive(primitive: any, name: string): Mesh {
    const positionAccessor = primitive.getAttribute("POSITION");
    const normalAccessor = primitive.getAttribute("NORMAL");
    const uvAccessor = primitive.getAttribute("TEXCOORD_0");
    const indicesAccessor = primitive.getIndices();

    if (!positionAccessor) {
      throw new Error("Primitive missing POSITION attribute");
    }

    const count = positionAccessor.getCount();
    const vertices: Vertex[] = [];

    for (let i = 0; i < count; i++) {
      const pos = positionAccessor.getElement(i, []) as number[];
      const norm = normalAccessor
        ? (normalAccessor.getElement(i, []) as number[])
        : [0, 1, 0];
      const uv = uvAccessor
        ? (uvAccessor.getElement(i, []) as number[])
        : [0, 0];

      vertices.push(
        new Vertex(
          [pos[0], pos[1], pos[2], 1.0],
          [norm[0], norm[1], norm[2], 0.0],
          [uv[0], uv[1]],
        ),
      );
    }

    // Indices
    let indices: number[] = [];
    if (indicesAccessor) {
      const idxArray = indicesAccessor.getArray();
      if (idxArray) {
        indices = Array.from(idxArray);
      }
    } else {
      // Unindexed
      for (let i = 0; i < count; i++) {
        indices.push(i);
      }
    }

    const geometry = new Geometry(this.renderer.getDevice(), vertices, indices);

    // Material
    const gltfMaterial = primitive.getMaterial();
    let material: MaterialBase;

    if (gltfMaterial) {
      material = this.processMaterial(gltfMaterial);
    } else {
      material = new MaterialBasic(
        this.renderer.getDevice(),
        `${name}_default_mat`,
      );
    }

    return new Mesh(this.renderer.getDevice(), name, geometry, material);
  }

  private processMaterial(gltfMaterial: GLTFMaterial): MaterialBase {
    if (this.parsedMaterials.has(gltfMaterial)) {
      return this.parsedMaterials.get(gltfMaterial)!;
    }

    const name = gltfMaterial.getName() || "GLTFMaterial";
    const baseColorTex = gltfMaterial.getBaseColorTexture();

    // If no albedo texture is present, fall back to MaterialBasic.
    // PBR in webgpu-renderer requires an albedoTexture otherwise GeometryPass bind groups fail.
    if (!baseColorTex) {
      const basic = new MaterialBasic(this.renderer.getDevice(), name, {
        color: gltfMaterial.getBaseColorFactor() as [
          number,
          number,
          number,
          number,
        ],
      });
      basic.doubleSided = gltfMaterial.getDoubleSided();
      const alphaMode = gltfMaterial.getAlphaMode();
      if (alphaMode === "OPAQUE") basic.alphaMode = "opaque";
      else if (alphaMode === "BLEND") basic.alphaMode = "blend";
      else if (alphaMode === "MASK") basic.alphaMode = "mask";
      basic.alphaCutoff = gltfMaterial.getAlphaCutoff();

      this.parsedMaterials.set(gltfMaterial, basic);
      return basic;
    }

    const pbr = new MaterialPBR(this.renderer.getDevice(), name);

    pbr.doubleSided = gltfMaterial.getDoubleSided();

    const alphaMode = gltfMaterial.getAlphaMode();
    if (alphaMode === "OPAQUE") pbr.alphaMode = "opaque";
    else if (alphaMode === "BLEND") pbr.alphaMode = "blend";
    else if (alphaMode === "MASK") pbr.alphaMode = "mask";

    pbr.alphaCutoff = gltfMaterial.getAlphaCutoff();

    // Textures
    if (baseColorTex) {
      pbr.albedoTexture = this.getTextureFromGLTFTexture(baseColorTex);
    }

    const normalTex = gltfMaterial.getNormalTexture();
    if (normalTex) {
      pbr.normalTexture = this.getTextureFromGLTFTexture(normalTex);
    }

    const metalRoughTex = gltfMaterial.getMetallicRoughnessTexture();
    if (metalRoughTex) {
      pbr.metalnessRoughnessTexture =
        this.getTextureFromGLTFTexture(metalRoughTex);
    }

    // Set colors - this would depend on how renderer accepts them,
    // but material property mapping is base implementation here.

    this.parsedMaterials.set(gltfMaterial, pbr);
    return pbr;
  }

  private getTextureFromGLTFTexture(gltfTexture: GLTFTexture): Texture {
    if (this.parsedTextures.has(gltfTexture)) {
      return this.parsedTextures.get(gltfTexture)!;
    }

    const mimeType = gltfTexture.getMimeType() || "image/png";
    const buffer = gltfTexture.getImage();

    // Fallback if image has no buffer, should not occur for regular valid GLTFs
    if (!buffer) {
      throw new Error("GLTF texture is missing image data buffer");
    }

    const blob = new Blob([buffer], { type: mimeType });
    const url = URL.createObjectURL(blob);

    const texture = new Texture(url);
    texture.load(); // Load asynchronously

    this.parsedTextures.set(gltfTexture, texture);
    return texture;
  }
}
